/**
 * Reading "did this athlete play again?" out of ESPN's athlete gamelog.
 *
 * Everything here is pure and exported so it can be tested against recorded
 * payloads (tests/fixtures/espn-gamelogs.json) without a network call. The
 * return detector supplies the I/O.
 *
 * Four properties of the live endpoint that the obvious implementation gets
 * wrong. All four were verified against real responses on 2026-09-15 and are
 * pinned by the recorded fixtures:
 *
 * 1. **Never iterate the flat `events` map.** It carries PRESEASON games in the
 *    same dictionary as regular-season ones — the recorded NBA payload has a
 *    "2025-26 Preseason" seasonType whose two events sit right beside the 65
 *    regular-season ones. A preseason appearance is not a return; it is a
 *    player being looked at in August.
 *
 * 2. **The regular-season test cannot key on `splitType`.** NFL sets
 *    `categories[].splitType` to the string "2". NBA names its categories after
 *    MONTHS ("april", splitType "april"). A `splitType === '2'` filter is not
 *    merely incomplete for NBA, it returns NOTHING — a silent "this athlete
 *    never came back" for an entire sport. The seasonType `displayName` is the
 *    only signal the two share.
 *
 * 3. **`season` means different things per sport.** NFL `season=2025` is the
 *    2025 season. NBA `season=2026` is the **2025-26** season — the ENDING
 *    year. Both verified in both directions. Omitting the param returns only
 *    the current season, so any injury spanning a season boundary needs the
 *    years enumerated explicitly.
 *
 * 4. **`gameDate` is full ISO in UTC.** `2025-05-01T02:00:00.000+00:00` is an
 *    April 30 game in the United States. Every date here goes through
 *    `localCalendarDate`, which is the same UTC/local trap that produced the
 *    Pinter 08-19 <-> 08-20 flip-flops.
 *
 * A fifth, for anyone extending this: the gamelog lists only games in which the
 * athlete recorded a STAT LINE. A player who dressed and took no snaps is
 * therefore MISSED rather than INVENTED. That is the direction this system
 * argues for everywhere else (date-validation.ts: "an absent date is
 * recoverable downstream; a confidently wrong one is not"), and it is why
 * game participation beats an ESPN status transition as the return signal.
 */
import type { SportKey } from '../../types.js';
import { localCalendarDate } from '../../agents/injury-intelligence/season-calendar.js';

/** The sports with a gamelog this can read. PL and UFC are deliberately absent. */
export const GAMELOG_LEAGUE_PATH: Partial<Record<SportKey, string>> = {
  NFL: 'football/nfl',
  NBA: 'basketball/nba',
};

export function hasGamelog(sport: string): sport is 'NFL' | 'NBA' {
  return sport === 'NFL' || sport === 'NBA';
}

export interface GamelogGame {
  event_id: string;
  /** Local calendar date in the sport's own timezone, 'YYYY-MM-DD'. */
  date: string;
  /** The raw UTC instant, kept so a reader can check the conversion. */
  game_date_utc: string;
  week: number | null;
  opponent: string | null;
  /** The public espn.com recap — a URL a reader can open. */
  url: string | null;
  season_type_label: string;
}

export interface GamelogParse {
  games: GamelogGame[];
  /**
   * seasonType displayNames that matched neither the regular-season pattern nor
   * a known non-regular one. Reported, never assumed: if ESPN adds a label
   * (a play-in bracket, an in-season tournament split), this is how we find out
   * from the logs instead of from a wrong accuracy number.
   */
  unknown_labels: string[];
  /** Games excluded because their split is not the regular season. */
  excluded_non_regular: number;
}

const REGULAR_SEASON_RE = /regular season/i;
// Labels we recognise as deliberately NOT the regular season. Anything outside
// both lists is reported as unknown and excluded (the cautious direction).
const KNOWN_NON_REGULAR_RE = /preseason|postseason|playoff|play-?in|exhibition|all-?star|friendly/i;

