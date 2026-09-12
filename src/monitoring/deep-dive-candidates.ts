/**
 * DEEP_DIVE candidate selection — pure, so the scheduler, its tests and
 * src/scripts/deep-dive-starvation-dryrun.ts all run the SAME predicate. The
 * dry-run used to re-implement it, which is exactly how a replay drifts from the
 * code it claims to measure.
 *
 * Three things changed from the predicate this replaces, and each is load-bearing:
 *
 * 1. GROUPING KEY vs TOPIC LABEL are separate. Candidates group on
 *    canonicalInjuryKey (injury-taxonomy.ts) so fragmented prose can reach the
 *    count. But processDeepDive writes `Injury type: ${injury_type}` straight
 *    into the prompt, so the topic handed to the agent stays a real clinical
 *    label — the most common raw injury_type in the bucket — never a bare key
 *    like "ankle". Lowercased and trimmed, as the old predicate passed it.
 *
 * 2. COOLDOWN is keyed the same way as candidates. The old code compared a
 *    DEEP_DIVE's raw injury_type to a candidate's raw injury_type; comparing a
 *    canonical candidate key to a raw DEEP_DIVE string would never match, and a
 *    hamstring explainer would not cool the hamstring bucket — the scheduler
 *    would write it again next cycle. A DEEP_DIVE row falls back to its headline
 *    when its label names no bucket, with false friends refused (a headline says
 *    "won't be back"; a label does not).
 *
 * 3. ATHLETES and TEAMS stay index-aligned. processDeepDive zips them back
 *    together by index (`input.teams[i]`). The old code pushed each array only
 *    when its field was present and then de-duplicated them INDEPENDENTLY, so one
 *    post with an athlete but no team shifted every later pairing — a wrong team
 *    printed beside a named athlete in physician-branded content. Grouping by
 *    body part puts more athletes in a bucket and would have made that worse.
 *
 * 4. COUNT is DISTINCT ATHLETES, not posts. processDeepDive tells the agent
 *    `Recent occurrences: ${count} cases`. Counting posts meant three TRACKING
 *    updates on one athlete were published as "3 cases" — a false clinical claim
 *    under a physician byline. The exact-string key mostly hid it, because an
 *    athlete's follow-ups rarely repeat a label verbatim; canonical keys collapse
 *    that evolution ("cervical spine / neck injury — unspecified" → "cervical
 *    spine surgery") into one bucket and would have made it routine. The live
 *    neck bucket held 23 distinct labels that read as one or two athletes'
 *    recurring stinger. DEEP_DIVE_MIN_INJURY_COUNT therefore now means athletes.
 *
 * Deliberately unchanged, for parity: grouping is sport-agnostic (the top sport
 * wins, as before); retired rows never count and never hold a cooldown; the
 * bucket with the highest count wins.
 */
import { canonicalInjuryKey } from './injury-taxonomy.js';
import { isRetiredPostStatus } from '../utils/web-posts.js';
import type { SportKey } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window of recent reports counted toward a candidate. */
export const DEEP_DIVE_LOOKBACK_MS = 5 * DAY_MS;
/**
 * No second DEEP_DIVE for the same canonical key inside this window.
 *
 * 30 days, not the 7 the exact-string predicate used. A key now means a
 * STRUCTURE, not a phrasing: under 7 days the live replay (2026-09-12) projected
 * 3 DEEP_DIVEs in a month and two of them were ACL ("acl reconstruction", then
 * "acl tear") — near-duplicate physician-bylined explainers. The old 7 days was
 * sized for labels that already differed on every rephrasing.
 */
export const DEEP_DIVE_COOLDOWN_MS = 30 * DAY_MS;

export interface CandidatePost {
  status?: string;
  injury_type?: string;
  headline?: string;
  sport?: string;
  athlete_name?: string;
  team?: string;
  created_at?: string;
  content_type?: string;
}

export interface DeepDiveCandidate {
  /** Grouping key. Use it for cooldown bookkeeping, never as the prompt topic. */
  canonical_key: string;
  /** Topic handed to the agent: the most common raw label in the bucket. */
  injury_type: string;
  /** Distinct athletes — the agent prints it as "N cases". Never a post count. */
  count: number;
  sport: SportKey;
  athletes: string[];
  /** Index-aligned with `athletes`; '' where the report named no team. */
  teams: string[];
}

