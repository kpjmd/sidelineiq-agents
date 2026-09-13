/**
 * Read-only diagnostic AND ship gate for DEEP_DIVE candidate selection.
 *
 * Only 2 DEEP_DIVE posts have PUBLISHED (2026-04-20, 2026-04-29) against a
 * scheduler configured for ~8/month. DEEP_DIVE is the only content type carrying
 * the referral CTA, so this is the whole funnel. Three explanations competed and
 * need different fixes:
 *
 *   H1  CANDIDATE STARVATION — the old predicate grouped on the exact
 *       injury_type string, which is free model prose.         CONFIRMED 2026-09-12
 *   H2  GENERATED BUT NEVER APPROVED — rows would exist as
 *       PENDING_REVIEW/REJECTED; the public feed cannot see them.  ruled out: 0 rows
 *   H3  SCHEDULER NOT RUNNING — not visible to the database.   ruled out in Railway:
 *       DEEP_DIVE_ENABLED=true, and the only retained cycle logs "No injury type
 *       meets threshold … skipping" at min_count=3.
 *
 *   A — DEEP_DIVE census by status and month (H2).
 *   B — LEGACY predicate replay: exact injury_type, the code this replaced (H1).
 *   C — Label fragmentation under the canonical key.
 *   D — SHIP GATE. Replays the REAL selectDeepDiveCandidate — imported, not
 *       re-implemented, so the replay cannot drift from the scheduler.
 *   E — Projected generation at the scheduler's real cadence WITH cooldown
 *       feedback. D measures candidate availability, which overstates output:
 *       each DEEP_DIVE cools its own key for 30 days. E is the MD review load.
 *
 * The verdict is judged on the trailing 30 days, never the all-time rate. The
 * first version of this script used an all-time percentage and printed the wrong
 * answer: 24 qualifying days, all before 2026-05-16, read as "candidates existed"
 * over a four-month drought.
 *
 * Numbers that must be ZERO (section D):
 *   Z1  existing DEEP_DIVE rows whose cooldown key is null — a DEEP_DIVE that can
 *       never hold its cooldown, so its topic regenerates every cycle
 *   Z2  candidates chosen while an independent recomputation says their key was
 *       inside a genuine cooldown (DEEP_DIVE_COOLDOWN_MS, 30 days)
 *   Z3  candidates whose athletes and teams arrays differ in length
 *   Z4  candidates naming an athlete who appears in the window only on retired rows
 *   Z5  candidates whose count differs from an independent count of DISTINCT
 *       athletes on live rows in the window — the agent prints the count as
 *       "N cases", so a post count here is a false clinical claim
 * Must be NON-ZERO: trailing-30-day days with a candidate.
 *
 * Known bias: before mcp migration 021 a rejected post was hard-DELETED, so those
 * rows are gone and every replay UNDERCOUNTS what the scheduler saw back then.
 *
 * Usage (mirror production's threshold — the code default is 2, Railway sets 3):
 *   DEEP_DIVE_MIN_INJURY_COUNT=3 npx tsx src/scripts/deep-dive-starvation-dryrun.ts
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import { isRetiredPostStatus, listAllPosts } from '../utils/web-posts.js';
import { canonicalInjuryKey } from '../monitoring/injury-taxonomy.js';
import {
  DEEP_DIVE_COOLDOWN_MS,
  DEEP_DIVE_LOOKBACK_MS,
  deepDiveCooldownKey,
  selectDeepDiveCandidate,
  type CandidatePost,
  type DeepDiveCandidate,
} from '../monitoring/deep-dive-candidates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAUNCH = Date.parse('2026-04-20T00:00:00Z');
const RECENT_WINDOW_DAYS = 30;
const DEFAULT_MIN_COUNT = 2;
const SCHEDULER_INTERVAL_MS = 3 * DAY_MS;
/** The replaced predicate's cooldown. Not DEEP_DIVE_COOLDOWN_MS, which is now 30 days. */
const LEGACY_COOLDOWN_MS = 7 * DAY_MS;

