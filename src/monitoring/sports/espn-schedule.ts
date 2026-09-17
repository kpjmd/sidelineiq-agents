/**
 * "Did this athlete miss any games?" — the team-schedule half of the return
 * detector, for pre-registration Amendment 1 (A1.3, calendar censoring).
 *
 * The athlete gamelog cannot answer it: it lists only games the athlete has a
 * stat line in, so a gap in it is a missed game OR a bye OR the offseason. The
 * team's regular-season schedule is the only source of "there was a game he
 * could have played".
 *
 * A return is CENSORED when the return game is the returning team's first
 * completed regular-season game strictly after injury_date. Such a return
 * proves only that recovery happened on or before it — every offseason injury
 * that resolves by the opener looks like this, which is why the whole first
 * accuracy cohort returned in Week 1.
 *
 * Properties of the live endpoint, verified 2026-09-16 and pinned by
 * tests/fixtures/espn-team-schedules.json:
 *
 * 1. **An unknown team id is HTTP 200 with an EMPTY `events` array**, not a
 *    404, and so is a season that has not been scheduled. Empty therefore means
 *    "cannot decide". Reading it as "no games to miss" would mark every such
 *    return censored; reading it as "missed games" would score it.
 * 2. **`season` follows the gamelog's convention**: NFL is the starting year,
 *    NBA the ENDING year (season=2026 is 2025-26). gamelogSeasonParam is reused
 *    rather than re-derived.
 * 3. **Completion is per event** (`competitions[0].status.type.completed`). The
 *    current season's schedule lists every future game; a scheduled game is
 *    never "the first game after the injury".
 * 4. **`date` is UTC** — the Bosa Thursday-night trap. localCalendarDate, as
 *    everywhere else.
 * 5. **A team can carry a game that is not one of its 82.** The NBA Cup final
 *    appears in the finalists' regular-season schedule. Harmless unless it is
 *    the first game after an injury; noted, not special-cased.
 */
import type { SportKey } from '../../types.js';
import { localCalendarDate } from '../../agents/injury-intelligence/season-calendar.js';
import { fetchEspnJson } from './espn-json.js';
import { GAMELOG_LEAGUE_PATH, gamelogSeasonParam, type GamelogGame } from './espn-gamelog.js';

export interface ScheduleGame {
  event_id: string;
  /** Local calendar date in the sport's own timezone. */
  date: string;
  completed: boolean;
}

export function buildTeamScheduleUrl(sport: 'NFL' | 'NBA', teamId: string, season: number): string {
  const league = GAMELOG_LEAGUE_PATH[sport];
  return `https://site.api.espn.com/apis/site/v2/sports/${league}/teams/${teamId}/schedule?season=${season}&seasontype=2`;
}

interface RawSchedule {
  events?: Array<{
    id?: string;
    date?: string;
    seasonType?: { type?: number; name?: string };
    competitions?: Array<{ status?: { type?: { completed?: boolean } } }>;
  }>;
}

/**
 * Regular-season games from one schedule payload, sorted by local date.
 *
 * `seasontype=2` is requested, and the event's own seasonType is still checked:
 * a preseason game here would be a "game he could have played" that counts for
 * nothing.
 */
export function parseTeamSchedule(payload: unknown, sport: SportKey): ScheduleGame[] {
  const body = (payload ?? {}) as RawSchedule;
  const out: ScheduleGame[] = [];
  for (const ev of body.events ?? []) {
    if (!ev?.id || !ev.date) continue;
    const st = ev.seasonType;
    const regular = st?.type === 2 || /regular season/i.test(st?.name ?? '');
    if (!regular) continue;
    const when = new Date(ev.date);
    if (Number.isNaN(when.getTime())) continue;
    out.push({
      event_id: String(ev.id),
      date: localCalendarDate(when, sport).date,
      completed: ev.competitions?.[0]?.status?.type?.completed === true,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * Is `returnGame` the first completed regular-season game on `schedule` dated
 * strictly after `injuryDateIso`? Pure. Order-independent.
 *
 * - **false** as soon as the team completed a game strictly between the injury
 *   and the return: the athlete had no stat line in it (the return is the
 *   first game he has one in), so he missed it and the return date carries
 *   recovery information. That is decidable without having seen the return
 *   game itself.
 * - **true** when no such game exists AND the schedule contains the return
 *   game — nothing was there to miss.
 * - **null** otherwise: the schedule does not contain the return game (empty
 *   body, wrong team, season not fetched). The caller must not close on it.
 */
export function isCalendarCensored(
  injuryDateIso: string,
  returnGame: Pick<GamelogGame, 'event_id' | 'date'>,
  schedule: ScheduleGame[],
): boolean | null {
  const isReturn = (g: ScheduleGame) => g.event_id === returnGame.event_id || g.date === returnGame.date;
  const missed = schedule.some(
    (g) => g.completed && !isReturn(g) && g.date > injuryDateIso && g.date < returnGame.date,
  );
  if (missed) return false;
  return schedule.some(isReturn) ? true : null;
}

/** Per-cycle cache: one fetch per team-season, shared across threads. */
export type ScheduleCache = Map<string, ScheduleGame[] | null>;

/**
 * Decide censoring for one detected return, fetching every season from the
 * injury's to the return's. Stops at the first season that settles it.
 *
 * @returns true/false, or null when the schedule could not settle it (no team
 *   id on the game, empty or 404 schedule).
 * @throws {TransientEspnError} on a bad PAGE — the caller aborts the cycle
 *   rather than closing a thread whose record it could not compute.
 */
export async function loadCalendarCensoring(
  sport: 'NFL' | 'NBA',
  injuryDateIso: string,
  returnGame: GamelogGame,
  cache: ScheduleCache,
): Promise<boolean | null> {
  const teamId = returnGame.team_id;
  if (!teamId) return null;
  const first = gamelogSeasonParam(sport, injuryDateIso);
  const last = gamelogSeasonParam(sport, returnGame.date);
  const games: ScheduleGame[] = [];
  for (let season = first; season <= Math.max(first, last); season++) {
    const key = `${sport}|${teamId}|${season}`;
    let parsed = cache.get(key);
    if (parsed === undefined) {
      const body = await fetchEspnJson(buildTeamScheduleUrl(sport, teamId, season));
      parsed = body === null ? null : parseTeamSchedule(body, sport);
      cache.set(key, parsed);
    }
    if (parsed) games.push(...parsed);
    // A missed game settles it; later seasons cannot change that.
    if (isCalendarCensored(injuryDateIso, returnGame, games) === false) return false;
  }
  return isCalendarCensored(injuryDateIso, returnGame, games);
}
