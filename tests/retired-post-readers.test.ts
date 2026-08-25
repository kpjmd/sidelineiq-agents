/**
 * A retired post is not evidence of coverage.
 *
 * REJECTED and SUPERSEDED (mcp migration 021) join PUBLISHED and
 * PENDING_REVIEW in every query that has no status predicate. The readers that
 * ask "did we cover this?" are equality allowlists and already ignore an
 * unknown status; these are the ones that had no predicate at all, where a new
 * status silently starts counting as coverage.
 *
 * The deduplicator is the sharpest case and the reason this file exists: a
 * REJECTED post is the STRONGEST possible evidence we have NOT covered a story —
 * an MD looked at it and said no — and without the exclusion the first
 * rejection would suppress every later report about that athlete for 24 hours.
 *
 * All four suppression tests FAIL against pre-fix code: listAthletePosts had no
 * status filter of any kind, so each of these rows returned isDuplicate:true.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => true),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { checkForExisting } from '../src/monitoring/deduplicator.js';
import { isRetiredPostStatus } from '../src/utils/web-posts.js';
import type { RawInjuryEvent } from '../src/types.js';

const mockCallTool = vi.mocked(callTool);
const ARTICLE = 'https://www.espn.com/mma/story/_/id/1/mcgregor-acl';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function stubPosts(posts: Array<Record<string, unknown>>) {
  mockCallTool.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ posts }) }],
  } as never);
}

function event(over: Partial<RawInjuryEvent> = {}): RawInjuryEvent {
  return {
    athlete_name: 'Conor McGregor',
    sport: 'UFC',
    team: 'UFC',
    injury_description: 'Conor McGregor suffered ACL injury in UFC return',
    source_url: ARTICLE,
    reported_at: new Date(),
    source_name: 'espn-ufc',
    source_kind: 'article',
    ...over,
  };
}

function priorPost(over: Record<string, unknown> = {}) {
  return {
    post_id: 'p1',
    athlete_name: 'Conor McGregor',
    sport: 'UFC',
    created_at: hoursAgo(3),
    source_url: ARTICLE,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MAX_EVENT_AGE_DAYS', '7');
});

describe('fallback dedup ignores retired rows', () => {
  // FAILS PRE-FIX (all four): no status filter existed, so every one of these
  // came back isDuplicate:true and silenced the athlete for 24h.
  it.each(['REJECTED', 'SUPERSEDED'])(
    'a %s post 3h old does not make a new report a 24h duplicate',
    async (status) => {
      // The source_url differs so the same-article guard cannot be what passes it.
      stubPosts([priorPost({ status, source_url: 'https://other.example/story' })]);
      const result = await checkForExisting(event());
      expect(result.isDuplicate).toBe(false);
    },
  );

  it.each(['REJECTED', 'SUPERSEDED'])(
    'a %s post from the same article does not trigger the same-article guard',
    async (status) => {
      stubPosts([priorPost({ status })]);
      expect((await checkForExisting(event())).isDuplicate).toBe(false);
    },
  );
});

describe('what the exclusion deliberately still counts', () => {
  // PASSES IN BOTH DIRECTIONS — fail-closed. The exclusion is narrow: it drops
  // the retired set and nothing else. Tightening this reader to a PUBLISHED
  // allowlist is a separate, larger change, and a test asserting today's
  // PENDING_REVIEW behaviour is CORRECT would only make it harder to make.
  // This asserts what the code does, not that it is right.
  it('still counts a PENDING_REVIEW row, unchanged by this fix', async () => {
    stubPosts([priorPost({ status: 'PENDING_REVIEW' })]);
    expect((await checkForExisting(event())).isDuplicate).toBe(true);
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. A status-less row is malformed,
  // not retired, and must keep counting as coverage.
  it.each([undefined, null, ''])('does not treat status %s as retired', (status) => {
    expect(isRetiredPostStatus(status as string | null | undefined)).toBe(false);
  });

  it('still counts a PUBLISHED row', async () => {
    stubPosts([priorPost({ status: 'PUBLISHED' })]);
    expect((await checkForExisting(event())).isDuplicate).toBe(true);
  });
});
