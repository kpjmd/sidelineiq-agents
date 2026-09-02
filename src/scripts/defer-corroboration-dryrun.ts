/**
 * Read-only ship gate for the defer-queue corroboration redesign.
 *
 * The repo convention is that an extraction or scoring change is verified by
 * diffing old against new over the LIVE feed, with the numbers that must be
 * zero stated up front. Unit tests have missed the real failure mode here
 * repeatedly — the defer queue itself shipped with nine passing tests against
 * a read that never worked.
 *
 * THE NUMBERS THAT MUST BE ZERO (this script exits 1 on any of them):
 *   1. Promotions reachable with ONE source family. That is self-corroboration,
 *      the thing the redesign exists to stop.
 *   2. Live events from a registered source class (espn-*, newsapi-*, X:*)
 *      whose sourceFamily is null. A publisher we cannot name cannot
 *      corroborate, so a null here silently disables the feature for that feed.
 *   3. Decision changes at discount 0. Threading the discount must be inert
 *      when there is no corroboration.
 *   4. Any decision that got WORSE (PROCESS→DEFER/DROP, DEFER→DROP).
 *
 * Sections:
 *   A. What the live defer queue holds right now, and how much of it needs
 *      migrating.
 *   B. Live sources fetched INDIVIDUALLY (not through MultiSource, which
 *      collapses same-day duplicates before anything can see them), so
 *      cross-publisher collisions on one athlete are visible.
 *   C. Replay of the DEFER decisions in a Railway log, scored twice: once
 *      under the OLD recency bonus at k sightings, once under the NEW
 *      threshold discount at k families.
 *   D. Inertness and monotonicity of the discount over the live config.
 *
 * Usage:
 *   npx tsx src/scripts/defer-corroboration-dryrun.ts --log railway.log
 *   railway run npx tsx src/scripts/defer-corroboration-dryrun.ts --log railway.log
 *     (the `railway run` form is the only one with NEWSAPI_KEY in the env)
 *
 * Writes nothing, publishes nothing, makes no model calls.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { initializeMCPClients, disconnectAll, callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { readSocialState } from '../utils/social-state.js';
import { normalizeEntry, type DeferQueueEntry } from '../monitoring/defer-queue.js';
import { sourceFamily, sourceFamilies } from '../monitoring/source-family.js';
import { deduplicateEvents } from '../monitoring/sports/multi-source.js';
import {
  loadSignificanceData,
  getDeferConfig,
  computeCorroborationDiscount,
  computeAthleteKey,
  computeRawScore,
  computeSignificance,
  decideTriage,
  effectiveThresholds,
} from '../agents/injury-intelligence/significance.js';
import { extractInjuryMetadata } from '../agents/injury-intelligence/fact-validator.js';
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';
import { ESPNPremierLeagueSource } from '../monitoring/sports/espn-premier-league.js';
import { ESPNPremierLeagueNewsSource } from '../monitoring/sports/espn-premier-league-news.js';
import { NewsAPINFLSource } from '../monitoring/sports/newsapi-nfl.js';
import { XInsiderNFLSource } from '../monitoring/sports/x-insider-nfl.js';
import { XInsiderNBASource } from '../monitoring/sports/x-insider-nba.js';
import type { AthleteTier, ContentType, RawInjuryEvent, SportKey } from '../types.js';

const SPORTS: SportKey[] = ['NFL', 'NBA', 'PREMIER_LEAGUE'];

// Content-type priors and tier prominences, inverted. The gate log prints the
// derived subscores but not the labels that produced them.
const PRIOR_TO_CT: Record<number, ContentType> = {
  75: 'BREAKING', 30: 'TRACKING', 80: 'DEEP_DIVE', 85: 'CONFLICT_FLAG',
};
const PROMINENCE_TO_TIER: Record<number, AthleteTier> = { 95: 1, 70: 2, 40: 3, 10: 4 };

const failures: string[] = [];
function mustBeZero(label: string, count: number, examples: string[] = []): void {
  const ok = count === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${count}`);
}

// ── A. The live queue ────────────────────────────────────────────────────────

async function sectionA(): Promise<void> {
  console.log('\n═══ A. Live defer queue ═══');
  if (!isServerAvailable('web')) {
    console.log('  web MCP unavailable — skipped.');
    return;
  }
  for (const sport of SPORTS) {
    let entries: DeferQueueEntry[] = [];
    try {
      const raw = await callTool('web', 'web_get_social_state', { key: `defer_queue_v1:${sport}` });
      const read = readSocialState(raw);
      if (read.status === 'unreadable') {
        console.log(`  ${sport}: UNREADABLE (${read.reason})`);
        continue;
      }
      if (read.status === 'absent') {
        console.log(`  ${sport}: absent (never written)`);
        continue;
      }
      const parsed = JSON.parse(read.value) as { entries?: DeferQueueEntry[] };
      entries = (parsed.entries ?? []).map((e) => normalizeEntry(e, sport));
    } catch (err) {
      console.log(`  ${sport}: read failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const needsMigration = entries.filter((e) => e.sources.length === 0).length;
    const bySize = new Map<number, number>();
    let ages: number[] = [];
    for (const e of entries) {
      bySize.set(e.sources.length, (bySize.get(e.sources.length) ?? 0) + 1);
      ages.push((Date.now() - new Date(e.deferred_at).getTime()) / 3_600_000);
    }
    ages = ages.sort((a, b) => a - b);
    console.log(
      `  ${sport}: ${entries.length} entries | families ` +
        `${[...bySize.entries()].map(([k, v]) => `${k}:${v}`).join(' ') || '-'} | ` +
        `needs migration ${needsMigration} | age h ` +
        `${ages.length ? `${ages[0].toFixed(1)}–${ages[ages.length - 1].toFixed(1)}` : '-'}`,
    );

    // Informational: the fingerprint names a different athlete than the entry.
    const mismatched = entries.filter(
      (e) => e.fingerprint.split(':')[0] !== e.athlete_key.split('|')[1],
    );
    if (mismatched.length > 0) {
      console.log(
        `    note: ${mismatched.length} entr${mismatched.length === 1 ? 'y' : 'ies'} whose fingerprint ` +
          'names a different athlete than athlete_name (ESPN rows carrying a teammate comment). ' +
          'The athlete key follows the classifier, so these now group correctly.',
      );
    }
  }
}

// ── B. Live sources, fetched one at a time ───────────────────────────────────

interface Fetched {
  name: string;
  events: RawInjuryEvent[];
  skipped?: string;
}

async function fetchOne(
  name: string,
  fn: () => Promise<RawInjuryEvent[]>,
): Promise<Fetched> {
  try {
    return { name, events: await fn() };
  } catch (err) {
    return { name, events: [], skipped: err instanceof Error ? err.message : String(err) };
  }
}

async function sectionB(): Promise<void> {
  console.log('\n═══ B. Live sources (fetched individually, pre-MultiSource) ═══');

  const sources: Array<[string, () => Promise<RawInjuryEvent[]>]> = [
    ['espn-nfl', () => new ESPNNFLSource().fetchLatestEvents()],
    ['espn-nba', () => new ESPNNBASource().fetchLatestEvents()],
    ['espn-premier-league', () => new ESPNPremierLeagueSource().fetchLatestEvents()],
    ['espn-premier-league-news', () => new ESPNPremierLeagueNewsSource().fetchLatestEvents()],
    ['x-insider-nfl', () => new XInsiderNFLSource().fetchLatestEvents()],
    ['x-insider-nba', () => new XInsiderNBASource().fetchLatestEvents()],
  ];
  if (process.env.NEWSAPI_KEY) {
    sources.push(['newsapi-nfl', () => new NewsAPINFLSource().fetchLatestEvents()]);
  } else {
    console.log('  newsapi-nfl: SKIPPED (NEWSAPI_KEY absent — re-run under `railway run` to include it)');
  }

  const fetched = await Promise.all(sources.map(([n, f]) => fetchOne(n, f)));
  const all: RawInjuryEvent[] = [];
  for (const f of fetched) {
    console.log(`  ${f.name}: ${f.skipped ? `error — ${f.skipped}` : `${f.events.length} events`}`);
    all.push(...f.events);
  }

  // Family census, and the must-be-zero unidentifiable ones.
  const byFamily = new Map<string, number>();
  const unnamed: string[] = [];
  for (const e of all) {
    const family = sourceFamily(e);
    if (family === null) {
      unnamed.push(`${e.source_name ?? '(no source_name)'} ${e.source_url}`);
    } else {
      byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
    }
  }
  console.log('\n  families seen:');
  for (const [f, n] of [...byFamily.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f}: ${n}`);
  }
  mustBeZero('events from a registered source with no resolvable family', unnamed.length, unnamed);

  // Athlete keys reachable from more than one family: the entire population
  // that can ever promote.
  const byAthlete = new Map<string, { families: Set<string>; parts: Set<string> }>();
  for (const e of all) {
    const family = sourceFamily(e);
    if (!family) continue;
    const key = computeAthleteKey(e.sport, e.athlete_name);
    const slot = byAthlete.get(key) ?? { families: new Set(), parts: new Set() };
    slot.families.add(family);
    const part = extractInjuryMetadata(e.injury_description, e.injury_details).primary_body_part;
    if (part) slot.parts.add(part);
    byAthlete.set(key, slot);
  }
  const multi = [...byAthlete.entries()].filter(([, v]) => v.families.size > 1);
  console.log(`\n  athletes reported by 2+ families this fetch: ${multi.length}`);
  for (const [key, v] of multi.slice(0, 20)) {
    console.log(`    ${key}: ${[...v.families].join(' + ')} | parts ${[...v.parts].join('/') || '-'}`);
  }
  // Informational, not a failure: these are the pairs the body-part guard will
  // hold apart as separate injuries rather than corroborating.
  const split = multi.filter(([, v]) => v.parts.size > 1);
  console.log(`  of those, ${split.length} name more than one body part (guard will split them)`);

  // What MultiSource does to the same list, and whether provenance survives it.
  const before = all.length;
  const merged = deduplicateEvents(all.map((e) => ({ ...e })));
  const carriers = merged.filter((e) => (e.corroborating_families?.length ?? 0) > 0);
  console.log(
    `\n  deduplicateEvents: ${before} → ${merged.length} (${before - merged.length} collapsed), ` +
      `${carriers.length} survivor(s) carrying a merged publisher`,
  );
  for (const c of carriers.slice(0, 10)) {
    console.log(`    ${c.athlete_name}: ${sourceFamilies(c).join(' + ')}`);
  }
  // A same-publisher collapse carries nothing, and that is correct — so the
  // check is that no CROSS-family collapse lost its loser.
  const lostLosers = countLostCrossFamilyMerges(all, merged);
  mustBeZero('cross-family merges whose second publisher was lost', lostLosers);
}

function countLostCrossFamilyMerges(all: RawInjuryEvent[], merged: RawInjuryEvent[]): number {
  const keyOf = (e: RawInjuryEvent) =>
    `${e.sport}|${e.athlete_name.trim().toLowerCase()}|${e.reported_at.toISOString().slice(0, 10)}`;
  const expected = new Map<string, Set<string>>();
  for (const e of all) {
    const f = sourceFamily(e);
    if (!f) continue;
    const set = expected.get(keyOf(e)) ?? new Set<string>();
    set.add(f);
    expected.set(keyOf(e), set);
  }
  let lost = 0;
  for (const e of merged) {
    const want = expected.get(keyOf(e));
    if (!want || want.size < 2) continue;
    const have = new Set(sourceFamilies(e));
    for (const f of want) if (!have.has(f)) lost++;
  }
  return lost;
}

// ── C. Replay of logged DEFER decisions ──────────────────────────────────────

interface LoggedDefer {
  score: number;
  bar: number;
  deferBar: number;
  tier: AthleteTier;
  contentType: ContentType;
  spec: number;
  rec: number;
  athlete: string;
}

/** `[SignificanceGate] decision=DEFER score=46 raw=46 bar=65 defer_bar=40 … */
function parseDefers(text: string): LoggedDefer[] {
  const out: LoggedDefer[] = [];
  const re =
    /decision=DEFER score=(\d+) raw=\d+ bar=(\d+) defer_bar=(\d+).*?athlete="([^"]*)".*?ct_prior=(\d+) prom=(\d+) spec=(\d+) rec=(\d+)/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const contentType = PRIOR_TO_CT[Number(m[5])];
    const tier = PROMINENCE_TO_TIER[Number(m[6])];
    if (!contentType || !tier) continue;
    out.push({
      score: Number(m[1]),
      bar: Number(m[2]),
      deferBar: Number(m[3]),
      athlete: m[4],
      contentType,
      tier,
      spec: Number(m[7]),
      rec: Number(m[8]),
    });
  }
  return out;
}

