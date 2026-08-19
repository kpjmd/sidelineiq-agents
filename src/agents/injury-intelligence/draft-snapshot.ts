// Draft-position snapshot: the third promote-only tier provider.
//
// Salary answers "what does the market pay this athlete". Club/card answers
// "who does he play for, where is he on the card". Draft position answers a
// third question — "what did the league itself say he was worth before any
// market existed" — and it is the only one of the three DEFINED for a player
// with no contract history at all. That is exactly the population stuck at the
// flat tier-3 default: rookie-scale money is structurally below the NFL
// tier-2 band no matter how highly an athlete was drafted, and TRACKING
// hard-drops tier 3, so their injury updates could never publish.
//
// Deliberately NOT folded into loadSignificanceData(): that runs at the top of
// every poll cycle, and this does HTTP against a host that rate-limits.
import { getLoadedDraftBands, setDraftSnapshot } from './significance.js';
import type { SportKey } from '../../types.js';

// Draft results are immutable once a draft completes, so this TTL is not about
// freshness — it is about self-healing and observability. A TTL of "effectively
// never" is indistinguishable in the logs from a first load that failed and was
// never retried. A week means a transient ESPN outage self-corrects with no
// deploy, and the annual class rollover lands within a week of the draft.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Measured: 6 concurrent ref resolutions completed 64/64 cleanly. Higher
// concurrency has been observed dropping a contiguous block of refs, which is
// the failure this module's abort semantics exist for.
const DEFAULT_CONCURRENCY = 5;
const REF_RETRY_DELAY_MS = 500;

// Below this share of in-window picks resolving, the snapshot is decimated
// rather than merely imperfect. The MIN_PLAUSIBLE_PL_PLAYERS analogue.
const MIN_RESOLVED_FRACTION = 0.95;

const LEAGUE_PATHS: Partial<Record<SportKey, string>> = {
  NFL: 'football/leagues/nfl',
  NBA: 'basketball/leagues/nba',
};

let lastRefreshedAt = 0;

function ttlMs(): number {
  const raw = process.env.DRAFT_SNAPSHOT_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Whether draft-derived tiers are switched on.
 *
 * Opt-in, following SALARY_TIER_ENABLED and DERIVED_TIER_ENABLED: the feature
 * ships dark so the snapshot can be observed refreshing in production before it
 * is allowed to change a single tier.
 */
export function draftTiersEnabled(): boolean {
  return process.env.DRAFT_TIER_ENABLED === 'true';
}

interface RawPick {
  status?: { id?: number; name?: string };
  pick?: number;
  overall?: number;
  round?: number;
  athlete?: { $ref?: string };
}

interface RoundsPayload {
  items?: Array<{ number?: number; picks?: RawPick[] }>;
}

interface InWindowPick {
  year: number;
  round: number;
  overall: number;
  ref: string;
}

/** Distinguishes a bounded, known-empty pick from a read that failed. */
class TransientRefError extends Error {}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null; // Bounded: a forfeited or voided pick.
  if (!res.ok) throw new TransientRefError(`HTTP ${res.status}`);
  return res.json();
}

/** One call per class year returns every round with its picks inline. */
async function fetchRoundPicks(
  leaguePath: string,
  year: number,
  maxOverall: number,
): Promise<InWindowPick[] | null> {
  const url = `https://sports.core.api.espn.com/v2/sports/${leaguePath}/seasons/${year}/draft/rounds`;
  const body = (await getJson(url)) as RoundsPayload | null;
  // A class year that has not happened yet answers 200 with an empty items
  // array, NOT a 404 — verified for 2027 and 2028. So "not held yet" and "read
  // failed" look nothing alike, and only the latter should abort.
  if (!body) return [];
  const out: InWindowPick[] = [];
  for (const round of body.items ?? []) {
    for (const p of round.picks ?? []) {
      if (p.status?.name !== 'SELECTION_MADE') continue;
      const overall = p.overall;
      const ref = p.athlete?.$ref;
      if (!Number.isFinite(overall) || !ref) continue;
      if ((overall as number) > maxOverall) continue; // Never spend a ref we cannot use.
      out.push({ year, round: round.number ?? p.round ?? 0, overall: overall as number, ref });
    }
  }
  return out;
}

interface ResolvedPick extends InWindowPick {
  name: string | null;
}

async function resolveNames(
  picks: InWindowPick[],
  concurrency: number,
): Promise<ResolvedPick[]> {
  const out: ResolvedPick[] = new Array(picks.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < picks.length) {
      const i = cursor++;
      const p = picks[i];
      let record: unknown;
      try {
        record = await getJson(p.ref);
      } catch (err) {
        // One retry, then let it propagate — see the abort rationale below.
        await new Promise((r) => setTimeout(r, REF_RETRY_DELAY_MS));
        record = await getJson(p.ref);
        void err;
      }
      const r = record as { fullName?: string; displayName?: string } | null;
      out[i] = { ...p, name: r?.fullName ?? r?.displayName ?? null };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, picks.length) }, worker));
  return out;
}

