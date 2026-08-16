// Loads the non-salary prominence signals that back derived athlete tiers for
// the two sports ESPN publishes no contract data for, and installs them into
// significance.ts.
//
// Two providers, one per sport, because the sports do not share a notion of
// prominence:
//
//   PREMIER_LEAGUE — the athlete's CLUB, read from the players table that
//   roster-sync already maintains. Free of new upstream dependencies, and it
//   self-refreshes through transfers: a player who leaves Arsenal stops being
//   tier 2 on the next roster cycle without anyone editing a file.
//
//   UFC — the fighter's best CARD SLOT across a rolling window of ESPN's MMA
//   scoreboard. UFC has no roster to read (fighters are not team-rostered, so
//   the players table holds zero UFC rows) and no disclosed pay, so this is the
//   only prominence signal the sport actually publishes. It is also the honest
//   one: card position IS how the promotion itself ranks its fighters.
//
// Mirrors salary-snapshot.ts deliberately, down to the failure modes — never
// throws, never commits a partial read, keeps the previous snapshot on any
// error. A half-loaded snapshot would silently demote every athlete in the
// missing pages with no exception and no symptom other than a quiet drop in
// prominence. See that file's header for why this is not folded into
// loadSignificanceData().

import { callTool, isServerAvailable } from '../../utils/mcp-client-manager.js';
import {
  fetchUfcScoreboardEvents,
  isExcludedEvent,
  isPlaceholderFighter,
  type ScoreboardCompetitor,
} from '../../monitoring/sports/espn-ufc-scoreboard.js';
import {
  setDerivedTierSnapshot,
  derivedSnapshotSize,
  getLoadedDerivedConfig,
  type DerivedRow,
  type DerivedTierConfig,
  type CardSlot,
} from './significance.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // matches roster-sync's cadence
const PAGE_SIZE = 200;                     // web_list_players' hard maximum
const MAX_PAGES = 60;                      // runaway backstop, ~3x the population

/**
 * The floor below which a Premier League squad read is not believable.
 *
 * Same guard as tier-file-audit.ts's MIN_PLAUSIBLE_ROSTER, for the same reason:
 * `fetchTeams`-style reads fail by returning nothing rather than by throwing,
 * so absence is never evidence. 20 clubs held 910 in-coverage players on
 * 2026-08-15; 400 is comfortably under any real squad list and far above what a
 * broken read returns.
 */
const MIN_PLAUSIBLE_PL_PLAYERS = 400;

let lastRefreshedAt = 0;

