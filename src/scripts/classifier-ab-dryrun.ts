/**
 * Read-only A/B of the injury classifier across two models.
 *
 * The classifier decides more than its cost suggests: `is_injury_event` gates the
 * whole pipeline, `is_new` is the update-signal fallback, `athlete_name` feeds the
 * re-anchor and entity matching, and two of the four significance subscores are
 * produced by it. A model swap that looks free on the bill can move what
 * publishes, so this replays one live cycle through BOTH models and diffs every
 * field the pipeline reads.
 *
 * Usage:
 *   npx tsx src/scripts/classifier-ab-dryrun.ts [--sport NFL|NBA|PREMIER_LEAGUE]
 *       [--baseline claude-haiku-4-5-20251001] [--candidate claude-haiku-5-5]
 *       [--limit N] [--repeat-baseline] [--repeat-candidate] [--export path.csv]
 *
 * Needs ANTHROPIC_API_KEY. Makes 2 model calls per event (3 with
 * --repeat-baseline) and nothing else: no MCP, no database, no writes. Events go
 * through the same age filter and `isObviousNonInjury` pre-filter the poller
 * applies, and the same tier lookup, so the population is the one that is paid for.
 *
 * `--repeat-baseline` runs the baseline twice. The classifier is sampled at the
 * API default temperature, so the two baseline runs disagree with EACH OTHER on
 * some events; that rate is the floor. A candidate flip rate at or below it is
 * noise, not a regression.
 *
 * `--repeat-candidate` runs the candidate twice and reports how many of the events it
 * newly sends to PROCESS are stable across both runs.
 *
 * `--export path.csv` writes every event the two models disagree on (injury
 * call, `is_new`, athlete, content type or triage decision) with blank
 * `md_label` / `md_notes` columns, for a physician to rule on which model is right.
 *
 * Gate (exit 1 otherwise). With `--repeat-baseline` the bar is the baseline's own
 * disagreement with itself, because comparing against a noisy baseline fails even
 * a perfect candidate. Counts compared: candidate-vs-baseline against
 * `floor + 2*sqrt(floor) + 1` from baseline-vs-baseline (about two Poisson
 * standard deviations; the +1 keeps a floor of 0 from demanding perfection).
 *   - candidate classification errors: always zero
 *   - injury→non-injury flips: at most the noise bar
 *   - triage-decision downgrades (PROCESS→DEFER, PROCESS→DROP, DEFER→DROP): at
 *     most the noise bar
 * Without `--repeat-baseline` there is no floor, so those two fall back to zero.
 * Reported but never gated, because both directions are judgement: is_new flips,
 * athlete_name / team / content_type changes, subscore drift, and upgrades
 * (newly-published volume).
 */
import { writeFileSync } from 'node:fs';
import { SPORT_SOURCES } from '../monitoring/sports/index.js';
import { isObviousNonInjury } from '../monitoring/poller.js';
import { classifyEvent } from '../agents/injury-intelligence/classifier.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
} from '../agents/injury-intelligence/significance.js';
import type { ClassificationResult, RawInjuryEvent, SportKey, TriageDecision } from '../types.js';

const DEFAULT_BASELINE = 'claude-haiku-4-5-20251001';
const DEFAULT_CANDIDATE = 'claude-haiku-5-5';
const CONCURRENCY = 6;

const DECISION_RANK: Record<TriageDecision, number> = { DROP: 0, DEFER: 1, PROCESS: 2 };

function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}
const has = (name: string): boolean => process.argv.slice(2).includes(name);

const norm = (s: string | undefined): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

interface Pair {
  event: RawInjuryEvent;
  a: ClassificationResult;
  b: ClassificationResult;
  a2?: ClassificationResult;
  b2?: ClassificationResult;
}

const decisionOf = (c: ClassificationResult): TriageDecision | null =>
  c.is_injury_event ? (c.significance?.triage_decision ?? null) : null;

