/**
 * Resolution and freeze-point rules for the five ledger fields (spec: "Prediction
 * taxonomy", "Resolution rules", "Scoring integrity → Freeze point per field"),
 * with the interpretations the founder approved on 2026-10-04 (plan §2.3,
 * recorded in docs/ledger-preregistration.md).
 *
 * Pure. Takes `games.csv`-shaped schedule rows, nflverse snap-count rows,
 * nflverse injury-report rows and ALREADY-ATTRIBUTED transaction events (the
 * ingest decides which prose transaction names this athlete and quotes the
 * sentence; this module only reads dates and kinds). Returns a decision per
 * field. It never writes anything: Stage 3's ingest turns a `resolved` or
 * `void` decision into a PROPOSAL, and the physician confirms it.
 *
 * Properties worth stating:
 *  - Every date is a YYYY-MM-DD on the New York calendar. Freeze points are
 *    instants (ISO UTC) because F2's is a kickoff clock time; day-based freeze
 *    points are the END of that New York day.
 *  - "Played" means a snap-count row with ≥1 snap of any kind. A game the snap
 *    file does not cover AT ALL (no row for any player) is `awaiting_snap_counts`,
 *    never a miss: absence of the player's row is evidence only when the game is
 *    present.
 *  - Byes are not rows in the schedule, so they are never counted as games.
 *  - Void (trade/release/retirement/suspension) applies per field and only when
 *    the event is dated strictly BEFORE the date the field resolved on. A field
 *    that resolved first stays resolved.
 *  - A field whose first resolvable moment had already passed when v1 was
 *    published is void (`forecast_after_freeze`): there was nothing to forecast.
 */
import {
  type IsoDate,
  addDays,
  compareDates,
  compareInstants,
  endOfEtDayIso,
  etToUtcIso,
} from './dates.js';
import type { LedgerField } from './fields.js';

// ── Inputs ─────────────────────────────────────────────────────────────

/** One row of nflverse `games.csv`, reduced to what the rules read. */
export interface ScheduleGame {
  game_id: string;
  season: number;
  /** 'REG' | 'POST' | 'PRE' … only 'REG' counts toward anything. */
  game_type: string;
  week: number;
  gameday: IsoDate;
  /** 'HH:MM' Eastern, or null when the schedule has none. */
  gametime: string | null;
  away_team: string;
  home_team: string;
  /** `result` is non-blank in games.csv once the game has been played. */
  completed: boolean;
  /** games.csv `pfr` column: the Pro Football Reference boxscore id, e.g. 202609130sdg. */
  pfr_game_id?: string | null;
  /** games.csv `espn` column: ESPN's event id. */
  espn_event_id?: string | null;
}

/** One row of nflverse `snap_counts_<season>.csv`. */
export interface SnapRow {
  game_id: string;
  pfr_player_id: string;
  team: string;
  offense_snaps: number;
  defense_snaps: number;
  st_snaps: number;
}

/** One row of nflverse `injuries_<season>.csv`. */
export interface InjuryReportRow {
  season: number;
  week: number;
  team: string;
  gsis_id: string;
  report_primary_injury: string | null;
  report_secondary_injury: string | null;
  report_status: string | null;
}

export type TransactionKind = 'IR' | 'TRADE' | 'RELEASE' | 'RETIRE' | 'SUSPEND';

/** A transaction the ingest has already attributed to THIS athlete. */
export interface TransactionEvent {
  kind: TransactionKind;
  /** The transaction wire is day-granular. */
  date: IsoDate;
  team: string;
  /** The sentence the kind was read from — the evidence a human sees. */
  sentence: string;
  url: string;
}

export const VOID_KINDS: readonly TransactionKind[] = ['TRADE', 'RELEASE', 'RETIRE', 'SUSPEND'];

/** What the rules need to know about an entry. */
export interface LedgerEntryContext {
  entry_id: string;
  injury_date: IsoDate;
  /** nflverse team abbreviation at the time of the forecast. */
  team: string;
  season: number;
  /** Pro Football Reference id (snap counts). null = cannot resolve gamebook fields. */
  pfr_id: string | null;
  /** GSIS id (injury report). null = cannot resolve F5. */
  gsis_id: string | null;
  reported_injury: string;
  base_rate_row: string;
  /** v1 published_at, ISO UTC. A field whose freeze point precedes it is void. */
  v1_published_at: string;
}