export interface SelectDeepDiveOptions {
  now: number;
  minCount: number;
  /** Process-lifetime cooldown the scheduler keeps; keyed on canonical_key. */
  isInMemoryCooldown?: (canonicalKey: string) => boolean;
}

/**
 * The key a published DEEP_DIVE holds its cooldown under. Label first; the
 * headline only as a fallback, and never through a false friend.
 */
export function deepDiveCooldownKey(post: CandidatePost): string | null {
  return (
    canonicalInjuryKey(post.injury_type) ??
    canonicalInjuryKey(post.headline, { allowFalseFriends: false })
  );
}

interface Bucket {
  labels: Map<string, { n: number; latest: number }>;
  sports: string[];
  cases: Array<{ athlete: string; team: string }>;
  seenAthletes: Set<string>;
}

function createdAt(post: CandidatePost): number {
  return post.created_at ? Date.parse(post.created_at) : NaN;
}

export function selectDeepDiveCandidate(
  posts: readonly CandidatePost[],
  options: SelectDeepDiveOptions,
): DeepDiveCandidate | null {
  const { now, minCount, isInMemoryCooldown } = options;

  const cooling = new Set<string>();
  const buckets = new Map<string, Bucket>();

  // Newest first, so the de-duplicated case list keeps each athlete's most
  // recent team — the one a reader would recognise today.
  const ordered = [...posts]
    .filter((p) => Number.isFinite(createdAt(p)) && createdAt(p) <= now)
    .sort((a, b) => createdAt(b) - createdAt(a));

  for (const post of ordered) {
    // A rejected or superseded row is a story we decided not to tell: it neither
    // makes an injury type "hot" nor, for a DEEP_DIVE, holds the cooldown
    // against its replacement.
    if (isRetiredPostStatus(post.status)) continue;
    const age = now - createdAt(post);

    if (post.content_type === 'DEEP_DIVE') {
      const key = deepDiveCooldownKey(post);
      if (key && age < DEEP_DIVE_COOLDOWN_MS) cooling.add(key);
      continue;
    }

    if (age >= DEEP_DIVE_LOOKBACK_MS) continue;
    const key = canonicalInjuryKey(post.injury_type);
    const label = post.injury_type?.toLowerCase().trim();
    if (!key || !label) continue;

    // athlete_name is NOT NULL on injury_posts; a row without one names no case.
    const athlete = post.athlete_name?.trim();
    if (!athlete) continue;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { labels: new Map(), sports: [], cases: [], seenAthletes: new Set() };
      buckets.set(key, bucket);
    }

    // Every tally is once per athlete, from their MOST RECENT report (rows are
    // newest-first). Otherwise one athlete's run of follow-ups out-votes several
    // other athletes on the topic label and the sport, the same inflation the
    // count had.
    const norm = athlete.toLowerCase();
    if (bucket.seenAthletes.has(norm)) continue;
    bucket.seenAthletes.add(norm);
    bucket.cases.push({ athlete, team: post.team?.trim() ?? '' });

    const seen = bucket.labels.get(label);
    bucket.labels.set(label, { n: (seen?.n ?? 0) + 1, latest: Math.max(seen?.latest ?? 0, createdAt(post)) });
    if (post.sport) bucket.sports.push(post.sport);
  }

  const ranked = [...buckets.entries()]
    .filter(([key, b]) => b.cases.length >= minCount && !cooling.has(key) && !(isInMemoryCooldown?.(key) ?? false))
    .sort(([, a], [, b]) => b.cases.length - a.cases.length);
  if (ranked.length === 0) return null;

  const [canonicalKey, bucket] = ranked[0];

  const [topic] = [...bucket.labels.entries()].sort(
    ([, a], [, b]) => b.n - a.n || b.latest - a.latest,
  )[0];

  const sportCounts = new Map<string, number>();
  for (const s of bucket.sports) sportCounts.set(s, (sportCounts.get(s) ?? 0) + 1);
  const sport = ([...sportCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'NFL') as SportKey;

  return {
    canonical_key: canonicalKey,
    injury_type: topic,
    count: bucket.cases.length,
    sport,
    athletes: bucket.cases.map((c) => c.athlete),
    teams: bucket.cases.map((c) => c.team),
  };
}
