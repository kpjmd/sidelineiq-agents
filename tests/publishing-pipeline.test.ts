import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InjuryPostContent } from '../src/types.js';

// Mock the MCP client manager
vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { publishInjuryPost, publishApprovedPost } from '../src/utils/publishing-pipeline.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

const WEB_CREATE_RESPONSE = { content: [{ type: 'text', text: JSON.stringify({ post_id: 'post-abc-123', status: 'PUBLISHED' }) }] };
const FARCASTER_RESPONSE = { content: [{ type: 'text', text: JSON.stringify({ hash: '0xdeadbeef', url: 'https://warpcast.com/~/conversations/0xdeadbeef' }) }] };
const TWITTER_RESPONSE = { content: [{ type: 'text', text: JSON.stringify({ id: 'tweet-xyz-456' }) }] };

function makeContent(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Patrick Mahomes',
    sport: 'NFL',
    team: 'Kansas City Chiefs',
    injury_type: 'High ankle sprain',
    injury_severity: 'MODERATE' as const,
    content_type: 'BREAKING',
    headline: 'Patrick Mahomes suffers high ankle sprain in Week 12',
    clinical_summary: 'MRI confirms Grade 2 high ankle sprain.',
    return_to_play: {
      min_weeks: 4,
      max_weeks: 6,
      probability_week_2: 0.20,
      probability_week_4: 0.65,
      probability_week_8: 0.95,
      confidence: 0.85,
    },
    confidence: 0.92,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsServerAvailable.mockReturnValue(true);
  mockCallTool.mockImplementation(async (_server, tool) => {
    if (tool === 'web_list_posts') return [];
    if (tool === 'web_create_injury_post') return WEB_CREATE_RESPONSE;
    if (tool === 'farcaster_publish_cast') return FARCASTER_RESPONSE;
    if (tool === 'farcaster_publish_thread') return FARCASTER_RESPONSE;
    if (tool === 'twitter_publish_tweet') return TWITTER_RESPONSE;
    if (tool === 'twitter_publish_thread') return TWITTER_RESPONSE;
    return { content: [{ type: 'text', text: 'ok' }] };
  });
});