export interface ResolutionFacts {
  schedule: ScheduleGame[];
  snaps: SnapRow[];
  injuries: InjuryReportRow[];
  /** This athlete's transactions only. */
  transactions: TransactionEvent[];
  /** Today on the New York calendar. */
  today: IsoDate;
}

// ── Outputs ────────────────────────────────────────────────────────────

export interface Evidence {
  /** The human-checkable URL(s): a PFR boxscore, the transactions page, the injury file. */
  urls: string[];
  /** Short, factual, no judgement. */
  note: string;
  game_ids?: string[];
  sentence?: string;
}

export type FieldDecision =
  | { status: 'open'; reason: OpenReason; freeze_at: string | null }
  | { status: 'resolved'; outcome: number; resolved_at: IsoDate; freeze_at: string; evidence: Evidence }
  | { status: 'void'; void_reason: VoidReason; freeze_at: string | null; evidence: Evidence }
  | { status: 'unresolvable'; reason: UnresolvableReason };

export type OpenReason =
  | 'before_resolution_window'
  | 'game_not_completed'
  | 'awaiting_snap_counts'
  | 'awaiting_injury_report'
  | 'awaiting_return'
  | 'awaiting_f5_window';

export type VoidReason =
  | 'traded'
  | 'released'
  | 'retired'
  | 'suspended'
  | 'forecast_after_freeze'
  | 'no_next_game_this_season'
  | 'concussion_rule'
  | 'no_return_this_season';

export type UnresolvableReason = 'no_pfr_id' | 'no_gsis_id' | 'no_schedule_for_team';

// ── Schedule helpers ───────────────────────────────────────────────────

function byKickoff(a: ScheduleGame, b: ScheduleGame): number {
  const d = compareDates(a.gameday, b.gameday);
  if (d !== 0) return d;
  return (a.gametime ?? '').localeCompare(b.gametime ?? '');
}

/** The team's regular-season games for the season, in kickoff order. */
export function teamRegularSeasonGames(schedule: ScheduleGame[], team: string, season: number): ScheduleGame[] {
  return schedule
    .filter((g) => g.game_type === 'REG' && g.season === season && (g.away_team === team || g.home_team === team))
    .sort(byKickoff);
}

/** Games dated strictly after `date` (the game he was hurt in is not one of them). */
export function gamesAfter(games: ScheduleGame[], date: IsoDate): ScheduleGame[] {
  return games.filter((g) => compareDates(g.gameday, date) > 0);
}

/** The kickoff instant: gameday + gametime (ET), or the start of the ET day when no time is known. */
export function kickoffIso(game: ScheduleGame): string {
  return etToUtcIso(game.gameday, game.gametime ?? '00:00');
}

/** The team's remaining regular-season games after a date, played or not. For the season-ending flag. */
export function remainingRegularSeasonGames(games: ScheduleGame[], date: IsoDate): number {
  return gamesAfter(games, date).length;
}

// ── Participation helpers ──────────────────────────────────────────────

/** True when the snap file has ANY row for this game — only then is a missing player row a miss. */
export function gameCoveredBySnaps(snaps: SnapRow[], gameId: string): boolean {
  return snaps.some((s) => s.game_id === gameId);
}

export function snapsInGame(snaps: SnapRow[], pfrId: string, gameId: string): number {
  return snaps
    .filter((s) => s.game_id === gameId && s.pfr_player_id === pfrId)
    .reduce((n, s) => n + (s.offense_snaps || 0) + (s.defense_snaps || 0) + (s.st_snaps || 0), 0);
}

export function playedInGame(snaps: SnapRow[], pfrId: string, gameId: string): boolean {
  return snapsInGame(snaps, pfrId, gameId) >= 1;
}

export type ReturnWalk =
  | { kind: 'returned'; game: ScheduleGame; missed: ScheduleGame[] }
  | { kind: 'awaiting_snap_counts'; game: ScheduleGame; missed: ScheduleGame[] }
  | { kind: 'no_return_yet'; next_game: ScheduleGame; missed: ScheduleGame[] }
  | { kind: 'season_over'; missed: ScheduleGame[] };

/**
 * Walk the team's games after `fromDate` in order and find the first one the
 * athlete played in. Stops at the first completed game the snap file does not
 * cover (we cannot know), or at the first game not yet played.
 */
