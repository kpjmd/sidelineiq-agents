import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { maybeProposeReturnWatch } from './return-watch.js';
import { fetchEspnJson, TransientEspnError } from './sports/espn-json.js';
import {
  buildGamelogUrl,
  firstGameAfter,
  gamelogSeasonsFor,
  hasGamelog,
  parseRegularSeasonGames,
  type GamelogGame,
} from './sports/espn-gamelog.js';
import { localCalendarDate } from '../agents/injury-intelligence/season-calendar.js';
import type { SportKey } from '../types.js';

/**
 * Closes an injury thread when the athlete plays again.
 *
 * This is the one write that gives the platform a track record: `within_range`
 * — "did the athlete return inside the window OTM published?" — is computed at
 * close, and nothing closed threads, so the number did not exist. Gate G1 (the
 * thesis kill switch) is unevaluable until this runs.
 *
 * **The signal is game participation, not an availability designation.** ESPN's
 * `status` is a STATE, not a DELTA — CLAUDE.md settles that twice — and an
 * `Active` row sometimes carries a comment about a TEAMMATE. A stat line in a
 * completed regular-season game is an EVENT, a reader can verify it, and
 * because the gamelog lists only games the athlete recorded a stat line in, a
 * player who dressed and took no snaps is MISSED rather than INVENTED.
 *
 * **Not inside pollSport.** That loop carries PublishBudgetState, so a
 * cap-exhausted cycle would silently skip returns, and it is feed-driven and
 * therefore structurally blind to threads that have stopped generating events —
 * which is precisely the population that has returned.
 *
 * **RETURN_DETECT_MODE=off|shadow|on, default shadow.** Shadow decides and logs
 * and changes nothing, including the cases that look obviously safe. Same
 * convention and same reasoning as ATHLETE_REANCHOR_MODE.
 *
 * Failure policy, inherited from espn-json.ts and non-negotiable here: a 404 is
 * a bad ROW (skip that athlete, count it); a timeout, 429 or 5xx is a bad PAGE
 * (abort the cycle, leave every thread ACTIVE). ESPN rate-limits by dropping a
 * contiguous block of requests, so a rate limit read as "these athletes played
 * no games" would close a RUN of threads with no return at all — and a close is
 * only reversible by a human calling web_thread_reopen.
 *
 * Deliberately unreachable, and stated here so nobody "completes" the design
 * with it: ESPN's `details.returnDate`. It is a lapsed ESTIMATE — 64 of 111
 * live rows carried one dated BEFORE the row itself — and it is an opinion
 * about the future, which is the exact thing this module exists to check.
 */

export type ReturnDetectMode = 'off' | 'shadow' | 'on';

