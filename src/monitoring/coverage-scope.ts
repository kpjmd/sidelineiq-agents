/**
 * Coverage scope: is this event about an athlete we cover at all?
 *
 * Nico Iamaleava (UCLA quarterback) reached the MD queue on 2026-10-22 as an
 * NFL BREAKING post. NewsAPI's NFL query is `"NFL" AND injury…`, and a college
 * story that mentions the NFL matches it — 8 of 100 live results that day sat
 * in a college section. He resolved to no player, which is only a SOFT
 * `identity_unresolvable`, and the post-OTM team re-check ran only for a
 * RESOLVED player, so the model's "UCLA" was never compared against anything.
 *
 * "Unresolved" alone is NOT evidence of out-of-coverage: 5 of the 6 historical
 * `identity_unresolvable` posts were real pros (AJ Brown, Shaedon Sharpe, Jalon
 * Walker, Richie Saunders, Jaylon Hutchings) — name drift and roster lag. So
 * both checks here require a POSITIVE non-coverage signal, and the callers
 * consult them only for an athlete who did not resolve. A rostered player can
 * never be dropped by this module.
 *
 * Two layers, because they see different evidence:
 *   1. `outOfCoverageSection` — the publisher's own section for the story,
 *      before OTM (no Sonnet spend). Blind to X, which has no sections.
 *   2. `postTeamOutOfCoverage` — the team OTM wrote, after OTM. Catches a
 *      college story from any source, X included.
 *
 * Re-verify with `src/scripts/coverage-scope-dryrun.ts`; the number that must
 * be zero is drops of a post/event whose athlete resolves to a rostered player.
 */
import type { RawInjuryEvent, SportKey } from '../types.js';
import { NFL_TEAM_NAMES } from './sports/newsapi-nfl.js';
import { NBA_TEAM_NAMES } from './sports/x-insider-nba.js';

export type CoverageScopeMode = 'off' | 'shadow' | 'on';

/** `COVERAGE_SCOPE_MODE=off|shadow|on`, default `on`. Shadow logs and drops nothing. */
export function coverageScopeMode(
  env: string | undefined = process.env.COVERAGE_SCOPE_MODE,
): CoverageScopeMode {
  const v = env?.trim().toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'on';
}

/**
 * Path segments that name a non-professional SECTION of a publisher's site.
 * Exact-segment matches only: `cbssports.com/nfl/news/…-in-college-football/`
 * is a real NFL story whose SLUG mentions college, and the slug (the last
 * segment) is never consulted.
 */
const NON_PRO_SECTIONS: ReadonlySet<string> = new Set([
  'college',
  'college-football',
  'college-basketball',
  'mens-college-basketball',
  'womens-college-basketball',
  'ncaa',
  'ncaaf',
  'ncaab',
  'ncaam',
  'ncaaw',
  'cfb',
  'high-school',
  'recruiting',
]);

/**
 * The non-professional section segment of the event's source URL, or null.
 *
 * X events are skipped: their path is `/<handle>/status/<id>`, and a handle is
 * not a section.
 */
export function outOfCoverageSection(
  event: Pick<RawInjuryEvent, 'source_url' | 'source_name'>,
): string | null {
  if (event.source_name?.startsWith('X:')) return null;
  let path: string;
  try {
    path = new URL(event.source_url).pathname;
  } catch {
    return null;
  }
  const segments = path.split('/').filter(Boolean).map((s) => s.toLowerCase());
  for (const segment of segments.slice(0, -1)) {
    if (NON_PRO_SECTIONS.has(segment)) return segment;
  }
  return null;
}

/**
 * Club nicknames per sport, plus the short forms a model writes. NFL and NBA
 * only: their club sets are fixed. PREMIER_LEAGUE is deliberately absent —
 * PL_TEAM_NAMES is hand-maintained across promotion and relegation and
 * abbreviated forms ("Spurs", "Man Utd", "Wolves") are routine, so a miss there
 * would drop a real club, which is the expensive direction.
 */
const CLUB_NICKNAMES: Partial<Record<SportKey, readonly string[]>> = {
  NFL: [...NFL_TEAM_NAMES, 'Niners', 'Bucs', 'Pats', 'Jags'],
  NBA: [...NBA_TEAM_NAMES, 'Blazers', 'Sixers', 'Cavs', 'Wolves', 'Mavs'],
};

/** Teams that say "no team", not "a different team". Never a drop. */
const NO_TEAM_RE = /^(|unknown|n\/?a|none|free agent|unsigned|unattached)$/i;

/**
 * The team OTM wrote, when it names a team that is not a club of `sport`, or
 * null. Null also when the team is blank/"Unknown"/"Free Agent" — those are a
 * gap, not a contradiction, and keep their current route (MD review) — and for
 * any sport without a club list.
 */
export function postTeamOutOfCoverage(team: string | null | undefined, sport: SportKey): string | null {
  const clubs = CLUB_NICKNAMES[sport];
  if (!clubs) return null;
  const trimmed = (team ?? '').trim();
  if (NO_TEAM_RE.test(trimmed)) return null;
  const names = clubs.some((club) => new RegExp(`\\b${club}\\b`, 'i').test(trimmed));
  return names ? null : trimmed;
}