export function walkToFirstReturn(games: ScheduleGame[], snaps: SnapRow[], pfrId: string, fromDate: IsoDate): ReturnWalk {
  const missed: ScheduleGame[] = [];
  for (const game of gamesAfter(games, fromDate)) {
    if (!game.completed) return { kind: 'no_return_yet', next_game: game, missed };
    if (!gameCoveredBySnaps(snaps, game.game_id)) return { kind: 'awaiting_snap_counts', game, missed };
    if (playedInGame(snaps, pfrId, game.game_id)) return { kind: 'returned', game, missed };
    missed.push(game);
  }
  return { kind: 'season_over', missed };
}

// ── Transaction helpers ────────────────────────────────────────────────

function voidReasonOf(kind: TransactionKind): VoidReason {
  switch (kind) {
    case 'TRADE':
      return 'traded';
    case 'RELEASE':
      return 'released';
    case 'RETIRE':
      return 'retired';
    case 'SUSPEND':
      return 'suspended';
    case 'IR':
      throw new Error('IR is not a void kind');
  }
}

/**
 * The earliest void-kind transaction dated on/after the injury and strictly
 * before `beforeDate` (exclusive). Null when none.
 */
export function voidingTransaction(
  transactions: TransactionEvent[],
  injuryDate: IsoDate,
  beforeDate: IsoDate | null,
): TransactionEvent | null {
  const hits = transactions
    .filter((t) => VOID_KINDS.includes(t.kind))
    .filter((t) => compareDates(t.date, injuryDate) >= 0)
    .filter((t) => beforeDate === null || compareDates(t.date, beforeDate) < 0)
    .sort((a, b) => compareDates(a.date, b.date));
  return hits[0] ?? null;
}

function voidDecision(t: TransactionEvent, freezeAt: string | null): FieldDecision {
  return {
    status: 'void',
    void_reason: voidReasonOf(t.kind),
    freeze_at: freezeAt,
    evidence: { urls: [t.url], note: `${t.kind.toLowerCase()} transaction dated ${t.date}`, sentence: t.sentence },
  };
}

/** A field is void when its first resolvable moment preceded the v1 forecast. */
function forecastAfterFreeze(freezeAt: string, ctx: LedgerEntryContext): FieldDecision | null {
  if (compareInstants(ctx.v1_published_at, freezeAt) >= 0) {
    return {
      status: 'void',
      void_reason: 'forecast_after_freeze',
      freeze_at: freezeAt,
      evidence: { urls: [], note: `v1 published ${ctx.v1_published_at}, field froze ${freezeAt}` },
    };
  }
  return null;
}

// ── Body-site vocabulary (F5) ──────────────────────────────────────────

/**
 * The site words the official injury report uses, with the spelled-out
 * structures the SOURCE wording may use for the same site. Lower-case match on
 * whole words. "Same site" (spec Resolution rules) means the same key here.
 */
export const BODY_SITE_LEXICON: Readonly<Record<string, readonly string[]>> = Object.freeze({
  knee: ['knee', 'acl', 'mcl', 'pcl', 'lcl', 'meniscus', 'patella', 'patellar'],
  ankle: ['ankle', 'high ankle', 'syndesmosis', 'syndesmotic'],
  achilles: ['achilles'],
  hamstring: ['hamstring'],
  quadricep: ['quadricep', 'quadriceps', 'quad'],
  calf: ['calf', 'gastrocnemius', 'soleus'],
  groin: ['groin', 'adductor', 'core muscle', 'sports hernia'],
  hip: ['hip', 'labrum hip', 'hip flexor'],
  thigh: ['thigh'],
  foot: ['foot', 'lisfranc', 'plantar', 'metatarsal'],
  toe: ['toe', 'turf toe'],
  heel: ['heel'],
  shoulder: ['shoulder', 'labrum', 'rotator cuff', 'ac joint', 'clavicle', 'collarbone'],
  pectoral: ['pectoral', 'pec'],
  bicep: ['bicep', 'biceps'],
  tricep: ['tricep', 'triceps'],
  elbow: ['elbow', 'ucl'],
  forearm: ['forearm'],
  wrist: ['wrist'],
  hand: ['hand'],
  finger: ['finger', 'thumb'],
  back: ['back', 'lumbar', 'spine'],
  neck: ['neck', 'cervical'],
  rib: ['rib', 'ribs'],
  oblique: ['oblique'],
  abdomen: ['abdomen', 'abdominal', 'core'],
  chest: ['chest', 'sternum'],
  concussion: ['concussion', 'head'],
  shin: ['shin', 'tibia', 'fibula'],
});

