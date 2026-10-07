/**
 * The three nflverse tables the resolution ingest reads (plan D1, D3;
 * docs/ledger-preregistration.md "Sources"): the game universe, the gamebook
 * participation (snap counts) and the official injury report. Parsed into the
 * row shapes `src/ledger/rules.ts` takes, and nothing more.
 *
 * Where they live (verified 2026-10-07; the Stage 1 plan's games.csv release URL
 * is a 404):
 *   games.csv               github.com/nflverse/nfldata  data/games.csv
 *   snap_counts_<season>    nflverse-data release `snap_counts`
 *   injuries_<season>       nflverse-data release `injuries`
 * Each URL is overridable by env so a moved file is a config change.
 *
 * Failure policy: every fetch here is a whole FILE, so every failure is a bad
 * PAGE. A non-200 (404 included — a missing file is not "no games"), a timeout,
 * a missing required column or a file with no data rows throws
 * `NflverseFactsUnavailableError`, and the ingest aborts the cycle before its
 * first write. There is no row-level fetch in this module to which the
 * 404-is-a-bad-row half of the split could apply.
 *
 * Identity: snap rows are keyed on `pfr_player_id`, injury rows on `gsis_id`.
 * The `player` / `full_name` columns are deliberately NOT carried into the
 * parsed rows, so no rule can key on a name (preregistration "Identity").
 */
import { parseCsv } from '../nflverse-players.js';
import type { InjuryReportRow, ScheduleGame, SnapRow } from '../rules.js';
import { isIsoDate } from '../dates.js';

export const NFLVERSE_GAMES_URL = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv';
export const NFLVERSE_SNAPS_URL_TEMPLATE =
  'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{season}.csv';
export const NFLVERSE_INJURIES_URL_TEMPLATE =
  'https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{season}.csv';

const FETCH_TIMEOUT_MS = 60_000;

export class NflverseFactsUnavailableError extends Error {
  constructor(
    readonly source: 'games' | 'snap_counts' | 'injuries',
    message: string,
  ) {
    super(`nflverse ${source} unavailable: ${message}`);
    this.name = 'NflverseFactsUnavailableError';
  }
}

export interface NflverseUrls {
  games: string;
  snapsTemplate: string;
  injuriesTemplate: string;
}

export function nflverseUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): NflverseUrls {
  return {
    games: env.NFLVERSE_GAMES_URL || NFLVERSE_GAMES_URL,
    snapsTemplate: env.NFLVERSE_SNAPS_URL_TEMPLATE || NFLVERSE_SNAPS_URL_TEMPLATE,
    injuriesTemplate: env.NFLVERSE_INJURIES_URL_TEMPLATE || NFLVERSE_INJURIES_URL_TEMPLATE,
  };
}

export const seasonUrl = (template: string, season: number): string => template.replace('{season}', String(season));

// ── Parsing ────────────────────────────────────────────────────────────

type Source = NflverseFactsUnavailableError['source'];

/** Header-indexed rows. Throws when a required column is missing or there are no data rows. */
function table(text: string, required: readonly string[], source: Source): Array<(col: string) => string | null> {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''));
  if (rows.length === 0) throw new NflverseFactsUnavailableError(source, 'empty file');
  const col = new Map(rows[0].map((h, i) => [h.trim(), i] as const));
  const missing = required.filter((c) => !col.has(c));
  if (missing.length > 0) throw new NflverseFactsUnavailableError(source, `header lacks ${missing.join(', ')}`);
  const data = rows.slice(1);
  if (data.length === 0) throw new NflverseFactsUnavailableError(source, 'no data rows');
  return data.map((r) => (name: string) => {
    const i = col.get(name);
    const v = i === undefined ? undefined : r[i];
    return v === undefined || v === '' || v === 'NA' ? null : v;
  });
}

const int = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const GAMES_COLUMNS = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'home_team', 'result', 'pfr', 'espn'] as const;

