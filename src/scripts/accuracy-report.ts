/**
 * The accuracy number, in the pre-registration's own terms. Read-only.
 *
 * docs/accuracy-preregistration.md fixes what is counted and how it may be
 * shown; this prints exactly that and nothing it does not define:
 *
 *   - HEADLINE: "Returns inside the published window: X of Y" (within_range).
 *     Never MAE — MAE scores a call inside the window as an error.
 *   - Median signed error in days, with ITS OWN n.
 *   - The window-width distribution, beside the headline.
 *   - Every exclusion, by reason, counted. A denominator that quietly drops the
 *     hard cases is the failure the file exists to prevent.
 *   - Amendment 2 (A2.1): one return is one observation. Collapsed groups are
 *     listed so the collapse can be checked by hand.
 *
 * Scope is NFL + NBA (the pre-registration's), RESOLVED + RETIRED threads.
 * VOID is excluded by definition; ACTIVE has not closed.
 *
 * Publication rules are printed, not enforced: no number below n = 20 leaves
 * the admin view, G1 (the kill switch) is evaluable only at n ≥ 30, and a page
 * that publishes one carries these definitions beside it. (skills/ was signed
 * off by the physician founder on 2026-10-03.)
 *
 * Usage:
 *   npx tsx src/scripts/accuracy-report.ts
 *   npx tsx src/scripts/accuracy-report.ts --json
 *   npx tsx src/scripts/accuracy-report.ts --emit-fixture --out=<path>
 *
 * --emit-fixture RECORDS the live rows (reduced to the fields the helper reads)
 * and the helper's summary of them as one `source: "live"` case, for
 * tests/fixtures/accuracy-observation-cases.json in both repos. Fixtures in
 * this repo are recorded, never hand-written for live shapes.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import {
  summarizeAccuracy,
  ACCURACY_OBSERVATIONS_VERSION,
  type ObservationThread,
  type AccuracySummary,
} from '../utils/accuracy-observations.js';

const PUBLISH_FLOOR = 20;
const G1_FLOOR = 30;
const SPORTS = ['NFL', 'NBA'] as const;
const STATUSES = ['RESOLVED', 'RETIRED'] as const;

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

type Row = ObservationThread & { sport?: string | null };

async function listClosed(): Promise<Row[]> {
  const byId = new Map<string, Row>();
  for (const status of STATUSES) {
    for (const sport of SPORTS) {
      let offset = 0;
      for (;;) {
        const raw = await callTool('web', 'web_list_threads', { status, sport, limit: 500, offset });
        if (isMCPError(raw)) throw new Error(`web_list_threads failed: ${extractMCPErrorMessage(raw)}`);
        const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
        if (!text) throw new Error('web_list_threads returned no content');
        const page = JSON.parse(text) as { threads: Row[]; has_more?: boolean; next_offset?: number | null };
        for (const t of page.threads) byId.set(t.id, t);
        if (!page.has_more || page.next_offset == null || page.next_offset <= offset) break;
        offset = page.next_offset;
      }
    }
  }
  return [...byId.values()];
}

/** Only the fields the helper reads — what a fixture should carry. */
function reduce(t: Row): ObservationThread {
  const r = t.accuracy_record;
  return {
    id: t.id,
    player_id: t.player_id,
    status: t.status,
    sport: t.sport ?? null,
    athlete_name: t.athlete_name ?? null,
    first_reported_at: t.first_reported_at ?? null,
    actual_return_date: t.actual_return_date ? String(t.actual_return_date).slice(0, 10) : null,
    accuracy_record: r
      ? {
          ...('scoreable' in r ? { scoreable: r.scoreable } : {}),
          within_range: r.within_range ?? null,
          error_days: r.error_days ?? null,
          unscoreable_reason: r.unscoreable_reason ?? null,
          otm_min_weeks: r.otm_min_weeks ?? null,
          otm_max_weeks: r.otm_max_weeks ?? null,
          censored: r.censored ?? null,
        }
      : null,
  };
}

function expectOf(s: AccuracySummary) {
  return {
    within: s.within,
    n: s.n,
    excluded_by_reason: s.excluded_by_reason,
    collapsed: s.collapsed.length,
    legacy: s.legacy,
    signed_error_median: s.signed_error_days.median,
    signed_error_n: s.signed_error_days.n,
    window_weeks_median: s.window_weeks.median,
    observation_ids: s.observations.map((o) => o.thread_id).sort(),
  };
}

function fmt(n: number | null): string {
  return n === null ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(1);
}

