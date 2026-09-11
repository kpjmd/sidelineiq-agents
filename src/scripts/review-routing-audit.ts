/**
 * review-routing audit — does every post routed to physician review reach the
 * MD queue, and stay off the public site until approved?
 *
 * WHY. web_create_injury_post used to strip `status`, so a review-routed row
 * landed PUBLISHED and a second call (web_flag_for_md_review) flipped it and
 * filed its md_reviews row. Had that call failed, the post was live on the
 * homepage, feed and sitemap, invisible to the MD queue (which is driven only by
 * md_reviews rows), and eligible for ApprovalSync's re-cast to Farcaster and X.
 * Since mcp fix/review-status-on-create the create lands PENDING_REVIEW and files
 * the review row in the SAME statement.
 *
 * Read-only. Run it anywhere with the public endpoint:
 *   export WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp
 *   npx tsx src/scripts/review-routing-audit.ts [--since <ISO>]
 *
 * The numbers that must be zero:
 *   1  PUBLISHED + md_review_required + no APPROVED review, excluding the
 *      retrospective flags the repair scripts put on already-live posts
 *   2  PENDING_REVIEW with no md_reviews row at all (invisible to the MD)
 *   3  PENDING_REVIEW with md_review_required not true
 *   4  confidences outside [0,1] (what migration 022 forbids)
 *   5  (--since) in-window review-routed rows NOT filed atomically
 *
 * On 5: injury_posts.created_at and md_reviews.created_at both DEFAULT NOW(),
 * and now() is fixed for a whole statement. A review filed by the create's own
 * CTE therefore carries EXACTLY the post's created_at; one filed by a separate
 * flag call lands milliseconds later (Tua Tagovailoa, 2026-09-10: post
 * 21:15:35.262, review 21:15:35.282). Equality is the positive proof that the
 * atomic path ran — pass a --since after the agents deploy.
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll, isServerAvailable, callTool } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';

interface PostRow {
  id: string;
  status: string | null;
  md_review_required: boolean | null;
  md_review_reason: string | null;
  md_review_confidence: unknown;
  rtp_confidence: unknown;
  farcaster_hash: string | null;
  twitter_id: string | null;
  athlete_name: string | null;
  content_type: string | null;
  created_at: string;
}

interface ReviewRow {
  post_id: string;
  status: string;
  created_at: string;
}

const failures: string[] = [];
function mustBeZero(label: string, examples: string[]): void {
  const ok = examples.length === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${examples.length}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${examples.length}`);
}
function report(label: string, examples: string[] | number): void {
  const n = typeof examples === 'number' ? examples : examples.length;
  console.log(`  ---   ${label}: ${n}`);
  if (typeof examples !== 'number') for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
}

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? null;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
};

const short = (id: string): string => id.slice(0, 8);
const label = (p: PostRow): string =>
  `${short(p.id)} ${p.created_at.slice(0, 16)} ${p.content_type ?? '?'} ${p.athlete_name ?? '?'}`;

/** Postgres hands DECIMAL back as a string ("0.720"); compare numbers. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reasons the repair scripts write when they flag an ALREADY-LIVE post with
 * preserve_status. Those rows are legitimately PUBLISHED + required with a
 * PENDING review; they are reported, not failed.
 */
const RETROSPECTIVE_REASON = /^(legacy_sweep:|laterality_correction:|social_orphan:)/;

async function listReviews(): Promise<ReviewRow[]> {
  const res = await callTool('web', 'web_list_md_reviews', {});
  if (isMCPError(res)) throw new Error(extractMCPErrorMessage(res));
  const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  const reviews = text ? (JSON.parse(text) as { reviews?: ReviewRow[] }).reviews : undefined;
  // An unreadable review table must not read as "no reviews", which would fail
  // check 2 for every row — or, worse, pass check 1 vacuously.
  if (!Array.isArray(reviews)) throw new Error('web_list_md_reviews returned no reviews array');
  return reviews;
}

