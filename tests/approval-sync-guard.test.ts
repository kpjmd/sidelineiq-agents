import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import {
  selectPostsToRepublish,
  withholdUnapproved,
  getSocialReachReport,
  type ApprovedPost,
} from '../src/monitoring/approval-sync.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

const NOW = Date.parse('2026-08-16T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function post(overrides: Partial<ApprovedPost> = {}): ApprovedPost {
  return {
    post_id: 'p1',
    status: 'PUBLISHED',
    content_type: 'DEEP_DIVE',
    farcaster_hash: null,
    twitter_id: null,
    created_at: new Date(NOW - 2 * HOUR).toISOString(),
    athlete_name: 'Jaren Kanak',
    ...overrides,
  };
}

/**
 * ApprovalSync re-casts any hashless DEEP_DIVE from the last 7 days, and its
 * duplicate guard is in-memory. Without a cutoff, the first deploy after a
 * publish outage fires the whole backlog at the live accounts at once.
 */
describe('selectPostsToRepublish — backlog cutoff', () => {
  it('suppresses posts created before the cutoff and counts them', () => {
    const cutoff = Date.parse('2026-08-17T00:00:00Z');
    const posts = [
      post({ post_id: 'old-1', created_at: new Date(NOW - 5 * DAY).toISOString() }),
      post({ post_id: 'old-2', created_at: new Date(NOW - 1 * DAY).toISOString() }),
    ];

    const { pending, suppressed } = selectPostsToRepublish(posts, NOW, cutoff);

    expect(pending).toHaveLength(0);
    expect(suppressed).toBe(2);
  });

  it('lets posts created after the cutoff through', () => {
    const cutoff = NOW - 3 * HOUR;
    const posts = [
      post({ post_id: 'before', created_at: new Date(NOW - 4 * HOUR).toISOString() }),
      post({ post_id: 'after', created_at: new Date(NOW - 1 * HOUR).toISOString() }),
    ];

    const { pending, suppressed } = selectPostsToRepublish(posts, NOW, cutoff);

    expect(pending.map((p) => p.post_id)).toEqual(['after']);
    expect(suppressed).toBe(1);
  });

  it('is unchanged when no cutoff is configured', () => {
    const posts = [post({ post_id: 'a' }), post({ post_id: 'b' })];

    const { pending, suppressed } = selectPostsToRepublish(posts, NOW, null);

    expect(pending).toHaveLength(2);
    expect(suppressed).toBe(0);
  });

  it('does not count already-processed or otherwise ineligible posts as suppressed', () => {
    const cutoff = NOW;
    const posts = [
      post({ post_id: 'processed', created_at: new Date(NOW - 1 * DAY).toISOString() }),
      post({ post_id: 'has-hash', farcaster_hash: '0xabc', created_at: new Date(NOW - 1 * DAY).toISOString() }),
      post({ post_id: 'breaking', content_type: 'BREAKING', created_at: new Date(NOW - 1 * DAY).toISOString() }),
      post({ post_id: 'pending', status: 'PENDING_REVIEW', created_at: new Date(NOW - 1 * DAY).toISOString() }),
      post({ post_id: 'too-old', created_at: new Date(NOW - 9 * DAY).toISOString() }),
      post({ post_id: 'genuinely-suppressed', created_at: new Date(NOW - 1 * DAY).toISOString() }),
    ];

    const { pending, suppressed } = selectPostsToRepublish(posts, NOW, cutoff, new Set(['processed']));

    expect(pending).toHaveLength(0);
    // Only the one that was eligible in every other respect.
    expect(suppressed).toBe(1);
  });
});

/**
 * The Aug 2026 outage orphaned 6 BREAKING and 3 CONFLICT_FLAG posts and not one
 * DEEP_DIVE — so this loop, which only ever re-cast DEEP_DIVE, could not have
 * recovered any of the failure it exists to catch. Widening it is real risk, so
 * it ships behind an allowlist and stays off until turned on deliberately.
 */