function sectionC(logPath: string | null): void {
  console.log('\n═══ C. Replay of logged DEFER decisions ═══');
  if (!logPath) {
    console.log('  no --log given; skipped. (Dump one with `railway logs -n 5000 > railway.log`.)');
    return;
  }
  const defers = parseDefers(readFileSync(logPath, 'utf-8'));
  console.log(`  parsed ${defers.length} DEFER decisions`);
  if (defers.length === 0) return;

  const cfg = getDeferConfig();
  const gaps = defers.map((d) => d.bar - d.score).sort((a, b) => a - b);
  const pct = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
  console.log(
    `  gap to bar — min ${gaps[0]} p25 ${pct(0.25)} median ${pct(0.5)} p75 ${pct(0.75)} max ${gaps[gaps.length - 1]}`,
  );

  console.log('\n  would-promote, same corpus scored twice:');
  console.log('    OLD counts SIGHTINGS (one feed re-serving itself). NEW counts FAMILIES.');
  console.log('    k   OLD (k sightings, recency bonus)   NEW (k families, threshold discount)');
  const singleFamilyPromotions: string[] = [];
  let oldSelfCorroborated = 0;
  for (const k of [1, 2, 3, 4, 5]) {
    // OLD: bonus = min(20, k*5) added to event_recency_novelty, re-scored.
    const oldBonus = Math.min(20, k * 5);
    const oldPromotes = defers.filter((d) => {
      const rec = Math.min(100, d.rec + oldBonus);
      const raw = computeRawScore({
        athlete_prominence: { 1: 95, 2: 70, 3: 40, 4: 10 }[d.tier],
        information_specificity: d.spec,
        event_recency_novelty: rec,
        content_type_prior: { BREAKING: 75, TRACKING: 30, DEEP_DIVE: 80, CONFLICT_FLAG: 85 }[d.contentType],
      });
      return raw >= d.bar;
    }).length;

    // NEW: the bar moves, the score does not. Clamped at the logged defer bar,
    // which is what effectiveThresholds does.
    const discount = computeCorroborationDiscount(k, cfg);
    const newPromoted = defers.filter((d) => d.score >= Math.max(d.bar - discount, d.deferBar));
    if (k === 1) {
      for (const d of newPromoted) singleFamilyPromotions.push(`${d.athlete} score=${d.score} bar=${d.bar}`);
    }
    // The old code's first corroboration was source_count 1→2, and the only
    // thing that could produce it was the same feed re-serving its own row.
    if (k === 2) oldSelfCorroborated = oldPromotes;
    console.log(
      `    ${k}   ${String(oldPromotes).padEnd(4)} (bonus +${oldBonus} recency)          ` +
        `${String(newPromoted.length).padEnd(4)} (bar −${discount})`,
    );
  }

  // k=1 is one publisher. Under the old model it promoted on self-repetition;
  // under the new one it must be impossible by arithmetic, and the queue's
  // two-family guard refuses it independently.
  mustBeZero(
    'promotions reachable with a single source family',
    singleFamilyPromotions.length,
    singleFamilyPromotions,
  );
  console.log(
    `\n  ${oldSelfCorroborated} of ${defers.length} would have promoted under the OLD model on ` +
      'ONE feed re-serving its own row — the self-corroboration this replaces. ' +
      '(It almost never fired only because ttl_hours 6 evicted every entry first.)',
  );
}