function wordHit(text: string, phrase: string): boolean {
  const re = new RegExp(`(^|[^a-z])${phrase.replace(/\s+/g, '\\s+')}([^a-z]|$)`);
  return re.test(text);
}

/** The body-site keys a free-text injury description names, in lexicon order. */
export function bodySitesOf(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.toLowerCase();
  return Object.entries(BODY_SITE_LEXICON)
    .filter(([, phrases]) => phrases.some((p) => wordHit(t, p)))
    .map(([site]) => site);
}

/** True when the injury-report row names any of the entry's sites. */
export function reportNamesSameSite(row: InjuryReportRow, entrySites: string[]): boolean {
  if (entrySites.length === 0) return false;
  const reportSites = new Set([...bodySitesOf(row.report_primary_injury), ...bodySitesOf(row.report_secondary_injury)]);
  return entrySites.some((s) => reportSites.has(s));
}

// ── Field rules ────────────────────────────────────────────────────────

const F1_DAYS = 7;
const F3_DAYS = 28;
const F5_GAMES = 6;

export const TRANSACTIONS_URL = 'https://www.espn.com/nfl/transactions';

/** F1: P(placed on IR within 7 days of injury). Transaction wire. */
export function resolveF1(ctx: LedgerEntryContext, facts: ResolutionFacts): FieldDecision {
  const day7 = addDays(ctx.injury_date, F1_DAYS);
  const ir = facts.transactions
    .filter((t) => t.kind === 'IR')
    .filter((t) => compareDates(t.date, ctx.injury_date) >= 0 && compareDates(t.date, day7) <= 0)
    .sort((a, b) => compareDates(a.date, b.date))[0];

  if (ir) {
    // The wire is day-granular, so the field froze at the START of the IR day:
    // a revision published that day cannot be shown to precede the transaction.
    const freezeAt = etToUtcIso(ir.date, '00:00');
    const v = voidingTransaction(facts.transactions, ctx.injury_date, ir.date);
    if (v) return voidDecision(v, freezeAt);
    return (
      forecastAfterFreeze(freezeAt, ctx) ?? {
        status: 'resolved',
        outcome: 1,
        resolved_at: ir.date,
        freeze_at: freezeAt,
        evidence: { urls: [ir.url], note: `placed on IR ${ir.date}, day ${daysFrom(ctx.injury_date, ir.date)} after injury`, sentence: ir.sentence },
      }
    );
  }

  const freezeAt = endOfEtDayIso(day7);
  const after = forecastAfterFreeze(freezeAt, ctx);
  if (after) return after;
  if (compareDates(facts.today, day7) <= 0) return { status: 'open', reason: 'before_resolution_window', freeze_at: freezeAt };
  const v = voidingTransaction(facts.transactions, ctx.injury_date, addDays(day7, 1));
  if (v) return voidDecision(v, freezeAt);
  return {
    status: 'resolved',
    outcome: 0,
    resolved_at: day7,
    freeze_at: freezeAt,
    evidence: { urls: [TRANSACTIONS_URL], note: `no IR transaction from ${ctx.injury_date} through ${day7}` },
  };
}