interface Diff {
  injury: boolean;
  injuryLost: boolean;
  isNew: boolean;
  athlete: boolean;
  team: boolean;
  contentType: boolean;
  decision: boolean;
  downgrade: boolean;
  upgrade: boolean;
}

function diff(x: ClassificationResult, y: ClassificationResult): Diff {
  const dx = decisionOf(x);
  const dy = decisionOf(y);
  // A non-injury result has no decision; it ranks below DROP so that
  // injury→non-injury reads as a downgrade and the reverse as an upgrade.
  const rx = dx ? DECISION_RANK[dx] : -1;
  const ry = dy ? DECISION_RANK[dy] : -1;
  const both = x.is_injury_event && y.is_injury_event;
  return {
    injury: x.is_injury_event !== y.is_injury_event,
    injuryLost: x.is_injury_event && !y.is_injury_event,
    isNew: both && x.is_new !== y.is_new,
    athlete: both && norm(x.athlete_name) !== norm(y.athlete_name),
    team: both && norm(x.team) !== norm(y.team),
    contentType: both && x.content_type !== y.content_type,
    decision: rx !== ry,
    downgrade: ry < rx,
    upgrade: ry > rx,
  };
}

function tally(pairs: Array<[ClassificationResult, ClassificationResult]>): Record<keyof Diff, number> {
  const t = {
    injury: 0, injuryLost: 0, isNew: 0, athlete: 0, team: 0,
    contentType: 0, decision: 0, downgrade: 0, upgrade: 0,
  } as Record<keyof Diff, number>;
  for (const [x, y] of pairs) {
    const d = diff(x, y);
    for (const k of Object.keys(t) as Array<keyof Diff>) if (d[k]) t[k]++;
  }
  return t;
}

