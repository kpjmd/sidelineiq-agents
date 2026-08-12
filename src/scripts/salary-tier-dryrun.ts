// Models salary-derived athlete tiers against real data, BEFORE they are
// allowed to change a single gate decision. This is the ship gate for the
// feature, in the same spirit as the modelling that preceded the 55->60
// default.process change.
//
// READ-ONLY. It fetches ESPN rosters and reads injury_posts through MCP. It
// writes nothing, and it does not require SALARY_TIER_ENABLED to be on — it
// installs its own snapshot in-process.
//
// Four sections:
//   A  Snapshot distribution — how many athletes each band captures, who the
//      new tier-1s would be, and which curated stars salary would MISS.
//   B  Before/after tier distribution over recent posts, as a 4x4 confusion
//      matrix. Only the 3->1 and 3->2 cells may be non-zero; anything else
//      means the promote-only property is broken and the script exits 1.
//   C  Gate decision delta. DROP->DEFER, DROP->PROCESS and DEFER->PROCESS are
//      expected; PROCESS->anything and DEFER->DROP must be zero.
//   D  Volume estimate against MAX_PUBLISHES_PER_DAY.
//
// Usage:
//   npx tsx src/scripts/salary-tier-dryrun.ts
//   npx tsx src/scripts/salary-tier-dryrun.ts --days 60
//   npx tsx src/scripts/salary-tier-dryrun.ts --source db        # after a roster sync
//   npx tsx src/scripts/salary-tier-dryrun.ts --bands NFL:t1=20000000,t2=8000000
//
// --source espn (the default) reads live ESPN rosters, so this runs BEFORE
// migration 019 is applied and before anything is deployed. --source db reads
// the players table and is the post-deploy verification.

import 'dotenv/config';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
  computeSignificance,
  getLoadedConfig,
  setSalarySnapshot,
  salarySnapshotSize,
  _setConfigForTesting,
} from '../agents/injury-intelligence/significance.js';
import { ESPN_ROSTERED_SOURCES } from '../monitoring/roster-sync.js';
import type { SportKey, AthleteTier, ContentType, TriageDecision } from '../types.js';

const BANDED_SPORTS: SportKey[] = ['NFL', 'NBA'];
const DEFAULT_DAYS = 30;
const PAGE_SIZE = 50;
const M = 1_000_000;

interface SalaryRow {
  full_name: string;
  sport: string;
  salary: number;
}

interface MCPResult {
  content?: Array<{ text?: string }>;
}