async function main(): Promise<void> {
  await initializeMCPClients();
  if (!isServerAvailable('web')) {
    console.error('web MCP is unavailable — cannot read the corpus.');
    process.exitCode = 1;
    return;
  }
  const rows = await listClosed();
  const s = summarizeAccuracy(rows);
  const asOf = new Date().toISOString();

  if (has('--emit-fixture')) {
    const out = opt('--out');
    if (!out) throw new Error('--emit-fixture needs --out=<path>');
    const reduced = rows.map(reduce).sort((a, b) => (a.id < b.id ? -1 : 1));
    const live = summarizeAccuracy(reduced);
    writeFileSync(
      out,
      JSON.stringify(
        {
          name: `live corpus ${asOf.slice(0, 10)} (NFL+NBA RESOLVED+RETIRED)`,
          source: 'live',
          recorded_at: asOf,
          helper_version: ACCURACY_OBSERVATIONS_VERSION,
          threads: reduced,
          expect: expectOf(live),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`wrote ${reduced.length} rows to ${out}`);
    return;
  }

  if (has('--json')) {
    console.log(JSON.stringify({ as_of: asOf, ...s }, null, 2));
    return;
  }

  const pct = s.n > 0 ? ` (${Math.round((s.within / s.n) * 100)}%)` : '';
  console.log('\n═══ Accuracy — pre-registered definitions (docs/accuracy-preregistration.md) ═══\n');
  console.log(`  as_of: ${asOf}   scope: NFL+NBA, RESOLVED+RETIRED   helper v${ACCURACY_OBSERVATIONS_VERSION}`);
  console.log(`\n  Returns inside the published window: ${s.within} of ${s.n}${pct}`);
  if (s.n < PUBLISH_FLOOR) {
    console.log(`\n  NOT PUBLISHABLE — n=${s.n} is below the n≈${PUBLISH_FLOOR} floor. Do not quote this number.`);
  } else if (s.n < G1_FLOOR) {
    console.log(`\n  Below the n≥${G1_FLOOR} publish/kill decision. Private reading only.`);
  } else {
    console.log(`\n  G1 evaluable (n≥${G1_FLOOR}): kill switch fires below ~50%.`);
  }

  console.log('\n─── Secondary ───');
  const e = s.signed_error_days;
  console.log(`  median signed error: ${fmt(e.median)} days (n=${e.n}, range ${fmt(e.min)} to ${fmt(e.max)})`);
  const w = s.window_weeks;
  console.log(`  window width: median ${fmt(w.median)} weeks (n=${w.n}, range ${fmt(w.min)}–${fmt(w.max)})`);
  console.log(`  scored returns that were calendar-censored misses: ${s.observations.filter((o) => o.censored === true).length}`);

  console.log('\n─── Excluded (counted per return) ───');
  console.log(`  closed threads read: ${s.closed_threads}  →  returns: ${s.n + s.exclusions.length}`);
  if (s.out_of_scope > 0) console.log(`  out of scope (not NFL/NBA): ${s.out_of_scope}`);
  for (const [reason, count] of Object.entries(s.excluded_by_reason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(24)} ${count}`);
  }

  console.log('\n─── Amendment 2 (A2.1): threads collapsed into one return ───');
  if (s.collapsed.length === 0) console.log('  none');
  for (const c of s.collapsed) {
    console.log(`  ${c.athlete_name ?? '?'} return=${c.actual_return_date ?? '-'}  threads=${c.thread_ids.map((id) => id.slice(0, 8)).join(', ')}`);
  }

  console.log('\n─── Legacy records (pre-2026-09-15, verdict derived from within_range) ───');
  const legacy = s.observations.filter((o) => o.legacy);
  if (legacy.length === 0) console.log('  none');
  for (const o of legacy) console.log(`  ${o.athlete_name ?? '?'} (${o.thread_id.slice(0, 8)}) within_range=${o.within_range}`);

  console.log('\n─── Scored returns ───');
  for (const o of [...s.observations].sort((a, b) => String(a.actual_return_date).localeCompare(String(b.actual_return_date)))) {
    console.log(
      `  ${(o.athlete_name ?? '?').padEnd(22)} return=${o.actual_return_date}  ` +
        `${o.within_range ? 'IN ' : 'OUT'}  err=${fmt(o.error_days)}d  width=${fmt(o.window_weeks)}w` +
        `${o.censored ? '  censored' : ''}${o.legacy ? '  LEGACY' : ''}${o.member_ids.length > 1 ? `  (${o.member_ids.length} threads)` : ''}`,
    );
  }

  console.log(
    '\n  Governance: skills/SKILL.md and its 6 reference files were signed off by the physician founder\n' +
      '  on 2026-10-03. A public page still publishes these definitions, unchanged, beside the number.\n',
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
