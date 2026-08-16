// Models derived athlete tiers — club for PREMIER_LEAGUE, card position for
// UFC — against real data, BEFORE they are allowed to change a single gate
// decision. This is the ship gate for the feature, the same role
// salary-tier-dryrun.ts played for salary.
//
// READ-ONLY. It reads the players table through MCP and ESPN's MMA scoreboard
// over HTTP, writes nothing, and does not require DERIVED_TIER_ENABLED to be on
// — it installs its own snapshot in-process.
//
// It differs from the salary dry-run in one structural way, and the reason
// matters. That script modelled against recent injury_posts, because NFL and
// NBA have hundreds. PREMIER_LEAGUE and UFC have ZERO posts ever — polling for
// both has never been enabled — so a post-based corpus would be empty and the
// gate would look unchanged no matter what this feature did. The corpus here is
// therefore the POPULATION the change actually touches: every in-coverage PL
// player, every fighter on a card in the window, and every curated name.
//
// Five sections:
//   A  Snapshot distribution — who each provider promotes, and to what.
//   B  Before/after tier confusion matrix per sport. Only 3->1 and 3->2 may be
//      non-zero, and NFL/NBA must be entirely diagonal — this change must not
//      touch the sports that already publish. Anything else exits 1.
//   C  Gate decision delta across a grid of plausible classifier subscores and
//      content types. PROCESS->DEFER, PROCESS->DROP and DEFER->DROP must be
//      zero: nothing that publishes today may stop publishing.
//   D  Curated-file health — every PREMIER_LEAGUE/UFC name in athlete-tiers.json
//      that does not resolve against live data. Must be zero to ship.
//   E  Volume estimate against MAX_PUBLISHES_PER_DAY.
//
// Usage:
//   npx tsx src/scripts/derived-tier-dryrun.ts
//   npx tsx src/scripts/derived-tier-dryrun.ts --json docs/derived-tier-dryrun.json
//   npx tsx src/scripts/derived-tier-dryrun.ts --clubs 359,364,382

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
  computeSignificance,
  getLoadedConfig,
  getLoadedDerivedConfig,
  setDerivedTierSnapshot,
  derivedSnapshotSize,
  _setConfigForTesting,
  type DerivedRow,
} from '../agents/injury-intelligence/significance.js';
import { _internals } from '../agents/injury-intelligence/derived-tier-snapshot.js';
import type { SportKey, AthleteTier, ContentType, TriageDecision } from '../types.js';

const DERIVED_SPORTS: SportKey[] = ['PREMIER_LEAGUE', 'UFC'];
/** The sports this change must leave byte-identical. */
const CONTROL_SPORTS: SportKey[] = ['NFL', 'NBA'];

/**
 * The classifier's subscores are never persisted, so they are modelled rather
 * than read — as in salary-tier-dryrun.ts. Three points spanning the plausible
 * range: a vague report, a typical ESPN injury line, and a specific fresh one.
 */
const SUBSCORE_GRID = [
  { label: 'vague', information_specificity: 50, event_recency_novelty: 70 },
  { label: 'typical', information_specificity: 65, event_recency_novelty: 85 },
  { label: 'specific', information_specificity: 80, event_recency_novelty: 90 },
];

/** The two content types the poller's gate actually scores. */
const CONTENT_TYPES: ContentType[] = ['BREAKING', 'TRACKING'];

