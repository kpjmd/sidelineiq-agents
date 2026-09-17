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
 *  7. Closes proposed while the team schedule could not say whether the return
 *     was the first game available (pre-registration Amendment 1, A1.3). The
 *     record depends on that answer; without it the thread must stay ACTIVE.
 *     Schedule failures are injected in Section D alongside gamelog ones, with
 *     the same 404-row / 503-page split.
 *
 * Reported but NOT gates:
 *  - Closes that would produce an unscoreable accuracy_record, split by
 *    reason: no_projection (no PUBLISHED post carries an estimate) and
 *    calendar_censored. Real and worth knowing — the gap between "threads
 *    closed" and "threads counted" — but not a defect in this code.
 *  - Section G, the re-score preview: every detector-closed RESOLVED thread,
 *    its stored record against the record Amendment 1 would write. That is the
 *    list web_thread_reopen would be run over.
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
 *   npx tsx src/scripts/return-detect-dryrun.ts --skip-rescore  # skip section G
 *
 * Read-only. It forces RETURN_DETECT_MODE=shadow regardless of the environment,
 * so no thread is closed, no update is appended and no date-review flag is set.
 * It reads web_list_threads and the public ESPN gamelog and team-schedule
 * endpoints, nothing else.
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll, isServerAvailable } from '../utils/mcp-client-manager.js';
import { callTool } from '../utils/mcp-client-manager.js';
import {
  listActiveThreads,
  decideThread,
  loadGames,
  runReturnDetectCycle,
  minFractionOfMinWeeks,
  predictUnscoreable,
  scoredWindowOf,
  addWeeksIso,
  type DetectorThread,
  type ThreadOutcome,
} from '../monitoring/return-detector.js';
import { hasGamelog } from '../monitoring/sports/espn-gamelog.js';
import { loadCalendarCensoring, type ScheduleCache } from '../monitoring/sports/espn-schedule.js';
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
  /** Only for 'returned': the A1.3 answer, null when the schedule could not say. */
  censored: boolean | null;
}

async function collectDecisions(threads: DetectorThread[], now: Date): Promise<Decision[]> {
  const out: Decision[] = [];
  const cache: ScheduleCache = new Map();
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
    const censored =
      outcome.kind === 'returned'
        ? await loadCalendarCensoring(sport, t.injury_date, outcome.game, cache)
        : null;
    out.push({ thread: t, outcome, seasonLabels: labels, unknownLabels: loaded.unknown_labels, censored });
  }
  return out;
}

/** A stable, comparable fingerprint of one verdict. */
function fingerprint(d: Decision): string {
  const g = d.outcome.kind === 'returned' || d.outcome.kind === 'too_early' ? d.outcome.game.date : '-';
  return `${d.thread.id}|${d.outcome.kind}|${g}|${d.censored}`;
}