describe('publishInjuryPost', () => {
  it('publishes web first, then social, then writes hashes back', async () => {
    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    expect(result.platform_results).toHaveLength(3);
    expect(result.platform_results.every((r) => r.success)).toBe(true);
    // The poller gates entity maintenance on this — see poller.ts maintainEntity call.
    expect(result.post_id).toBe('post-abc-123');

    // Sequence: dedup + web create + farcaster + twitter + web update = 5 calls
    expect(mockCallTool).toHaveBeenCalledTimes(5);
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_list_posts', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_create_injury_post', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('farcaster', 'farcaster_publish_thread', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('twitter', 'twitter_publish_thread', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_update_injury_post', {
      post_id: 'post-abc-123',
      updates: {
        farcaster_hash: '0xdeadbeef',
        twitter_id: 'tweet-xyz-456',
      },
      update_reason: 'Social platform hash writeback',
    });
  });

  it('routes to MD review when confidence is below threshold', async () => {
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));

    expect(result.status).toBe('pending_review');
    expect(result.reason).toContain('confidence');
    expect(result.post_id).toBe('post-abc-123');

    // No social call of ANY kind. Checking only *_publish_cast / *_publish_tweet
    // (as this used to) could not see a BREAKING post, which publishes via the
    // *_thread tools.
    const servers = mockCallTool.mock.calls.map((c) => c[0]);
    expect(servers).not.toContain('farcaster');
    expect(servers).not.toContain('twitter');
  });

  it('routes to MD review when severity is SEVERE', async () => {
    const result = await publishInjuryPost(
      makeContent({ injury_severity: 'SEVERE' as const, confidence: 0.95 })
    );

    expect(result.status).toBe('pending_review');
    expect(result.reason).toContain('SEVERE');
  });

  it('skips publishing when duplicate detected within 24h', async () => {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') {
        return [
          {
            athlete_name: 'Patrick Mahomes',
            sport: 'NFL',
            // Real rows always carry a status (schema default 'PUBLISHED');
            // only a post that reached an audience is evidence we covered this.
            status: 'PUBLISHED',
            created_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
          },
        ];
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('duplicate');
    // No post was created, so no entity maintenance should be attempted.
    expect(result.post_id).toBeUndefined();
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('still publishes to social when web post creation fails', async () => {
    mockCallTool.mockImplementation(async (server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (tool === 'web_create_injury_post') throw new Error('DB error');
      if (tool === 'farcaster_publish_cast') return FARCASTER_RESPONSE;
      if (tool === 'twitter_publish_tweet') return TWITTER_RESPONSE;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    const webResult = result.platform_results.find((r) => r.platform === 'web');
    expect(webResult?.success).toBe(false);
    const farcasterResult = result.platform_results.find((r) => r.platform === 'farcaster');
    expect(farcasterResult?.success).toBe(true);
    // No hash write-back since web create failed (no post ID)
    const callTools = mockCallTool.mock.calls.map((c) => c[1]);
    expect(callTools).not.toContain('web_update_injury_post');
    // ...and nothing to hang an entity off, so the poller must skip maintenance.
    expect(result.post_id).toBeUndefined();
  });

  it('continues publishing when one platform is unavailable', async () => {
    mockIsServerAvailable.mockImplementation((server) => server !== 'twitter');

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    const twitterResult = result.platform_results.find((r) => r.platform === 'twitter');
    expect(twitterResult?.success).toBe(false);
    expect(twitterResult?.error).toContain('unavailable');

    const farcasterResult = result.platform_results.find((r) => r.platform === 'farcaster');
    expect(farcasterResult?.success).toBe(true);
    const webResult = result.platform_results.find((r) => r.platform === 'web');
    expect(webResult?.success).toBe(true);
  });

  it('gracefully handles MCP server error during social publish', async () => {
    mockCallTool.mockImplementation(async (server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (tool === 'web_create_injury_post') return WEB_CREATE_RESPONSE;
      if (server === 'farcaster') throw new Error('Farcaster timeout');
      if (tool === 'twitter_publish_thread') return TWITTER_RESPONSE;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    const farcasterResult = result.platform_results.find((r) => r.platform === 'farcaster');
    expect(farcasterResult?.success).toBe(false);
    expect(farcasterResult?.error).toContain('timeout');
    const twitterResult = result.platform_results.find((r) => r.platform === 'twitter');
    expect(twitterResult?.success).toBe(true);
    // Hash write-back should still happen with twitter_id only
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_update_injury_post', {
      post_id: 'post-abc-123',
      updates: {
        twitter_id: 'tweet-xyz-456',
      },
      update_reason: 'Social platform hash writeback',
    });
  });
});

/**
 * The review path used to be two calls: create (whose `status` the server
 * stripped, so the row landed PUBLISHED) then web_flag_for_md_review to flip it.
 * The old assertion here — that `status: 'PENDING_REVIEW'` was PASSED to the
 * create — was true and meaningless: it checked the half the server discarded.
 *
 * The create now carries the review question and the server files the
 * md_reviews row in the same statement, echoing `md_review_filed`. These pin
 * both directions: no second call when it filed, a loud fallback when it did not.
 */
describe('publishInjuryPost — review filed on create', () => {
  /** Shape of mcp web_create_injury_post's toolSuccess payload (tools.ts). */
  const createResponse = (payload: Record<string, unknown>) => ({
    content: [{ type: 'text', text: JSON.stringify({ post_id: 'post-rev-1', slug: 's', created_at: 't', ...payload }) }],
  });

  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function respondWith(create: unknown, flag: unknown = { content: [{ type: 'text', text: '{}' }] }) {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (tool === 'web_create_injury_post') return create;
      if (tool === 'web_flag_for_md_review') {
        if (flag instanceof Error) throw flag;
        return flag;
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });
  }
  const toolsCalled = () => mockCallTool.mock.calls.map((c) => c[1]);
  const createArgs = () =>
    mockCallTool.mock.calls.find((c) => c[1] === 'web_create_injury_post')![2] as Record<string, unknown>;

  it('sends the review question WITH the create', async () => {
    respondWith(createResponse({ status: 'PENDING_REVIEW', md_review_filed: true }));
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));

    expect(createArgs()).toMatchObject({
      status: 'PENDING_REVIEW',
      md_review_required: true,
      md_review_reason: result.reason,
      md_review_confidence: 0.6,
    });
  });

  it('makes no flag call when the create filed the review', async () => {
    respondWith(createResponse({ status: 'PENDING_REVIEW', md_review_filed: true }));
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));

    expect(result.status).toBe('pending_review');
    expect(result.post_id).toBe('post-rev-1');
    // Pre-fix the pipeline ALWAYS made this second call.
    expect(toolsCalled()).not.toContain('web_flag_for_md_review');
    expect(result.review_flag_failed).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('REVIEW NOT FILED'));
  });

  it('falls back to the flag call when the create did not say it filed', async () => {
    // An mcp that predates md_review_filed: status stripped, field absent.
    respondWith(createResponse({ status: 'PUBLISHED' }));
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));

    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_flag_for_md_review', {
      post_id: 'post-rev-1',
      reason: result.reason,
      confidence_score: 0.6,
      flagged_by: 'injury-intelligence-agent',
    });
    expect(result.review_flag_failed).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('REVIEW NOT FILED ON CREATE'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('status=PUBLISHED'));
  });

  it('treats anything but a literal true as not filed', async () => {
    for (const filed of ['true', 1, null]) {
      mockCallTool.mockClear();
      respondWith(createResponse({ status: 'PENDING_REVIEW', md_review_filed: filed }));
      await publishInjuryPost(makeContent({ confidence: 0.6 }));
      expect(toolsCalled()).toContain('web_flag_for_md_review');
    }
  });

  it('reports review_flag_failed when the fallback flag is rejected', async () => {
    respondWith(
      createResponse({ status: 'PUBLISHED' }),
      { isError: true, content: [{ type: 'text', text: 'Error: Post post-rev-1 not found.' }] },
    );
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));

    expect(result.status).toBe('pending_review');
    expect(result.review_flag_failed).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MD REVIEW FLAG FAILED'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('post=post-rev-1'));
  });

  it('reports review_flag_failed when the fallback flag throws', async () => {
    respondWith(createResponse({ status: 'PUBLISHED' }), new Error('socket hang up'));
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));
    expect(result.review_flag_failed).toBe(true);
  });

  it('an auto-published create carries no review question', async () => {
    respondWith(createResponse({ status: 'PUBLISHED' }));
    await publishInjuryPost(makeContent());
    const args = createArgs();
    expect(args.status).toBe('PUBLISHED');
    expect(args.md_review_required).toBe(false);
    expect(args).not.toHaveProperty('md_review_reason');
    expect(toolsCalled()).not.toContain('web_flag_for_md_review');
  });
});

