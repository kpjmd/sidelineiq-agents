import type { SportKey } from '../types.js';
import { ESPNInjurySource, type ESPNTeam, type ESPNRosterAthlete } from './sports/espn-base.js';
import { ESPNNFLSource } from './sports/espn-nfl.js';
import { ESPNNBASource } from './sports/espn-nba.js';
import { ESPNPremierLeagueSource } from './sports/espn-premier-league.js';
import { callToolWithRetry } from '../utils/mcp-client-manager.js';

// ESPN roster endpoints exist for NFL/NBA/PremierLeague but not UFC
// (fighters aren't team-rostered). UFC fact validation handles names without
// a current_team requirement — see fact-validator.ts.
const ESPN_ROSTERED_SOURCES: Record<Exclude<SportKey, 'UFC'>, ESPNInjurySource> = {
  NFL: new ESPNNFLSource(),
  NBA: new ESPNNBASource(),
  PREMIER_LEAGUE: new ESPNPremierLeagueSource(),
};

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const STARTUP_DELAY_MS = 30 * 1000;             // let other services initialize first

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function getIntervalMs(): number {
  const raw = process.env.ROSTER_SYNC_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

interface UpsertTeamResponse {
  team: { id: string; espn_team_id: string };
}

async function upsertTeam(sport: SportKey, t: ESPNTeam): Promise<string | null> {
  try {
    const res = (await callToolWithRetry('web', 'web_upsert_team', {
      sport,
      espn_team_id: t.espn_team_id,
      name: t.name,
      abbreviation: t.abbreviation,
      location: t.location,
      display_name: t.display_name,
    })) as { content?: Array<{ text?: string }> };
    const text = res?.content?.[0]?.text;
    if (!text) return null;
    const parsed = JSON.parse(text) as UpsertTeamResponse;
    return parsed.team?.id ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[RosterSync] ${sport} team upsert failed for ${t.name}: ${message}`);
    return null;
  }
}

async function upsertPlayer(
  sport: SportKey,
  teamId: string,
  a: ESPNRosterAthlete,
): Promise<boolean> {
  try {
    await callToolWithRetry('web', 'web_upsert_player', {
      sport,
      espn_athlete_id: a.espn_athlete_id,
      full_name: a.full_name,
      current_team_id: teamId,
      position: a.position,
      jersey: a.jersey,
      prominence_source: 'espn',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[RosterSync] ${sport} player upsert failed for ${a.full_name}: ${message}`);
    return false;
  }
}

interface SyncSummary {
  sport: SportKey;
  teams_fetched: number;
  teams_upserted: number;
  players_fetched: number;
  players_upserted: number;
  errors: number;
}

async function syncSport(
  sport: SportKey,
  source: ESPNInjurySource,
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    sport,
    teams_fetched: 0,
    teams_upserted: 0,
    players_fetched: 0,
    players_upserted: 0,
    errors: 0,
  };

  const teams = await source.fetchTeams();
  summary.teams_fetched = teams.length;
  if (teams.length === 0) {
    console.warn(`[RosterSync] ${sport} — no teams fetched`);
    return summary;
  }

  for (const team of teams) {
    const teamId = await upsertTeam(sport, team);
    if (!teamId) {
      summary.errors++;
      continue;
    }
    summary.teams_upserted++;

    const athletes = await source.fetchRoster(team.espn_team_id);
    summary.players_fetched += athletes.length;
    for (const athlete of athletes) {
      if (await upsertPlayer(sport, teamId, athlete)) {
        summary.players_upserted++;
      } else {
        summary.errors++;
      }
    }
  }

  console.log(
    `[RosterSync] ${sport} — teams=${summary.teams_upserted}/${summary.teams_fetched} players=${summary.players_upserted}/${summary.players_fetched} errors=${summary.errors}`,
  );
  return summary;
}

export async function syncAllRosters(): Promise<SyncSummary[]> {
  const results: SyncSummary[] = [];
  for (const [sport, source] of Object.entries(ESPN_ROSTERED_SOURCES) as [
    SportKey,
    ESPNInjurySource,
  ][]) {
    try {
      results.push(await syncSport(sport, source));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[RosterSync] ${sport} — cycle crashed: ${message}`);
    }
  }
  return results;
}

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await syncAllRosters();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[RosterSync] cycle crashed: ${message}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

export function startRosterSync(): void {
  if (process.env.ROSTER_SYNC_ENABLED === 'false') {
    console.log('[RosterSync] ROSTER_SYNC_ENABLED=false — skipping startup');
    return;
  }

  stopped = false;
  const intervalMs = getIntervalMs();
  console.log(
    `[RosterSync] Starting — interval=${intervalMs}ms (first run in ${STARTUP_DELAY_MS}ms)`,
  );
  // Delay initial run so MCP clients have time to connect
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

export function stopRosterSync(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[RosterSync] Stopped');
}