function ttlMs(): number {
  const raw = process.env.DERIVED_TIER_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Whether derived tiers are switched on.
 *
 * Opt-in, following SALARY_TIER_ENABLED and DATE_RESOLUTION_ENABLED: the
 * feature ships dark so the snapshot can be watched refreshing in production
 * before it is allowed to change a single tier.
 */
export function derivedTiersEnabled(): boolean {
  return process.env.DERIVED_TIER_ENABLED === 'true';
}

// ── Premier League: club provider ────────────────────────────────────────────

interface ListTeamsRow {
  id?: string;
  espn_team_id?: string;
  name?: string;
  left_coverage_at?: string | null;
}
interface ListPlayersRow {
  full_name?: string;
  sport?: string;
  current_team_id?: string | null;
}

function unwrap<T>(res: unknown): T | null {
  try {
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Every in-coverage Premier League player, tagged with their club's ESPN id.
 *
 * Returns null — meaning "abort, keep the old snapshot" — rather than a short
 * list, on any failed page or implausibly small result.
 *
 * Note `coverage: 'in'` on BOTH reads. An out-of-coverage club is one that left
 * the division (relegation); its players are deliberately withheld from
 * publishing, and a player who moved to a club outside our scope should not
 * carry a Premier League prominence tier.
 */
async function loadClubRows(sport: string): Promise<DerivedRow[] | null> {
  const teamsRes = await callTool('web', 'web_list_teams', { sport, coverage: 'in', limit: 200 });
  const teams = unwrap<{ teams?: ListTeamsRow[] }>(teamsRes)?.teams;
  if (!teams || teams.length === 0) {
    console.warn(`[DerivedTierSnapshot] ${sport} returned no in-coverage teams — aborting refresh`);
    return null;
  }

  const clubById = new Map<string, { espn_team_id: string; team_name?: string }>();
  for (const t of teams) {
    if (t.id && t.espn_team_id) clubById.set(t.id, { espn_team_id: String(t.espn_team_id), team_name: t.name });
  }

  const rows: DerivedRow[] = [];
  let offset = 0;
  let pages = 0;
  let seen = 0;
  while (pages < MAX_PAGES) {
    let parsed: { players?: ListPlayersRow[]; has_more?: boolean; next_offset?: number } | null;
    try {
      const res = await callTool('web', 'web_list_players', {
        sport,
        coverage: 'in',
        limit: PAGE_SIZE,
        offset,
      });
      parsed = unwrap(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DerivedTierSnapshot] ${sport} page at offset ${offset} failed (${message}) — ` +
          'aborting refresh and keeping the previous snapshot',
      );
      return null;
    }
    if (!parsed) {
      console.warn(
        `[DerivedTierSnapshot] ${sport} page at offset ${offset} returned an unreadable body — ` +
          'aborting refresh and keeping the previous snapshot',
      );
      return null;
    }

    for (const p of parsed.players ?? []) {
      seen++;
      // A player with no club is skipped, not fatal — same bad-row-vs-bad-page
      // split as the salary snapshot. They simply have no club signal.
      const club = p.current_team_id ? clubById.get(p.current_team_id) : undefined;
      if (!p.full_name || !club) continue;
      rows.push({
        full_name: p.full_name,
        // The LOOP CONSTANT, never p.sport — these rows were requested with a
        // sport filter, so it is what we actually know. See salary-snapshot.ts.
        sport,
        signal: { kind: 'club', espn_team_id: club.espn_team_id, team_name: club.team_name },
      });
    }

    pages++;
    if (!parsed.has_more) break;
    offset = parsed.next_offset ?? offset + PAGE_SIZE;
  }

  if (seen < MIN_PLAUSIBLE_PL_PLAYERS) {
    console.warn(
      `[DerivedTierSnapshot] ${sport} returned only ${seen} players (expected at least ` +
        `${MIN_PLAUSIBLE_PL_PLAYERS}) — treating as a failed read and keeping the previous snapshot`,
    );
    return null;
  }
  console.log(
    `[DerivedTierSnapshot] ${sport} club: ${rows.length}/${seen} players across ${clubById.size} clubs`,
  );
  return rows;
}

// ── UFC: card provider ───────────────────────────────────────────────────────

/**
 * A numbered pay-per-view — "UFC 330: Makhachev vs. Machado Garry". These are
 * the sport's tentpole events; everything else UFC-branded (Fight Night, Noche
 * UFC, UFC on ABC) is a weekly card.
 *
 * ESPN publishes no card-segment field, so the event NAME is the only marker of
 * a card's stature and the bout ORDER is the only marker of position within it.
 * Verified against the live scoreboard on 2026-08-15: competitions[] runs first
 * prelim → main event, and `competitor.order` is the corner (1 or 2), not the
 * card position.
 */
function isNumberedPPV(eventName: string): boolean {
  return /^UFC\s+\d+/i.test(eventName);
}

function hasBelt(competitor: ScoreboardCompetitor): boolean {
  return (competitor.athlete?.accolades ?? []).some((a) => a.type === 'Belt');
}

/**
 * Slot for ONE fighter in the bout at `index` of `total`.
 *
 * Resolved per fighter rather than per bout because the belt accolade belongs
 * to the athlete. Mackenzie Dern held the strawweight title while fighting the
 * co-main at UFC 330: she is a champion, her opponent is a co-main fighter, and
 * a per-bout rule would have handed both of them tier 1 off one person's belt.
 */
function slotFor(index: number, total: number, ppv: boolean, champion: boolean): CardSlot | null {
  if (champion) return 'champion';
  const fromTop = total - 1 - index; // 0 = main event, 1 = co-main
  if (fromTop === 0) return ppv ? 'ppv_main_event' : 'fight_night_main_event';
  if (fromTop === 1) return ppv ? 'ppv_co_main' : 'fight_night_co_main';
  // The main card is the televised portion — the last five bouts on a
  // pay-per-view. Below that are prelims, which confer nothing. Fight Nights
  // have no equivalent distinction worth drawing: the whole card is one show.
  if (ppv && fromTop < 5) return 'ppv_main_card';
  return null;
}

/** Slots ordered best-first, so a fighter keeps their strongest recent billing. */
const SLOT_RANK: CardSlot[] = [
  'champion',
  'ppv_main_event',
  'ppv_co_main',
  'ppv_main_card',
  'fight_night_main_event',
  'fight_night_co_main',
];

/**
 * Every fighter who appeared on, or is booked for, a UFC card in the window,
 * tagged with their best slot.
 *
 * The fetch (and its whole-or-nothing failure semantics) lives in
 * espn-ufc-scoreboard.ts, which roster-sync reads too: a fighter silently
 * absent from a partial read would be demoted to the flat default here, and
 * would look like a fighter who does not exist there.
 */
async function loadCardRows(
  sport: string,
  windowBackDays: number,
  windowForwardDays: number,
  now: Date,
): Promise<DerivedRow[] | null> {
  const events = await fetchUfcScoreboardEvents(windowBackDays, windowForwardDays, now);
  if (events === null) {
    console.warn('[DerivedTierSnapshot] UFC scoreboard read failed — keeping the previous snapshot');
    return null;
  }

  const best = new Map<string, DerivedRow>();
  let bouts = 0;
  for (const event of events) {
    const eventName = event.name ?? '';
    if (!eventName || isExcludedEvent(eventName)) continue;
    const competitions = event.competitions ?? [];
    const ppv = isNumberedPPV(eventName);

    competitions.forEach((competition, index) => {
      let ranked = false;
      for (const competitor of competition.competitors ?? []) {
        const name = competitor.athlete?.displayName;
        if (!name || isPlaceholderFighter(name)) continue;
        const slot = slotFor(index, competitions.length, ppv, hasBelt(competitor));
        if (!slot) continue;
        ranked = true;
        const candidate: DerivedRow = {
          full_name: name,
          sport,
          signal: { kind: 'card', slot, event_name: eventName, event_date: event.date ?? '' },
        };
        const existing = best.get(name);
        if (!existing || betterSlot(candidate, existing)) best.set(name, candidate);
      }
      if (ranked) bouts++;
    });
  }

  const rows = [...best.values()];
  console.log(
    `[DerivedTierSnapshot] ${sport} card: ${rows.length} fighters from ${bouts} ranked bouts ` +
      `across ${events.length} events`,
  );
  return rows;
}

function betterSlot(a: DerivedRow, b: DerivedRow): boolean {
  if (a.signal.kind !== 'card' || b.signal.kind !== 'card') return false;
  return SLOT_RANK.indexOf(a.signal.slot) < SLOT_RANK.indexOf(b.signal.slot);
}

// ── Refresh ──────────────────────────────────────────────────────────────────

/**
 * Refresh the snapshot regardless of TTL. Returns whether it succeeded.
 *
 * NEVER THROWS, and never commits a partial read: the accumulator is local and
 * only swapped in once every provider has come back clean. One failing provider
 * aborts the whole refresh rather than installing a snapshot missing a sport,
 * because "no rows for UFC" and "UFC has no prominent fighters" are
 * indistinguishable downstream.
 */
export async function refreshDerivedTierSnapshot(now: Date = new Date()): Promise<boolean> {
  const config = getDerivedConfigs();
  if (config.length === 0) return false;

  const started = Date.now();
  const accumulated: DerivedRow[] = [];

  for (const { sport, cfg } of config) {
    if (cfg.kind === 'club') {
      if (!isServerAvailable('web')) {
        console.warn('[DerivedTierSnapshot] web MCP unavailable — keeping the previous snapshot');
        return false;
      }
      const rows = await loadClubRows(sport);
      if (rows === null) return false;
      accumulated.push(...rows);
    } else if (cfg.kind === 'card') {
      const rows = await loadCardRows(
        sport,
        cfg.window_days_back ?? 180,
        cfg.window_days_forward ?? 90,
        now,
      );
      if (rows === null) return false;
      accumulated.push(...rows);
    }
  }

  setDerivedTierSnapshot(accumulated);
  lastRefreshedAt = Date.now();
  console.log(
    `[DerivedTierSnapshot] ${derivedSnapshotSize()} athletes indexed in ${Date.now() - started}ms`,
  );
  return true;
}

/**
 * The configured providers. Read through significance.ts's loaded config so
 * that validation (which drops malformed entries) has already run.
 */
function getDerivedConfigs(): Array<{ sport: string; cfg: DerivedTierConfig }> {
  const cfg = getLoadedDerivedConfig();
  if (!cfg) return [];
  return Object.entries(cfg).map(([sport, value]) => ({ sport, cfg: value }));
}

/** Refresh only when the TTL has expired — what the poll cycle calls. */
export async function refreshDerivedTierSnapshotIfStale(now: Date = new Date()): Promise<void> {
  if (!derivedTiersEnabled()) return;
  if (Date.now() - lastRefreshedAt < ttlMs()) return;
  await refreshDerivedTierSnapshot(now);
}

/** Drop the TTL so the next refresh actually reads. Called by roster-sync. */
export function invalidateDerivedTierSnapshot(): void {
  lastRefreshedAt = 0;
}

/** Test seam — resets the TTL clock without touching the installed snapshot. */
export function _resetDerivedSnapshotTimerForTesting(): void {
  lastRefreshedAt = 0;
}

// Exported for the dry-run script and tests, which need to classify a
// scoreboard payload without performing a live refresh.
export const _internals = {
  slotFor,
  isNumberedPPV,
  isExcludedEvent,
  SLOT_RANK,
  loadCardRows,
  loadClubRows,
};
