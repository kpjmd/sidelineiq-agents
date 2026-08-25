/**
 * Read-only dry run for the rejection-memory change (mcp migration 021).
 *
 * Three questions, each with a number that must be zero, answered against the
 * live post corpus rather than against fixtures. Unit tests have missed the
 * real failure mode in this repo repeatedly; this is the gate.
 *
 *   A — MIGRATION PRE-FLIGHT. Rows whose status is outside the five the 021
 *       CHECK constraint allows.  MUST BE 0, or the migration fails on apply.
 *
 *   B — INERTNESS, the ship gate. findRecentRejection reads REJECTED rows and
 *       nothing else, so against the corpus as it stands today it must match
 *       NOTHING: no post has ever been rejected without being deleted.
 *       Suppressions against the live corpus MUST BE 0. The change cannot alter
 *       a single existing outcome until the first rejection lands.
 *
 *       Note what this section deliberately does NOT do. An earlier draft
 *       replayed every post as if its predecessors had been rejected and
 *       reported 243 hits, which reads alarming and means nothing: those are
 *       genuine follow-ups on the same thread, i.e. the feature working. The
 *       real monotonicity claim — that nothing which PUBLISHES today can stop
 *       publishing — is structural, not statistical: findRecentRejection is
 *       called only inside the `review.needed` branch, so its only possible
 *       effect is pending_review → skipped. A corpus replay cannot prove that
 *       and would only launder it. It is pinned by the unit test "never
 *       consults the rejection on the publish path" in rejection-memory.test.ts.
 *
 *       Section D reports the historical reach as an explicitly-labelled UPPER
 *       BOUND, so the change is not mistaken for inert forever.
 *
 *   C — REFACTOR EQUIVALENCE. isSameReviewQuestion was extracted out of
 *       findEquivalentPendingReview. Compared against the pre-extraction
 *       predicate over every ordered pair in the corpus.  Divergences MUST BE 0.
 *
 * Usage:
 *   npx tsx src/scripts/rejection-memory-dryrun.ts
 *
 * Reads through listAllPosts — never an unpaged web_list_posts, which returns
 * 20 rows and would answer a whole-corpus question from the newest page. No
 * writes, no model calls.
 */
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import {
  REJECTION_MEMORY_MS,
  findRecentRejection,
  isSameReviewQuestion,
  type ExistingPost,
} from '../utils/publishing-pipeline.js';
import type { InjuryPostContent, InjurySeverity, ContentType } from '../types.js';

const ALLOWED_STATUSES = new Set([
  'PUBLISHED',
  'PENDING_REVIEW',
  'DRAFT',
  'REJECTED',
  'SUPERSEDED',
]);

interface Row extends ExistingPost {
  injury_type?: string;
  team?: string;
}

/** The pre-extraction predicate, inlined verbatim, for section C. */
function legacyPendingMatch(content: InjuryPostContent, post: Row): boolean {
  const threadId = content.parent_post_id;
  if (post.status !== 'PENDING_REVIEW') return false;
  if (post.athlete_name !== content.athlete_name || post.sport !== content.sport) return false;
  if (post.content_type !== content.content_type) return false;
  if (threadId && !(post.id === threadId || post.parent_post_id === threadId)) return false;
  const d = (v: unknown) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n <= 0 ? null : n;
  };
  if (d(post.team_timeline_weeks) !== d(content.team_timeline_weeks)) return false;
  if (post.injury_severity !== content.injury_severity) return false;
  return true;
}

/** A stored row read back as the post the pipeline would be asked to publish. */
function asContent(row: Row): InjuryPostContent {
  return {
    athlete_name: row.athlete_name ?? '',
    sport: row.sport ?? '',
    team: row.team ?? '',
    injury_type: row.injury_type ?? '',
    injury_severity: (row.injury_severity ?? 'UNKNOWN') as InjurySeverity,
    content_type: (row.content_type ?? 'BREAKING') as ContentType,
    headline: '',
    clinical_summary: '',
    return_to_play: {
      min_weeks: 0,
      max_weeks: 0,
      probability_week_2: 0,
      probability_week_4: 0,
      probability_week_8: 0,
      confidence: 0,
    },
    confidence: 1,
    ...(row.parent_post_id ? { parent_post_id: row.parent_post_id } : {}),
    ...(row.team_timeline_weeks !== undefined && row.team_timeline_weeks !== null
      ? { team_timeline_weeks: Number(row.team_timeline_weeks) }
      : {}),
  };
}