describe('publishInjuryPost — dedup envelope handling (F5 regression)', () => {
  const recentPost = () => ({
    athlete_name: 'Patrick Mahomes',
    sport: 'NFL',
    // Real rows always carry a status (schema default 'PUBLISHED');
    // only a post that reached an audience is evidence we covered this.
    status: 'PUBLISHED',
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  });

  it('detects a duplicate from a real MCP envelope (array payload)', async () => {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') {
        return { content: [{ type: 'text', text: JSON.stringify([recentPost()]) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('duplicate');
  });

  it('detects a duplicate from a {posts:[...]} wrapped envelope', async () => {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') {
        return { content: [{ type: 'text', text: JSON.stringify({ posts: [recentPost()] }) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());
    expect(result.status).toBe('skipped');
  });

  it('publishes when the only prior post is older than 24h', async () => {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify([{
              athlete_name: 'Patrick Mahomes',
              sport: 'NFL',
              // Real rows always carry a status (schema default 'PUBLISHED');
              // only a post that reached an audience is evidence we covered this.
              status: 'PUBLISHED',
              created_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
            }]),
          }],
        };
      }
      if (tool === 'web_create_injury_post') return WEB_CREATE_RESPONSE;
      if (tool === 'farcaster_publish_thread') return FARCASTER_RESPONSE;
      if (tool === 'twitter_publish_thread') return TWITTER_RESPONSE;
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());
    expect(result.status).toBe('published');
  });
});

