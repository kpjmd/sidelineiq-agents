/**
 * A pending review item can be overtaken by events.
 *
 * #38 stopped the pipeline re-FILING a review item while an equivalent one was
 * pending — but it runs inside the `review.needed` branch. When the next
 * cycle's post PUBLISHES instead, it never enters that branch, and the pending
 * sibling is left sitting in the queue, approvable.
 *
 * Alvin Kamara, 2026-08-21: TRACKING c59cba69 filed to PENDING_REVIEW at 12:26
 * on thread b8d94a3f with a 4-week timeline; TRACKING caf3fee4 PUBLISHED at
 * 12:41 on the same thread with the same timeline. Approving the pending one
 * would have posted him to Farcaster and X a second time.
 *
 * The fixture carries the two rows that survive. The pending one was rejected
 * by hand, which at the time hard-DELETED it, so the test reconstructs it from
 * the published row's real payload overriding exactly three fields. Item 1 of
 * this same change is why it is gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InjuryPostContent } from '../src/types.js';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { publishInjuryPost } from '../src/utils/publishing-pipeline.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

const FIXTURE: { posts: Array<Record<string, unknown>> } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/kamara-supersede-pair.json', import.meta.url)),
    'utf-8',
  ),
);

/** The 12:41 TRACKING that published, verbatim. */
const PUBLISHED_TRACKING = FIXTURE.posts.find((p) => p.content_type === 'TRACKING')!;
/** The 12:26 BREAKING it hangs off, verbatim. */
const PARENT_BREAKING = FIXTURE.posts.find((p) => p.content_type === 'BREAKING')!;

// Read from the fixture, never retyped: the thread id is the real one and a
// hand-copied UUID that silently fails to match would make every assertion
// below pass for the wrong reason.
const THREAD_ID = String(PARENT_BREAKING.id);
const PENDING_ID = 'c59cba69-0000-4000-8000-000000000001';
const NEW_POST_ID = 'post-new';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/**
 * The deleted 12:26 pending row, rebuilt from the published sibling's real
 * payload. Only id, created_at and status differ — the fixture header names
 * those three and says why the original cannot be recorded.
 */
function pendingSibling(over: Record<string, unknown> = {}) {
  return {
    ...PUBLISHED_TRACKING,
    id: PENDING_ID,
    created_at: hoursAgo(1),
    status: 'PENDING_REVIEW',
    ...over,
  };
}

function publishedParent() {
  return { ...PARENT_BREAKING, created_at: hoursAgo(30) };
}

/** The 12:41 TRACKING as the pipeline would be asked to publish it. */
function kamaraTracking(over: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: String(PUBLISHED_TRACKING.athlete_name),
    sport: String(PUBLISHED_TRACKING.sport),
    team: String(PUBLISHED_TRACKING.team),
    injury_type: String(PUBLISHED_TRACKING.injury_type),
    injury_severity: 'MODERATE',
    content_type: 'TRACKING',
    parent_post_id: THREAD_ID,
    headline: String(PUBLISHED_TRACKING.headline),
    clinical_summary: String(PUBLISHED_TRACKING.clinical_summary),
    team_timeline_weeks: 4,
    return_to_play: {
      min_weeks: 3,
      max_weeks: 6,
      probability_week_2: 0.1,
      probability_week_4: 0.5,
      probability_week_8: 0.9,
      confidence: 0.8,
    },
    // Above threshold and not SEVERE, so this publishes rather than routing.
    confidence: 0.95,
    ...over,
  };
}

const WEB_CREATE = {
  content: [{ type: 'text', text: JSON.stringify({ post_id: NEW_POST_ID, slug: 'kamara-x' }) }],
};
const SOCIAL_OK = { content: [{ type: 'text', text: JSON.stringify({ hash: '0xabc' }) }] };

function withPriorPosts(posts: unknown[], supersedeResult?: unknown) {
  mockCallTool.mockImplementation(async (_server, tool) => {
    if (tool === 'web_list_posts') return posts;
    if (tool === 'web_create_injury_post') return WEB_CREATE;
    if (tool === 'web_supersede_injury_post') {
      if (supersedeResult) return supersedeResult;
      return { content: [{ type: 'text', text: JSON.stringify({ superseded: [PENDING_ID], skipped: [] }) }] };
    }
    return SOCIAL_OK;
  });
}