/** games.csv → ScheduleGame. `completed` = `result` populated (preregistration "Game universe"). */
export function parseGamesCsv(text: string): ScheduleGame[] {
  const out: ScheduleGame[] = [];
  for (const at of table(text, GAMES_COLUMNS, 'games')) {
    const season = int(at('season'));
    const week = int(at('week'));
    const gameday = at('gameday');
    const gameId = at('game_id');
    if (season === null || week === null || !gameId || !gameday || !isIsoDate(gameday)) continue;
    const gametime = at('gametime');
    out.push({
      game_id: gameId,
      season,
      game_type: at('game_type') ?? '',
      week,
      gameday,
      gametime: gametime && /^\d{2}:\d{2}$/.test(gametime) ? gametime : null,
      away_team: at('away_team') ?? '',
      home_team: at('home_team') ?? '',
      completed: at('result') !== null,
      pfr_game_id: at('pfr'),
      espn_event_id: at('espn'),
    });
  }
  return out;
}

export const SNAP_COLUMNS = ['game_id', 'pfr_player_id', 'team', 'offense_snaps', 'defense_snaps', 'st_snaps'] as const;

export function parseSnapsCsv(text: string): SnapRow[] {
  const out: SnapRow[] = [];
  for (const at of table(text, SNAP_COLUMNS, 'snap_counts')) {
    const gameId = at('game_id');
    const pfr = at('pfr_player_id');
    if (!gameId || !pfr) continue;
    out.push({
      game_id: gameId,
      pfr_player_id: pfr,
      team: at('team') ?? '',
      offense_snaps: int(at('offense_snaps')) ?? 0,
      defense_snaps: int(at('defense_snaps')) ?? 0,
      st_snaps: int(at('st_snaps')) ?? 0,
    });
  }
  return out;
}

export const INJURY_COLUMNS = ['season', 'week', 'team', 'gsis_id', 'report_primary_injury', 'report_secondary_injury', 'report_status'] as const;

export function parseInjuriesCsv(text: string): InjuryReportRow[] {
  const out: InjuryReportRow[] = [];
  for (const at of table(text, INJURY_COLUMNS, 'injuries')) {
    const season = int(at('season'));
    const week = int(at('week'));
    const gsis = at('gsis_id');
    if (season === null || week === null || !gsis) continue;
    out.push({
      season,
      week,
      team: at('team') ?? '',
      gsis_id: gsis,
      report_primary_injury: at('report_primary_injury'),
      report_secondary_injury: at('report_secondary_injury'),
      report_status: at('report_status'),
    });
  }
  return out;
}

// ── Fetch ──────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchedSource {
  source: Source;
  url: string;
  rows: number;
}

export interface NflverseFacts {
  schedule: ScheduleGame[];
  snaps: SnapRow[];
  injuries: InjuryReportRow[];
  sources: FetchedSource[];
}

async function getText(fetchFn: FetchLike, url: string, source: Source): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (err) {
    throw new NflverseFactsUnavailableError(source, `fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 404 included: a missing file is our failure to read, never "no games were played".
  if (!res.ok) throw new NflverseFactsUnavailableError(source, `HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Every table the rules need for the given seasons, fetched fresh (they change
 * weekly; the loop runs daily, so no cross-cycle cache). Any failure throws
 * before anything is returned.
 */
export async function fetchNflverseFacts(seasons: readonly number[], fetchFn: FetchLike, urls: NflverseUrls = nflverseUrlsFromEnv()): Promise<NflverseFacts> {
  const sources: FetchedSource[] = [];
  const schedule = parseGamesCsv(await getText(fetchFn, urls.games, 'games')).filter((g) => seasons.includes(g.season));
  sources.push({ source: 'games', url: urls.games, rows: schedule.length });
  const snaps: SnapRow[] = [];
  const injuries: InjuryReportRow[] = [];
  for (const season of [...new Set(seasons)].sort()) {
    const su = seasonUrl(urls.snapsTemplate, season);
    const s = parseSnapsCsv(await getText(fetchFn, su, 'snap_counts'));
    snaps.push(...s);
    sources.push({ source: 'snap_counts', url: su, rows: s.length });
    const iu = seasonUrl(urls.injuriesTemplate, season);
    const i = parseInjuriesCsv(await getText(fetchFn, iu, 'injuries'));
    injuries.push(...i);
    sources.push({ source: 'injuries', url: iu, rows: i.length });
  }
  return { schedule, snaps, injuries, sources };
}