async function main(): Promise<void> {
  const now = new Date();
  console.log('\n═══ Return-detect dry run ═══\n');
  console.log(`  as_of: ${now.toISOString()}`);
  console.log(`  too-early bar: ${minFractionOfMinWeeks()} × min_weeks (scored_window, else otm_projection)`);

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
  const found = decisions.filter((d) => d.outcome.kind === 'returned');
  // What the live loop would actually close: a return whose schedule answered.
  const returned = found.filter((d) => d.censored !== null);
  const undecidable = found.filter((d) => d.censored === null);
  const tooEarly = decisions.filter((d) => d.outcome.kind === 'too_early');
  report('threads evaluated against a gamelog', decisions.length);
  report('would close RESOLVED', returned.length,
    returned.map((d) => `${d.thread.athlete_name} ${d.thread.injury_date} → ${(d.outcome as { game: { date: string } }).game.date}`));
  report('no return yet', decisions.filter((d) => d.outcome.kind === 'no_return').length);
  report('returns left ACTIVE: schedule could not answer', undecidable.length,
    undecidable.map((d) => `${d.thread.athlete_name} team=${(d.outcome as { game: { team_id: string | null } }).game.team_id ?? '-'}`));
  report('closes that were the first game available (censored)', returned.filter((d) => d.censored).length);

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

  // Gate 7, over the live loop's own summary rather than this script's
  // filter, so it would catch the loop closing on an unanswered schedule.
  const liveShadow = await runReturnDetectCycle(now);
  const closedUnanswered = Math.max(0, liveShadow.returned - returned.length);
  mustBeZero('closes proposed without a schedule answer', closedUnanswered,
    closedUnanswered ? [`live loop returned=${liveShadow.returned}, answered=${returned.length}`] : []);

  const nonActive = decisions.filter((d) => d.thread.status !== 'ACTIVE' && d.outcome.kind === 'returned');
  mustBeZero('closes proposed for a non-ACTIVE thread', nonActive.length,
    nonActive.map((d) => `${d.thread.id} status=${d.thread.status}`));

  // ── Section D: injected HTTP failures ──────────────────────────────
  // Synthetic on purpose: the live endpoint will not 503 on demand, and this is
  // the property whose failure is worst.
  console.log('\n─── D. Injected HTTP failures ───');
  const realFetch = globalThis.fetch;
  async function cycleUnder(
    status: number,
    target: '/gamelog' | '/schedule' = '/gamelog',
  ): Promise<{ closes: number; aborted: boolean }> {
    // Forward EVERY argument. An earlier version took only the url and dropped
    // the init, which turned the MCP POST into an unauthenticated GET — so the
    // thread listing failed and BOTH injected cycles "aborted", for a reason
    // that had nothing to do with ESPN. The 404 gate caught it, which is the
    // gate working: a detector that aborts on everything is not tolerant, it is
    // broken in the other direction.
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes(target)) {
        return { ok: false, status, json: async () => null } as unknown as Response;
      }
      return realFetch(...args);
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

  // The same split one endpoint over. A schedule 404 is a bad row (that thread
  // stays ACTIVE); a 503 is a bad page. Either way nothing closes.
  const sched503 = await cycleUnder(503, '/schedule');
  const sched404 = await cycleUnder(404, '/schedule');
  mustBeZero('threads that would close under a schedule 503', sched503.closes);
  mustBeZero('threads that would close under a schedule 404', sched404.closes);
  mustBeZero('a schedule 503 that did not abort the cycle', returned.length === 0 || sched503.aborted ? 0 : 1);
  mustBeZero('a schedule 404 that aborted the cycle', sched404.aborted ? 1 : 0);

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
  const reasons = returned.map((d) => ({
    d,
    reason: predictUnscoreable(d.thread, (d.outcome as { game: Parameters<typeof predictUnscoreable>[1] }).game, d.censored === true),
  }));
  for (const r of ['no_projection', 'calendar_censored'] as const) {
    const hit = reasons.filter((x) => x.reason === r);
    report(`closes that would be unscoreable (${r})`, hit.length,
      hit.map((x) => `${x.d.thread.athlete_name} (${x.d.thread.id})`));
  }
  report('closes that would be scored', reasons.filter((x) => !x.reason).length);
  const drift = threads.filter((t) => {
    const a = scoredWindowOf(t);
    const b = t.otm_projection;
    return JSON.stringify(a ? [a.min_weeks, a.max_weeks] : null) !== JSON.stringify(b ? [b.min_weeks, b.max_weeks] : null);
  });
  report('ACTIVE threads whose scored window differs from otm_projection', drift.length,
    drift.map((t) => {
      const a = scoredWindowOf(t);
      const b = t.otm_projection;
      return `${t.athlete_name}: scored=${a ? `${a.min_weeks}-${a.max_weeks}` : '-'} stored=${b ? `${b.min_weeks}-${b.max_weeks}` : '-'}`;
    }));
  report('candidates below the too-early bar → date review', tooEarly.length,
    tooEarly.map((d) => {
      const o = d.outcome as { game: { date: string }; earliest_credible: string };
      return `${d.thread.athlete_name} injury=${d.thread.injury_date} candidate=${o.game.date} earliest=${o.earliest_credible}`;
    }));
  const labels = [...new Set(decisions.flatMap((d) => d.unknownLabels))];
  report('unknown seasonType labels (excluded)', labels.length, labels);
  report('ACTIVE threads with no espn_athlete_id', threads.length - withId,
    threads.filter((t) => !t.espn_athlete_id).map((t) => `${t.athlete_name} (${t.sport})`));

  // ── Section G: re-score preview (Amendment 1, A1.4) ────────────────
  console.log('\n─── G. Re-score preview: detector closes under Amendment 1 ───');
  if (has('--skip-rescore')) {
    report('skipped (--skip-rescore)', '-');
  } else {
    await rescorePreview(now);
  }

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

interface ClosedThread extends DetectorThread {
  return_source?: string | null;
  accuracy_record?: {
    scoreable?: boolean;
    within_range?: boolean | null;
    unscoreable_reason?: string;
  } | null;
}

/**
 * Predict, for every RESOLVED thread the detector closed, what Amendment 1
 * would write. Read-only: it replays the gamelog and schedule for the stored
 * actual_return_date. The prediction mirrors computeAccuracyRecord and is for
 * reading only — the reopen-and-reclose it previews goes through the mcp.
 */
async function rescorePreview(now: Date): Promise<void> {
  const closed: ClosedThread[] = [];
  for (const sport of ['NFL', 'NBA']) {
    let offset = 0;
    for (;;) {
      const raw = await callTool('web', 'web_list_threads', { status: 'RESOLVED', sport, limit: 100, offset });
      const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
      const page = text ? (JSON.parse(text) as { threads: ClosedThread[]; has_more?: boolean; next_offset?: number | null }) : null;
      if (!page) break;
      closed.push(...page.threads.filter((t) => t.return_source === 'detector'));
      if (!page.has_more || page.next_offset == null || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
  }
  const cache: ScheduleCache = new Map();
  const changes: string[] = [];
  let oldScored = 0;
  let oldWithin = 0;
  let newScored = 0;
  let newWithin = 0;
  let undecided = 0;
  for (const t of closed) {
    const rec = t.accuracy_record ?? null;
    const wasScored = rec?.scoreable ?? rec?.within_range != null;
    if (wasScored) oldScored++;
    if (rec?.within_range === true) oldWithin++;

    const sport = t.sport as 'NFL' | 'NBA';
    const ret = t.actual_return_date ? String(t.actual_return_date).slice(0, 10) : null;
    if (!t.injury_date || !t.espn_athlete_id || !ret) {
      undecided++;
      changes.push(`${t.athlete_name}: cannot replay (missing date or id)`);
      continue;
    }
    const today = localCalendarDate(now, sport).date;
    const loaded = await loadGames(sport, t.espn_athlete_id, t.injury_date, today);
    const game = loaded?.games.find((g) => g.date === ret);
    const censored = game ? await loadCalendarCensoring(sport, t.injury_date, game, cache) : null;
    if (!game || censored === null) {
      undecided++;
      changes.push(`${t.athlete_name}: return ${ret} not re-derivable (game=${!!game}, censored=${censored})`);
      continue;
    }
    const reason = predictUnscoreable(t, game, censored);
    const win = scoredWindowOf(t);
    let within: boolean | null = null;
    if (!reason && win && typeof win.min_weeks === 'number' && typeof win.max_weeks === 'number') {
      within = ret >= addWeeksIso(t.injury_date, win.min_weeks) && ret <= addWeeksIso(t.injury_date, win.max_weeks);
      newScored++;
      if (within) newWithin++;
    }
    const before = wasScored ? `within=${rec?.within_range}` : `unscoreable(${rec?.unscoreable_reason ?? '?'})`;
    const after = reason ? `unscoreable(${reason})` : `within=${within}`;
    if (before !== after) {
      changes.push(
        `${t.athlete_name} (${t.id.slice(0, 8)}): ${before} → ${after}  ` +
          `window=${win ? `${win.min_weeks}-${win.max_weeks}` : '-'} censored=${censored}`,
      );
    }
  }
  report('detector-closed RESOLVED threads', closed.length);
  report('stored: within_range', `${oldWithin} of ${oldScored} scoreable`);
  report('Amendment 1: within_range', `${newWithin} of ${newScored} scoreable`);
  report('not re-derivable (would stay as-is if reopened: check by hand)', undecided);
  report('records that would change', changes.length, changes.slice(0, 40));
  for (const c of changes.slice(8)) console.log(`          ${c}`);
}

main()
  .catch((err) => {
    console.error(`\n  dry run crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectAll().catch(() => {});
  });
