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

import { readFileSync } from 'node:fs';
import { maybeProposeReturnWatch, type InjuryUpdateKind } from '../src/monitoring/return-watch.js';
import { _setTiersForTesting } from '../src/agents/injury-intelligence/significance.js';

// Recorded live by src/scripts/record-return-watch-fixture.ts (free text
// redacted). Guard rows below are DERIVED from these recorded rows — never
// written from scratch — so their keys are the ones the server really returns.
const RECORDED = JSON.parse(
  readFileSync(new URL('./fixtures/return-watch-responses.json', import.meta.url), 'utf8'),
) as {
  desk_list_updates: { updates: Record<string, unknown>[] };
  web_list_candidates_DISMISSED: { candidates: Record<string, unknown>[] };
  web_list_candidates_ACCEPTED: { candidates: Record<string, unknown>[] };
};

const TEST_TIERS = {
  version: 1,
  updated_at: '2026-07-18',
  athletes: [
    { name: 'Star Athlete', team: 'X', sport: 'NBA', tier: 1 as const },
    { name: 'Mid Athlete', team: 'Z', sport: 'NBA', tier: 2 as const },
    { name: 'Role Athlete', team: 'W', sport: 'NBA', tier: 3 as const },
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

// A Return Watch candidate for our post, built from a recorded DISMISSED row.
function rwCandidate(status: 'DISMISSED' | 'ACCEPTED', decidedDaysAgo: number) {
  return {
    ...RECORDED.web_list_candidates_DISMISSED.candidates[0],
    status,
    candidate_kind: 'RETURN_WATCH_UPDATE',
    target_desk_post_id: DESK_POST_ID,
    decided_at: daysAgo(decidedDaysAgo),
  };
}

// No update has ever been appended in production, so the recorded list is
// empty. Keys follow mcp's DeskPostUpdate (web/client.ts); the guard reads
// created_at only.
function deskUpdate(createdDaysAgo: number) {
  return {
    id: 'u1',
    desk_post_id: DESK_POST_ID,
    headline: '<redacted>',
    markdown_body: '<redacted>',
    occurred_at: daysAgo(createdDaysAgo),
    author_id: null,
    content_hash: 'h',
    created_at: daysAgo(createdDaysAgo),
  };
}

interface World {
  publishedDaysAgo?: number | null;
  updates?: unknown;
  dismissed?: unknown;
  accepted?: unknown;
  failTool?: string;
}

// Route by tool name, so a test states the world rather than a call order.
function setWorld(w: World = {}) {
  const published = w.publishedDaysAgo === undefined ? 20 : w.publishedDaysAgo;
  mockCallTool.mockImplementation(async (_server: string, tool: string, args: Record<string, unknown>) => {
    if (tool === w.failTool) return { isError: true, content: [{ type: 'text', text: 'boom' }] };
    switch (tool) {
      case 'web_get_published_desk_post_for_entity':
        return mcpText({ post: published === null ? null : { id: DESK_POST_ID, published_at: daysAgo(published) } });
      case 'desk_list_updates':
        return mcpText({ updates: w.updates ?? RECORDED.desk_list_updates.updates });
      case 'web_list_candidates':
        return args.status === 'DISMISSED'
          ? mcpText({ candidates: w.dismissed ?? RECORDED.web_list_candidates_DISMISSED.candidates })
          : mcpText({ candidates: w.accepted ?? RECORDED.web_list_candidates_ACCEPTED.candidates });
      case 'web_get_entity':
        return mcpText({ entity: { last_updated_at: daysAgo(0) } });
      case 'web_propose_candidate':
        return mcpText({ candidate: { id: 'c1' } });
      default:
        throw new Error(`unexpected tool ${tool}`);
    }
  });
}

const toolsCalled = () => mockCallTool.mock.calls.map((c) => c[1] as string);
const proposal = () => mockCallTool.mock.calls.find((c) => c[1] === 'web_propose_candidate')?.[2] as
  | Record<string, unknown>
  | undefined;

describe('maybeProposeReturnWatch', () => {
  beforeEach(() => {
    // mockReset (not clearAllMocks) so a prior test's implementation can never
    // leak into the next test.
    mockCallTool.mockReset();
    mockIsServerAvailable.mockReset();
    mockResolveSourceTier.mockReset();
    _setTiersForTesting(TEST_TIERS as Parameters<typeof _setTiersForTesting>[0]);
    mockIsServerAvailable.mockReturnValue(true);
    mockResolveSourceTier.mockResolvedValue('T1');
    delete process.env.RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH;
    delete process.env.RETURN_WATCH_TRACKING_MIN_SCORE;
    delete process.env.RETURN_WATCH_TRACKING_COOLDOWN_DAYS;
    setWorld();
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

  it.each<InjuryUpdateKind>(['TRACKING', 'RESOLUTION'])(
    'does nothing when the entity has no PUBLISHED desk post (%s)',
    async (kind) => {
      setWorld({ publishedDaysAgo: null });
      await maybeProposeReturnWatch(ENTITY_ID, kind, ctx);
      expect(toolsCalled()).toEqual(['web_get_published_desk_post_for_entity']);
    },
  );

  it.each<InjuryUpdateKind>(['TRACKING', 'RESOLUTION'])(
    'does nothing when the post was published too recently (%s, default 14-day floor)',
    async (kind) => {
      setWorld({ publishedDaysAgo: 3 });
      await maybeProposeReturnWatch(ENTITY_ID, kind, ctx);
      expect(toolsCalled()).toEqual(['web_get_published_desk_post_for_entity']);
    },
  );

  it('respects a custom RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH', async () => {
    process.env.RETURN_WATCH_MIN_DAYS_SINCE_PUBLISH = '1';
    setWorld({ publishedDaysAgo: 3 });
    await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
    expect(proposal()).toEqual(
      expect.objectContaining({ candidate_kind: 'RETURN_WATCH_UPDATE', target_desk_post_id: DESK_POST_ID }),
    );
  });

  describe('RESOLUTION always proposes', () => {
    it.each([
      ['tier 2 (the Simmons case, max 53 under the NEW_POST bar)', 'Mid Athlete', 'T1'],
      ['tier 3 with an unknown source', 'Role Athlete', 'unknown'],
      ['tier 4 with an unknown source', 'Depth Athlete', 'unknown'],
    ])('%s', async (_label, athleteName, source) => {
      mockResolveSourceTier.mockResolvedValue(source);
      await maybeProposeReturnWatch(ENTITY_ID, 'RESOLUTION', { ...ctx, athleteName });
      const p = proposal();
      expect(p).toEqual(
        expect.objectContaining({
          entity_id: ENTITY_ID,
          candidate_kind: 'RETURN_WATCH_UPDATE',
          target_desk_post_id: DESK_POST_ID,
          proposed_by: 'system',
        }),
      );
      expect(p?.reasons).toContain('resolution (always proposes)');
    });

    it('never reads the TRACKING guards, so a recent update or dismissal cannot block it', async () => {
      setWorld({ updates: [deskUpdate(1)], dismissed: [rwCandidate('DISMISSED', 1)], accepted: [rwCandidate('ACCEPTED', 1)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'RESOLUTION', ctx);
      expect(toolsCalled()).not.toContain('desk_list_updates');
      expect(toolsCalled()).not.toContain('web_list_candidates');
      expect(proposal()).toBeDefined();
    });

    it('is unaffected by a guard read that would fail', async () => {
      setWorld({ failTool: 'desk_list_updates' });
      await maybeProposeReturnWatch(ENTITY_ID, 'RESOLUTION', ctx);
      expect(proposal()).toBeDefined();
    });
  });

  describe('TRACKING bar (default 40, not the NEW_POST 55)', () => {
    it('proposes a tier-2 athlete at 53 with a T1 source', async () => {
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', { ...ctx, athleteName: 'Mid Athlete' });
      expect(proposal()?.promotion_score).toBe(53);
    });

    it('proposes a tier-3 athlete at 41 with a T1 source', async () => {
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', { ...ctx, athleteName: 'Role Athlete' });
      expect(proposal()?.promotion_score).toBe(41);
    });

    it('skips a tier-3 athlete at 34 with a T2 source', async () => {
      mockResolveSourceTier.mockResolvedValue('T2');
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', { ...ctx, athleteName: 'Role Athlete' });
      expect(proposal()).toBeUndefined();
    });

    it('skips a tier-4 athlete', async () => {
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', { ...ctx, athleteName: 'Depth Athlete' });
      expect(proposal()).toBeUndefined();
    });

    it('respects a custom RETURN_WATCH_TRACKING_MIN_SCORE', async () => {
      process.env.RETURN_WATCH_TRACKING_MIN_SCORE = '55';
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', { ...ctx, athleteName: 'Mid Athlete' });
      expect(proposal()).toBeUndefined();
    });
  });

  describe('TRACKING guards', () => {
    it('proposes against the recorded live responses (no updates, no RW candidates)', async () => {
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeDefined();
    });

    it('skips within 14 days of a Return Watch update on the post', async () => {
      setWorld({ updates: [deskUpdate(13)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeUndefined();
    });

    it('proposes once the last update is older than the cooldown', async () => {
      setWorld({ updates: [deskUpdate(15)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeDefined();
    });

    it('skips within 14 days of the MD dismissing a Return Watch candidate for this post', async () => {
      setWorld({ dismissed: [...RECORDED.web_list_candidates_DISMISSED.candidates, rwCandidate('DISMISSED', 5)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeUndefined();
    });

    it('proposes once that dismissal is older than the cooldown', async () => {
      setWorld({ dismissed: [rwCandidate('DISMISSED', 20)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeDefined();
    });

    it('ignores a dismissal for a different desk post', async () => {
      setWorld({ dismissed: [{ ...rwCandidate('DISMISSED', 1), target_desk_post_id: 'other-post' }] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeDefined();
    });

    it('ignores a dismissed NEW_POST candidate (the recorded rows)', async () => {
      setWorld({ dismissed: RECORDED.web_list_candidates_DISMISSED.candidates.map((c) => ({ ...c, decided_at: daysAgo(1) })) });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeDefined();
    });

    it('skips while an ACCEPTED Return Watch candidate for this post is still pending', async () => {
      setWorld({ accepted: [rwCandidate('ACCEPTED', 40)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeUndefined();
    });

    it('respects a custom RETURN_WATCH_TRACKING_COOLDOWN_DAYS', async () => {
      process.env.RETURN_WATCH_TRACKING_COOLDOWN_DAYS = '3';
      setWorld({ updates: [deskUpdate(5)], dismissed: [rwCandidate('DISMISSED', 5)] });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeDefined();
    });

    it.each(['desk_list_updates', 'web_list_candidates'])('skips when %s is rejected', async (tool) => {
      setWorld({ failTool: tool });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeUndefined();
    });

    it('skips when a candidate page comes back full (cannot have seen every row)', async () => {
      setWorld({ dismissed: Array.from({ length: 500 }, () => RECORDED.web_list_candidates_DISMISSED.candidates[0]) });
      await maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx);
      expect(proposal()).toBeUndefined();
    });
  });

  it('propagates MCP errors to the caller (failure isolation is the caller\'s job)', async () => {
    // maybeProposeReturnWatch does not swallow errors itself — deduplicator.ts
    // and poller.ts each wrap their call in a try/catch that warns and
    // continues, matching the existing web_append_injury_update call pattern.
    mockCallTool.mockReset();
    mockCallTool.mockRejectedValueOnce(new Error('boom'));
    await expect(maybeProposeReturnWatch(ENTITY_ID, 'TRACKING', ctx)).rejects.toThrow('boom');
  });
});
