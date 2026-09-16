/**
 * Ship gate for the return detector (monetization plan, Phase 2).
 *
 * The detector closes injury threads, and a close is the least reversible write
 * this system makes: it takes the thread out of web_find_matching_entity, it
 * freezes an accuracy_record that a public number will eventually be computed
 * from, and the only way back is a human calling web_thread_reopen. So the
 * verdicts get replayed against the LIVE corpus and the live ESPN endpoint
 * before the mode is ever moved off shadow.
 *
 * THE NUMBERS THAT MUST BE ZERO (this script exits 1 on any of them):
 *
 *  1. Returns dated on or before the thread's injury_date. The athlete has a
 *     stat line for the game he was hurt IN, so an off-by-one here dates every
 *     in-game injury's recovery to the day it happened.
 *  2. Returns drawn from a non-regular-season split. Preseason games sit in the
 *     same flat `events` map as regular-season ones, and NBA's categories are
 *     named after MONTHS rather than carrying NFL's splitType of "2" — a
 *     parser that keys on the wrong field either counts an August look-see as a
 *     comeback or returns nothing at all for a whole sport.
 *  3. Threads that would close under an injected HTTP failure. ESPN rate-limits
 *     by dropping a CONTIGUOUS BLOCK of requests, so a 429 read as "these
 *     athletes played no games" closes a run of threads with no return at all.
 *     Both a 404 (a bad ROW: skip it) and a 503 (a bad PAGE: abort) are
 *     injected, and the split between them is asserted — a detector that
 *     aborted on everything would pass a 503-only check while being useless.
 *  4. Existing actual_return_date values that would be overwritten. Every one
 *     of those was typed by a person (migration 025 backfills return_source to
 *     'md' for exactly that reason).
 *  5. Closes proposed for a thread that is not ACTIVE.
 *  6. Decisions that differ across two runs over the same corpus. The whole
 *     point of game participation over a status designation is that it is an
 *     event; if the answer moves between passes, it is not.
 *
 * Reported but NOT gates:
 *  - Closes that would produce an unscoreable accuracy_record (no
 *    otm_projection). Real and worth knowing — it is the gap between "threads
 *    closed" and "threads counted" — but a thread with no projection is an old
 *    row, not a defect in this code.
 *  - Candidates below the too-early bar. These are date bugs the detector
 *    correctly declines to act on; a non-zero count is the feature working.
 *  - Unknown seasonType labels. Excluded by the parser and surfaced here so a
 *    new ESPN split is found in a log line rather than in a wrong number.
 *  - ACTIVE threads with no espn_athlete_id, as a coverage rate. A collapse
 *    here means roster sync, not this module.
 *
 * Usage:
 *   npx tsx src/scripts/return-detect-dryrun.ts
 *   npx tsx src/scripts/return-detect-dryrun.ts --limit 20      # quick pass
 *   npx tsx src/scripts/return-detect-dryrun.ts --skip-replay   # skip gate 6
 *
 * Read-only. It forces RETURN_DETECT_MODE=shadow regardless of the environment,
 * so no thread is closed, no update is appended and no date-review flag is set.
 * It reads web_list_threads and the public ESPN gamelog endpoint, nothing else.
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll, isServerAvailable } from '../utils/mcp-client-manager.js';
import {
  listActiveThreads,
  decideThread,
  loadGames,
  runReturnDetectCycle,
  minFractionOfMinWeeks,
  type DetectorThread,
  type ThreadOutcome,
} from '../monitoring/return-detector.js';
import { hasGamelog } from '../monitoring/sports/espn-gamelog.js';
import { localCalendarDate } from '../agents/injury-intelligence/season-calendar.js';
import type { SportKey } from '../types.js';

// Writes are impossible from here by construction, not by convention.
process.env.RETURN_DETECT_MODE = 'shadow';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => argv.includes(name);

const failures: string[] = [];
function mustBeZero(label: string, count: number, examples: string[] = []): void {
  const ok = count === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${count}`);
}
function report(label: string, count: number | string, examples: string[] = []): void {
  console.log(`  ---   ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
}

interface Decision {
  thread: DetectorThread;
  outcome: ThreadOutcome;
  seasonLabels: string[];
  unknownLabels: string[];
}

async function collectDecisions(threads: DetectorThread[], now: Date): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const t of threads) {
    const sport = t.sport ?? '';
    if (!hasGamelog(sport) || !t.espn_athlete_id || !t.injury_date) continue;
    const today = localCalendarDate(now, sport as SportKey).date;
    const loaded = await loadGames(sport, t.espn_athlete_id, t.injury_date, today);
    if (!loaded) continue;
    const outcome = decideThread(t, loaded.games);
    const labels =
      outcome.kind === 'returned' || outcome.kind === 'too_early'
        ? [outcome.game.season_type_label]
        : [];
    out.push({ thread: t, outcome, seasonLabels: labels, unknownLabels: loaded.unknown_labels });
  }
  return out;
}

/** A stable, comparable fingerprint of one verdict. */
function fingerprint(d: Decision): string {
  const g = d.outcome.kind === 'returned' || d.outcome.kind === 'too_early' ? d.outcome.game.date : '-';
  return `${d.thread.id}|${d.outcome.kind}|${g}`;
}

