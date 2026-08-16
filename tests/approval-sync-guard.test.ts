import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import {
  selectPostsToRepublish,
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

describe('getSocialReachReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsServerAvailable.mockReturnValue(true);
  });

  const listResponse = (posts: ApprovedPost[]) => ({
    content: [{ type: 'text', text: JSON.stringify(posts) }],
  });

  it('counts PUBLISHED posts with neither hash', async () => {
    mockCallTool.mockResolvedValue(
      listResponse([
        post({ post_id: 'reached', farcaster_hash: '0xabc' }),
        post({ post_id: 'tweet-only', twitter_id: '123' }),
        post({ post_id: 'unreached-1' }),
        post({ post_id: 'unreached-2', created_at: new Date(Date.now() - 3 * HOUR).toISOString() }),
      ])
    );

    const report = await getSocialReachReport(24);

    expect(report.missing_social).toBe(2);
    expect(report.published).toBe(4);
    expect(report.sample.map((s) => s.post_id).sort()).toEqual(['unreached-1', 'unreached-2']);
  });

  it('ignores posts still mid-publish', async () => {
    // The web row is created before the social calls fire, so a row seconds old
    // with no hash is in flight, not failed.
    mockCallTool.mockResolvedValue(
      listResponse([post({ post_id: 'in-flight', created_at: new Date().toISOString() })])
    );

    const report = await getSocialReachReport(24);

    expect(report.missing_social).toBe(0);
    expect(report.published).toBe(0);
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