export function buildGamelogUrl(sport: 'NFL' | 'NBA', espnAthleteId: string, season?: number): string {
  const league = GAMELOG_LEAGUE_PATH[sport];
  const base = `https://site.web.api.espn.com/apis/common/v3/sports/${league}/athletes/${espnAthleteId}/gamelog`;
  return season ? `${base}?season=${season}` : base;
}

/**
 * The ESPN `season` parameter for the season containing an ISO date.
 *
 * NFL labels a season by the year it STARTS (a January 2026 game belongs to
 * season 2025); NBA labels it by the year it ENDS (season=2026 is 2025-26).
 * Getting this backwards silently reads the wrong year and reports that the
 * athlete never returned.
 */
export function gamelogSeasonParam(sport: 'NFL' | 'NBA', iso: string): number {
  const [year, month] = iso.split('-').map((n) => parseInt(n, 10));
  if (sport === 'NFL') {
    // Season starts in September.
    return month >= 9 ? year : year - 1;
  }
  // NBA season starts in October and is named for the following calendar year.
  return month >= 10 ? year + 1 : year;
}

/** Every season parameter needed to cover [fromIso, toIso] inclusive. */
export function gamelogSeasonsFor(sport: 'NFL' | 'NBA', fromIso: string, toIso: string): number[] {
  const first = gamelogSeasonParam(sport, fromIso);
  const last = gamelogSeasonParam(sport, toIso);
  if (last < first) return [first];
  const out: number[] = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

interface RawGamelog {
  events?: Record<string, RawEvent | undefined>;
  seasonTypes?: Array<{
    displayName?: string;
    categories?: Array<{ events?: Array<{ eventId?: string }> }>;
  }>;
}

interface RawEvent {
  id?: string;
  week?: number;
  gameDate?: string;
  opponent?: { displayName?: string };
  links?: Array<{ href?: string }>;
}

/**
 * Extract the athlete's regular-season games from one gamelog payload.
 *
 * Walks seasonTypes -> categories -> events[].eventId and looks each id up in
 * the flat `events` map, rather than iterating that map directly. That order is
 * the whole point: the map is the only place the dates live, and the tree is
 * the only place the SPLIT lives.
 */
export function parseRegularSeasonGames(payload: unknown, sport: SportKey): GamelogParse {
  const body = (payload ?? {}) as RawGamelog;
  const events = body.events ?? {};
  const games: GamelogGame[] = [];
  const unknown = new Set<string>();
  let excluded = 0;
  const seen = new Set<string>();

  for (const st of body.seasonTypes ?? []) {
    const label = (st.displayName ?? '').trim();
    const isRegular = REGULAR_SEASON_RE.test(label);
    if (!isRegular && !KNOWN_NON_REGULAR_RE.test(label)) unknown.add(label || '(unnamed)');

    for (const cat of st.categories ?? []) {
      for (const ref of cat.events ?? []) {
        const id = ref.eventId;
        if (!id) continue;
        if (!isRegular) {
          excluded++;
          continue;
        }
        // NBA lists a game under exactly one month category, but an id seen
        // twice must not become two games.
        if (seen.has(id)) continue;
        const ev = events[id];
        const iso = ev?.gameDate;
        if (!iso) continue;
        const when = new Date(iso);
        if (Number.isNaN(when.getTime())) continue;
        seen.add(id);
        games.push({
          event_id: id,
          date: localCalendarDate(when, sport).date,
          game_date_utc: iso,
          week: Number.isFinite(ev?.week) ? (ev!.week as number) : null,
          opponent: ev?.opponent?.displayName ?? null,
          url: ev?.links?.[0]?.href ?? null,
          season_type_label: label,
        });
      }
    }
  }

  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { games, unknown_labels: [...unknown], excluded_non_regular: excluded };
}

/**
 * The first regular-season game STRICTLY after the injury date.
 *
 * Strictly: a game on the injury date itself is the game the athlete was hurt
 * in — he has a stat line for it precisely because he played until he could
 * not. Counting it would date every in-game injury's "return" to the day of the
 * injury.
 */
export function firstGameAfter(games: GamelogGame[], injuryDateIso: string): GamelogGame | null {
  for (const g of games) {
    if (g.date > injuryDateIso) return g;
  }
  return null;
}