interface Args {
  json?: string;
  clubs?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx >= 0) args.json = argv[jsonIdx + 1];
  const clubsIdx = argv.indexOf('--clubs');
  if (clubsIdx >= 0) args.clubs = (argv[clubsIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return args;
}

/** Replaces the configured tier-2 clubs, for retuning without a redeploy. */
function applyClubOverride(ids: string[]): void {
  const config = getLoadedConfig();
  if (!config) throw new Error('config not loaded');
  const next = structuredClone(config) as never as {
    derived_tiers?: Record<string, { kind: string; tier_2_clubs?: Array<{ espn_team_id: string }> }>;
  };
  const pl = next.derived_tiers?.PREMIER_LEAGUE;
  if (pl?.kind === 'club') pl.tier_2_clubs = ids.map((espn_team_id) => ({ espn_team_id }));
  _setConfigForTesting(next as never);
  console.log(`  club override applied: ${ids.join(', ')}`);
}

// ── Section A ────────────────────────────────────────────────────────────────

interface SnapshotReport {
  sport: string;
  by_tier: Record<string, number>;
  detail: Record<string, number>;
  tier_1: string[];
}

function sectionA(rows: DerivedRow[]): SnapshotReport[] {
  console.log('\n══ A. SNAPSHOT DISTRIBUTION ═══════════════════════════════════════');
  const reports: SnapshotReport[] = [];

  for (const sport of DERIVED_SPORTS) {
    const mine = rows.filter((r) => r.sport === sport);
    if (mine.length === 0) {
      console.log(`\n  ${sport}: no rows in the snapshot.`);
      continue;
    }
    const byTier: Record<string, number> = {};
    const detail: Record<string, number> = {};
    const tier1: string[] = [];

    for (const row of mine) {
      const resolved = lookupAthleteTier(row.full_name, sport);
      byTier[`t${resolved.tier}`] = (byTier[`t${resolved.tier}`] ?? 0) + 1;
      const key =
        row.signal.kind === 'club'
          ? (row.signal.team_name ?? row.signal.espn_team_id)
          : row.signal.slot;
      detail[key] = (detail[key] ?? 0) + 1;
      if (resolved.tier === 1) tier1.push(`${row.full_name} (${key}, ${resolved.source})`);
    }

    console.log(`\n  ${sport} — ${mine.length} athletes carry a signal`);
    console.log(
      `    resolved tiers: ${Object.entries(byTier).sort().map(([t, n]) => `${t}=${n}`).join(' ')}`,
    );
    for (const [key, n] of Object.entries(detail).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${key.padEnd(26)} ${String(n).padStart(4)}`);
    }
    console.log(`    tier 1 (${tier1.length}):`);
    for (const name of tier1.sort()) console.log(`      ${name}`);

    reports.push({ sport, by_tier: byTier, detail, tier_1: tier1 });
  }
  return reports;
}

// ── Sections B and C ─────────────────────────────────────────────────────────

interface Subject {
  name: string;
  sport: SportKey;
  origin: 'snapshot' | 'curated';
}

interface Flip {
  name: string;
  sport: string;
  content_type: string;
  subscores: string;
  from: TriageDecision;
  to: TriageDecision;
  tier_before: AthleteTier;
  tier_after: AthleteTier;
}

function sectionBC(subjects: Subject[], now: Date): {
  ok: boolean;
  matrices: Record<string, Record<string, number>>;
  flips: Flip[];
} {
  console.log('\n══ B. BEFORE/AFTER TIER DISTRIBUTION ══════════════════════════════');
  const tiers: AthleteTier[] = [1, 2, 3, 4];
  const matrices: Record<string, Record<string, number>> = {};
  const flips: Flip[] = [];
  const flipCounts = new Map<string, number>();
  let violations = 0;

  for (const sport of [...DERIVED_SPORTS, ...CONTROL_SPORTS]) {
    const mine = subjects.filter((s) => s.sport === sport);
    if (mine.length === 0) continue;
    const matrix: Record<string, number> = {};
    let promoted = 0;
    let sportViolations = 0;

    for (const subject of mine) {
      const before = lookupAthleteTier(subject.name, sport, { allowDerived: false });
      const after = lookupAthleteTier(subject.name, sport, { allowDerived: true });
      const key = `${before.tier}->${after.tier}`;
      matrix[key] = (matrix[key] ?? 0) + 1;
      if (after.tier < before.tier) promoted++;

      // The invariant: staying put, or 3 -> 1/2. Anything else removes coverage.
      if (after.tier > before.tier) sportViolations++;
      else if (after.tier < before.tier && before.tier !== 3) sportViolations++;

      // A control sport must not move AT ALL — not even upward. NFL and NBA
      // publish today; this feature is not allowed to touch them.
      if (CONTROL_SPORTS.includes(sport) && after.tier !== before.tier) sportViolations++;

      for (const ct of CONTENT_TYPES) {
        for (const grid of SUBSCORE_GRID) {
          const sub = {
            information_specificity: grid.information_specificity,
            event_recency_novelty: grid.event_recency_novelty,
          };
          const sigBefore = computeSignificance(before.tier, before.source, sub, ct, sport, now);
          const sigAfter = computeSignificance(after.tier, after.source, sub, ct, sport, now);
          if (sigBefore.triage_decision === sigAfter.triage_decision) continue;
          const k = `${sigBefore.triage_decision}->${sigAfter.triage_decision}`;
          flipCounts.set(k, (flipCounts.get(k) ?? 0) + 1);
          flips.push({
            name: subject.name,
            sport,
            content_type: ct,
            subscores: grid.label,
            from: sigBefore.triage_decision,
            to: sigAfter.triage_decision,
            tier_before: before.tier,
            tier_after: after.tier,
          });
        }
      }
    }

    matrices[sport] = matrix;
    violations += sportViolations;
    console.log(`\n  ${sport} — ${mine.length} athletes, ${promoted} promoted`);
    console.log('          after:    t1    t2    t3    t4');
    for (const b of tiers) {
      const cells = tiers.map((a) => String(matrix[`${b}->${a}`] ?? 0).padStart(5));
      console.log(`    before t${b}: ${cells.join(' ')}`);
    }
    if (sportViolations > 0) {
      console.log(`    ✗ ${sportViolations} illegal move(s) in ${sport}`);
    }
  }

  if (violations > 0) {
    console.log(
      `\n  ✗ FAIL — ${violations} athlete(s) moved somewhere other than 3->1 or 3->2, ` +
        `or a control sport moved at all. Derived tiers are meant to be promote-only, ` +
        `and NFL/NBA must be untouched.`,
    );
  } else {
    console.log('\n  ✓ promote-only holds, and NFL/NBA are unchanged.');
  }

  console.log('\n══ C. GATE DECISION DELTA ═════════════════════════════════════════');
  console.log(
    `  ${CONTENT_TYPES.length} content types x ${SUBSCORE_GRID.length} subscore points per athlete.\n`,
  );
  const FORBIDDEN = ['PROCESS->DEFER', 'PROCESS->DROP', 'DEFER->DROP'];
  let forbidden = 0;
  if (flipCounts.size === 0) console.log('  no gate decision changed.');
  for (const [k, n] of [...flipCounts.entries()].sort()) {
    const bad = FORBIDDEN.includes(k);
    if (bad) forbidden += n;
    console.log(`  ${bad ? '✗' : '·'} ${k.padEnd(18)} ${n}`);
  }

  // The headline number: TRACKING was previously impossible for these sports.
  const trackingUnblocked = flips.filter((f) => f.content_type === 'TRACKING' && f.to === 'PROCESS');
  console.log(
    `\n  TRACKING newly reaching PROCESS: ${trackingUnblocked.length} ` +
      `(was categorically impossible — tier 3 is tier_blocked for TRACKING).`,
  );

  if (forbidden > 0) {
    console.log(
      `\n  ✗ FAIL — ${forbidden} decision(s) got STRICTLY WORSE. Nothing that publishes ` +
        `today may stop publishing.`,
    );
  } else {
    console.log('\n  ✓ no decision got worse.');
  }

  return { ok: violations === 0 && forbidden === 0, matrices, flips };
}

// ── Section D ────────────────────────────────────────────────────────────────

/**
 * Curated PREMIER_LEAGUE/UFC names that do not appear in live data.
 *
 * A curated entry that matches nothing is not harmless: it is a name someone
 * believed was covered. For PL it usually means a transfer out of the division
 * or a spelling that does not match ESPN's; for UFC it means the fighter has
 * not been on a card in the window.
 */
function sectionD(rows: DerivedRow[], curated: Array<{ name: string; sport: string; tier: number }>): number {
  console.log('\n══ D. CURATED FILE HEALTH ═════════════════════════════════════════');
  const bySport = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!bySport.has(row.sport)) bySport.set(row.sport, new Set());
    bySport.get(row.sport)!.add(normalize(row.full_name));
  }

  let unresolved = 0;
  for (const sport of DERIVED_SPORTS) {
    const mine = curated.filter((c) => c.sport.toUpperCase() === sport);
    if (mine.length === 0) continue;
    const live = bySport.get(sport) ?? new Set();
    const missing = mine.filter((c) => !live.has(normalize(c.name)));
    console.log(`\n  ${sport} — ${mine.length} curated, ${mine.length - missing.length} resolve`);
    for (const m of missing) {
      console.log(`    ✗ ${m.name} (tier ${m.tier}) — not in live data`);
    }
    unresolved += missing.length;
  }
  if (unresolved === 0) console.log('\n  ✓ every curated name resolves against live data.');
  else {
    console.log(
      `\n  ✗ FAIL — ${unresolved} curated name(s) resolve to nothing. For PREMIER_LEAGUE that ` +
        `usually means a transfer out of the division or an ESPN spelling mismatch; the entry ` +
        `is inert either way.`,
    );
  }
  return unresolved;
}

/** Mirrors significance.ts normalizeText — the comparison must be the same one. */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();

  await loadSignificanceData();
  if (args.clubs?.length) applyClubOverride(args.clubs);

  const derivedConfig = getLoadedDerivedConfig();
  if (!derivedConfig || Object.keys(derivedConfig).length === 0) {
    console.error('No derived_tiers configured in data/significance-config.json — nothing to model.');
    process.exitCode = 1;
    return;
  }

  await initializeMCPClients();

  console.log('══ LOADING SNAPSHOT ═══════════════════════════════════════════════');
  const rows = await loadAllRows(now);
  if (rows === null) {
    console.error('\nSnapshot load failed — see the warnings above. Refusing to model on partial data.');
    await disconnectAll();
    process.exitCode = 1;
    return;
  }
  // Install exactly the rows that were just reported on, through the same
  // setter production uses, so the lookups below exercise the real index.
  setDerivedTierSnapshot(rows);
  console.log(`  ${derivedSnapshotSize()} athletes indexed.`);

  const reports = sectionA(rows);

  const curated = await readCuratedTiers();
  const subjects: Subject[] = [
    ...rows.map((r) => ({ name: r.full_name, sport: r.sport as SportKey, origin: 'snapshot' as const })),
    ...curated.map((c) => ({
      name: c.name,
      sport: c.sport.toUpperCase() as SportKey,
      origin: 'curated' as const,
    })),
  ];
  // A curated athlete who is also in the snapshot is one subject, not two.
  const seen = new Set<string>();
  const unique = subjects.filter((s) => {
    const key = `${s.sport}|${normalize(s.name)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const bc = sectionBC(unique, now);
  const unresolved = sectionD(rows, curated);

  console.log('\n══ E. VOLUME ESTIMATE ═════════════════════════════════════════════');
  const cap = parseInt(process.env.MAX_PUBLISHES_PER_DAY ?? '10', 10) || 10;
  const newlyEligible = new Set(
    bc.flips.filter((f) => f.to === 'PROCESS').map((f) => `${f.sport}|${f.name}`),
  );
  console.log(
    `  ${newlyEligible.size} athletes become PROCESS-eligible under at least one ` +
      `(content type, subscore) combination.`,
  );
  console.log(
    '  That is a POPULATION, not a rate: it becomes volume only when one of them is injured AND ' +
      'the news feed reports it. Measured feed volume is ~1-3 UFC injury events/month, and a ' +
      'handful of PL stories per week in season.',
  );
  console.log(
    `  MAX_PUBLISHES_PER_DAY=${cap} is global across all sports and is the binding constraint — ` +
      'enabling two more sports triples per-cycle capacity but not the daily cap.',
  );

  if (args.json) {
    await writeFile(
      args.json,
      JSON.stringify(
        {
          generated_at: now.toISOString(),
          snapshot: reports,
          matrices: bc.matrices,
          flips: bc.flips,
          unresolved_curated: unresolved,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`\n  report written to ${args.json}`);
  }

  await disconnectAll();

  const ok = bc.ok && unresolved === 0;
  console.log(
    `\n${ok ? '✓ SHIP GATE PASSED' : '✗ SHIP GATE FAILED'} — ` +
      `promote-only ${bc.ok ? 'holds' : 'BROKEN'}, ${unresolved} unresolved curated name(s).`,
  );
  if (!ok) process.exitCode = 1;
}

/**
 * Every provider's rows, fetched once. Returns null if ANY provider fails —
 * the same all-or-nothing rule the loader itself applies, for the same reason:
 * a sport silently missing from the corpus would read as "this change affects
 * nobody there".
 */
async function loadAllRows(now: Date): Promise<DerivedRow[] | null> {
  const config = getLoadedDerivedConfig() ?? {};
  const rows: DerivedRow[] = [];
  for (const [sport, cfg] of Object.entries(config)) {
    const provided =
      cfg.kind === 'card'
        ? await _internals.loadCardRows(sport, cfg.window_days_back ?? 180, cfg.window_days_forward ?? 90, now)
        : await _internals.loadClubRows(sport);
    if (provided === null) return null;
    rows.push(...provided);
  }
  return rows;
}

/** The curated file, read from disk — the same file loadSignificanceData reads. */
async function readCuratedTiers(): Promise<Array<{ name: string; sport: string; tier: AthleteTier }>> {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../data/athlete-tiers.json');
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as {
    athletes?: Array<{ name: string; sport: string; tier: AthleteTier }>;
  };
  return parsed.athletes ?? [];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