function printTally(label: string, n: number, t: Record<keyof Diff, number>): void {
  console.log(`\n${label}  (n=${n})`);
  const rows: Array<[string, number]> = [
    ['is_injury_event flips', t.injury],
    ['  of which injury→non-injury', t.injuryLost],
    ['is_new flips', t.isNew],
    ['athlete_name changes', t.athlete],
    ['team changes', t.team],
    ['content_type changes', t.contentType],
    ['triage decision changes', t.decision],
    ['  downgrades', t.downgrade],
    ['  upgrades', t.upgrade],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(30)} ${String(v).padStart(4)}  ${n ? ((100 * v) / n).toFixed(1) : '0.0'}%`);
}

const csvCell = (v: unknown): string => {
  const t = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** What differed, as one readable tag so the CSV can be sorted by it. */
function disagreementKind(x: ClassificationResult, y: ClassificationResult): string {
  const d = diff(x, y);
  const kinds: string[] = [];
  if (d.injuryLost) kinds.push('lost');
  else if (d.injury) kinds.push('gained');
  if (d.downgrade && !d.injuryLost) kinds.push('downgrade');
  if (d.upgrade && !d.injury) kinds.push('upgrade');
  if (d.isNew) kinds.push('is_new');
  if (d.athlete) kinds.push('athlete');
  if (d.contentType) kinds.push('content_type');
  return kinds.join('+') || 'decision';
}

function buildCsv(sport: string, rows: Pair[]): string {
  const header = [
    'sport', 'kind', 'athlete_source', 'source_name', 'reported_at', 'description', 'source_url',
    'base_injury', 'base_is_new', 'base_type', 'base_decision', 'base_score',
    'cand_injury', 'cand_is_new', 'cand_type', 'cand_decision', 'cand_score',
    'md_label', 'md_notes',
  ];
  const lines = [header.join(',')];
  for (const p of rows) {
    const { a, b, event: e } = p;
    lines.push(
      [
        sport, disagreementKind(a, b), e.athlete_name, e.source_name, e.reported_at.toISOString(),
        e.injury_description, e.source_url,
        a.is_injury_event, a.is_new, a.content_type, decisionOf(a) ?? '', a.significance?.composite_score ?? '',
        b.is_injury_event, b.is_new, b.content_type, decisionOf(b) ?? '', b.significance?.composite_score ?? '',
        '', '',
      ].map(csvCell).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required (this script makes real model calls).');
    process.exit(2);
  }
  const sport = (arg('--sport') ?? 'NFL').toUpperCase() as SportKey;
  const baseline = arg('--baseline') ?? DEFAULT_BASELINE;
  const candidate = arg('--candidate') ?? DEFAULT_CANDIDATE;
  const limit = Number(arg('--limit') ?? '0') || Infinity;
  const repeat = has('--repeat-baseline');
  const repeatCand = has('--repeat-candidate');

  await loadSignificanceData();

  const source = SPORT_SOURCES[sport];
  if (!source) {
    console.error(`No source registered for ${sport}`);
    process.exit(2);
  }
  const fetched = await source.fetchLatestEventsWithReport();
  if (fetched.errorCount > 0) {
    console.warn(`[ab] ${fetched.errorCount} source error(s) — population may be partial`);
  }
  const events = fetched.events.filter((e) => !isObviousNonInjury(e)).slice(0, limit);
  console.log(
    `[ab] ${sport}: fetched=${fetched.events.length} after pre-filter=${events.length}  ` +
      `baseline=${baseline} candidate=${candidate} repeat_baseline=${repeat}`,
  );

  const pairs = await mapLimit(events, CONCURRENCY, async (event): Promise<Pair> => {
    const tier = lookupAthleteTier(event.athlete_name, event.sport);
    const ctx = { athleteTier: tier.tier, athleteTierSource: tier.source };
    const [a, b, a2, b2] = await Promise.all([
      classifyEvent(event, ctx, baseline),
      classifyEvent(event, ctx, candidate),
      repeat ? classifyEvent(event, ctx, baseline) : Promise.resolve(undefined),
      repeatCand ? classifyEvent(event, ctx, candidate) : Promise.resolve(undefined),
    ]);
    return { event, a, b, a2, b2 };
  });

  const baselineErrors = pairs.filter((p) => p.a.classification_error).length;
  const candidateErrors = pairs.filter((p) => p.b.classification_error).length;
  // An errored call returns a synthetic is_injury_event:false. Comparing it would
  // read an outage as "the model said not an injury", so drop the pair and say so.
  const valid = pairs.filter((p) => !p.a.classification_error && !p.b.classification_error && !p.a2?.classification_error && !p.b2?.classification_error);

  console.log(`\nclassification errors: baseline=${baselineErrors} candidate=${candidateErrors}  compared=${valid.length}/${pairs.length}`);
  console.log(
    `positives: baseline=${valid.filter((p) => p.a.is_injury_event).length} candidate=${valid.filter((p) => p.b.is_injury_event).length}`,
  );

  const ab = tally(valid.map((p) => [p.a, p.b]));
  printTally(`BASELINE → CANDIDATE`, valid.length, ab);

  if (repeat) {
    const aa = tally(valid.map((p) => [p.a, p.a2!]));
    printTally(`BASELINE → BASELINE (sampling noise floor)`, valid.length, aa);
  }

  if (repeatCand) {
    const bb = tally(valid.map((p) => [p.b, p.b2!]));
    printTally(`CANDIDATE → CANDIDATE (candidate's own noise)`, valid.length, bb);
    const flips = valid.filter((p) => decisionOf(p.b) === 'PROCESS' && decisionOf(p.a) !== 'PROCESS');
    const stable = flips.filter((p) => decisionOf(p.b2!) === 'PROCESS');
    console.log(`\nnewly-PROCESS events: ${flips.length}, still PROCESS on candidate re-run: ${stable.length}`);
    for (const p of flips) {
      console.log(
        `  ${decisionOf(p.b2!) === 'PROCESS' ? 'stable  ' : 'UNSTABLE'} ${p.event.athlete_name} base=${decisionOf(p.a) ?? '-'}(${p.a.significance?.composite_score ?? '-'}) ` +
          `cand=${p.b.significance?.composite_score}/${decisionOf(p.b2!) ?? 'non-injury'}(${p.b2!.significance?.composite_score ?? '-'})`,
      );
    }
  }

  // Subscore drift, over events both models called injuries.
  const both = valid.filter((p) => p.a.is_injury_event && p.b.is_injury_event && p.a.significance && p.b.significance);
  if (both.length > 0) {
    const d = both.map((p) => p.b.significance!.composite_score - p.a.significance!.composite_score);
    const mean = d.reduce((s, v) => s + v, 0) / d.length;
    const mae = d.reduce((s, v) => s + Math.abs(v), 0) / d.length;
    console.log(`\ncomposite score (candidate − baseline), n=${both.length}: mean=${mean.toFixed(2)} mean|Δ|=${mae.toFixed(2)} max|Δ|=${Math.max(...d.map(Math.abs)).toFixed(0)}`);
  }

  // Concrete disagreements, so a human can read them rather than trust a count.
  const show = (label: string, rows: Pair[]): void => {
    if (rows.length === 0) return;
    console.log(`\n${label} (${rows.length}, first 12)`);
    for (const p of rows.slice(0, 12)) {
      console.log(
        `  - ${p.event.athlete_name} | ${p.event.injury_description.slice(0, 90).replace(/\s+/g, ' ')}\n` +
          `      base: inj=${p.a.is_injury_event} new=${p.a.is_new} ${p.a.athlete_name} ${decisionOf(p.a) ?? '-'} ${p.a.significance?.composite_score ?? '-'}\n` +
          `      cand: inj=${p.b.is_injury_event} new=${p.b.is_new} ${p.b.athlete_name} ${decisionOf(p.b) ?? '-'} ${p.b.significance?.composite_score ?? '-'}`,
      );
    }
  };
  show('LOST (injury→non-injury)', valid.filter((p) => diff(p.a, p.b).injuryLost));
  show('DOWNGRADES', valid.filter((p) => diff(p.a, p.b).downgrade && !diff(p.a, p.b).injuryLost));
  show('ATHLETE NAME CHANGED', valid.filter((p) => diff(p.a, p.b).athlete));
  show('UPGRADES (new volume)', valid.filter((p) => diff(p.a, p.b).upgrade));

  const exportPath = arg('--export');
  if (exportPath) {
    const rows = valid.filter((p) => {
      const d = diff(p.a, p.b);
      return d.injury || d.isNew || d.athlete || d.contentType || d.decision;
    });
    writeFileSync(exportPath, buildCsv(sport, rows));
    console.log(`\n[ab] exported ${rows.length} disagreement(s) to ${exportPath}`);
  }

  // Noise-floor bar: floor + 2*sqrt(floor) + 1 when the baseline was run twice.
  let floorLost: number | null = null;
  let floorDown: number | null = null;
  if (repeat) {
    const aa = tally(valid.map((p) => [p.a, p.a2!]));
    floorLost = aa.injuryLost;
    floorDown = aa.downgrade;
  }
  const bar = (floor: number | null): number =>
    floor === null ? 0 : Math.floor(floor + 2 * Math.sqrt(floor) + 1);

  const checks: Array<[string, number, number]> = [
    ['candidate classification errors', candidateErrors, 0],
    ['injury→non-injury flips', ab.injuryLost, bar(floorLost)],
    ['triage downgrades', ab.downgrade, bar(floorDown)],
  ];
  console.log(`\nGATE (${repeat ? 'noise-floor bar from --repeat-baseline' : 'no noise floor: strict zero'})`);
  let bad = 0;
  for (const [k, v, max] of checks) {
    console.log(`  ${v <= max ? 'ok  ' : 'FAIL'} ${k}: ${v} (max ${max})`);
    if (v > max) bad++;
  }
  process.exit(bad > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
