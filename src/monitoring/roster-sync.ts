import type { SportKey } from '../types.js';
import { ESPNInjurySource, type ESPNTeam, type ESPNRosterAthlete } from './sports/espn-base.js';
import { ESPNNFLSource } from './sports/espn-nfl.js';
import { ESPNNBASource } from './sports/espn-nba.js';
import { ESPNPremierLeagueSource } from './sports/espn-premier-league.js';
import { callToolWithRetry } from '../utils/mcp-client-manager.js';
import { hasSalaryBands } from '../agents/injury-intelligence/significance.js';
import { invalidateTierSnapshots } from '../agents/injury-intelligence/tier-snapshots.js';

// ESPN roster endpoints exist for NFL/NBA/PremierLeague but not UFC
// (fighters aren't team-rostered). UFC fact validation handles names without
// a current_team requirement — see fact-validator.ts.
export const ESPN_ROSTERED_SOURCES: Record<Exclude<SportKey, 'UFC'>, ESPNInjurySource> = {
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
      // Omitted, not nulled, when ESPN reports no contract: the server
      // COALESCEs, so omission preserves a salary an earlier cycle found. A
      // third of NFL athletes legitimately have none on any given cycle.
      salary: a.salary,
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
  /** Athletes ESPN reported a contract salary for. Logged every cycle because
   *  it is the only thing that would surface an ESPN contract-shape change:
   *  extractSalary returning undefined league-wide is silent everywhere else,
   *  and would just look like every athlete quietly reverting to tier 3. */
  players_with_salary: number;
  errors: number;
  /** In-coverage teams we hold that ESPN's feed no longer returns. -1 means the
   *  check did not run (a precondition failed); 0 means it ran and found none.
   *  Reported, never acted on — see diffCoverage. */
  teams_absent_from_feed: number;
}

export interface CoverageTeamRow {
  espn_team_id: string | null;
  name: string;
  last_synced_at?: string | null;
}

/**
 * Pure set difference between the in-coverage teams we hold and the teams ESPN
 * just returned, keyed on espn_team_id.
 *
 * Only the DB-minus-feed direction is reported. A team in the feed but not the
 * DB is a promotion or expansion, and the same cycle's upsert loop already
 * handles it — reporting it would be pure noise.
 *
 * Rows with no espn_team_id are skipped: they were hand-entered and were never
 * in the feed to begin with, so their absence is not drift.
 *
 * Pure so it can be tested without network or MCP.
 */
export function diffCoverage(
  dbInCoverage: CoverageTeamRow[],
  feed: ESPNTeam[],
): CoverageTeamRow[] {
  const feedIds = new Set(feed.map((t) => t.espn_team_id));
  return dbInCoverage.filter((t) => t.espn_team_id != null && !feedIds.has(t.espn_team_id));
}

interface ListTeamsResponse {
  teams: CoverageTeamRow[];
}

async function listInCoverageTeams(sport: SportKey): Promise<CoverageTeamRow[] | null> {
  try {
    const res = (await callToolWithRetry('web', 'web_list_teams', {
      sport,
      coverage: 'in',
      limit: 200,
    })) as { content?: Array<{ text?: string }> };
    const text = res?.content?.[0]?.text;
    if (!text) return null;
    return (JSON.parse(text) as ListTeamsResponse).teams ?? null;
  } catch {
    // Deliberately silent. A drift warning derived from a failed read is worse
    // than no warning: it would name teams as missing from ESPN on the strength
    // of our own MCP call failing.
    return null;
  }
}

/**
 * Reports — never repairs — in-coverage teams that ESPN stopped returning.
 *
 * This does not mutate anything, and it must not. fetchTeams returns [] on any
 * non-OK status, any throw, and any shape change under sports[0].leagues[0], so
 * its failure mode is spurious ABSENCE: one bad response is indistinguishable
 * from an entire league being relegated at once. Presence in the feed is
 * trustworthy (upsertTeam acts on it, which is what makes promotion self-heal);
 * absence is not, and is only ever acted on by a human running
 * scripts/reconcile-coverage-scope.ts.
 */
async function reportCoverageDrift(
  sport: SportKey,
  source: ESPNInjurySource,
  teams: ESPNTeam[],
  summary: SyncSummary,
): Promise<void> {
  // Every precondition below exists because a partial or degraded cycle cannot
  // make a claim about the FULL set of teams, which is exactly what a set
  // difference is.
  if (summary.errors > 0) return;
  if (summary.teams_upserted !== summary.teams_fetched) return;
  if (teams.length < source.expectedMinTeams) {
    console.warn(
      `[RosterSync] ${sport} — feed returned ${teams.length} teams, below the ${source.expectedMinTeams} floor; skipping coverage-drift check`,
    );
    return;
  }

  const dbTeams = await listInCoverageTeams(sport);
  if (dbTeams === null) return;

  const absent = diffCoverage(dbTeams, teams);
  summary.teams_absent_from_feed = absent.length;
  if (absent.length === 0) return;

  const lines = absent
    .map((t) => `  ${t.name} (espn=${t.espn_team_id}, last_synced=${t.last_synced_at ?? 'unknown'})`)
    .join('\n');
  // This fires every cycle until someone acts, so it has to carry its own
  // remediation rather than assume the reader knows what to do with it.
  console.warn(
    `[RosterSync] ${sport} — coverage drift: ${absent.length} in-coverage team(s) held in DB but absent from the ESPN feed:\n${lines}\n` +
      `  → not auto-resolved (absence is not evidence). To investigate:\n` +
      `    npx tsx src/scripts/reconcile-coverage-scope.ts --sport=${sport}`,
  );
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
    players_with_salary: 0,
    errors: 0,
    teams_absent_from_feed: -1,
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
        if (athlete.salary !== undefined) summary.players_with_salary++;
      } else {
        summary.errors++;
      }
    }
  }

  // After the loop: the preconditions read summary.errors and teams_upserted,
  // which only exist once every team has been attempted.
  await reportCoverageDrift(sport, source, teams, summary);

  console.log(
    `[RosterSync] ${sport} — teams=${summary.teams_upserted}/${summary.teams_fetched} players=${summary.players_upserted}/${summary.players_fetched} salary=${summary.players_with_salary} errors=${summary.errors} absent_from_feed=${summary.teams_absent_from_feed}`,
  );

  // A sport with configured salary bands is one we believe ESPN reports
  // contracts for. If that collapses, every athlete in it silently reverts to
  // the flat tier-3 default — a change with no error, no exception and no
  // other symptom. Live coverage when the bands were calibrated was 68% (NFL)
  // and 74% (NBA), so 20% is far below any plausible roster churn and can only
  // mean the contract shape moved under extractSalary.
  if (hasSalaryBands(sport) && summary.players_upserted > 0) {
    const pct = (100 * summary.players_with_salary) / summary.players_upserted;
    if (pct < 20) {
      console.warn(
        `[RosterSync] ${sport} — salary coverage ${pct.toFixed(1)}% ` +
          `(${summary.players_with_salary}/${summary.players_upserted}), expected ~70%. ` +
          `ESPN's contract shape has probably changed; extractSalary in espn-base.ts ` +
          `needs updating. Until then every unlisted ${sport} athlete defaults to tier 3.`,
      );
    }
  }
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
  // This loop is the only thing that changes salaries, so the snapshot's 6h TTL
  // is measured from the wrong event without this. Without it a freshly synced
  // salary could sit unused for most of a TTL window for no reason.
  invalidateTierSnapshots();
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