function daysFrom(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The page a human checks a participation claim against: the PFR boxscore
 * (the snap counts' own source), else ESPN's game page, else the nflverse id.
 */
export function gameEvidenceUrl(game: ScheduleGame): string {
  if (game.pfr_game_id) return `https://www.pro-football-reference.com/boxscores/${game.pfr_game_id}.htm`;
  if (game.espn_event_id) return `https://www.espn.com/nfl/game/_/gameId/${game.espn_event_id}`;
  return `nflverse:games.csv#${game.game_id}`;
}
const pfrBoxscoreUrl = gameEvidenceUrl;

/** F2: P(plays ≥1 snap in the team's next scheduled game). Gamebook. */
export function resolveF2(ctx: LedgerEntryContext, facts: ResolutionFacts): FieldDecision {
  if (!ctx.pfr_id) return { status: 'unresolvable', reason: 'no_pfr_id' };
  const games = teamRegularSeasonGames(facts.schedule, ctx.team, ctx.season);
  if (games.length === 0) return { status: 'unresolvable', reason: 'no_schedule_for_team' };
  const next = gamesAfter(games, ctx.injury_date)[0];
  if (!next) {
    return {
      status: 'void',
      void_reason: 'no_next_game_this_season',
      freeze_at: null,
      evidence: { urls: [], note: `no regular-season game for ${ctx.team} after ${ctx.injury_date}` },
    };
  }
  const freezeAt = kickoffIso(next);
  const after = forecastAfterFreeze(freezeAt, ctx);
  if (after) return after;
  const v = voidingTransaction(facts.transactions, ctx.injury_date, next.gameday);
  if (v) return voidDecision(v, freezeAt);
  if (!next.completed) return { status: 'open', reason: 'game_not_completed', freeze_at: freezeAt };
  if (!gameCoveredBySnaps(facts.snaps, next.game_id)) return { status: 'open', reason: 'awaiting_snap_counts', freeze_at: freezeAt };
  const snaps = snapsInGame(facts.snaps, ctx.pfr_id, next.game_id);
  return {
    status: 'resolved',
    outcome: snaps >= 1 ? 1 : 0,
    resolved_at: next.gameday,
    freeze_at: freezeAt,
    evidence: {
      urls: [pfrBoxscoreUrl(next)],
      note: `${snaps} snap(s) in ${next.game_id} (week ${next.week}, ${next.gameday})`,
      game_ids: [next.game_id],
    },
  };
}

/** F3: P(plays ≥1 snap in any game within 28 days of injury). Gamebook. */
export function resolveF3(ctx: LedgerEntryContext, facts: ResolutionFacts): FieldDecision {
  if (!ctx.pfr_id) return { status: 'unresolvable', reason: 'no_pfr_id' };
  const games = teamRegularSeasonGames(facts.schedule, ctx.team, ctx.season);
  if (games.length === 0) return { status: 'unresolvable', reason: 'no_schedule_for_team' };
  const day28 = addDays(ctx.injury_date, F3_DAYS);
  const dayFreeze = endOfEtDayIso(day28);
  const walk = walkToFirstReturn(games, facts.snaps, ctx.pfr_id, ctx.injury_date);

  if (walk.kind === 'returned' && compareDates(walk.game.gameday, day28) <= 0) {
    const freezeAt = kickoffIso(walk.game);
    const v = voidingTransaction(facts.transactions, ctx.injury_date, walk.game.gameday);
    if (v) return voidDecision(v, freezeAt);
    return (
      forecastAfterFreeze(freezeAt, ctx) ?? {
        status: 'resolved',
        outcome: 1,
        resolved_at: walk.game.gameday,
        freeze_at: freezeAt,
        evidence: { urls: [pfrBoxscoreUrl(walk.game)], note: `returned ${walk.game.gameday}, day ${daysFrom(ctx.injury_date, walk.game.gameday)}`, game_ids: [walk.game.game_id] },
      }
    );
  }

  const after = forecastAfterFreeze(dayFreeze, ctx);
  if (after) return after;

  // Returned after day 28, or no return: a 0 needs every game inside the window
  // to be completed and covered, and the window (or the season) to be over.
  const inWindow = gamesAfter(games, ctx.injury_date).filter((g) => compareDates(g.gameday, day28) <= 0);
  const pending = inWindow.find((g) => !g.completed);
  if (pending) return { status: 'open', reason: 'game_not_completed', freeze_at: dayFreeze };
  const uncovered = inWindow.find((g) => !gameCoveredBySnaps(facts.snaps, g.game_id));
  if (uncovered) return { status: 'open', reason: 'awaiting_snap_counts', freeze_at: dayFreeze };

  const seasonOver = walk.kind === 'season_over';
  if (!seasonOver && compareDates(facts.today, day28) <= 0) {
    return { status: 'open', reason: 'before_resolution_window', freeze_at: dayFreeze };
  }
  const resolvedAt = seasonOver && inWindow.length > 0 && compareDates(inWindow[inWindow.length - 1].gameday, day28) < 0
    ? inWindow[inWindow.length - 1].gameday
    : day28;
  const v = voidingTransaction(facts.transactions, ctx.injury_date, addDays(resolvedAt, 1));
  if (v) return voidDecision(v, dayFreeze);
  return {
    status: 'resolved',
    outcome: 0,
    resolved_at: resolvedAt,
    freeze_at: dayFreeze,
    evidence: {
      urls: inWindow.map(pfrBoxscoreUrl),
      note: `no snaps in ${inWindow.length} game(s) through ${resolvedAt}${seasonOver ? ' (season over)' : ''}`,
      game_ids: inWindow.map((g) => g.game_id),
    },
  };
}

/** F4: games missed, injury through the game before first return. Gamebook. */
export function resolveF4(ctx: LedgerEntryContext, facts: ResolutionFacts): FieldDecision {
  if (!ctx.pfr_id) return { status: 'unresolvable', reason: 'no_pfr_id' };
  const games = teamRegularSeasonGames(facts.schedule, ctx.team, ctx.season);
  if (games.length === 0) return { status: 'unresolvable', reason: 'no_schedule_for_team' };
  const walk = walkToFirstReturn(games, facts.snaps, ctx.pfr_id, ctx.injury_date);

  if (walk.kind === 'returned') {
    const freezeAt = kickoffIso(walk.game);
    const v = voidingTransaction(facts.transactions, ctx.injury_date, walk.game.gameday);
    if (v) return voidDecision(v, freezeAt);
    return (
      forecastAfterFreeze(freezeAt, ctx) ?? {
        status: 'resolved',
        outcome: walk.missed.length,
        resolved_at: walk.game.gameday,
        freeze_at: freezeAt,
        evidence: {
          urls: [pfrBoxscoreUrl(walk.game), ...walk.missed.map(pfrBoxscoreUrl)],
          note: `missed ${walk.missed.length} game(s), returned ${walk.game.gameday} (${walk.game.game_id})`,
          game_ids: [walk.game.game_id, ...walk.missed.map((g) => g.game_id)],
        },
      }
    );
  }
  if (walk.kind === 'awaiting_snap_counts') return { status: 'open', reason: 'awaiting_snap_counts', freeze_at: null };
  if (walk.kind === 'no_return_yet') {
    const v = voidingTransaction(facts.transactions, ctx.injury_date, walk.next_game.gameday);
    if (v) return voidDecision(v, null);
    return { status: 'open', reason: 'awaiting_return', freeze_at: null };
  }
  // Season over, no return: "F4 as games remaining".
  const last = walk.missed[walk.missed.length - 1];
  const resolvedAt = last ? last.gameday : ctx.injury_date;
  const freezeAt = last ? kickoffIso(last) : endOfEtDayIso(ctx.injury_date);
  const v = voidingTransaction(facts.transactions, ctx.injury_date, addDays(resolvedAt, 1));
  if (v) return voidDecision(v, freezeAt);
  return (
    forecastAfterFreeze(freezeAt, ctx) ?? {
      status: 'resolved',
      outcome: walk.missed.length,
      resolved_at: resolvedAt,
      freeze_at: freezeAt,
      evidence: {
        urls: walk.missed.map(pfrBoxscoreUrl),
        note: `did not play again this regular season; ${walk.missed.length} game(s) remained after ${ctx.injury_date}`,
        game_ids: walk.missed.map((g) => g.game_id),
      },
    }
  );
}

/** F5: same-site injury on the report AND ≥1 game missed within 6 games of return. */
export function resolveF5(ctx: LedgerEntryContext, facts: ResolutionFacts): FieldDecision {
  if (ctx.base_rate_row === 'concussion' || bodySitesOf(ctx.reported_injury).includes('concussion')) {
    return {
      status: 'void',
      void_reason: 'concussion_rule',
      freeze_at: null,
      evidence: { urls: [], note: 'F5 is void by rule for concussion entries (spec: Evidence strength table)' },
    };
  }
  if (!ctx.pfr_id) return { status: 'unresolvable', reason: 'no_pfr_id' };
  if (!ctx.gsis_id) return { status: 'unresolvable', reason: 'no_gsis_id' };
  const games = teamRegularSeasonGames(facts.schedule, ctx.team, ctx.season);
  if (games.length === 0) return { status: 'unresolvable', reason: 'no_schedule_for_team' };
  const walk = walkToFirstReturn(games, facts.snaps, ctx.pfr_id, ctx.injury_date);
  if (walk.kind === 'awaiting_snap_counts') return { status: 'open', reason: 'awaiting_snap_counts', freeze_at: null };
  if (walk.kind === 'no_return_yet') {
    const v = voidingTransaction(facts.transactions, ctx.injury_date, walk.next_game.gameday);
    if (v) return voidDecision(v, null);
    return { status: 'open', reason: 'awaiting_return', freeze_at: null };
  }
  if (walk.kind === 'season_over') {
    return {
      status: 'void',
      void_reason: 'no_return_this_season',
      freeze_at: null,
      evidence: { urls: [], note: 'no return this regular season, so no re-injury clock started' },
    };
  }

  const returnGame = walk.game;
  const freezeAt = kickoffIso(returnGame);
  const after = forecastAfterFreeze(freezeAt, ctx);
  if (after) return after;
  const v0 = voidingTransaction(facts.transactions, ctx.injury_date, returnGame.gameday);
  if (v0) return voidDecision(v0, freezeAt);

  const span = gamesAfter(games, returnGame.gameday).slice(0, F5_GAMES);
  const entrySites = bodySitesOf(ctx.reported_injury);
  const reportsForPlayer = facts.injuries.filter((r) => r.gsis_id === ctx.gsis_id && r.season === ctx.season);

  let sameSiteWeek: number | null = null;
  for (const g of span) {
    // Walk in order so a void dated before the deciding game still voids.
    const v = voidingTransaction(facts.transactions, returnGame.gameday, g.gameday);
    if (v) return voidDecision(v, freezeAt);
    if (sameSiteWeek === null) {
      const named = reportsForPlayer.some((r) => r.week === g.week && reportNamesSameSite(r, entrySites));
      if (named) sameSiteWeek = g.week;
    }
    if (!g.completed) return { status: 'open', reason: 'awaiting_f5_window', freeze_at: freezeAt };
    if (!gameCoveredBySnaps(facts.snaps, g.game_id)) return { status: 'open', reason: 'awaiting_snap_counts', freeze_at: freezeAt };
    const missed = !playedInGame(facts.snaps, ctx.pfr_id, g.game_id);
    if (sameSiteWeek !== null && missed) {
      return {
        status: 'resolved',
        outcome: 1,
        resolved_at: g.gameday,
        freeze_at: freezeAt,
        evidence: {
          urls: [pfrBoxscoreUrl(g)],
          note: `same-site listing on the week ${sameSiteWeek} report; missed ${g.game_id} (${g.gameday})`,
          game_ids: [g.game_id],
        },
      };
    }
  }

  // The window has closed (six games, or the season ended short of six) with no hit.
  const windowShort = span.length < F5_GAMES;
  if (windowShort) {
    const seasonDone = games.every((g) => g.completed);
    if (!seasonDone) return { status: 'open', reason: 'awaiting_f5_window', freeze_at: freezeAt };
  }
  const lastGame = span[span.length - 1] ?? returnGame;
  return {
    status: 'resolved',
    outcome: 0,
    resolved_at: lastGame.gameday,
    freeze_at: freezeAt,
    evidence: {
      urls: span.map(pfrBoxscoreUrl),
      note: `no same-site listing with a missed game across ${span.length} game(s) after the ${returnGame.gameday} return${windowShort ? ' (season ended)' : ''}`,
      game_ids: span.map((g) => g.game_id),
    },
  };
}

export function resolveField(field: LedgerField, ctx: LedgerEntryContext, facts: ResolutionFacts): FieldDecision {
  switch (field) {
    case 'F1':
      return resolveF1(ctx, facts);
    case 'F2':
      return resolveF2(ctx, facts);
    case 'F3':
      return resolveF3(ctx, facts);
    case 'F4':
      return resolveF4(ctx, facts);
    case 'F5':
      return resolveF5(ctx, facts);
  }
}

// ── Cross-cutting rules ────────────────────────────────────────────────

/**
 * Season-ending flag (spec "Prediction taxonomy"): F3 < 5% and the F4 lower
 * bound exceeds the regular-season games remaining after the injury date.
 */
export function seasonEndingFlag(f3_4wk: number, f4_low: number, remainingGames: number): boolean {
  return f3_4wk < 0.05 && f4_low > remainingGames;
}

/**
 * A revision counts for a field only if it was published strictly before that
 * field's freeze point (spec "Freeze point per field"). Stored regardless;
 * excluded at scoring.
 */
export function revisionCountsForField(publishedAt: string, freezeAt: string): boolean {
  return compareInstants(publishedAt, freezeAt) < 0;
}
