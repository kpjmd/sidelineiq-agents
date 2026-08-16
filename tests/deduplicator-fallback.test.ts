/**
 * The fallback dedup path — the only dedup a sport with no roster ever gets.
 *
 * For NFL/NBA/PL an athlete resolves to a player row, an injury_entity forms,
 * and entity-aware dedup covers 21 days with an is_update escape for genuine
 * follow-ups. UFC fighters are not team-rostered, so web_resolve_player returns
 * resolved=false for every one of them (verified against production), no entity
 * ever forms, and this 24h window is the whole story.
 *
 * That collides with the news sources: an ESPN article stays in the feed for
 * MAX_EVENT_AGE_DAYS (7 by default) and is re-emitted as an event every cycle
 * for its whole life. With only a 24h memory, the SAME article becomes
 * publishable again every single day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => true),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { checkForExisting } from '../src/monitoring/deduplicator.js';
import type { RawInjuryEvent } from '../src/types.js';

const mockCallTool = vi.mocked(callTool);

const ACL_ARTICLE = 'https://www.espn.com/mma/story/_/id/1/mcgregor-acl';
const SURGERY_ARTICLE = 'https://www.espn.com/mma/story/_/id/2/mcgregor-surgery';
/** NFL's structured feed: every NFL event shares this one URL. */
const NFL_FEED = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

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
    injury_description: 'Conor McGregor suffered ACL injury in UFC return, Dana White says',
    source_url: ACL_ARTICLE,
    reported_at: new Date(),
    source_name: 'espn-ufc',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MAX_EVENT_AGE_DAYS', '7');
});

describe('the 24h window still governs same-day repeats', () => {
  it('suppresses a second post about the same athlete within 24h', async () => {
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(3), source_url: ACL_ARTICLE },
    ]);
    const result = await checkForExisting(event());
    expect(result.isDuplicate).toBe(true);
    expect(result.decision).toBe('fallback_24h');
  });

  it('lets a genuinely new athlete through', async () => {
    stubPosts([]);
    expect((await checkForExisting(event())).isDuplicate).toBe(false);
  });
});

describe('an article that is still in the feed must not republish daily', () => {
  it('suppresses the SAME article re-served the next day', async () => {
    // The failure this test exists for. The ESPN news feed keeps serving this
    // article for 7 days; at 25h the 24h window has expired and the identical
    // story would publish a second time, then a third the day after.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(25), source_url: ACL_ARTICLE },
    ]);
    const result = await checkForExisting(event());
    expect(result.isDuplicate).toBe(true);
    expect(result.decision).toBe('fallback_same_source');
  });

  it('still suppresses it six days later, while the article is in the window', async () => {
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(24 * 6), source_url: ACL_ARTICLE },
    ]);
    expect((await checkForExisting(event())).isDuplicate).toBe(true);
  });

  it('does NOT suppress a genuinely new article about the same injury', async () => {
    // "McGregor to undergo surgery" five days after the ACL report is a real
    // follow-up. A blunt long window would have killed it — this is why the
    // guard is keyed on the article, not on the athlete.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(24 * 5), source_url: ACL_ARTICLE },
    ]);
    const result = await checkForExisting(
      event({
        source_url: SURGERY_ARTICLE,
        injury_description: 'Conor McGregor to undergo surgery, plans to fight again',
      }),
    );
    expect(result.isDuplicate).toBe(false);
  });

  it('releases the article once it can no longer be re-served', async () => {
    // Past MAX_EVENT_AGE_DAYS the source drops it, so it cannot come back and
    // there is nothing left to suppress.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(24 * 9), source_url: ACL_ARTICLE },
    ]);
    expect((await checkForExisting(event())).isDuplicate).toBe(false);
  });
});

describe('sports that do have a roster are untouched', () => {
  it('does not apply the source guard to an unresolved NFL athlete', async () => {
    // NFL's source_url is the FEED, shared by every NFL event, so a URL guard
    // there would suppress every unresolved NFL athlete after the first one.
    // Those sports get entity dedup anyway; this path is their transient
    // fallback, not their permanent state.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Some Rookie', sport: 'NFL', created_at: hoursAgo(25), source_url: NFL_FEED },
    ]);
    const result = await checkForExisting(
      event({ athlete_name: 'Some Rookie', sport: 'NFL', team: 'Bears', source_url: NFL_FEED }),
    );
    expect(result.isDuplicate).toBe(false);
  });

  it('still applies the plain 24h window to NFL', async () => {
    stubPosts([
      { post_id: 'p1', athlete_name: 'Some Rookie', sport: 'NFL', created_at: hoursAgo(3), source_url: NFL_FEED },
    ]);
    const result = await checkForExisting(
      event({ athlete_name: 'Some Rookie', sport: 'NFL', team: 'Bears', source_url: NFL_FEED }),
    );
    expect(result.isDuplicate).toBe(true);
  });
});
