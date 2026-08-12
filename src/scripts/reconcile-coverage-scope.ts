// Seasonal reconciliation for clubs that leave our editorial coverage.
//
// Relegation is annual and predictable, and a club that drops out of ESPN's
// eng.1 feed does NOT stop existing — it keeps playing, keeps a roster, and may
// be promoted back. The 6h roster sync deliberately refuses to act on a team's
// absence (fetchTeams returns [] on any error, so one bad response is
// indistinguishable from a mass relegation); it only reports drift. This script
// is where a human resolves that report.
//
// What it does, per candidate club:
//   1. Confirms the club still EXISTS upstream, in a secondary league feed.
//      Absence from both is an unknown state, not a departure → skipped.
//   2. Asks ESPN where each of its players actually is now, one player at a
//      time, via the league-agnostic athlete endpoint. This is the only source
//      that answers "where is this player" once the team roster endpoint stops
//      covering our league — a roster diff between eng.1 and eng.2 is NOT a
//      substitute, it reports players as departed who never left.
//   3. Repoints players who genuinely moved onto their true club, creating that
//      club as an out-of-coverage row when we do not already hold it.
//   4. Only then marks the club itself out of coverage.
//
// Order matters: repoint BEFORE flagging. If the run dies midway, every
// intermediate state is then still truthful — some players fixed, club still
// visible — rather than "club hidden, players still wrong".
//
// Why repoint at all, when flagging the club already hides everyone: on
// promotion, upsertTeam clears the club's coverage flag and re-syncs its
// roster, but upsertPlayer COALESCEs current_team_id and so can never CLEAR a
// stale one. The players who left would silently resurface pointing at a club
// they no longer play for, at exactly the moment that league's volume returns.
//
// What it cannot fix: a player who moved to a league we do not cover gets a
// CORRECT current_team_id but stays unresolvable, because his new club is out
// of coverage too. That is the right end state, not a gap.
//
// Usage:
//   npx tsx src/scripts/reconcile-coverage-scope.ts --sport=PREMIER_LEAGUE
//   npx tsx src/scripts/reconcile-coverage-scope.ts --sport=PREMIER_LEAGUE --apply
//
// Dry run is the DEFAULT here, unlike the other one-shot scripts in this
// directory, and --apply is required to write anything. This rewires roster
// identity for whole clubs at once and runs roughly once a year, so nobody has
// muscle memory for it.

import 'dotenv/config';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { type ESPNTeam } from '../monitoring/sports/espn-base.js';
import {
  diffCoverage,
  ESPN_ROSTERED_SOURCES,
  type CoverageTeamRow,
} from '../monitoring/roster-sync.js';
import type { SportKey } from '../types.js';

// ── ESPN, beyond what espn-base exposes ──────────────────────────────────────
// Deliberately local rather than added to ESPNInjurySource. Nothing in the 6h
// polling loop should acquire the ability to make 85 sequential athlete calls;
// this is a once-a-year tool and its network surface stays here.

const ATHLETE_ENDPOINT = 'https://site.web.api.espn.com/apis/common/v3/sports';
const TEAMS_ENDPOINT = 'https://site.api.espn.com/apis/site/v2/sports';

// Where to look for a club that dropped out of the primary feed. Relegation
// from a top flight lands in that country's second tier.
const SECONDARY_LEAGUE_PATH: Partial<Record<SportKey, string>> = {
  PREMIER_LEAGUE: 'soccer/eng.2',
};

// The sport-level path the athlete endpoint is keyed on. It ignores league, so
// only the sport segment matters.
const ATHLETE_SPORT_PATH: Partial<Record<SportKey, string>> = {
  PREMIER_LEAGUE: 'soccer',
  NFL: 'football',
  NBA: 'basketball',
};