function ts(row: CandidatePost): number {
  return row.created_at ? Date.parse(row.created_at) : NaN;
}

/** The predicate deep-dive-candidates.ts replaced. Kept here for comparison only. */
function legacyHasCandidate(rows: CandidatePost[], now: number, minCount: number): string | null {
  const counts = new Map<string, number>();
  const cooling = new Set<string>();
  for (const r of rows) {
    const t = ts(r);
    if (!Number.isFinite(t) || t >= now || isRetiredPostStatus(r.status)) continue;
    const k = r.injury_type?.toLowerCase().trim();
    if (!k) continue;
    if (r.content_type === 'DEEP_DIVE') {
      if (now - t < LEGACY_COOLDOWN_MS) cooling.add(k);
    } else if (now - t < DEEP_DIVE_LOOKBACK_MS) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()]
    .filter(([k, n]) => n >= minCount && !cooling.has(k))
    .sort(([, a], [, b]) => b - a)[0];
  return best?.[0] ?? null;
}

interface Tally {
  ticks: number;
  hits: number;
  recentTicks: number;
  recentHits: number;
  lastHit: string | null;
  winners: Map<string, number>;
}

function newTally(): Tally {
  return { ticks: 0, hits: 0, recentTicks: 0, recentHits: 0, lastHit: null, winners: new Map() };
}

function record(t: Tally, now: number, recentFrom: number, winner: string | null): void {
  t.ticks++;
  const recent = now >= recentFrom;
  if (recent) t.recentTicks++;
  if (!winner) return;
  t.hits++;
  if (recent) t.recentHits++;
  t.lastHit = new Date(now).toISOString().slice(0, 10);
  t.winners.set(winner, (t.winners.get(winner) ?? 0) + 1);
}

function printTally(label: string, t: Tally): void {
  console.log(`  ${label}`);
  console.log(`    all-time: ${t.hits}/${t.ticks} days with a candidate`);
  console.log(`    last ${RECENT_WINDOW_DAYS} days: ${t.recentHits}/${t.recentTicks}   ← judged on this`);
  console.log(`    last day with a candidate: ${t.lastHit ?? 'never'}`);
  const top = [...t.winners.entries()].sort(([, a], [, b]) => b - a).slice(0, 8);
  if (top.length) console.log(`    winners: ${top.map(([k, n]) => `${k}×${n}`).join(', ')}`);
}