describe('publishInjuryPost — MD review gate hardening (F3, F4, F6)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['0,75', '75', '-1', 'abc'])(
    'ignores invalid threshold %j and applies the 0.75 default',
    async (bad) => {
      vi.stubEnv('MD_REVIEW_CONFIDENCE_THRESHOLD', bad);
      // Above default → publishes (proves a bad env did not disable the gate);
      // below default → routes to review (proves it did not flag everything).
      const above = await publishInjuryPost(makeContent({ confidence: 0.8 }));
      expect(above.status).toBe('published');
      const below = await publishInjuryPost(makeContent({ confidence: 0.7 }));
      expect(below.status).toBe('pending_review');
    },
  );

  it('routes NaN confidence to review (fail closed)', async () => {
    const result = await publishInjuryPost(makeContent({ confidence: NaN }));
    expect(result.status).toBe('pending_review');
  });

  it('publishes when confidence exactly equals the threshold', async () => {
    vi.stubEnv('MD_REVIEW_CONFIDENCE_THRESHOLD', '0.75');
    const result = await publishInjuryPost(makeContent({ confidence: 0.75 }));
    expect(result.status).toBe('published');
  });

  it('routes to review when md_review_flags is set, even at high confidence', async () => {
    const result = await publishInjuryPost(
      makeContent({ confidence: 0.99, md_review_flags: ['rtp_monotonicity_violation'] }),
    );
    expect(result.status).toBe('pending_review');
    expect(result.reason).toContain('rtp_monotonicity_violation');
  });

  it('forceMDReviewReason overrides a passing confidence check', async () => {
    const result = await publishInjuryPost(
      makeContent({ confidence: 0.99 }),
      { forceMDReviewReason: 'fact_soft_fail:source_tier_low' },
    );
    expect(result.status).toBe('pending_review');
    expect(result.reason).toBe('fact_soft_fail:source_tier_low');
  });

  // The force flag used to short-circuit needsMDReview entirely, so whatever
  // else was true of the post never reached the queue. A reviewer opening a
  // post flagged 'athlete_name_drift' had no way to see it was also SEVERE.
  it('keeps the intrinsic reason alongside a forced one', async () => {
    const result = await publishInjuryPost(
      makeContent({ confidence: 0.99, injury_severity: 'SEVERE' }),
      { forceMDReviewReason: 'athlete_name_drift' },
    );
    expect(result.status).toBe('pending_review');
    expect(result.reason).toContain('athlete_name_drift');
    expect(result.reason).toContain('SEVERE');
  });

  it('records the forced reason alone when nothing intrinsic applies', async () => {
    const result = await publishInjuryPost(
      makeContent({ confidence: 0.99, injury_severity: 'MODERATE' }),
      { forceMDReviewReason: 'athlete_name_drift' },
    );
    // No trailing separator, no empty second clause.
    expect(result.reason).toBe('athlete_name_drift');
  });
});

/**
 * A five-day social publish outage went unnoticed because these three outcomes
 * were indistinguishable in the logs — and the middle one was completely
 * silent. Each must now produce its own greppable line.
 */
describe('publishInjuryPost — social reach reporting', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  const errorLines = () => errorSpy.mock.calls.map((c) => String(c[0]));
  const logLines = () => logSpy.mock.calls.map((c) => String(c[0]));

  it('reports reaching 0 social platforms as an error, naming both causes', async () => {
    mockCallTool.mockImplementation(async (server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (tool === 'web_create_injury_post') return WEB_CREATE_RESPONSE;
      if (server === 'farcaster') throw new Error('Neynar API returned status 400');
      if (server === 'twitter') throw new Error('Twitter API forbidden');
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    const failure = errorLines().find((l) => l.includes('SOCIAL PUBLISH FAILED'));
    expect(failure).toBeDefined();
    expect(failure).toContain('post post-abc-123');
    expect(failure).toContain('Neynar API returned status 400');
    expect(failure).toContain('Twitter API forbidden');

    // Nothing to write back, and that skip is no longer silent.
    expect(mockCallTool.mock.calls.map((c) => c[1])).not.toContain('web_update_injury_post');
  });

  it('reports a published-but-unparseable hash separately from a failed publish', async () => {
    // Both platforms accept the post but answer in a shape we cannot read —
    // the cast and tweet are live, only the DB link is lost.
    mockCallTool.mockImplementation(async (server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (tool === 'web_create_injury_post') return WEB_CREATE_RESPONSE;
      if (server === 'farcaster') return { content: [{ type: 'text', text: JSON.stringify({ cast_hash: '0xdeadbeef' }) }] };
      if (server === 'twitter') return { content: [{ type: 'text', text: JSON.stringify({ tweet: { id: '123' } }) }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.platform_results.filter((r) => r.success)).toHaveLength(3);
    const unparseable = errorLines().filter((l) => l.includes('SOCIAL HASH UNPARSEABLE'));
    expect(unparseable).toHaveLength(2);
    expect(unparseable.some((l) => l.includes('the cast published'))).toBe(true);
    expect(unparseable.some((l) => l.includes('the tweet published'))).toBe(true);

    // Not a publish failure — that line must NOT appear.
    expect(errorLines().some((l) => l.includes('SOCIAL PUBLISH FAILED'))).toBe(false);
    expect(mockCallTool.mock.calls.map((c) => c[1])).not.toContain('web_update_injury_post');
  });

  it('does not report a rejected hash writeback as a success', async () => {
    // callTool resolves tool-level errors as a value rather than throwing, so
    // an unchecked writeback logged "Wrote social hashes back" over a failure.
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (tool === 'web_create_injury_post') return WEB_CREATE_RESPONSE;
      if (tool === 'farcaster_publish_thread') return FARCASTER_RESPONSE;
      if (tool === 'twitter_publish_thread') return TWITTER_RESPONSE;
      if (tool === 'web_update_injury_post') {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'column farcaster_hash does not exist' }) }] };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    await publishInjuryPost(makeContent());

    expect(logLines().some((l) => l.includes('Wrote social hashes back'))).toBe(false);
    const failure = errorLines().find((l) => l.includes('Failed to write social hashes'));
    expect(failure).toBeDefined();
    expect(failure).toContain('column farcaster_hash does not exist');
  });

  it('stays quiet on the happy path', async () => {
    await publishInjuryPost(makeContent());

    expect(errorLines().some((l) => l.includes('SOCIAL PUBLISH FAILED'))).toBe(false);
    expect(errorLines().some((l) => l.includes('SOCIAL HASH UNPARSEABLE'))).toBe(false);
    expect(logLines().some((l) => l.includes('Wrote social hashes back'))).toBe(true);
  });
});