describe('selectPostsToRepublish — content-type allowlist', () => {
  const originalTypes = process.env.APPROVAL_SYNC_CONTENT_TYPES;

  afterEach(() => {
    if (originalTypes === undefined) delete process.env.APPROVAL_SYNC_CONTENT_TYPES;
    else process.env.APPROVAL_SYNC_CONTENT_TYPES = originalTypes;
  });

  it('defaults to DEEP_DIVE only — the behaviour that shipped', () => {
    delete process.env.APPROVAL_SYNC_CONTENT_TYPES;
    const posts = [
      post({ post_id: 'dd', content_type: 'DEEP_DIVE' }),
      post({ post_id: 'br', content_type: 'BREAKING' }),
      post({ post_id: 'cf', content_type: 'CONFLICT_FLAG' }),
    ];

    const { pending } = selectPostsToRepublish(posts, NOW, null);

    expect(pending.map((p) => p.post_id)).toEqual(['dd']);
  });

  it('lets the allowlisted types through when configured', () => {
    process.env.APPROVAL_SYNC_CONTENT_TYPES = 'DEEP_DIVE,CONFLICT_FLAG';
    const posts = [
      post({ post_id: 'dd', content_type: 'DEEP_DIVE' }),
      post({ post_id: 'br', content_type: 'BREAKING' }),
      post({ post_id: 'cf', content_type: 'CONFLICT_FLAG' }),
    ];

    const { pending } = selectPostsToRepublish(posts, NOW, null);

    expect(pending.map((p) => p.post_id).sort()).toEqual(['cf', 'dd']);
  });

  it('falls back to DEEP_DIVE on an empty or blank allowlist rather than opening up', () => {
    process.env.APPROVAL_SYNC_CONTENT_TYPES = '  ,  ';
    const posts = [
      post({ post_id: 'dd', content_type: 'DEEP_DIVE' }),
      post({ post_id: 'br', content_type: 'BREAKING' }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual(['dd']);
  });
});

/**
 * This loop recovers a publish that failed minutes-to-hours ago. Whether a
 * days-old injury report is still worth posting is an editorial call that
 * belongs to a human, so age budgets vary by type — a "breaking" headline cast
 * two days late is false on its face.
 */
describe('selectPostsToRepublish — per-type staleness', () => {
  const originalTypes = process.env.APPROVAL_SYNC_CONTENT_TYPES;

  beforeEach(() => {
    process.env.APPROVAL_SYNC_CONTENT_TYPES = 'BREAKING,TRACKING,CONFLICT_FLAG,DEEP_DIVE';
  });

  afterEach(() => {
    if (originalTypes === undefined) delete process.env.APPROVAL_SYNC_CONTENT_TYPES;
    else process.env.APPROVAL_SYNC_CONTENT_TYPES = originalTypes;
  });

  it('drops BREAKING older than 6 hours but keeps a fresh one', () => {
    const posts = [
      post({ post_id: 'fresh', content_type: 'BREAKING', created_at: new Date(NOW - 2 * HOUR).toISOString() }),
      post({ post_id: 'stale', content_type: 'BREAKING', created_at: new Date(NOW - 8 * HOUR).toISOString() }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual(['fresh']);
  });

  it('drops TRACKING older than 48 hours', () => {
    const posts = [
      post({ post_id: 'fresh', content_type: 'TRACKING', created_at: new Date(NOW - 24 * HOUR).toISOString() }),
      post({ post_id: 'stale', content_type: 'TRACKING', created_at: new Date(NOW - 3 * DAY).toISOString() }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual(['fresh']);
  });

  it('keeps CONFLICT_FLAG and DEEP_DIVE for the full 7 days', () => {
    const posts = [
      post({ post_id: 'cf', content_type: 'CONFLICT_FLAG', created_at: new Date(NOW - 5 * DAY).toISOString() }),
      post({ post_id: 'dd', content_type: 'DEEP_DIVE', created_at: new Date(NOW - 5 * DAY).toISOString() }),
      post({ post_id: 'ancient', content_type: 'DEEP_DIVE', created_at: new Date(NOW - 9 * DAY).toISOString() }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id).sort()).toEqual(['cf', 'dd']);
  });

  it('a cleared cutoff still cannot fire an 8-day-old BREAKING post', () => {
    const posts = [
      post({ post_id: 'walker', content_type: 'BREAKING', created_at: new Date(NOW - 8 * DAY).toISOString() }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending).toHaveLength(0);
  });
});

/**
 * publishApprovedPost skips the dedup and cadence checks publishInjuryPost
 * performs, so without this the three hashless Coby Bryant CONFLICT_FLAGs go
 * out back to back — and the two older ones carry a superseded team timeline.
 */
describe('selectPostsToRepublish — one per thread', () => {
  const originalTypes = process.env.APPROVAL_SYNC_CONTENT_TYPES;

  beforeEach(() => {
    process.env.APPROVAL_SYNC_CONTENT_TYPES = 'CONFLICT_FLAG,DEEP_DIVE';
  });

  afterEach(() => {
    if (originalTypes === undefined) delete process.env.APPROVAL_SYNC_CONTENT_TYPES;
    else process.env.APPROVAL_SYNC_CONTENT_TYPES = originalTypes;
  });

  it('keeps only the newest post on a thread', () => {
    const thread = 'coby-bryant-knee';
    const posts = [
      post({
        post_id: 'cf-1',
        content_type: 'CONFLICT_FLAG',
        parent_post_id: thread,
        created_at: new Date(NOW - 5 * DAY).toISOString(),
      }),
      post({
        post_id: 'cf-3',
        content_type: 'CONFLICT_FLAG',
        parent_post_id: thread,
        created_at: new Date(NOW - 1 * DAY).toISOString(),
      }),
      post({
        post_id: 'cf-2',
        content_type: 'CONFLICT_FLAG',
        parent_post_id: thread,
        created_at: new Date(NOW - 3 * DAY).toISOString(),
      }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual(['cf-3']);
  });

  it('does not collapse posts on different threads', () => {
    const posts = [
      post({ post_id: 'a', content_type: 'DEEP_DIVE', parent_post_id: 'thread-a' }),
      post({ post_id: 'b', content_type: 'DEEP_DIVE', parent_post_id: 'thread-b' }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending).toHaveLength(2);
  });

  it('returns oldest-first so a recovered backlog publishes in order', () => {
    const posts = [
      post({ post_id: 'newer', content_type: 'DEEP_DIVE', created_at: new Date(NOW - 1 * HOUR).toISOString() }),
      post({ post_id: 'older', content_type: 'DEEP_DIVE', created_at: new Date(NOW - 5 * HOUR).toISOString() }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual([
      'older',
      'newer',
    ]);
  });
});

/**
 * PUBLISHED is not proof of approval. A review-routed post used to be CREATED
 * PUBLISHED and flipped by a second call; had that call failed, the row met
 * every condition selectPostsToRepublish checks — and the default allowlist is
 * DEEP_DIVE, the one type that always routes to review.
 */
describe('withholdUnapproved — a review-routed post needs an APPROVED review', () => {
  it('withholds a required post with no APPROVED review', () => {
    const p = post({ post_id: 'flag-failed', md_review_required: true });
    const { allowed, withheld } = withholdUnapproved([p], new Set());
    expect(allowed).toEqual([]);
    expect(withheld).toEqual([p]);
  });

  it('lets an approved one through', () => {
    const p = post({ post_id: 'approved', md_review_required: true });
    const { allowed, withheld } = withholdUnapproved([p], new Set(['approved']));
    expect(allowed).toEqual([p]);
    expect(withheld).toEqual([]);
  });

  it('never consults approval for a post that was not routed to review', () => {
    // The auto-publish path: required=false, no review row exists by design.
    const p = post({ post_id: 'auto', md_review_required: false });
    expect(withholdUnapproved([p], new Set()).allowed).toEqual([p]);
  });

  it('matches on post_id or id, whichever the row carries', () => {
    const p = post({ post_id: undefined, id: 'by-id', md_review_required: true });
    expect(withholdUnapproved([p], new Set(['by-id'])).allowed).toEqual([p]);
  });

  it('runs after the newest-per-thread choice, so a withheld post does not promote an older sibling', () => {
    const older = post({ post_id: 'older', parent_post_id: 'root', created_at: new Date(NOW - 3 * HOUR).toISOString() });
    const newest = post({ post_id: 'newest', parent_post_id: 'root', md_review_required: true, created_at: new Date(NOW - 1 * HOUR).toISOString() });
    const { pending } = selectPostsToRepublish([older, newest], NOW, null);
    const { allowed, withheld } = withholdUnapproved(pending, new Set());
    expect(withheld.map((p) => p.post_id)).toEqual(['newest']);
    expect(allowed).toEqual([]);
  });
});

/**
 * The in-flight grace on the CAST path.
 *
 * ApprovalSync treats "PUBLISHED with no social hash" as "approved, and its
 * social publish failed". But the web row is written BEFORE the social calls and
 * the hashes are written back AFTER, so for the length of that window the same
 * row also means "publishing right now". The file's own auditSocialReach has had
 * a 10-minute floor for exactly this reason since it was written; the selector
 * that actually casts never got one. processedIds does not help: it is
 * in-memory and only covers this loop's own publishes, not the pipeline's and
 * not the approve route's.
 *
 * Measured live 2026-09-11: the window is sub-second (median 0.4s auto, 0.8s
 * approve, max 1.1s over 54 rows), and there were zero hashless PUBLISHED rows
 * inside the 7-day lookback. So this changes no live decision today. It is
 * argued from consequence: a double cast to the real Farcaster and X accounts
 * with no MD in the loop.
 */
describe('selectPostsToRepublish — the in-flight grace', () => {
  const MINUTE = 60 * 1000;

  it('holds back an auto-published row that was created seconds ago', () => {
    // The auto path never bumps updated_at when both socials fail, so
    // created_at is all there is — and here it is young.
    const posts = [post({ post_id: 'mid-publish', created_at: new Date(NOW - 30 * 1000).toISOString() })];

    expect(selectPostsToRepublish(posts, NOW, null).pending).toEqual([]);
  });

  /**
   * The case created_at alone cannot catch, and the reason the clock is
   * updated_at. A review-routed post is FILED hours or days before it is
   * approved, so its created_at is old the moment it becomes eligible — while
   * its social calls have only just started.
   */
  it('holds back a row approved seconds ago but filed hours ago', () => {
    const posts = [
      post({
        post_id: 'just-approved',
        created_at: new Date(NOW - 3 * HOUR).toISOString(),
        updated_at: new Date(NOW - 30 * 1000).toISOString(),
      }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending).toEqual([]);
  });

  it('lets a row through once the grace has passed', () => {
    const posts = [
      post({
        post_id: 'genuinely-failed',
        created_at: new Date(NOW - 3 * HOUR).toISOString(),
        updated_at: new Date(NOW - 11 * MINUTE).toISOString(),
      }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual([
      'genuinely-failed',
    ]);
  });

  /**
   * Placement, not just presence. The filter runs AFTER the newest-per-thread
   * collapse for the same reason withholdUnapproved does: holding back the
   * newest post must not promote an older sibling on the same thread, which by
   * construction carries a superseded timeline. A filter placed BEFORE the
   * collapse would return the sibling here.
   */
  it('does not promote an older sibling when the newest post is in flight', () => {
    const posts = [
      post({
        post_id: 'older-sibling',
        parent_post_id: 'thread-1',
        created_at: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      post({
        post_id: 'newest-in-flight',
        parent_post_id: 'thread-1',
        created_at: new Date(NOW - 30 * 1000).toISOString(),
      }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending).toEqual([]);
  });

  it('counts in-flight rows separately from the backlog cutoff', () => {
    const posts = [
      post({ post_id: 'in-flight', created_at: new Date(NOW - 30 * 1000).toISOString() }),
      post({ post_id: 'settled', created_at: new Date(NOW - 2 * HOUR).toISOString() }),
    ];

    const result = selectPostsToRepublish(posts, NOW, null);

    expect(result.inFlight).toBe(1);
    // suppressed is the editorial cutoff and must not absorb this count — an
    // in-flight row is not suppressed, it is not decidable yet.
    expect(result.suppressed).toBe(0);
    expect(result.pending.map((p) => p.post_id)).toEqual(['settled']);
  });

  /** A row that cannot be aged cannot be judged, and the safe answer is not to cast. */
  it('treats an unusable timestamp as in flight', () => {
    const posts = [post({ post_id: 'bad-clock', created_at: 'not a date' })];

    expect(selectPostsToRepublish(posts, NOW, null).pending).toEqual([]);
  });

  /** A malformed updated_at must make the gate more cautious, never less. */
  it('falls back to created_at when updated_at is unparseable', () => {
    const posts = [
      post({
        post_id: 'bad-updated',
        created_at: new Date(NOW - 2 * HOUR).toISOString(),
        updated_at: 'not a date',
      }),
    ];

    expect(selectPostsToRepublish(posts, NOW, null).pending.map((p) => p.post_id)).toEqual([
      'bad-updated',
    ]);
  });
});

describe('getSocialReachReport', () => {
  // getSocialReachReport reads Date.now(), and the fixtures above are pinned to
  // NOW. Without a fake clock these assertions decay as real time moves past
  // the fixture date — the suite silently started failing once it did.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockIsServerAvailable.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One full page: fewer rows than the page size, so has_more is false. */
  const listResponse = (posts: ApprovedPost[]) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          posts,
          total: posts.length,
          has_more: false,
          next_offset: null,
        }),
      },
    ],
  });

  it('counts PUBLISHED posts with neither hash', async () => {
    mockCallTool.mockResolvedValue(
      listResponse([
        post({ post_id: 'reached', farcaster_hash: '0xabc' }),
        post({ post_id: 'tweet-only', twitter_id: '123' }),
        post({ post_id: 'unreached-1' }),
        post({ post_id: 'unreached-2', created_at: new Date(NOW - 3 * HOUR).toISOString() }),
      ])
    );

    const report = await getSocialReachReport(24);

    expect(report.missing_social).toBe(2);
    expect(report.published).toBe(4);
    expect(report.sample.map((s) => s.post_id).sort()).toEqual(['unreached-1', 'unreached-2']);
    expect(report.truncated).toBe(false);
    expect(report.scanned).toBe(4);
  });

  it('ignores posts still mid-publish', async () => {
    // The web row is created before the social calls fire, so a row seconds old
    // with no hash is in flight, not failed.
    mockCallTool.mockResolvedValue(
      listResponse([post({ post_id: 'in-flight', created_at: new Date(NOW).toISOString() })])
    );

    const report = await getSocialReachReport(24);

    expect(report.missing_social).toBe(0);
    expect(report.published).toBe(0);
  });

  it('ignores a post approved seconds ago, however long it sat in the queue', async () => {
    // Same blind spot as the cast path: created_at is filing time, so a post
    // approved moments ago looks hours old and would be reported as an outage.
    mockCallTool.mockResolvedValue(
      listResponse([
        post({
          post_id: 'just-approved',
          created_at: new Date(NOW - 3 * HOUR).toISOString(),
          updated_at: new Date(NOW - 30 * 1000).toISOString(),
        }),
      ])
    );

    const report = await getSocialReachReport(24);

    expect(report.missing_social).toBe(0);
    expect(report.published).toBe(0);
  });

  /**
   * The regression proof. web_list_posts defaults to limit=20, and every caller
   * passed {} — so a 14-day and a 30-day window returned byte-identical counts
   * off the newest 20 rows. A post at index 25 was invisible at any window size.
   */
  it('sees a post past the first page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      post({ post_id: `reached-${i}`, farcaster_hash: '0xabc' })
    );
    const secondPage = [post({ post_id: 'unreached-page-2' })];

    mockCallTool
      .mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              posts: firstPage,
              total: 51,
              has_more: true,
              next_offset: 50,
            }),
          },
        ],
      })
      .mockResolvedValueOnce(listResponse(secondPage));

    const report = await getSocialReachReport(24);

    expect(report.scanned).toBe(51);
    expect(report.missing_social).toBe(1);
    expect(report.sample[0].post_id).toBe('unreached-page-2');
    expect(mockCallTool).toHaveBeenCalledTimes(2);
  });

  it('filters and pages server-side rather than asking for everything', async () => {
    mockCallTool.mockResolvedValue(listResponse([post({ post_id: 'unreached-1' })]));

    await getSocialReachReport(24);

    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_list_posts', {
      status: 'PUBLISHED',
      limit: 50,
      offset: 0,
    });
  });

  it('stops scanning once rows fall outside the window', async () => {
    // Rows come back newest-first, so the first row past the window ends the
    // scan — this is what keeps window_hours=720 from walking the whole table.
    mockCallTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            posts: [
              post({ post_id: 'in-window' }),
              post({ post_id: 'too-old', created_at: new Date(NOW - 40 * HOUR).toISOString() }),
            ],
            total: 500,
            has_more: true,
            next_offset: 50,
          }),
        },
      ],
    });

    const report = await getSocialReachReport(24);

    expect(report.scanned).toBe(1);
    expect(report.truncated).toBe(false);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('throws rather than reporting a clean bill of health when the query fails', async () => {
    mockCallTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'connection refused' }],
    });

    await expect(getSocialReachReport()).rejects.toThrow(/web_list_posts failed/);
  });

  it('throws when the web server is unavailable', async () => {
    mockIsServerAvailable.mockReturnValue(false);

    await expect(getSocialReachReport()).rejects.toThrow(/unavailable/);
  });
});