const supersedeCalls = () =>
  mockCallTool.mock.calls.filter((c) => c[1] === 'web_supersede_injury_post');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsServerAvailable.mockReturnValue(true);
});

describe('publishing retires the pending item it just answered', () => {
  // FAILS PRE-FIX: no such call existed anywhere, so the 12:26 row stayed
  // approvable and approving it would have double-posted Kamara.
  it('supersedes the equivalent pending row on the same thread', async () => {
    withPriorPosts([pendingSibling(), publishedParent()]);
    const r = await publishInjuryPost(kamaraTracking());

    expect(r.status).toBe('published');
    expect(supersedeCalls()).toHaveLength(1);
    expect(supersedeCalls()[0][2]).toMatchObject({
      post_ids: [PENDING_ID],
      superseded_by: NEW_POST_ID,
    });
    expect(r.superseded_post_ids).toEqual([PENDING_ID]);
  });

  // FAILS PRE-FIX. The Biadasz shape: three identical pending rows, one per
  // cycle. Retiring only the first would leave two approvable duplicates.
  it('retires every equivalent pending row, not just the first', async () => {
    const a = pendingSibling({ id: 'pending-a' });
    const b = pendingSibling({ id: 'pending-b' });
    const c = pendingSibling({ id: 'pending-c' });
    withPriorPosts([a, b, c, publishedParent()]);

    const r = await publishInjuryPost(kamaraTracking());
    expect(r.superseded_post_ids).toEqual(['pending-a', 'pending-b', 'pending-c']);
  });

  // FAILS PRE-FIX on the log assertion. MCP tool failures resolve as a VALUE
  // carrying isError, not a throw — a bare try/catch never sees one. And the
  // publish already succeeded, so a queue-hygiene failure must not be reported
  // as a failed publish.
  it('keeps the publish when supersede resolves as an isError value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    withPriorPosts([pendingSibling(), publishedParent()], {
      content: [{ type: 'text', text: 'permission denied' }],
      isError: true,
    });

    const r = await publishInjuryPost(kamaraTracking());
    expect(r.status).toBe('published');
    expect(r.platform_results.length).toBeGreaterThan(0);
    expect(r.superseded_post_ids).toBeUndefined();
    expect(spy.mock.calls.flat().join(' ')).toContain('SUPERSEDE FAILED');
    spy.mockRestore();
  });
});

describe('what supersede deliberately will not touch', () => {
  // PASSES IN BOTH DIRECTIONS — fail-closed, and the load-bearing one.
  // Retiring a queue item is a write against the MD's work; athlete-level
  // identity, all a parentless BREAKING has, is too weak to authorise it.
  it('does nothing when the publishing post has no thread', async () => {
    withPriorPosts([pendingSibling({ parent_post_id: null })]);
    const r = await publishInjuryPost(kamaraTracking({ parent_post_id: undefined }));
    expect(supersedeCalls()).toHaveLength(0);
    expect(r.superseded_post_ids).toBeUndefined();
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed.
  it.each([
    ['a different thread', { parent_post_id: 'another-thread' }],
    ['a different content_type', { content_type: 'CONFLICT_FLAG' }],
    ['a different disclosed timeline', { team_timeline_weeks: 12 }],
    ['a different severity', { injury_severity: 'SEVERE' }],
  ])('leaves a pending row with %s alone', async (_label, over) => {
    withPriorPosts([pendingSibling(over), publishedParent()]);
    await publishInjuryPost(kamaraTracking());
    expect(supersedeCalls()).toHaveLength(0);
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. Nothing published, so nothing was
  // answered; the pending row still holds a live question.
  it('does nothing on the review path', async () => {
    withPriorPosts([pendingSibling({ injury_severity: 'MODERATE', content_type: 'BREAKING' })]);
    const r = await publishInjuryPost(kamaraTracking({ injury_severity: 'SEVERE' }));
    expect(r.status).toBe('pending_review');
    expect(supersedeCalls()).toHaveLength(0);
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. A PUBLISHED sibling is coverage,
  // not a queue item, and the mcp guard would refuse it anyway.
  it('leaves an already-PUBLISHED sibling alone', async () => {
    withPriorPosts([pendingSibling({ status: 'PUBLISHED' }), publishedParent()]);
    await publishInjuryPost(kamaraTracking());
    expect(supersedeCalls()).toHaveLength(0);
  });
});
