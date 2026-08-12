// Loads the players-table salary snapshot that backs salary-derived athlete
// tiers, and installs it into significance.ts.
//
// WHY THIS IS NOT PART OF loadSignificanceData(). That function runs at the top
// of every poll cycle (poller.ts), once per enabled sport, on a 15-minute
// timer — roughly 192 loads/day. Paging ~3,500 player rows at limit 200 is ~18
// MCP calls, so folding it in would cost ~3,456 calls/day to re-read data that
// only changes when roster-sync runs, every 6h. It would also put a network
// dependency on the first statement of every cycle, and make three currently
// hermetic test files (concussion-gate, significance-reachability,
// content-type-drift) MCP-dependent, since they call the real
// loadSignificanceData() in setup. Four explicit call sites is the cheaper
// trade. See refreshSalarySnapshotIfStale's callers.
//
// If the player table ever outgrows this (say >10k rows), the escape hatch is a
// web_list_player_salaries MCP tool returning a compact
// {sport, full_name, salary} projection at limit 5000 — 1-2 calls instead of
// 18. Not worth the extra LLM-facing tool surface today.

import { callTool, isServerAvailable } from '../../utils/mcp-client-manager.js';
import { setSalarySnapshot, salarySnapshotSize, hasSalaryBands } from './significance.js';
import type { SportKey } from '../../types.js';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // matches roster-sync's cadence
const PAGE_SIZE = 200;                     // web_list_players' hard maximum
// Backstop only. has_more is computed server-side from a window function; if it
// ever gets stuck true, an unbounded loop inside the poll cycle would hang
// publishing entirely. 60 pages is 12,000 rows — ~3x the current population.
const MAX_PAGES = 60;

// Sports whose rosters ESPN reports contracts for. PREMIER_LEAGUE is excluded
// at the source: its athletes carry no contract field, so paging it would cost
// calls to import a column that is NULL in every row. UFC has no roster
// endpoint at all.
const CANDIDATE_SPORTS: SportKey[] = ['NFL', 'NBA'];

let lastRefreshedAt = 0;

function ttlMs(): number {
  const raw = process.env.SALARY_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Whether salary-derived tiers are switched on.
 *
 * Opt-in, following the DATE_RESOLUTION_ENABLED precedent: the feature ships
 * dark so the snapshot can be observed refreshing in production before it is
 * allowed to change a single tier.
 */
export function salaryTiersEnabled(): boolean {
  return process.env.SALARY_TIER_ENABLED === 'true';
}

interface ListPlayersRow {
  full_name?: string;
  sport?: string;
  salary?: number | string | null;
}

interface ListPlayersResponse {
  players?: ListPlayersRow[];
  has_more?: boolean;
  next_offset?: number;
}

function unwrap(res: unknown): ListPlayersResponse | null {
  try {
    const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as ListPlayersResponse;
  } catch {
    return null;
  }
}

interface SalaryRow {
  full_name: string;
  sport: string;
  salary: number;
}

/**
 * Refresh the snapshot, regardless of TTL. Returns whether it succeeded.
 *
 * NEVER THROWS, and never commits a partial read. The accumulator is local and
 * only swapped in once every page of every sport has come back clean — a
 * half-loaded snapshot would silently demote every athlete in the missing
 * pages back to the flat default, with no error, no exception and no symptom
 * other than a quiet drop in prominence. On any failure the previous snapshot
 * is kept, matching the "keep existing cache on error" contract the config
 * loads already use.
 */
export async function refreshSalarySnapshot(): Promise<boolean> {
  if (!isServerAvailable('web')) {
    console.warn('[SalarySnapshot] web MCP unavailable — keeping the previous snapshot');
    return false;
  }

  const started = Date.now();
  const accumulated: SalaryRow[] = [];
  const perSport: string[] = [];

  for (const sport of CANDIDATE_SPORTS) {
    if (!hasSalaryBands(sport)) continue; // No bands configured — nothing to use it for.
    let offset = 0;
    let pages = 0;
    let seen = 0;
    let withSalary = 0;

    while (pages < MAX_PAGES) {
      let parsed: ListPlayersResponse | null;
      try {
        const res = await callTool('web', 'web_list_players', {
          sport,
          coverage: 'all',
          limit: PAGE_SIZE,
          offset,
        });
        parsed = unwrap(res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[SalarySnapshot] ${sport} page at offset ${offset} failed (${message}) — ` +
            'aborting refresh and keeping the previous snapshot',
        );
        return false;
      }
      if (!parsed) {
        console.warn(
          `[SalarySnapshot] ${sport} page at offset ${offset} returned an unreadable body — ` +
            'aborting refresh and keeping the previous snapshot',
        );
        return false;
      }

      const rows = parsed.players ?? [];
      seen += rows.length;
      for (const r of rows) {
        // A malformed row is skipped, not fatal: one bad row should not cost
        // the whole league its salaries, unlike a failed page which means we
        // genuinely do not know what we missed.
        const salary = typeof r?.salary === 'string' ? Number(r.salary) : r?.salary;
        if (!r?.full_name || typeof salary !== 'number' || !Number.isFinite(salary) || salary <= 0) {
          continue;
        }
        accumulated.push({ full_name: r.full_name, sport: r.sport ?? sport, salary });
        withSalary++;
      }

      pages++;
      if (!parsed.has_more) break;
      offset = parsed.next_offset ?? offset + PAGE_SIZE;
    }

    if (pages >= MAX_PAGES) {
      console.warn(
        `[SalarySnapshot] ${sport} hit the ${MAX_PAGES}-page ceiling — the snapshot may be ` +
          'truncated. Raise MAX_PAGES or move to a bulk projection tool.',
      );
    }
    perSport.push(`${sport} ${withSalary}/${seen}`);
  }

  setSalarySnapshot(accumulated);
  lastRefreshedAt = Date.now();
  console.log(
    `[SalarySnapshot] ${salarySnapshotSize()} salaried athletes indexed ` +
      `(${perSport.join(', ')}) in ${Date.now() - started}ms`,
  );
  return true;
}

/**
 * Refresh only when the TTL has expired. This is what the poll cycle calls, so
 * it must be cheap in the common case — it does no I/O at all inside the
 * window.
 */
export async function refreshSalarySnapshotIfStale(): Promise<void> {
  if (!salaryTiersEnabled()) return;
  if (Date.now() - lastRefreshedAt < ttlMs()) return;
  await refreshSalarySnapshot();
}

/**
 * Drop the TTL so the next refresh actually reads. Called by roster-sync after
 * a successful cycle: that is the only thing that changes salaries, so waiting
 * out a full 6h window afterwards would leave freshly synced numbers unused
 * for no reason.
 */
export function invalidateSalarySnapshot(): void {
  lastRefreshedAt = 0;
}

/** Test seam — resets the TTL clock without touching the installed snapshot. */
export function _resetSalarySnapshotTimerForTesting(): void {
  lastRefreshedAt = 0;
}
