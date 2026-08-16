/**
 * The fallback dedup path — what runs when no player resolves and no entity can
 * be found, plus the same-article guard that both paths share.
 *
 * An ESPN article stays in the feed for MAX_EVENT_AGE_DAYS (7 by default) and is
 * re-emitted as an event every cycle for its whole life. With only a 24h memory,
 * the SAME article becomes publishable again every single day.
 *
 * The guard is keyed on source_kind, not on the sport. It used to be keyed on
 * `!hasRosterProvider(sport)`, which was a correct proxy only while UFC was both
 * the only rosterless sport and the only article-sourced one. What it was always
 * about is whether the URL identifies one STORY (news) or a shared FEED endpoint
 * (the structured sources, where every event carries the same URL).
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
/** What espn-ufc falls back to when an article carries no story link. */
const UFC_NEWS_FEED = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/news?limit=50';

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
    source_kind: 'article',
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

/**
 * The entity path, once fighters have player rows.
 *
 * This is the failure direction the roster change creates. Before it, a UFC
 * story republished daily. After it, an entity matches and — with no is_update,
 * which no news source can ever set — EVERYTHING after the first post is
 * suppressed for 21 days, including "McGregor to undergo surgery" five days
 * later. The classifier's is_new judgement is the substitute signal.
 */
describe('the entity path with a resolved fighter', () => {
  const PLAYER = { player_id: 'pl-1', full_name: 'Conor McGregor', confidence: 'exact' };
  const META = {
    body_parts: ['knee'],
    primary_body_part: 'knee',
    laterality: 'UNSPECIFIED' as const,
    injury_type_hint: 'acl tear',
  };

  /** web_find_matching_entity → match, then whatever else the path calls. */
  function stubEntityMatch(posts: Array<Record<string, unknown>> = []) {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_find_matching_entity') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                matched: true,
                entity_id: 'ent-1',
                canonical_post_id: 'post-1',
                body_part: 'knee',
                laterality: 'UNSPECIFIED',
                injury_type: 'acl tear',
                match_count: 1,
              }),
            },
          ],
        } as never;
      }
      if (tool === 'web_list_posts') {
        return { content: [{ type: 'text', text: JSON.stringify({ posts }) }] } as never;
      }
      return { content: [{ type: 'text', text: '{}' }] } as never;
    });
  }

  const context = (over: Record<string, unknown> = {}) =>
    ({ resolvedPlayer: PLAYER, metadata: META, ...over }) as never;

  it('suppresses a repeat when nothing signals an update', async () => {
    stubEntityMatch();
    const result = await checkForExisting(event(), context({ isUpdate: false }));
    expect(result.isDuplicate).toBe(true);
    expect(result.decision).toBe('entity_match_skip');
  });

  it('lets the surgery follow-up through on the classifier signal alone', async () => {
    // The whole point. The source cannot set is_update — espn-ufc has no status
    // field to set it from — so without this the follow-up is silenced for 21
    // days and UFC ends up quieter with entity backing than without it.
    stubEntityMatch();
    const result = await checkForExisting(
      event({
        source_url: SURGERY_ARTICLE,
        injury_description: 'Conor McGregor to undergo surgery, plans to fight again',
      }),
      context({ isUpdate: true, updateSignal: 'classifier' }),
    );
    expect(result.isDuplicate).toBe(false);
    expect(result.decision).toBe('entity_match_pass_through');
    // The parent link is what makes it a TRACKING post on the existing thread
    // rather than a second unthreaded BREAKING.
    expect(result.existingPostId).toBe('post-1');
    expect(result.entityId).toBe('ent-1');
  });

  it('still suppresses an update signal when the article was already published', async () => {
    // An article is re-served every cycle for its whole life. Without this the
    // classifier escape would re-open the same story every 15 minutes, each
    // time burning a Sonnet call and an entity timeline row before the cadence
    // throttle rejected it downstream.
    stubEntityMatch([
      { post_id: 'p9', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(25), source_url: ACL_ARTICLE },
    ]);
    const result = await checkForExisting(event(), context({ isUpdate: true }));
    expect(result.isDuplicate).toBe(true);
    expect(result.decision).toBe('entity_match_same_source');
  });

  it('does not apply the same-article check to a feed-sourced event', async () => {
    // Every NFL event shares one URL, so this check would suppress the entire
    // sport after its first post.
    stubEntityMatch([
      { post_id: 'p9', athlete_name: 'Some Rookie', sport: 'NFL', created_at: hoursAgo(25), source_url: NFL_FEED },
    ]);
    const result = await checkForExisting(
      event({ athlete_name: 'Some Rookie', sport: 'NFL', team: 'Bears', source_url: NFL_FEED, source_kind: 'feed' }),
      context({ isUpdate: true }),
    );
    expect(result.isDuplicate).toBe(false);
    expect(result.decision).toBe('entity_match_pass_through');
  });

  it('falls back to the source flag when the caller computes no signal', async () => {
    // Back-compat: a caller that predates DedupContext.isUpdate must behave
    // exactly as it did, reading event.is_update alone.
    stubEntityMatch();
    const passed = await checkForExisting(event({ is_update: true }), context());
    expect(passed.decision).toBe('entity_match_pass_through');

    stubEntityMatch();
    const skipped = await checkForExisting(event({ is_update: false }), context());
    expect(skipped.decision).toBe('entity_match_skip');
  });
});

describe('feed-sourced events are untouched by the article guard', () => {
  const nflFeedEvent = (over: Partial<RawInjuryEvent> = {}) =>
    event({
      athlete_name: 'Some Rookie',
      sport: 'NFL',
      team: 'Bears',
      source_url: NFL_FEED,
      source_kind: 'feed',
      ...over,
    });

  it('does not apply the source guard to an unresolved NFL athlete', async () => {
    // NFL's source_url is the FEED, shared by every NFL event, so a URL guard
    // there would suppress every unresolved NFL athlete after the first one.
    // Those sports get entity dedup anyway; this path is their transient
    // fallback, not their permanent state.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Some Rookie', sport: 'NFL', created_at: hoursAgo(25), source_url: NFL_FEED },
    ]);
    expect((await checkForExisting(nflFeedEvent())).isDuplicate).toBe(false);
  });

  it('still applies the plain 24h window to NFL', async () => {
    stubPosts([
      { post_id: 'p1', athlete_name: 'Some Rookie', sport: 'NFL', created_at: hoursAgo(3), source_url: NFL_FEED },
    ]);
    expect((await checkForExisting(nflFeedEvent())).isDuplicate).toBe(true);
  });

  it('treats an unset source_kind as a feed, not an article', async () => {
    // The conservative default. An event with no declared kind must not have
    // its URL treated as an identity — that is the direction that suppresses
    // real reports, and the one a new source would fall into by omission.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(25), source_url: ACL_ARTICLE },
    ]);
    const result = await checkForExisting(event({ source_kind: undefined }));
    expect(result.isDuplicate).toBe(false);
  });

  it('does not apply the guard when a news source fell back to its feed URL', async () => {
    // espn-ufc sets source_kind:'feed' when an article carries no story link,
    // because the fallback URL is the shared news endpoint. Treating that as an
    // article identity would suppress every fighter after the first.
    stubPosts([
      { post_id: 'p1', athlete_name: 'Conor McGregor', sport: 'UFC', created_at: hoursAgo(25), source_url: UFC_NEWS_FEED },
    ]);
    const result = await checkForExisting(
      event({ source_url: UFC_NEWS_FEED, source_kind: 'feed' }),
    );
    expect(result.isDuplicate).toBe(false);
  });
});