function unwrap<T>(res: unknown): T | null {
  try {
    const text = (res as MCPResult)?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function fmtMoney(n: number): string {
  return `$${(n / M).toFixed(2)}M`;
}

// ── Salary sourcing ──────────────────────────────────────────────────────────

async function loadFromESPN(): Promise<SalaryRow[]> {
  const rows: SalaryRow[] = [];
  for (const sport of BANDED_SPORTS) {
    const source = ESPN_ROSTERED_SOURCES[sport as Exclude<SportKey, 'UFC'>];
    const teams = await source.fetchTeams();
    for (const team of teams) {
      const athletes = await source.fetchRoster(team.espn_team_id);
      for (const a of athletes) {
        if (a.salary) rows.push({ full_name: a.full_name, sport, salary: a.salary });
      }
    }
    process.stdout.write(`  ${sport}: ${rows.filter((r) => r.sport === sport).length} salaried\n`);
  }
  return rows;
}

async function loadFromDB(): Promise<SalaryRow[]> {
  const rows: SalaryRow[] = [];
  for (const sport of BANDED_SPORTS) {
    let offset = 0;
    for (;;) {
      const res = await callTool('web', 'web_list_players', {
        sport,
        coverage: 'all',
        limit: 200,
        offset,
      });
      const page = unwrap<{
        players?: Array<{ full_name?: string; sport?: string; salary?: number | string | null }>;
        has_more?: boolean;
        next_offset?: number;
      }>(res);
      if (!page) break;
      for (const p of page.players ?? []) {
        const salary = typeof p.salary === 'string' ? Number(p.salary) : p.salary;
        if (p.full_name && typeof salary === 'number' && salary > 0) {
          rows.push({ full_name: p.full_name, sport: p.sport ?? sport, salary });
        }
      }
      if (!page.has_more) break;
      offset = page.next_offset ?? offset + 200;
    }
    process.stdout.write(`  ${sport}: ${rows.filter((r) => r.sport === sport).length} salaried\n`);
  }
  return rows;
}

// ── Section A ────────────────────────────────────────────────────────────────

function sectionA(rows: SalaryRow[]): void {
  console.log('\n══ A. SNAPSHOT DISTRIBUTION ═══════════════════════════════════════');
  const bands = getLoadedConfig()?.salary_tiers?.bands ?? {};

  for (const sport of BANDED_SPORTS) {
    const band = bands[sport];
    const mine = rows.filter((r) => r.sport === sport);
    if (!band) {
      console.log(`\n${sport}: no bands configured — every athlete keeps the flat default.`);
      continue;
    }
    const sorted = [...mine].sort((a, b) => a.salary - b.salary);
    const q = (p: number): string =>
      sorted.length ? fmtMoney(sorted[Math.floor(p * (sorted.length - 1))].salary) : '-';

    // Recomputed live rather than trusted from the plan: the bands were
    // calibrated on 2026-08-12 rosters and salaries move.
    console.log(
      `\n${sport}  n=${mine.length} salaried  ` +
        `bands: t1>=${fmtMoney(band.tier_1_min)} t2>=${fmtMoney(band.tier_2_min)}`,
    );
    console.log(
      `  live percentiles: p50 ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  p95 ${q(0.95)}`,
    );

    const t1 = mine.filter((r) => r.salary >= band.tier_1_min);
    const t2 = mine.filter((r) => r.salary >= band.tier_2_min && r.salary < band.tier_1_min);
    console.log(
      `  would promote: tier 1 ${t1.length}, tier 2 ${t2.length} ` +
        `(of ${mine.length} salaried)`,
    );

    // The MD reads this list and says yes or no. Tier 1 also swaps the BREAKING
    // bar from default.process to BREAKING_T1.process, so a false tier 1 is the
    // expensive error.
    const newT1 = t1
      .filter((r) => lookupAthleteTier(r.full_name, sport, { allowSalary: false }).source !== 'lookup')
      .sort((a, b) => b.salary - a.salary)
      .slice(0, 20);
    console.log(`  top new tier-1s (not in athlete-tiers.json):`);
    for (const r of newT1) console.log(`    ${fmtMoney(r.salary).padStart(9)}  ${r.full_name}`);
  }

  // The known failure mode, reprinted every run so it is re-confirmed rather
  // than remembered: salary measures market value, not fame.
  console.log('\n  Curated stars salary would NOT have promoted (rookie/restructured deals):');
  const byName = new Map(rows.map((r) => [r.full_name.toLowerCase(), r]));
  let misses = 0;
  for (const sport of BANDED_SPORTS) {
    const band = bands[sport];
    if (!band) continue;
    for (const row of rows.filter((r) => r.sport === sport)) {
      const hand = lookupAthleteTier(row.full_name, sport, { allowSalary: false });
      if (hand.source !== 'lookup' || hand.tier > 2) continue;
      const banded = row.salary >= band.tier_1_min ? 1 : row.salary >= band.tier_2_min ? 2 : 3;
      if (banded > hand.tier) {
        console.log(
          `    ${fmtMoney(row.salary).padStart(9)}  ${row.full_name.padEnd(24)} hand=t${hand.tier} salary=t${banded === 3 ? '-' : banded}`,
        );
        misses++;
      }
    }
  }
  console.log(
    `  ${misses} such athletes. This is why athlete-tiers.json stays authoritative ` +
      `and must stay maintained.`,
  );
  void byName;
}

// ── Sections B & C ───────────────────────────────────────────────────────────

interface Post {
  athlete_name: string;
  sport: string;
  content_type: string;
  created_at: string;
}

async function fetchRecentPosts(days: number): Promise<Post[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const all: Post[] = [];
  let offset = 0;
  for (;;) {
    const res = await callTool('web', 'web_list_posts', { limit: PAGE_SIZE, offset });
    const page = unwrap<{ posts?: Post[]; has_more?: boolean; next_offset?: number }>(res);
    if (!page?.posts?.length) break;
    all.push(...page.posts);
    const oldest = page.posts[page.posts.length - 1]?.created_at;
    if (!page.has_more || (oldest && new Date(oldest).getTime() < cutoff)) break;
    offset = page.next_offset ?? offset + PAGE_SIZE;
  }
  return all.filter((p) => new Date(p.created_at).getTime() >= cutoff);
}

// Deterministic mid-range subscores. The Haiku subscores were never persisted
// on injury_posts, so the ONLY thing varying between the before and after runs
// is the tier — which is exactly what this is measuring. Documented, not
// hidden, following the same proxy convention as score-candidates-replay.
const PROXY_SUBSCORES = { information_specificity: 65, event_recency_novelty: 85 };

function sectionBC(posts: Post[]): boolean {
  console.log('\n══ B. BEFORE/AFTER TIER DISTRIBUTION ══════════════════════════════');
  const matrix = new Map<string, number>();
  const gateFlips = new Map<string, number>();
  const now = new Date();
  let promoted = 0;

  for (const p of posts) {
    const sport = p.sport as SportKey;
    const before = lookupAthleteTier(p.athlete_name, sport, { allowSalary: false });
    const after = lookupAthleteTier(p.athlete_name, sport, { allowSalary: true });
    const key = `${before.tier}->${after.tier}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if (after.tier < before.tier) promoted++;

    const ct = (p.content_type as ContentType) ?? 'BREAKING';
    const sigBefore = computeSignificance(before.tier, before.source, PROXY_SUBSCORES, ct, sport, now);
    const sigAfter = computeSignificance(after.tier, after.source, PROXY_SUBSCORES, ct, sport, now);
    if (sigBefore.triage_decision !== sigAfter.triage_decision) {
      const k = `${sigBefore.triage_decision}->${sigAfter.triage_decision}`;
      gateFlips.set(k, (gateFlips.get(k) ?? 0) + 1);
    }
  }

  console.log(`  ${posts.length} posts examined, ${promoted} athletes promoted\n`);
  console.log('        after:    t1    t2    t3    t4');
  const tiers: AthleteTier[] = [1, 2, 3, 4];
  let violations = 0;
  for (const b of tiers) {
    const cells = tiers.map((a) => {
      const n = matrix.get(`${b}->${a}`) ?? 0;
      // The invariant: the only legal moves are staying put, or 3 -> 1/2.
      if (n > 0 && a > b) violations += n;
      if (n > 0 && a < b && b !== 3) violations += n;
      return String(n).padStart(5);
    });
    console.log(`  before t${b}: ${cells.join(' ')}`);
  }

  if (violations > 0) {
    console.log(
      `\n  ✗ FAIL — ${violations} post(s) moved somewhere other than 3->1 or 3->2. ` +
        `Salary is meant to be promote-only; a demotion removes coverage that publishes today.`,
    );
  } else {
    console.log('\n  ✓ promote-only holds: every move is 3->1 or 3->2.');
  }

  console.log('\n══ C. GATE DECISION DELTA ═════════════════════════════════════════');
  const FORBIDDEN = ['PROCESS->DEFER', 'PROCESS->DROP', 'DEFER->DROP'];
  let forbidden = 0;
  if (gateFlips.size === 0) {
    console.log('  no gate decision changed.');
  }
  for (const [k, n] of [...gateFlips.entries()].sort()) {
    const bad = FORBIDDEN.includes(k);
    if (bad) forbidden += n;
    console.log(`  ${bad ? '✗' : '·'} ${k.padEnd(18)} ${n}`);
  }
  if (forbidden > 0) {
    console.log(
      `\n  ✗ FAIL — ${forbidden} decision(s) got STRICTLY WORSE. Nothing that publishes ` +
        `today may stop publishing.`,
    );
  } else {
    console.log('\n  ✓ no decision got worse.');
  }

  // ── Section D ──
  console.log('\n══ D. VOLUME ESTIMATE ═════════════════════════════════════════════');
  const newProcess =
    (gateFlips.get('DROP->PROCESS') ?? 0) + (gateFlips.get('DEFER->PROCESS') ?? 0);
  const days = Math.max(
    1,
    Math.round(
      (Date.now() -
        Math.min(...posts.map((p) => new Date(p.created_at).getTime()), Date.now())) /
        86_400_000,
    ),
  );
  const cap = parseInt(process.env.MAX_PUBLISHES_PER_DAY ?? '10', 10) || 10;
  console.log(
    `  ${newProcess} additional PROCESS over ~${days}d = ` +
      `${(newProcess / days).toFixed(2)}/day against MAX_PUBLISHES_PER_DAY=${cap}.`,
  );
  console.log(
    '  Note: tier 1 also swaps the BREAKING bar to BREAKING_T1, the loosest in the config. ' +
      'Anti-spam is a hard requirement — hold the daily cap low for the first 48h.',
  );

  return violations === 0 && forbidden === 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

function applyBandOverride(spec: string): void {
  // e.g. NFL:t1=20000000,t2=8000000 — lets the MD retune and re-read the
  // counts without editing the config or redeploying.
  const config = getLoadedConfig();
  if (!config?.salary_tiers?.bands) return;
  const [sport, rest] = spec.split(':');
  const parts = Object.fromEntries(
    (rest ?? '').split(',').map((kv) => kv.split('=') as [string, string]),
  );
  const band = config.salary_tiers.bands[sport as SportKey];
  if (!band) return;
  if (parts.t1) band.tier_1_min = Number(parts.t1);
  if (parts.t2) band.tier_2_min = Number(parts.t2);
  _setConfigForTesting(config as Parameters<typeof _setConfigForTesting>[0]);
  console.log(`[dryrun] band override: ${sport} t1>=${band.tier_1_min} t2>=${band.tier_2_min}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const daysArg = args.indexOf('--days');
  const days = daysArg >= 0 ? parseInt(args[daysArg + 1], 10) || DEFAULT_DAYS : DEFAULT_DAYS;
  const sourceArg = args.indexOf('--source');
  const source = sourceArg >= 0 ? args[sourceArg + 1] : 'espn';
  const bandsArg = args.indexOf('--bands');

  await initializeMCPClients();
  await loadSignificanceData();

  if (bandsArg >= 0) applyBandOverride(args[bandsArg + 1]);

  console.log(`[dryrun] loading salaries from ${source}...`);
  const rows = source === 'db' ? await loadFromDB() : await loadFromESPN();
  setSalarySnapshot(rows);
  console.log(`[dryrun] ${salarySnapshotSize()} salaried athletes indexed`);

  sectionA(rows);

  const posts = await fetchRecentPosts(days);
  console.log(`\n[dryrun] ${posts.length} posts in the last ${days}d`);
  const ok = posts.length > 0 ? sectionBC(posts) : true;
  if (posts.length === 0) {
    console.log('  (no posts in range — sections B/C/D skipped)');
  }

  console.log('\n[dryrun] No writes were made.');
  if (!ok) {
    console.log('[dryrun] SHIP GATE FAILED — do not enable SALARY_TIER_ENABLED.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('[dryrun] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll();
  });