async function main(): Promise<void> {
  const now = new Date();
  console.log('\n═══ Return-detect dry run ═══\n');
  console.log(`  as_of: ${now.toISOString()}`);
  console.log(`  too-early bar: ${minFractionOfMinWeeks()} × otm_projection.min_weeks`);

  await initializeMCPClients();
  if (!isServerAvailable('web')) {
    console.error('  web MCP is unavailable — cannot read the corpus.');
    process.exitCode = 1;
    return;
  }

  // ── Section A: the corpus ──────────────────────────────────────────
  const all = await listActiveThreads();
  const limitRaw = flag('--limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : null;
  const threads = limit && Number.isFinite(limit) ? all.slice(0, limit) : all;

  console.log('\n─── A. Corpus ───');
  report('ACTIVE NFL/NBA threads', all.length);
  if (limit) report('limited to', threads.length);
  const withId = threads.filter((t) => t.espn_athlete_id).length;
  const withDate = threads.filter((t) => t.injury_date).length;
  report(
    'resolvable to an ESPN athlete',
    `${withId}/${threads.length}` + (threads.length ? ` (${Math.round((withId / threads.length) * 100)}%)` : ''),
  );
  report('carrying an injury_date', `${withDate}/${threads.length}`);
  report(
    'already carrying an actual_return_date',
    threads.filter((t) => t.actual_return_date).length,
  );

  // ── Section B: verdicts over the live corpus ───────────────────────
  console.log('\n─── B. Verdicts (live ESPN) ───');
  const decisions = await collectDecisions(threads, now);
  const returned = decisions.filter((d) => d.outcome.kind === 'returned');
  const tooEarly = decisions.filter((d) => d.outcome.kind === 'too_early');
  report('threads evaluated against a gamelog', decisions.length);
  report('would close RESOLVED', returned.length,
    returned.map((d) => `${d.thread.athlete_name} ${d.thread.injury_date} → ${(d.outcome as { game: { date: string } }).game.date}`));
  report('no return yet', decisions.filter((d) => d.outcome.kind === 'no_return').length);

  // ── Section C: the gates ───────────────────────────────────────────
  console.log('\n─── C. Gates ───');

  const onOrBefore = returned.filter((d) => {
    const g = (d.outcome as { game: { date: string } }).game;
    return !!d.thread.injury_date && g.date <= d.thread.injury_date;
  });
  mustBeZero('returns dated on or before injury_date', onOrBefore.length,
    onOrBefore.map((d) => `${d.thread.id} ${d.thread.athlete_name}`));

  const nonRegular = decisions.filter((d) =>
    d.seasonLabels.some((l) => !/regular season/i.test(l)),
  );
  mustBeZero('returns from a non-regular-season split', nonRegular.length,
    nonRegular.map((d) => `${d.thread.athlete_name}: ${d.seasonLabels.join(',')}`));

  const wouldOverwrite = decisions.filter(
    (d) => d.thread.actual_return_date && d.outcome.kind === 'returned',
  );
  mustBeZero('existing actual_return_date values that would be overwritten', wouldOverwrite.length,
    wouldOverwrite.map((d) => `${d.thread.id} stored=${d.thread.actual_return_date}`));

  const nonActive = decisions.filter((d) => d.thread.status !== 'ACTIVE' && d.outcome.kind === 'returned');
  mustBeZero('closes proposed for a non-ACTIVE thread', nonActive.length,
    nonActive.map((d) => `${d.thread.id} status=${d.thread.status}`));

  // ── Section D: injected HTTP failures ──────────────────────────────
  // Synthetic on purpose: the live endpoint will not 503 on demand, and this is
  // the property whose failure is worst.
  console.log('\n─── D. Injected HTTP failures ───');
  const realFetch = globalThis.fetch;
  async function cycleUnder(status: number): Promise<{ closes: number; aborted: boolean }> {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('/gamelog')) {
        return { ok: false, status, json: async () => null } as unknown as Response;
      }
      return realFetch(url as never);
    }) as typeof fetch;
    try {
      const summary = await runReturnDetectCycle(now);
      return { closes: summary.returned, aborted: summary.aborted };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const under503 = await cycleUnder(503);
  const under404 = await cycleUnder(404);
  mustBeZero('threads that would close under a 503', under503.closes);
  mustBeZero('threads that would close under a 404', under404.closes);
  // The split itself: a detector that aborted on EVERYTHING would pass the two
  // counts above while being unable to tolerate one retired athlete id.
  mustBeZero('a 503 that did not abort the cycle', under503.aborted ? 0 : 1);
  mustBeZero('a 404 that aborted the cycle', under404.aborted ? 1 : 0);

  // ── Section E: replay ──────────────────────────────────────────────
  console.log('\n─── E. Replay ───');
  if (has('--skip-replay')) {
    report('skipped (--skip-replay)', 'gate 6 not evaluated');
    failures.push('replay gate skipped');
  } else {
    const second = await collectDecisions(threads, now);
    const a = new Set(decisions.map(fingerprint));
    const b = new Set(second.map(fingerprint));
    const drifted = [...a].filter((f) => !b.has(f)).concat([...b].filter((f) => !a.has(f)));
    mustBeZero('decisions that differ across two runs', drifted.length, drifted);
  }

  // ── Section F: reported, not gated ─────────────────────────────────
  console.log('\n─── F. Reported, not gated ───');
  const unscoreable = returned.filter(
    (d) => !d.thread.otm_projection || typeof d.thread.otm_projection.min_weeks !== 'number',
  );
  report('closes that would be unscoreable (no otm_projection)', unscoreable.length,
    unscoreable.map((d) => `${d.thread.athlete_name} (${d.thread.id})`));
  report('candidates below the too-early bar → date review', tooEarly.length,
    tooEarly.map((d) => {
      const o = d.outcome as { game: { date: string }; earliest_credible: string };
      return `${d.thread.athlete_name} injury=${d.thread.injury_date} candidate=${o.game.date} earliest=${o.earliest_credible}`;
    }));
  const labels = [...new Set(decisions.flatMap((d) => d.unknownLabels))];
  report('unknown seasonType labels (excluded)', labels.length, labels);
  report('ACTIVE threads with no espn_athlete_id', threads.length - withId,
    threads.filter((t) => !t.espn_athlete_id).map((t) => `${t.athlete_name} (${t.sport})`));

  console.log('\n═══ Verdict ═══\n');
  if (failures.length === 0) {
    console.log('  PASS — every gated number is zero.\n');
  } else {
    console.log('  FAIL');
    for (const f of failures) console.log(`    ${f}`);
    console.log('');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`\n  dry run crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectAll().catch(() => {});
  });