export function returnDetectMode(): ReturnDetectMode {
  const raw = (process.env.RETURN_DETECT_MODE ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'on' ? raw : 'shadow';
}

/**
 * How much of the literature MINIMUM must elapse before a stat line is read as
 * a return rather than as evidence the injury date is wrong.
 *
 * A gamelog entry two days after a "torn ACL" means one of the two facts is
 * wrong, and the date is overwhelmingly the likelier one — the resolver picks
 * it from prose, the feed re-stamps it, and CLAUDE.md documents a whole class
 * of carryover injuries dated to the day they were reported. Closing on that
 * would record a 39-week projection as having resolved in 48 hours.
 */
const DEFAULT_MIN_FRACTION = 0.5;

export function minFractionOfMinWeeks(): number {
  const raw = process.env.RETURN_MIN_FRACTION_OF_MIN_WEEKS;
  if (!raw) return DEFAULT_MIN_FRACTION;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_MIN_FRACTION;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3 * 60 * 1000;
const PAGE_LIMIT = 500;
const SPORTS: readonly SportKey[] = ['NFL', 'NBA'];

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function getIntervalMs(): number {
  const raw = process.env.RETURN_DETECT_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The subset of a thread row this module reads. */
export interface DetectorThread {
  id: string;
  athlete_name: string | null;
  sport: string | null;
  status: string;
  injury_date: string | null;
  actual_return_date: string | null;
  espn_athlete_id?: string | null;
  otm_projection?: { min_weeks?: number | null; max_weeks?: number | null } | null;
}

export type ThreadOutcome =
  | { kind: 'returned'; game: GamelogGame }
  | { kind: 'too_early'; game: GamelogGame; earliest_credible: string }
  | { kind: 'no_return' }
  | { kind: 'skipped'; reason: SkipReason };

export type SkipReason =
  | 'not_active'
  | 'sport_unsupported'
  | 'no_espn_athlete_id'
  | 'no_injury_date'
  | 'already_returned'
  | 'athlete_not_found';

export interface ReturnDetectSummary {
  mode: ReturnDetectMode;
  threads: number;
  by_sport: Record<string, number>;
  returned: number;
  date_review: number;
  no_return: number;
  skipped: Record<SkipReason, number>;
  unscoreable: number;
  unknown_labels: string[];
  errors: number;
  aborted: boolean;
  abort_reason: string | null;
  decisions: Array<{ thread: DetectorThread; outcome: ThreadOutcome }>;
}

function emptySummary(mode: ReturnDetectMode): ReturnDetectSummary {
  return {
    mode,
    threads: 0,
    by_sport: {},
    returned: 0,
    date_review: 0,
    no_return: 0,
    skipped: {
      not_active: 0,
      sport_unsupported: 0,
      no_espn_athlete_id: 0,
      no_injury_date: 0,
      already_returned: 0,
      athlete_not_found: 0,
    },
    unscoreable: 0,
    unknown_labels: [],
    errors: 0,
    aborted: false,
    abort_reason: null,
    decisions: [],
  };
}

function unwrap<T>(raw: unknown): T | null {
  if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
  const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text) as T;
}

/**
 * Every ACTIVE thread for the sports we can read, paged.
 *
 * Pages rather than asserting a single page is the whole answer: the two
 * in-repo callers of web_list_threads still throw at the limit, from before the
 * tool grew offset paging. De-duped by id because offset paging over the
 * non-unique `last_updated_at DESC` sort can repeat a row at a page boundary.
 */
export async function listActiveThreads(sports: readonly SportKey[] = SPORTS): Promise<DetectorThread[]> {
  const byId = new Map<string, DetectorThread>();
  for (const sport of sports) {
    let offset = 0;
    for (;;) {
      const page = unwrap<{ threads: DetectorThread[]; next_offset: number | null; has_more: boolean }>(
        await callTool('web', 'web_list_threads', { status: 'ACTIVE', sport, limit: PAGE_LIMIT, offset }),
      );
      if (!page) break;
      for (const t of page.threads ?? []) byId.set(t.id, t);
      if (!page.has_more || page.next_offset == null || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
  }
  return [...byId.values()];
}

/** injury_date plus `weeks` weeks, as a local ISO date. Pure. */
export function addWeeksIso(iso: string, weeks: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(weeks * 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Decide one thread against its gamelog. Pure — no I/O, no writes — so the dry
 * run and the live loop reach the same verdict from the same inputs.
 */
export function decideThread(thread: DetectorThread, games: GamelogGame[]): ThreadOutcome {
  if (thread.status !== 'ACTIVE') return { kind: 'skipped', reason: 'not_active' };
  if (!thread.injury_date) return { kind: 'skipped', reason: 'no_injury_date' };
  if (thread.actual_return_date) return { kind: 'skipped', reason: 'already_returned' };

  const game = firstGameAfter(games, thread.injury_date);
  if (!game) return { kind: 'no_return' };

  const minWeeks = thread.otm_projection?.min_weeks;
  if (typeof minWeeks === 'number' && Number.isFinite(minWeeks) && minWeeks > 0) {
    const earliest = addWeeksIso(thread.injury_date, minWeeks * minFractionOfMinWeeks());
    if (game.date < earliest) {
      return { kind: 'too_early', game, earliest_credible: earliest };
    }
  }
  return { kind: 'returned', game };
}

/**
 * Fetch and parse every regular-season game for one athlete across the seasons
 * an injury spans.
 *
 * Returns null for an athlete ESPN does not know (404 — a bad ROW). Throws
 * TransientEspnError upward for anything else, which aborts the cycle.
 */
export async function loadGames(
  sport: 'NFL' | 'NBA',
  espnAthleteId: string,
  injuryDateIso: string,
  today: string,
): Promise<{ games: GamelogGame[]; unknown_labels: string[] } | null> {
  const games: GamelogGame[] = [];
  const unknown = new Set<string>();
  let anyFound = false;

  for (const season of gamelogSeasonsFor(sport, injuryDateIso, today)) {
    const body = await fetchEspnJson(buildGamelogUrl(sport, espnAthleteId, season));
    if (body === null) continue; // 404 for this season only.
    anyFound = true;
    const parsed = parseRegularSeasonGames(body, sport);
    games.push(...parsed.games);
    for (const l of parsed.unknown_labels) unknown.add(l);
  }

  if (!anyFound) return null;
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { games, unknown_labels: [...unknown] };
}

/**
 * Record a detected return.
 *
 * **Emit order is the reverse of intuition and load-bearing.** The RESOLUTION
 * update goes FIRST: maybeProposeReturnWatch fires off the append path, and
 * web_thread_close takes the thread out of matching — close first and the
 * "first game back" Desk follow-up is never proposed. `isReturnWatchWorthy` has
 * accepted 'RESOLUTION' since it was written and nothing has ever emitted one;
 * this is its first producer.
 */
async function recordReturn(thread: DetectorThread, game: GamelogGame): Promise<void> {
  const description =
    `Returned to game action: ${game.date} vs ${game.opponent ?? 'opponent'}` +
    (game.week ? ` (week ${game.week})` : '') +
    '. First regular-season game with a recorded stat line after the injury date.';

  const appended = await callTool('web', 'web_append_injury_update', {
    entity_id: thread.id,
    update_kind: 'RESOLUTION',
    ...(game.url ? { source_url: game.url } : {}),
    description: description.slice(0, 500),
  });
  if (isMCPError(appended)) {
    throw new Error(`append RESOLUTION failed: ${extractMCPErrorMessage(appended)}`);
  }

  // Never fatal: a missed Desk candidate must not block the close.
  try {
    await maybeProposeReturnWatch(thread.id, 'RESOLUTION', {
      athleteName: thread.athlete_name ?? 'Unknown athlete',
      sport: (thread.sport as SportKey) ?? 'NFL',
      sourceUrl: game.url,
    });
  } catch (err) {
    console.warn(`[ReturnDetect] ${thread.id} — Return Watch proposal failed: ${errorMessage(err)}`);
  }

  const closed = await callTool('web', 'web_thread_close', {
    entity_id: thread.id,
    actual_return_date: game.date,
    outcome: 'RESOLVED',
    // Must be the literal 'system': any other value stamps the audit actor as a
    // physician, and subjects nothing to the system-caller guards.
    closed_by: 'system',
    return_source: 'detector',
  });
  if (isMCPError(closed)) {
    throw new Error(`close failed: ${extractMCPErrorMessage(closed)}`);
  }

  // Read back rather than trusting the write's echo — the same rule
  // void-thread.ts follows, and the md-guard can refuse part of a write.
  const readBack = unwrap<{ entity?: { status?: string; actual_return_date?: string | null } }>(
    await callTool('web', 'web_thread_get', { entity_id: thread.id }),
  );
  const status = readBack?.entity?.status;
  if (status !== 'RESOLVED') {
    throw new Error(`close did not stick: thread is ${status ?? 'unreadable'}`);
  }
}

/**
 * A return that arrived impossibly early is evidence about the DATE. Flag the
 * thread for the MD's existing date-review view and leave it ACTIVE — closing
 * it would freeze a wrong injury_date into an accuracy record.
 */
async function flagDateReview(
  thread: DetectorThread,
  game: GamelogGame,
  earliest: string,
): Promise<void> {
  const res = await callTool('web', 'web_thread_update_dates', {
    entity_id: thread.id,
    needs_date_review: true,
    updated_by: 'system',
  });
  if (isMCPError(res)) throw new Error(`date-review flag failed: ${extractMCPErrorMessage(res)}`);

  try {
    await callTool('web', 'web_audit_append', {
      actor: 'system',
      actor_id: 'return-detector',
      entity_type: 'injury_thread',
      entity_id: thread.id,
      action: 'return_before_credible_window',
      payload: {
        injury_date: thread.injury_date,
        candidate_return_date: game.date,
        earliest_credible_return: earliest,
        otm_min_weeks: thread.otm_projection?.min_weeks ?? null,
        game_url: game.url,
        reason:
          'A regular-season stat line this soon after the stored injury_date is evidence the date is wrong, not that the athlete returned.',
      },
    });
  } catch (err) {
    console.warn(`[ReturnDetect] ${thread.id} — could not audit the date-review flag: ${errorMessage(err)}`);
  }
}

export async function runReturnDetectCycle(now: Date = new Date()): Promise<ReturnDetectSummary> {
  const mode = returnDetectMode();
  const summary = emptySummary(mode);
  if (mode === 'off') {
    console.log('[ReturnDetect] mode=off — nothing to do');
    return summary;
  }
  if (!isServerAvailable('web')) {
    console.warn('[ReturnDetect] web MCP unavailable — skipping cycle');
    summary.errors++;
    return summary;
  }

  let threads: DetectorThread[];
  try {
    threads = await listActiveThreads();
  } catch (err) {
    summary.errors++;
    summary.aborted = true;
    summary.abort_reason = `thread listing failed: ${errorMessage(err)}`;
    console.error(`[ReturnDetect] ABORTED — ${summary.abort_reason}`);
    return summary;
  }

  summary.threads = threads.length;
  const unknownLabels = new Set<string>();

  for (const thread of threads) {
    const sport = thread.sport ?? '';
    summary.by_sport[sport] = (summary.by_sport[sport] ?? 0) + 1;

    if (!hasGamelog(sport)) {
      summary.skipped.sport_unsupported++;
      continue;
    }
    if (thread.status !== 'ACTIVE') {
      summary.skipped.not_active++;
      continue;
    }
    if (!thread.injury_date) {
      summary.skipped.no_injury_date++;
      continue;
    }
    if (thread.actual_return_date) {
      summary.skipped.already_returned++;
      continue;
    }
    if (!thread.espn_athlete_id) {
      summary.skipped.no_espn_athlete_id++;
      continue;
    }

    const today = localCalendarDate(now, sport).date;
    let loaded: Awaited<ReturnType<typeof loadGames>>;
    try {
      loaded = await loadGames(sport, thread.espn_athlete_id, thread.injury_date, today);
    } catch (err) {
      // A bad PAGE. Stop the whole cycle rather than reading a dropped block of
      // requests as "none of these athletes have played".
      summary.errors++;
      summary.aborted = true;
      summary.abort_reason =
        err instanceof TransientEspnError
          ? `ESPN read failed on ${thread.athlete_name ?? thread.id}: ${err.message}`
          : errorMessage(err);
      console.error(`[ReturnDetect] ABORTED — ${summary.abort_reason} (threads left ACTIVE)`);
      break;
    }

    if (!loaded) {
      summary.skipped.athlete_not_found++;
      continue;
    }
    for (const l of loaded.unknown_labels) unknownLabels.add(l);

    const outcome = decideThread(thread, loaded.games);
    summary.decisions.push({ thread, outcome });

    if (outcome.kind === 'skipped') {
      summary.skipped[outcome.reason]++;
      continue;
    }
    if (outcome.kind === 'no_return') {
      summary.no_return++;
      continue;
    }

    const projection = thread.otm_projection;
    const wouldBeUnscoreable = !projection || typeof projection.min_weeks !== 'number';

    if (outcome.kind === 'too_early') {
      summary.date_review++;
      console.log(
        `[ReturnDetect] date_review thread=${thread.id} athlete=${thread.athlete_name ?? '?'} sport=${sport} ` +
          `injury_date=${thread.injury_date} candidate=${outcome.game.date} earliest_credible=${outcome.earliest_credible}`,
      );
      if (mode === 'on') {
        try {
          await flagDateReview(thread, outcome.game, outcome.earliest_credible);
        } catch (err) {
          summary.errors++;
          console.error(`[ReturnDetect] date-review flag failed thread=${thread.id}: ${errorMessage(err)}`);
        }
      }
      continue;
    }

    summary.returned++;
    if (wouldBeUnscoreable) summary.unscoreable++;
    console.log(
      `[ReturnDetect] returned thread=${thread.id} athlete=${thread.athlete_name ?? '?'} sport=${sport} ` +
        `injury_date=${thread.injury_date} return=${outcome.game.date} week=${outcome.game.week ?? '-'} ` +
        `scoreable=${!wouldBeUnscoreable} mode=${mode}`,
    );
    if (mode === 'on') {
      try {
        await recordReturn(thread, outcome.game);
      } catch (err) {
        summary.errors++;
        console.error(`[ReturnDetect] CLOSE FAILED thread=${thread.id}: ${errorMessage(err)}`);
      }
    }
  }

  summary.unknown_labels = [...unknownLabels];
  if (summary.unknown_labels.length > 0) {
    console.warn(
      `[ReturnDetect] unknown seasonType labels seen (excluded): ${summary.unknown_labels.join(' | ')}`,
    );
  }

  const sports = SPORTS.map((s) => `${s.toLowerCase()}=${summary.by_sport[s] ?? 0}`).join(' ');
  console.log(
    `[ReturnDetect] mode=${summary.mode} threads=${summary.threads} ${sports} ` +
      `returned=${summary.returned} date_review=${summary.date_review} no_return=${summary.no_return} ` +
      `skipped_no_id=${summary.skipped.no_espn_athlete_id} skipped_no_date=${summary.skipped.no_injury_date} ` +
      `skipped_returned=${summary.skipped.already_returned} not_found=${summary.skipped.athlete_not_found} ` +
      `unscoreable=${summary.unscoreable} errors=${summary.errors} aborted=${summary.aborted}`,
  );
  return summary;
}

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await runReturnDetectCycle();
  } catch (err) {
    console.error(`[ReturnDetect] cycle crashed: ${errorMessage(err)}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

export function startReturnDetector(): void {
  if (process.env.RETURN_DETECT_ENABLED === 'false' || returnDetectMode() === 'off') {
    console.log('[ReturnDetect] disabled — skipping startup');
    return;
  }
  stopped = false;
  const intervalMs = getIntervalMs();
  console.log(
    `[ReturnDetect] Starting — mode=${returnDetectMode()} interval=${intervalMs}ms (first run in ${STARTUP_DELAY_MS}ms)`,
  );
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

export function stopReturnDetector(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[ReturnDetect] Stopped');
}