/**
 * Rebuild the draft index.
 *
 * All-or-nothing, matching the salary and derived loaders: the accumulator is
 * local and installed only on complete success. The failure split matters and
 * is not the obvious one:
 *
 *  - A 404 on one ref, after a retry, is a bad ROW. A forfeited or voided pick
 *    is bounded and known; skip it and count it.
 *  - A timeout, 429 or 5xx is a bad PAGE. ABORT and keep the incumbent. ESPN
 *    rate-limits this endpoint by dropping a contiguous block of refs, and a
 *    rate limit that read as "this pick has no athlete" would install a
 *    snapshot missing an arbitrary run of picks — silently demoting exactly the
 *    athletes this feature exists to promote, with no error and no symptom.
 */
export async function refreshDraftSnapshot(now: Date = new Date()): Promise<boolean> {
  const bands = getLoadedDraftBands();
  const sports = Object.keys(bands) as SportKey[];
  if (sports.length === 0) return false;

  const started = Date.now();
  const rows: Array<{ full_name: string; sport: string; draft: { year: number; round: number; overall: number } }> = [];
  const perSport: string[] = [];
  let unresolved = 0;

  for (const sport of sports) {
    const leaguePath = LEAGUE_PATHS[sport];
    const band = bands[sport];
    if (!leaguePath || !band) continue;

    const thisYear = now.getUTCFullYear();
    // One class wider than the lookup window, so the anchor is always the
    // newest completed draft rather than whatever the window's edge happens
    // to be. tierFromDraft re-applies the real window.
    const years: number[] = [];
    for (let back = 0; back <= band.max_seasons_since_draft + 1; back++) years.push(thisYear - back);

    let inWindow: InWindowPick[] = [];
    for (const year of years) {
      let picks: InWindowPick[] | null;
      try {
        picks = await fetchRoundPicks(leaguePath, year, band.tier_2_max_overall);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[DraftSnapshot] ${sport} ${year} round list failed (${msg}) — keeping the previous snapshot`,
        );
        return false;
      }
      inWindow = inWindow.concat(picks ?? []);
    }

    if (inWindow.length === 0) {
      // Absence is never evidence — the MIN_PLAUSIBLE_PL_PLAYERS rule.
      console.warn(
        `[DraftSnapshot] ${sport} produced no picks across ${years.length} class years — ` +
          `keeping the previous snapshot`,
      );
      return false;
    }

    let resolved: ResolvedPick[];
    try {
      resolved = await resolveNames(inWindow, DEFAULT_CONCURRENCY);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[DraftSnapshot] ${sport} name resolution failed (${msg}) — keeping the previous ` +
          `snapshot rather than installing a partial index`,
      );
      return false;
    }

    const named = resolved.filter((r) => r.name);
    const missing = resolved.length - named.length;
    if (named.length / resolved.length < MIN_RESOLVED_FRACTION) {
      console.warn(
        `[DraftSnapshot] ${sport} resolved only ${named.length}/${resolved.length} picks ` +
          `(floor ${Math.round(MIN_RESOLVED_FRACTION * 100)}%) — keeping the previous snapshot`,
      );
      return false;
    }
    unresolved += missing;

    for (const r of named) {
      rows.push({
        // The LOOP CONSTANT, never a value off the wire — an upstream format
        // drift would otherwise move every key out from under the lookup with
        // no error and no symptom.
        full_name: r.name as string,
        sport,
        draft: { year: r.year, round: r.round, overall: r.overall },
      });
    }
    const classes = [...new Set(named.map((r) => r.year))].sort();
    perSport.push(
      `${sport} ${named.length}/${resolved.length} across classes ${classes[0]}-${classes[classes.length - 1]}`,
    );
  }

  setDraftSnapshot(rows);
  lastRefreshedAt = Date.now();
  console.log(
    `[DraftSnapshot] ${rows.length} picks indexed (${perSport.join(', ')}, ` +
      `${unresolved} unresolved) in ${Date.now() - started}ms`,
  );
  return true;
}

export async function refreshDraftSnapshotIfStale(now: Date = new Date()): Promise<void> {
  if (!draftTiersEnabled()) return;
  if (lastRefreshedAt !== 0 && Date.now() - lastRefreshedAt < ttlMs()) return;
  await refreshDraftSnapshot(now);
}

/**
 * Drop the TTL so the next call re-reads.
 *
 * NOT called from invalidateTierSnapshots, unlike its two siblings: roster sync
 * changes salaries and club assignments, it does not change draft results.
 * Wiring it in would spend ~180 HTTP calls every 6h re-reading data that
 * changes once a year. Exists for the dry run and for tests.
 */
export function invalidateDraftSnapshot(): void {
  lastRefreshedAt = 0;
}

export function _resetDraftSnapshotTimerForTesting(): void {
  lastRefreshedAt = 0;
}

export const _internals = { fetchRoundPicks, resolveNames, LEAGUE_PATHS };