const REQUEST_DELAY_MS = 120;
const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJSON<T>(url: string): Promise<T | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      // 400 and 404 are ANSWERS ("no such athlete"), not failures — verified
      // against ESPN, which returns 400 for an unknown athlete id. Retrying
      // them burns three requests and two backoffs per bad id for nothing.
      // Either way the caller writes nothing; this only avoids the waste.
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[reconcile]   fetch failed after ${MAX_ATTEMPTS} attempts: ${url} — ${message}`);
        return null;
      }
      await sleep(REQUEST_DELAY_MS * attempt * 2);
    }
  }
  return null;
}

interface AthleteTeam {
  id: string;
  displayName?: string;
  name?: string;
  abbreviation?: string;
  location?: string;
}

interface AthleteResponse {
  athlete?: { active?: boolean; team?: AthleteTeam | null };
}

/** The player's true current club, anywhere in the world, or null if unknown. */
async function fetchAthleteTeam(
  sport: SportKey,
  espnAthleteId: string,
): Promise<{ team: AthleteTeam | null; active: boolean } | null> {
  const sportPath = ATHLETE_SPORT_PATH[sport];
  if (!sportPath) return null;
  const body = await getJSON<AthleteResponse>(`${ATHLETE_ENDPOINT}/${sportPath}/athletes/${espnAthleteId}`);
  if (!body?.athlete) return null;
  return { team: body.athlete.team ?? null, active: body.athlete.active !== false };
}

interface TeamsResponse {
  sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: { id?: string | number } }> }> }>;
}

/** ESPN team ids present in a secondary league feed, for the existence check. */
async function fetchSecondaryLeagueTeamIds(sport: SportKey): Promise<Set<string> | null> {
  const path = SECONDARY_LEAGUE_PATH[sport];
  if (!path) return null;
  const body = await getJSON<TeamsResponse>(`${TEAMS_ENDPOINT}/${path}/teams`);
  const teams = body?.sports?.[0]?.leagues?.[0]?.teams;
  if (!teams || teams.length === 0) return null;
  return new Set(teams.map((t) => String(t?.team?.id ?? '')).filter(Boolean));
}

// ── MCP plumbing ─────────────────────────────────────────────────────────────

interface MCPResult {
  content?: Array<{ text?: string }>;
}

function unwrap<T>(res: unknown): T | null {
  try {
    const text = (res as MCPResult)?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface DbTeam extends CoverageTeamRow {
  id: string;
  sport: string;
  left_coverage_at: string | null;
}

interface DbPlayer {
  id: string;
  sport: string;
  espn_athlete_id: string | null;
  full_name: string;
  current_team_id: string | null;
}

async function listTeams(sport: SportKey, coverage: 'in' | 'out' | 'all'): Promise<DbTeam[]> {
  const res = await callTool('web', 'web_list_teams', { sport, coverage, limit: 200 });
  return unwrap<{ teams: DbTeam[] }>(res)?.teams ?? [];
}

async function listPlayersForTeam(teamId: string): Promise<DbPlayer[]> {
  const out: DbPlayer[] = [];
  let offset = 0;
  for (;;) {
    const res = await callTool('web', 'web_list_players', {
      team_id: teamId,
      coverage: 'all',
      limit: 200,
      offset,
    });
    const page = unwrap<{ players: DbPlayer[]; has_more: boolean; next_offset: number }>(res);
    if (!page) break;
    out.push(...page.players);
    if (!page.has_more) break;
    offset = page.next_offset;
  }
  return out;
}

// ── Classification ───────────────────────────────────────────────────────────

type Disposition =
  | 'stayed'
  | 'moved_known'
  | 'moved_into_coverage'
  | 'moved_unknown'
  | 'unknown'
  | 'no_espn_id';

interface PlayerOutcome {
  player: DbPlayer;
  disposition: Disposition;
  destination: AthleteTeam | null;
  note: string;
}

interface Summary {
  sport: SportKey;
  candidates: number;
  clubs_flagged: number;
  clubs_skipped: number;
  stayed: number;
  moved_known: number;
  moved_into_coverage: number;
  moved_unknown: number;
  unknown: number;
  no_espn_id: number;
  errors: number;
}

async function classifyPlayer(
  sport: SportKey,
  player: DbPlayer,
  clubEspnId: string,
  teamsByEspnId: Map<string, DbTeam>,
  inCoverageEspnIds: Set<string>,
): Promise<PlayerOutcome> {
  if (!player.espn_athlete_id) {
    return { player, disposition: 'no_espn_id', destination: null, note: 'no espn_athlete_id to probe' };
  }

  const probe = await fetchAthleteTeam(sport, player.espn_athlete_id);
  await sleep(REQUEST_DELAY_MS);

  // A failed probe is NEVER evidence of a move. Same rule as the team-level
  // absence check: we write nothing on a non-answer.
  if (!probe) {
    return { player, disposition: 'unknown', destination: null, note: 'athlete lookup failed' };
  }
  if (!probe.team?.id) {
    return {
      player,
      disposition: 'unknown',
      destination: null,
      note: probe.active ? 'no team reported (unsigned?)' : 'reported inactive, no team',
    };
  }

  const destId = String(probe.team.id);
  if (destId === clubEspnId) {
    return { player, disposition: 'stayed', destination: probe.team, note: 'still at this club' };
  }
  if (inCoverageEspnIds.has(destId)) {
    // Roster sync will repoint this player on its next cycle; racing it here
    // would just duplicate the write.
    return {
      player,
      disposition: 'moved_into_coverage',
      destination: probe.team,
      note: 'moved to an in-coverage club; roster sync will repoint',
    };
  }
  return {
    player,
    disposition: teamsByEspnId.has(destId) ? 'moved_known' : 'moved_unknown',
    destination: probe.team,
    note: teamsByEspnId.has(destId) ? 'moved to a club we hold' : 'moved to a club we do not hold',
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

function teamName(t: AthleteTeam): string {
  return t.displayName ?? t.name ?? `ESPN team ${t.id}`;
}

/**
 * Creates the destination club as an out-of-coverage row and returns its UUID.
 *
 * sport is the MOVING PLAYER's sport, not a truer label for the club: sport is
 * functionally a coverage-namespace here (the relegated clubs already sit under
 * PREMIER_LEAGUE while playing in the Championship), and ESPN soccer ids are
 * global, so (PREMIER_LEAGUE, espn_team_id) is a stable collision-free key for
 * any club on earth. See migration 018's residual-gaps note.
 */
async function ensureOutOfCoverageTeam(
  sport: SportKey,
  dest: AthleteTeam,
  reason: string,
): Promise<string | null> {
  const upserted = unwrap<{ team: { id: string } }>(
    await callTool('web', 'web_upsert_team', {
      sport,
      espn_team_id: String(dest.id),
      name: teamName(dest),
      abbreviation: dest.abbreviation,
      location: dest.location,
      display_name: dest.displayName,
    }),
  );
  const teamId = upserted?.team?.id;
  if (!teamId) return null;

  // upsertTeam's ESPN branch CLEARS left_coverage_at, so this must follow it,
  // never precede it.
  await callTool('web', 'web_set_team_coverage', {
    team_id: teamId,
    in_coverage: false,
    reason,
  });
  return teamId;
}

async function repoint(player: DbPlayer, destTeamId: string, destLabel: string): Promise<void> {
  // full_name is echoed back from OUR row, never re-derived from the athlete
  // endpoint's displayName: upsertPlayer's ESPN branch overwrites
  // normalized_name from it, so a differently-spelled name would silently break
  // every future resolve for this player. Same reason sport comes from the
  // player row rather than the destination club.
  // position/jersey/prominence_* are omitted so they COALESCE through unchanged.
  await callTool('web', 'web_upsert_player', {
    sport: player.sport,
    espn_athlete_id: player.espn_athlete_id,
    full_name: player.full_name,
    current_team_id: destTeamId,
  });
  await callTool('web', 'web_audit_append', {
    actor: 'automation',
    actor_id: 'reconcile-coverage-scope',
    entity_type: 'player',
    entity_id: player.id,
    action: 'repoint_team',
    before: { current_team_id: player.current_team_id },
    after: { current_team_id: destTeamId },
    payload: { reason: 'coverage_scope_reconcile', destination: destLabel },
  });
}

// ── Main flow ────────────────────────────────────────────────────────────────

async function reconcile(sport: SportKey, apply: boolean, minFeedTeams: number): Promise<Summary> {
  const summary: Summary = {
    sport,
    candidates: 0,
    clubs_flagged: 0,
    clubs_skipped: 0,
    stayed: 0,
    moved_known: 0,
    moved_into_coverage: 0,
    moved_unknown: 0,
    unknown: 0,
    no_espn_id: 0,
    errors: 0,
  };

  // Same registry the 6h cycle syncs from, so "what the feed returns" here is
  // definitionally what roster-sync saw.
  const source = ESPN_ROSTERED_SOURCES[sport as Exclude<SportKey, 'UFC'>];
  if (!source) {
    throw new Error(`${sport} has no ESPN roster source; nothing to reconcile`);
  }

  // ── Feed side, with the guard that matters most in this whole script ──
  const feed: ESPNTeam[] = await source.fetchTeams();
  const floor = Math.max(minFeedTeams, source.expectedMinTeams);
  if (feed.length < floor) {
    throw new Error(
      `ESPN returned ${feed.length} ${sport} teams, below the ${floor} floor. ` +
        `fetchTeams returns [] on any error, so a short feed reads as a mass relegation. ` +
        `Refusing to proceed — re-run when the feed is healthy, or lower --min-feed-teams deliberately.`,
    );
  }

  const allTeams = await listTeams(sport, 'all');
  const inCoverage = allTeams.filter((t) => t.left_coverage_at === null);
  const teamsByEspnId = new Map(
    allTeams.filter((t) => t.espn_team_id).map((t) => [t.espn_team_id as string, t]),
  );
  const inCoverageEspnIds = new Set(
    feed.map((t) => t.espn_team_id).filter((id): id is string => Boolean(id)),
  );

  const candidates = diffCoverage(inCoverage, feed) as DbTeam[];
  summary.candidates = candidates.length;
  console.log(
    `[reconcile] ${sport} — db_in_coverage=${inCoverage.length} feed=${feed.length} candidates=${candidates.length}`,
  );

  const promoted = feed.filter((t) => !teamsByEspnId.has(t.espn_team_id));
  if (promoted.length > 0) {
    console.log(
      `[reconcile] ${sport} — ${promoted.length} club(s) in the feed we do not hold (promotions; roster sync handles these): ${promoted.map((t) => t.name).join(', ')}`,
    );
  }
  if (candidates.length === 0) return summary;

  // ── Existence check: confirm, never infer ──
  const secondaryIds = await fetchSecondaryLeagueTeamIds(sport);
  if (secondaryIds === null) {
    console.warn(
      `[reconcile] ${sport} — could not read the secondary league feed; cannot confirm any club still exists. Skipping all candidates.`,
    );
    summary.clubs_skipped = candidates.length;
    return summary;
  }

  // Every player classified this run, so nobody is probed or counted twice.
  //
  // This is reachable whenever a mover's destination is itself a later
  // candidate, which is not a corner case: Ward-Prowse moved Burnley -> West
  // Ham and BOTH clubs were relegated together. Clubs are processed in name
  // order and repointing happens before flagging, so by the time West Ham's
  // roster is read he is already on it, and he would be probed a second time
  // and counted again as 'stayed'. The second pass writes nothing, so this only
  // ever corrupted the summary — but a summary that reports 86 outcomes for 85
  // players is exactly the kind of thing that makes an operator distrust a
  // once-a-year script at the moment they most need to trust it.
  const processedPlayerIds = new Set<string>();

  for (const club of candidates) {
    const clubEspnId = club.espn_team_id as string;
    console.log(`\n[reconcile] ── ${club.name} (espn=${clubEspnId}) ──`);

    if (!secondaryIds.has(clubEspnId)) {
      console.warn(
        `[reconcile]   absent from BOTH the primary and secondary feeds — unknown state, not a confirmed departure. Skipping.`,
      );
      summary.clubs_skipped++;
      continue;
    }

    const roster = await listPlayersForTeam(club.id);
    const players = roster.filter((p) => !processedPlayerIds.has(p.id));
    const alreadySeen = roster.length - players.length;
    console.log(
      `[reconcile]   confirmed alive in the secondary league; probing ${players.length} players` +
        (alreadySeen > 0 ? ` (${alreadySeen} already classified earlier in this run)` : ''),
    );

    const outcomes: PlayerOutcome[] = [];
    for (const player of players) {
      processedPlayerIds.add(player.id);
      try {
        outcomes.push(await classifyPlayer(sport, player, clubEspnId, teamsByEspnId, inCoverageEspnIds));
      } catch (err) {
        summary.errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[reconcile]   ${player.full_name}: ${message}`);
        outcomes.push({ player, disposition: 'unknown', destination: null, note: message });
      }
    }

    for (const o of outcomes) {
      summary[o.disposition]++;
      if (o.disposition === 'stayed') continue;
      const dest = o.destination ? `${teamName(o.destination)} (${o.destination.id})` : '—';
      console.log(`[reconcile]   ${o.disposition.padEnd(20)} ${o.player.full_name} → ${dest}  [${o.note}]`);
    }

    // ── Repoint the movers, BEFORE touching the club's own flag ──
    const movers = outcomes.filter(
      (o) => o.disposition === 'moved_known' || o.disposition === 'moved_unknown',
    );
    for (const o of movers) {
      const dest = o.destination as AthleteTeam;
      const destLabel = `${teamName(dest)} (${dest.id})`;
      if (!apply) {
        console.log(`[reconcile]   DRY RUN would repoint ${o.player.full_name} → ${destLabel}`);
        continue;
      }
      try {
        const destTeamId =
          o.disposition === 'moved_known'
            ? (teamsByEspnId.get(String(dest.id)) as DbTeam).id
            : await ensureOutOfCoverageTeam(
                sport,
                dest,
                `never in coverage — destination club for ${o.player.full_name}`,
              );
        if (!destTeamId) {
          summary.errors++;
          console.error(`[reconcile]   could not resolve a team row for ${destLabel}; leaving player untouched`);
          continue;
        }
        await repoint(o.player, destTeamId, destLabel);
        console.log(`[reconcile]   repointed ${o.player.full_name} → ${destLabel}`);
      } catch (err) {
        summary.errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[reconcile]   repoint failed for ${o.player.full_name}: ${message}`);
      }
    }

    // ── Flag the club, only on a complete picture ──
    // `outcomes` omits players already classified earlier in this run, which is
    // safe for this gate and must stay that way: the only players who can reach
    // a LATER candidate club are ones this run repointed there, and repointing
    // requires a resolved destination. An 'unknown' or 'no_espn_id' player is
    // never repointed, so it can never migrate off the club it is blocking.
    const unresolved = outcomes.filter(
      (o) => o.disposition === 'unknown' || o.disposition === 'no_espn_id',
    ).length;
    if (unresolved > 0) {
      console.warn(
        `[reconcile]   ${unresolved} player(s) unresolved — a partial probe is a partial truth. NOT marking ${club.name} out of coverage.`,
      );
      summary.clubs_skipped++;
      continue;
    }
    if (!apply) {
      console.log(`[reconcile]   DRY RUN would mark ${club.name} out of coverage`);
      continue;
    }
    try {
      await callTool('web', 'web_set_team_coverage', {
        team_id: club.id,
        in_coverage: false,
        reason: `absent from ${sport} feed, confirmed still active in the secondary league`,
      });
      await callTool('web', 'web_audit_append', {
        actor: 'automation',
        actor_id: 'reconcile-coverage-scope',
        entity_type: 'team',
        entity_id: club.id,
        action: 'set_team_coverage',
        before: { left_coverage_at: null },
        after: { left_coverage_at: 'now' },
        payload: { reason: 'coverage_scope_reconcile', sport, espn_team_id: clubEspnId },
      });
      summary.clubs_flagged++;
      console.log(`[reconcile]   marked ${club.name} out of coverage`);
    } catch (err) {
      summary.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile]   failed to flag ${club.name}: ${message}`);
    }
  }

  return summary;
}

function argValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main(): Promise<void> {
  const sport = (argValue('sport') ?? 'PREMIER_LEAGUE') as SportKey;
  const apply = process.argv.includes('--apply');
  const minFeedTeams = Number(argValue('min-feed-teams') ?? 0);

  if (!apply) {
    console.log(
      '[reconcile] DRY RUN (default) — nothing will be written. Re-run with --apply to commit changes.',
    );
  } else {
    console.log(`[reconcile] APPLY MODE — ${sport} roster identity will be modified.`);
  }

  await initializeMCPClients();
  try {
    const summary = await reconcile(sport, apply, minFeedTeams);
    console.log(`\n[reconcile] summary (apply=${apply}):`);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.unknown > 0 || summary.no_espn_id > 0) {
      console.log(
        '[reconcile] NOTE: unresolved players block their club from being flagged. Re-run once ESPN answers for them.',
      );
    }
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[reconcile] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