/**
 * publishApprovedPost was named publishApprovedDeepDive and said "DEEP_DIVE" in
 * every log line and in the persisted update_reason, so an MD approving a
 * BREAKING post saw "Approved DEEP_DIVE social publish" — misleading in exactly
 * the logs relied on to tell whether a publish reached anyone. The function
 * itself was always content-type agnostic; only the wording lied.
 */
describe('publishApprovedPost — content type is not assumed', () => {
  const POST_URL = 'https://sidelineiq.vercel.app/post/mahomes-ankle';

  it('sends a single cast for CONFLICT_FLAG and a thread for DEEP_DIVE', async () => {
    await publishApprovedPost(makeContent({ content_type: 'CONFLICT_FLAG' }), POST_URL, 'post-1');
    const conflictTools = mockCallTool.mock.calls.map((c) => c[1]);
    expect(conflictTools).toContain('farcaster_publish_cast');
    expect(conflictTools).not.toContain('farcaster_publish_thread');

    mockCallTool.mockClear();

    await publishApprovedPost(makeContent({ content_type: 'DEEP_DIVE' }), POST_URL, 'post-2');
    const deepDiveTools = mockCallTool.mock.calls.map((c) => c[1]);
    expect(deepDiveTools).toContain('farcaster_publish_thread');
  });

  it('records the real content type in the persisted update_reason', async () => {
    await publishApprovedPost(makeContent({ content_type: 'BREAKING' }), POST_URL, 'post-3');

    const writeback = mockCallTool.mock.calls.find((c) => c[1] === 'web_update_injury_post');
    expect(writeback).toBeDefined();
    expect((writeback![2] as { update_reason: string }).update_reason).toBe(
      'Approved BREAKING social hash writeback'
    );
  });

  it('writes both hashes back so the post stops looking unreached', async () => {
    await publishApprovedPost(makeContent({ content_type: 'BREAKING' }), POST_URL, 'post-4');

    const writeback = mockCallTool.mock.calls.find((c) => c[1] === 'web_update_injury_post');
    expect((writeback![2] as { updates: Record<string, string> }).updates).toEqual({
      farcaster_hash: '0xdeadbeef',
      twitter_id: 'tweet-xyz-456',
    });
  });

  it('says a publish reached nobody rather than reporting success', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg) => errors.push(String(msg)));
    mockIsServerAvailable.mockImplementation((server) => server === 'web');

    await publishApprovedPost(makeContent({ content_type: 'TRACKING' }), POST_URL, 'post-5');

    expect(errors.join('\n')).toContain('SOCIAL PUBLISH FAILED');
    spy.mockRestore();
  });
});