// ── D. Inertness and monotonicity over the live config ───────────────────────

function sectionD(): void {
  console.log('\n═══ D. Discount is inert at 0 and monotone above it ═══');
  const CTS: ContentType[] = ['BREAKING', 'TRACKING', 'DEEP_DIVE', 'CONFLICT_FLAG'];
  const TIERS: AthleteTier[] = [1, 2, 3, 4];
  const RANK = { DROP: 0, DEFER: 1, PROCESS: 2 } as const;

  let inertBreaks = 0;
  let worse = 0;
  const worseExamples: string[] = [];

  for (const ct of CTS) {
    for (const tier of TIERS) {
      for (const delta of [-5, 0, 5]) {
        for (let score = 0; score <= 100; score++) {
          const base = decideTriage(score, ct, tier, delta);
          if (decideTriage(score, ct, tier, delta, 0) !== base) inertBreaks++;
          for (const discount of [5, 10, 20]) {
            const got = decideTriage(score, ct, tier, delta, discount);
            if (RANK[got] < RANK[base]) {
              worse++;
              if (worseExamples.length < 8) {
                worseExamples.push(`${ct} tier${tier} delta${delta} score${score} d${discount}: ${base}→${got}`);
              }
            }
          }
        }
      }
    }
  }
  mustBeZero('decisions that change at discount 0', inertBreaks);
  mustBeZero('decisions that get WORSE under a discount', worse, worseExamples);

  // The bar can never fall below the defer floor.
  let belowFloor = 0;
  for (const ct of CTS) {
    for (const tier of TIERS) {
      const t = effectiveThresholds(ct, tier, 0, 50);
      if (t.process !== null && t.defer !== null && t.process < t.defer) belowFloor++;
    }
  }
  mustBeZero('content types whose discounted bar fell below the DEFER floor', belowFloor);

  // And the assessment records what it applied.
  const s = computeSignificance(2, 'lookup', { information_specificity: 48, event_recency_novelty: 15 },
    'BREAKING', 'NFL', new Date(), { corroborationDiscount: 10, corroboratingSources: ['espn', 'x:rapsheet'] });
  console.log(`  sample: score=${s.composite_score} bar=${s.process_threshold} ` +
    `discount=${s.corroboration_discount} decision=${s.triage_decision}`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };

  await loadSignificanceData();
  const cfg = getDeferConfig();
  console.log('defer config:', JSON.stringify(cfg));
  // Report against PRODUCTION, not whatever the local .env happens to say. A
  // laptop running the 15-minute code default would show a comfortable margin
  // for the exact setting that made the queue a no-op in Railway.
  const PROD_POLL_INTERVAL_MS = 21_600_000;
  const localMs = Number(process.env.POLL_INTERVAL_MS ?? PROD_POLL_INTERVAL_MS);
  const cycles = (ms: number) => (cfg.ttl_hours / (ms / 3_600_000)).toFixed(1);
  console.log(
    `poll interval: production ${PROD_POLL_INTERVAL_MS}ms (6.0h) — an entry survives ` +
      `${cycles(PROD_POLL_INTERVAL_MS)} cycles` +
      (localMs !== PROD_POLL_INTERVAL_MS
        ? ` | local .env says ${localMs}ms (${cycles(localMs)} cycles) — not what ships`
        : ''),
  );

  try {
    await initializeMCPClients();
  } catch {
    console.log('MCP init failed — section A will be skipped.');
  }

  try {
    await sectionA();
    await sectionB();
    sectionC(flag('--log'));
    sectionD();
  } finally {
    await disconnectAll().catch(() => {});
  }

  console.log('\n═══ Verdict ═══');
  if (failures.length === 0) {
    console.log('  All must-be-zero checks passed.');
    process.exit(0);
  }
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