async function main(): Promise<void> {
  await initializeMCPClients();
  let failures = 0;
  try {
    const { posts, truncated } = await listAllPosts<Row>({});
    if (truncated) {
      // A partial corpus makes every "must be 0" below an unknown rather than a
      // pass, which is exactly the confusion /admin/social-health was fixed for.
      console.error('[dryrun] FAIL: the post scan was truncated — results are not conclusive.');
      process.exitCode = 1;
      return;
    }
    console.log(`[dryrun] corpus: ${posts.length} posts\n`);

    // ── A. Migration pre-flight ──────────────────────────────────────────
    const byStatus = new Map<string, number>();
    for (const p of posts) {
      const s = p.status ?? '<null>';
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    }
    const outside = [...byStatus.entries()].filter(([s]) => !ALLOWED_STATUSES.has(s));
    for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${s}: ${n}`);
    }
    const outsideCount = outside.reduce((n, [, c]) => n + c, 0);
    console.log(`[dryrun] A: statuses outside the 021 CHECK set = ${outsideCount} (must be 0)`);
    if (outsideCount > 0) {
      failures++;
      console.error(`[dryrun]    offending: ${outside.map(([s, n]) => `${s}×${n}`).join(', ')}`);
    }

    // ── B. Inertness against the corpus as it stands ────────────────────
    const rejectedRows = posts.filter((p) => p.status === 'REJECTED');
    let liveSuppressions = 0;
    for (const post of posts) {
      const at = post.created_at ? new Date(post.created_at).getTime() : Date.now();
      const hit = findRecentRejection(asContent(post), posts, at);
      if (hit) {
        liveSuppressions++;
        console.log(`  SUPPRESSED ${post.id} ${post.athlete_name} <- rejection ${hit.id}`);
      }
    }
    console.log(
      `[dryrun] B: REJECTED rows in the corpus = ${rejectedRows.length}; ` +
        `suppressions against the live corpus = ${liveSuppressions} (must be 0 until ` +
        `the first rejection lands)`,
    );
    if (rejectedRows.length === 0 && liveSuppressions > 0) failures++;

    // ── C. Refactor equivalence ──────────────────────────────────────────
    let divergences = 0;
    for (const a of posts) {
      const content = asContent(a);
      for (const b of posts) {
        if (a.id === b.id) continue;
        if (isSameReviewQuestion(content, b) && b.status === 'PENDING_REVIEW') {
          if (!legacyPendingMatch(content, b)) divergences++;
        } else if (legacyPendingMatch(content, b)) {
          divergences++;
        }
      }
    }
    console.log(
      `[dryrun] C: isSameReviewQuestion vs the pre-extraction predicate, ` +
        `divergences = ${divergences} (must be 0, over ${posts.length ** 2} ordered pairs)`,
    );
    if (divergences > 0) failures++;

    // ── D. Historical reach — an UPPER BOUND, not a gate ─────────────────
    // How often WOULD a rejection have suppressed a later equivalent review
    // routing, had rejections been recorded? Counted by replaying each post
    // against its predecessors as if those had been rejected.
    //
    // Read it as an upper bound and nothing more. A post that is PUBLISHED
    // today may have been PENDING_REVIEW at the time and later approved — the
    // stored row cannot tell the two apart — and a rejected story would have
    // had no successor at all. The number says the change is not inert; it does
    // not say how many rows it will actually stop.
    let reach = 0;
    for (const post of posts) {
      const at = post.created_at ? new Date(post.created_at).getTime() : NaN;
      if (!Number.isFinite(at)) continue;
      const priorAsRejected: Row[] = posts
        .filter((p) => {
          if (p.id === post.id || !p.created_at) return false;
          const t = new Date(p.created_at).getTime();
          return Number.isFinite(t) && t < at && at - t < REJECTION_MEMORY_MS;
        })
        .map((p) => ({ ...p, status: 'REJECTED', retired_at: p.created_at }));
      if (findRecentRejection(asContent(post), priorAsRejected, at)) reach++;
    }
    console.log(
      `[dryrun] D: historical reach (UPPER BOUND, not a gate) = ${reach} of ${posts.length} ` +
        `posts had an equivalent predecessor inside the 21-day window`,
    );

    console.log(`\n[dryrun] ${failures === 0 ? 'PASS' : `FAIL: ${failures} section(s)`}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
