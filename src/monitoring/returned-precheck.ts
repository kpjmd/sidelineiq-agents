import type { RawInjuryEvent } from '../types.js';
import { reportsFreshEvent } from '../agents/injury-intelligence/carryover.js';
import { localCalendarDate } from '../agents/injury-intelligence/season-calendar.js';
import type { InjuryThreadContext } from '../agents/injury-intelligence/agent.js';
import { callTool } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { loadGames } from './return-detector.js';
import { hasGamelog, type GamelogGame } from './sports/espn-gamelog.js';

/**
 * Has this athlete already played since the injury this report is anchored to?
 *
 * ESPN's feed is a status table, so it can list an athlete for an old injury long
 * after he came back. Kyrie Irving: surgery March 2025, five regular-season games
 * from 2026-10-21, then day-to-day for knee management on 2026-11-02. That row
 * minted a thread and produced a post saying he "remains out". The return detector
 * could not help: the thread did not exist when he returned, a game before the
 * first report is a predates_report hold, and a closed thread only lets the next
 * report mint another.
 *
 * A game in the window and no fresh-injury wording means no post. Fresh wording
 * means a physician decides, because a re-injury anchored to the old date looks
 * identical from here.
 *
 * This check only ever suppresses, so every way of not knowing passes the event
 * through: a failed read must never silence a report. That is the opposite of the
 * detector's abort-on-failure, and for the same reason: each takes the direction
 * in which a read failure writes nothing irreversible.
 */

export type ReturnedPrecheckMode = 'off' | 'shadow' | 'on';

export function returnedPrecheckMode(): ReturnedPrecheckMode {
  const raw = (process.env.RETURNED_PRECHECK_MODE ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'on' ? raw : 'shadow';
}

export const RETURNED_SINCE_CODE = 'returned_since_anchor';

const ANCHORED_CONFIDENCE = new Set(['probable', 'confirmed']);

export interface ReturnedHit {
  kind: 'skip' | 'review';
  anchor: string;
  report_date: string;
  games: number;
  first_game_date: string;
  last_game_date: string;
}

export type ReturnedDecision =
  | { kind: 'not_applicable'; reason: string }
  | { kind: 'not_returned' }
  | ReturnedHit;

/** Pure, so the dry run and the live path reach the same verdict. */
export function decideReturned(
  games: GamelogGame[],
  anchor: string,
  reportDate: string,
  freshReport: boolean,
): ReturnedDecision {
  // Strictly after the anchor: a game on the injury date is the one he was hurt
  // in. Strictly before the report: a same-day game may be the one being reported.
  const window = games.filter((g) => g.date > anchor && g.date < reportDate);
  if (window.length === 0) return { kind: 'not_returned' };
  return {
    kind: freshReport ? 'review' : 'skip',
    anchor,
    report_date: reportDate,
    games: window.length,
    first_game_date: window[0].date,
    last_game_date: window[window.length - 1].date,
  };
}

export async function checkReturnedBeforeReport(
  event: RawInjuryEvent,
  thread: Pick<InjuryThreadContext, 'injury_date' | 'injury_date_confidence'>,
  skipReason: string | null,
): Promise<ReturnedDecision> {
  const mode = returnedPrecheckMode();
  if (mode === 'off') return { kind: 'not_applicable', reason: 'mode_off' };
  const sport = event.sport;
  if (!hasGamelog(sport)) return { kind: 'not_applicable', reason: 'sport_without_gamelog' };
  if (!event.espn_athlete_id) return { kind: 'not_applicable', reason: 'no_espn_athlete_id' };
  const anchor = thread.injury_date?.slice(0, 10);
  if (!anchor) return { kind: 'not_applicable', reason: 'no_anchor' };
  // A guessed date cannot say the athlete played AFTER the injury. An MD's date
  // can, at whatever confidence the MD chose to record.
  if (skipReason !== 'md_manual' && !ANCHORED_CONFIDENCE.has(thread.injury_date_confidence)) {
    return { kind: 'not_applicable', reason: 'date_not_anchored' };
  }

  const reportDate = localCalendarDate(event.reported_at, sport).date;
  try {
    const loaded = await loadGames(sport, event.espn_athlete_id, anchor, reportDate);
    if (!loaded) return { kind: 'not_applicable', reason: 'athlete_not_found' };
    return decideReturned(loaded.games, anchor, reportDate, reportsFreshEvent(event));
  } catch (err) {
    console.warn(
      `[ReturnedPrecheck] game log unavailable for ${event.athlete_name} (${sport}), ` +
        `passing the event through: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: 'not_applicable', reason: 'gamelog_unavailable' };
  }
}

/**
 * Retract a thread this cycle minted for a report it then skipped. closed_by is
 * the literal 'system': anything else stamps the audit row as a physician's act.
 * Never fatal, and a failure leaves only a predates_report hold for the MD.
 */
export async function voidUnneededThread(
  entityId: string,
  event: RawInjuryEvent,
  decision: ReturnedHit,
): Promise<void> {
  const reason =
    `Minted from a report dated ${decision.report_date} about an injury dated ${decision.anchor}. ` +
    `The athlete had played ${decision.games} regular-season game(s) in between, first on ` +
    `${decision.first_game_date}, and the report describes nothing new.`;
  try {
    const res = await callTool('web', 'web_thread_close', {
      entity_id: entityId,
      outcome: 'VOID',
      void_reason: reason,
      closed_by: 'system',
    });
    if (isMCPError(res)) {
      console.warn(
        `[ReturnedPrecheck] could not void thread ${entityId} for ${event.athlete_name}: ${extractMCPErrorMessage(res)}`,
      );
    }
  } catch (err) {
    console.warn(
      `[ReturnedPrecheck] could not void thread ${entityId} for ${event.athlete_name}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