async function main(): Promise<void> {
  await initializeMCPClients();
  if (!isServerAvailable('web')) {
    console.error('[audit] the web MCP server is unavailable.');
    process.exitCode = 1;
    return;
  }

  const since = flag('--since');
  const sinceMs = since ? Date.parse(since) : NaN;
  if (since && !Number.isFinite(sinceMs)) {
    console.error(`[audit] FAIL: --since ${since} is not a parseable date.`);
    process.exitCode = 1;
    return;
  }

  const { posts, pages, truncated } = await listAllPosts<PostRow>({});
  if (truncated) {
    console.error(`[audit] FAIL: the post scan was truncated after ${pages} page(s) — every count would be a floor.`);
    process.exitCode = 1;
    return;
  }
  const reviews = await listReviews();
  const byPost = new Map<string, ReviewRow[]>();
  for (const r of reviews) byPost.set(r.post_id, [...(byPost.get(r.post_id) ?? []), r]);
  const reviewsFor = (p: PostRow): ReviewRow[] => byPost.get(p.id) ?? [];

  const count = (s: string) => posts.filter((p) => p.status === s).length;
  console.log(
    `\n═══ review-routing audit (${new Date().toISOString()}, posts=${posts.length} from ${pages} page(s), md_reviews=${reviews.length}) ═══`,
  );
  report('PUBLISHED', count('PUBLISHED'));
  report('PENDING_REVIEW', count('PENDING_REVIEW'));
  report('REJECTED + SUPERSEDED', count('REJECTED') + count('SUPERSEDED'));

  console.log('\n── 1. nothing routed to review is live without an MD approval ──\n');
  const liveUnapproved = posts.filter(
    (p) =>
      p.status === 'PUBLISHED' &&
      p.md_review_required === true &&
      !reviewsFor(p).some((r) => r.status === 'APPROVED'),
  );
  mustBeZero(
    'PUBLISHED + required + no APPROVED review (excl. retrospective flags)',
    liveUnapproved.filter((p) => !RETROSPECTIVE_REASON.test(p.md_review_reason ?? '')).map(
      (p) => `${label(p)} social=${p.farcaster_hash || p.twitter_id ? 'yes' : 'NO'} reason=${p.md_review_reason ?? '-'}`,
    ),
  );
  report(
    'retrospective flags on already-live posts (repair scripts, preserve_status)',
    liveUnapproved.filter((p) => RETROSPECTIVE_REASON.test(p.md_review_reason ?? '')).map(label),
  );

  console.log('\n── 2-3. every PENDING_REVIEW row is a queue item and says so ──\n');
  const pending = posts.filter((p) => p.status === 'PENDING_REVIEW');
  mustBeZero('PENDING_REVIEW with no md_reviews row', pending.filter((p) => reviewsFor(p).length === 0).map(label));
  mustBeZero('PENDING_REVIEW with md_review_required not true', pending.filter((p) => p.md_review_required !== true).map(label));
  // A post whose only reviews are closed but which never left PENDING_REVIEW:
  // the pre-021 reject path closed md_reviews and left the post behind. Not
  // caused by, or fixable by, the create path — listed so it stays visible.
  report(
    'PENDING_REVIEW whose reviews are all closed (pre-021 residue)',
    pending
      .filter((p) => reviewsFor(p).length > 0 && !reviewsFor(p).some((r) => r.status === 'PENDING'))
      .map((p) => `${label(p)} reviews=${reviewsFor(p).map((r) => r.status).join('/')}`),
  );

  console.log('\n── 4. confidences are in range (migration 022) ──\n');
  for (const col of ['md_review_confidence', 'rtp_confidence'] as const) {
    const vals = posts.map((p) => ({ p, v: num(p[col]) })).filter((x) => x.v !== null);
    report(`${col} non-null`, vals.length);
    mustBeZero(
      `${col} outside [0,1]`,
      vals.filter(({ v }) => (v as number) < 0 || (v as number) > 1).map(({ p, v }) => `${label(p)} ${col}=${v}`),
    );
  }

  console.log('\n── 5. review-routed rows in the window were filed atomically ──\n');
  if (!since) {
    console.log('  SKIP  no --since given.');
  } else {
    const routed = posts.filter((p) => Date.parse(p.created_at) >= sinceMs && p.md_review_required === true);
    const atomic = routed.filter((p) =>
      reviewsFor(p).some((r) => Date.parse(r.created_at) === Date.parse(p.created_at)),
    );
    report(`in-window review-routed rows since ${since}`, routed.length);
    report('  filed in the same statement (review created_at == post created_at)', atomic.length);
    mustBeZero(
      'in-window review-routed rows NOT filed atomically',
      routed
        .filter((p) => !atomic.includes(p))
        .map((p) => {
          const gaps = reviewsFor(p).map((r) => `${Date.parse(r.created_at) - Date.parse(p.created_at)}ms`);
          return `${label(p)} review_gap=${gaps.join(',') || 'NO REVIEW'}`;
        }),
    );
  }

  console.log(failures.length === 0 ? '\nALL ZERO-CHECKS PASS' : `\nFAILED: ${failures.join('; ')}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`[audit] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
