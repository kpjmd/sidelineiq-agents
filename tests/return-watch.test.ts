import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallTool = vi.fn();
const mockIsServerAvailable = vi.fn();
vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: (...args: unknown[]) => mockCallTool(...args),
  isServerAvailable: (...args: unknown[]) => mockIsServerAvailable(...args),
}));

const mockResolveSourceTier = vi.fn();
vi.mock('../src/agents/injury-intelligence/fact-validator.js', () => ({
  resolveSourceTier: (...args: unknown[]) => mockResolveSourceTier(...args),
}));

// Keep the real scoring math (already covered by significance.test.ts) but
// stub the file-reading loader so tests control tiers deterministically via
// _setTiersForTesting instead of depending on data/athlete-tiers.json.
vi.mock('../src/agents/injury-intelligence/significance.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/agents/injury-intelligence/significance.js')>();
  return { ...actual, loadSignificanceData: vi.fn().mockResolvedValue(undefined) };
});

import { maybeProposeReturnWatch, type InjuryUpdateKind } from '../src/monitoring/return-watch.js';
import { _setTiersForTesting } from '../src/agents/injury-intelligence/significance.js';

const TEST_TIERS = {
  version: 1,
  updated_at: '2026-07-18',
  athletes: [
    { name: 'Star Athlete', team: 'X', sport: 'NBA', tier: 1 as const },
    { name: 'Depth Athlete', team: 'Y', sport: 'NBA', tier: 4 as const },
  ],
};

function mcpText(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const ENTITY_ID = 'entity-1';
const DESK_POST_ID = 'post-1';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const ctx = { athleteName: 'Star Athlete', sport: 'NBA' as const, sourceUrl: 'https://espn.com/x' };

describe('maybeProposeReturnWatch', () => {
  beforeEach(() => {
    // mockReset (not clearAllMocks) so a prior test's unconsumed
    // mockResolvedValueOnce queue can never leak into the next test.
    mockCallTool.mockReset();
    mockIsServerAvailable.mockReset();
    mockResolveSourceTier.mockReset();
    _setTiersForTesting(TEST_TIERS as Parameters<typeof _setTiersForTesting>[0]);
    mockIsServerAvailable.mockReturnValue(true);
    mockResolveSourceTier.mockResolvedValue('T1');
    delete process.env.RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH;
  });

  it.each<InjuryUpdateKind>(['CONFLICT', 'CORRECTION', 'INITIAL', 'DEEP_DIVE'])(
    'ignores update_kind=%s',
    async (kind) => {
      await maybeProposeReturnWatch(ENTITY_ID, kind, ctx);
      expect(mockCallTool).not.toHaveBeenCalled();
    },
  );

  it('does nothing when the web MCP server is unavailable', async () => {
    mockIsServerAvailable.mockReturnValue(false);
    await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('does nothing when the entity has no PUBLISHED desk post', async () => {
    mockCallTool.mockResolvedValueOnce(mcpText({ post: null }));
    await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith(
      'web',
      'web_get_published_desk_post_for_entity',
      { entity_id: ENTITY_ID },
    );
  });

  it('does nothing when the post was published too recently (default 14-day floor)', async () => {
    mockCallTool.mockResolvedValueOnce(
      mcpText({ post: { id: DESK_POST_ID, published_at: daysAgo(3) } }),
    );
    await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('respects a custom RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH', async () => {
    process.env.RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH = '1';
    mockCallTool
      .mockResolvedValueOnce(mcpText({ post: { id: DESK_POST_ID, published_at: daysAgo(3) } }))
      .mockResolvedValueOnce(mcpText({ entity: { last_updated_at: daysAgo(0) } }))
      .mockResolvedValueOnce(mcpText({ candidate: { id: 'c1' } }));
    await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
    expect(mockCallTool).toHaveBeenCalledTimes(3);
    expect(mockCallTool).toHaveBeenNthCalledWith(
      3,
      'web',
      'web_propose_candidate',
      expect.objectContaining({ candidate_kind: 'RETURN_WATCH_UPDATE', target_desk_post_id: DESK_POST_ID }),
    );
  });

  it('does not propose a candidate for a low-tier athlete below threshold', async () => {
    mockCallTool
      .mockResolvedValueOnce(mcpText({ post: { id: DESK_POST_ID, published_at: daysAgo(20) } }))
      .mockResolvedValueOnce(mcpText({ entity: { last_updated_at: daysAgo(0) } }));
    await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', { ...ctx, athleteName: 'Depth Athlete' });
    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(mockCallTool).not.toHaveBeenCalledWith('web', 'web_propose_candidate', expect.anything());
  });

  it('proposes a RETURN_WATCH_UPDATE candidate for a high-tier athlete above threshold', async () => {
    mockCallTool
      .mockResolvedValueOnce(mcpText({ post: { id: DESK_POST_ID, published_at: daysAgo(20) } }))
      .mockResolvedValueOnce(mcpText({ entity: { last_updated_at: daysAgo(0) } }))
      .mockResolvedValueOnce(mcpText({ candidate: { id: 'c1' } }));
    await maybeProposeReturnWatch(ENTITY_ID, 'RESOLUTION', ctx);
    expect(mockCallTool).toHaveBeenCalledTimes(3);
    expect(mockCallTool).toHaveBeenNthCalledWith(
      3,
      'web',
      'web_propose_candidate',
      expect.objectContaining({
        entity_id: ENTITY_ID,
        candidate_kind: 'RETURN_WATCH_UPDATE',
        target_desk_post_id: DESK_POST_ID,
        proposed_by: 'system',
      }),
    );
  });

  it('propagates MCP errors to the caller (failure isolation is the caller\'s job)', async () => {
    // maybeProposeReturnWatch does not swallow errors itself — deduplicator.ts
    // and poller.ts each wrap their call in a try/catch that warns and
    // continues, matching the existing web_append_injury_update call pattern.
    mockCallTool.mockRejectedValueOnce(new Error('boom'));
    await expect(maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx)).rejects.toThrow('boom');
  });
});