async function main(): Promise<void> {
  await initializeMCPClients();
  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.log(`    FAIL  ${msg}`);
  };

  try {
    const { posts, truncated, pages } = await listAllPosts<CandidatePost>({}, { maxPages: 40 });
    if (truncated) {
      console.error('[dryrun] FAIL: the post scan was truncated — results are not conclusive.');
      process.exitCode = 1;
      return;
    }
    const parsed = parseInt(process.env.DEEP_DIVE_MIN_INJURY_COUNT ?? '', 10);
    const minCount = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MIN_COUNT;
    const endMs = Date.now();
    const recentFrom = endMs - RECENT_WINDOW_DAYS * DAY_MS;
    console.log(`[dryrun] scanned ${posts.length} rows over ${pages} page(s); minCount=${minCount}`);
    if (!process.env.DEEP_DIVE_MIN_INJURY_COUNT) {
      console.log('[dryrun] NOTE: DEEP_DIVE_MIN_INJURY_COUNT unset — production sets 3; this run uses the code default.');
    }

    // ── A ────────────────────────────────────────────────────────────────
    console.log('\n── A. DEEP_DIVE census by status (H2) ──');
    const deepDives = posts.filter((p) => p.content_type === 'DEEP_DIVE').sort((a, b) => ts(a) - ts(b));
    const byStatus = new Map<string, number>();
    for (const d of deepDives) byStatus.set(d.status ?? '(null)', (byStatus.get(d.status ?? '(null)') ?? 0) + 1);
    console.log(`  DEEP_DIVE rows, all statuses: ${deepDives.length}`);
    for (const [s, n] of [...byStatus.entries()].sort()) console.log(`    ${s.padEnd(16)} ${n}`);
    for (const d of deepDives) {
      console.log(
        `    ${d.created_at?.slice(0, 10)}  ${(d.status ?? '').padEnd(15)} key=${String(deepDiveCooldownKey(d)).padEnd(10)} ${d.headline?.slice(0, 55) ?? ''}`,
      );
    }
    const sinceMay = deepDives.filter((d) => ts(d) >= Date.parse('2026-05-01T00:00:00Z'));

    // ── B ────────────────────────────────────────────────────────────────
    console.log('\n── B. LEGACY predicate replay — exact injury_type (H1) ──');
    const legacy = newTally();
    for (let now = LAUNCH + DAY_MS; now <= endMs; now += DAY_MS) {
      record(legacy, now, recentFrom, legacyHasCandidate(posts, now, minCount));
    }
    printTally('exact injury_type string', legacy);

    // ── C ────────────────────────────────────────────────────────────────
    console.log('\n── C. Label fragmentation under the canonical key ──');
    const eligible = posts.filter((p) => p.content_type !== 'DEEP_DIVE' && !isRetiredPostStatus(p.status));
    const exact = new Set<string>();
    const perKey = new Map<string, Set<string>>();
    const unmatched = new Map<string, number>();
    for (const p of eligible) {
      const label = p.injury_type?.toLowerCase().trim();
      if (!label) continue;
      exact.add(label);
      const key = canonicalInjuryKey(label);
      if (!key) {
        unmatched.set(label, (unmatched.get(label) ?? 0) + 1);
        continue;
      }
      if (!perKey.has(key)) perKey.set(key, new Set());
      perKey.get(key)!.add(label);
    }
    const unmatchedRows = [...unmatched.values()].reduce((a, b) => a + b, 0);
    console.log(`  eligible rows: ${eligible.length}; distinct labels: ${exact.size} → ${perKey.size} canonical keys`);
    console.log(`  rows mapping to no key (never a candidate): ${unmatchedRows} across ${unmatched.size} labels`);
    for (const [k, set] of [...perKey.entries()].sort(([, a], [, b]) => b.size - a.size).slice(0, 8)) {
      console.log(`    ${k.padEnd(13)} ${String(set.size).padStart(3)} labels`);
    }
    console.log('  most common unmatched labels (review: should any become a key?):');
    for (const [label, n] of [...unmatched.entries()].sort(([, a], [, b]) => b - a).slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)}  ${label}`);
    }

    // ── D ────────────────────────────────────────────────────────────────
    console.log('\n── D. SHIP GATE — replay of the real selectDeepDiveCandidate ──');
    const current = newTally();
    let z2 = 0;
    let z3 = 0;
    let z4 = 0;
    let z5 = 0;
    for (let now = LAUNCH + DAY_MS; now <= endMs; now += DAY_MS) {
      const c: DeepDiveCandidate | null = selectDeepDiveCandidate(posts, { now, minCount });
      record(current, now, recentFrom, c?.canonical_key ?? null);
      if (!c) continue;

      // Z2 — an independent recomputation of the cooldown.
      const cooled = posts.some(
        (p) =>
          p.content_type === 'DEEP_DIVE' &&
          !isRetiredPostStatus(p.status) &&
          ts(p) <= now &&
          now - ts(p) < DEEP_DIVE_COOLDOWN_MS &&
          deepDiveCooldownKey(p) === c.canonical_key,
      );
      if (cooled) z2++;

      // Z3
      if (c.athletes.length !== c.teams.length) z3++;

      // Z4 — every named athlete must appear on a live row in this window and key.
      const live = new Set(
        posts
          .filter(
            (p) =>
              p.content_type !== 'DEEP_DIVE' &&
              !isRetiredPostStatus(p.status) &&
              ts(p) <= now &&
              now - ts(p) < DEEP_DIVE_LOOKBACK_MS &&
              canonicalInjuryKey(p.injury_type) === c.canonical_key,
          )
          .map((p) => p.athlete_name?.trim().toLowerCase()),
      );
      if (c.athletes.some((a) => !live.has(a.toLowerCase()))) z4++;

      // Z5 — `live` is already the distinct-athlete set for this window and key.
      live.delete(undefined);
      if (c.count !== live.size) z5++;
    }
    printTally('canonical key (NEW)', current);

    const z1 = deepDives.filter((d) => !isRetiredPostStatus(d.status) && deepDiveCooldownKey(d) === null).length;

    console.log('\n  gate:');
    console.log(`    non-zero  trailing-${RECENT_WINDOW_DAYS}-day days with a candidate: ${current.recentHits}`);
    if (current.recentHits === 0) fail('the new predicate still finds nothing to write');
    console.log(`    Z1  DEEP_DIVE rows whose cooldown key is null: ${z1}`);
    if (z1 > 0) fail('a live DEEP_DIVE could never hold its cooldown');
    console.log(`    Z2  candidates chosen inside a genuine cooldown: ${z2}`);
    if (z2 > 0) fail('selection ignored an active cooldown');
    console.log(`    Z3  candidates with misaligned athletes/teams: ${z3}`);
    if (z3 > 0) fail('athlete/team pairing is misaligned');
    console.log(`    Z4  candidates naming an athlete seen only on retired rows: ${z4}`);
    if (z4 > 0) fail('a retired report leaked into the athlete list');
    console.log(`    Z5  candidates whose count is not distinct athletes: ${z5}`);
    if (z5 > 0) fail('the "N cases" the agent prints is not a count of athletes');

    // ── E ────────────────────────────────────────────────────────────────
    console.log('\n── E. Projected generation — 72h cadence, cooldown feedback, last 30 days ──');
    const synthetic: CandidatePost[] = [];
    const generated: DeepDiveCandidate[] = [];
    for (let now = recentFrom; now <= endMs; now += SCHEDULER_INTERVAL_MS) {
      const c = selectDeepDiveCandidate([...posts, ...synthetic], { now, minCount });
      if (!c) continue;
      generated.push(c);
      // Every generated DEEP_DIVE routes to MD review and, unless rejected, cools its key.
      synthetic.push({
        content_type: 'DEEP_DIVE',
        status: 'PENDING_REVIEW',
        injury_type: c.injury_type,
        created_at: new Date(now).toISOString(),
      });
    }
    const cycles = Math.floor((endMs - recentFrom) / SCHEDULER_INTERVAL_MS) + 1;
    console.log(`  ${generated.length} DEEP_DIVE(s) across ${cycles} scheduler cycles → ~${generated.length} MD review items / 30 days`);
    for (const g of generated) {
      console.log(`    key=${g.canonical_key.padEnd(10)} n=${g.count}  ${g.sport.padEnd(15)} "${g.injury_type}"`);
    }
    console.log('  (upper bound: assumes no deploy resets the 72h timer and no rejection releases a cooldown early)');

    // ── Verdict ──────────────────────────────────────────────────────────
    console.log('\n── Verdict ──');
    console.log(`  H2 ${sinceMay.length === 0 ? 'ruled out' : 'SUPPORTED'}: ${sinceMay.length} DEEP_DIVE row(s) of any status since May.`);
    console.log(
      `  H1 ${legacy.recentHits === 0 ? 'CONFIRMED' : 'not supported'}: legacy predicate ${legacy.recentHits}/${legacy.recentTicks} recent days (last ${legacy.lastHit ?? 'never'}); ` +
        `new predicate ${current.recentHits}/${current.recentTicks}.`,
    );
    console.log(failures === 0 ? '\nSHIP GATE PASSED' : `\nSHIP GATE FAILED (${failures})`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error(`[dryrun] crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
