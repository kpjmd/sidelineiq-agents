import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InjuryPostContent } from '../src/types.js';

// Mock the MCP client manager
vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { publishInjuryPost } from '../src/utils/publishing-pipeline.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

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
      timeline: '4-6 weeks',
      probability: 0.85,
      factors: ['Grade of sprain', 'Player age'],
    },
    confidence: 0.92,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsServerAvailable.mockReturnValue(true);
  // Default: no existing posts (no duplicates)
  mockCallTool.mockImplementation(async (server, tool) => {
    if (tool === 'web_list_posts') return [];
    return { content: [{ type: 'text', text: 'ok' }] };
  });
});

describe('publishInjuryPost', () => {
  it('publishes to all 3 platforms in parallel on BREAKING content', async () => {
    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    expect(result.platform_results).toHaveLength(3);
    expect(result.platform_results.every((r) => r.success)).toBe(true);

    // Dedup check + 3 publishes = 4 callTool calls
    expect(mockCallTool).toHaveBeenCalledTimes(4);
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_list_posts', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('farcaster', 'farcaster_publish_cast', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('twitter', 'twitter_publish_tweet', expect.any(Object));
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_create_injury_post', expect.any(Object));
  });

  it('routes to MD review when confidence is below threshold', async () => {
    const result = await publishInjuryPost(makeContent({ confidence: 0.6 }));

    expect(result.status).toBe('pending_review');
    expect(result.reason).toContain('confidence');

    // Should NOT call farcaster or twitter publish
    const callArgs = mockCallTool.mock.calls.map((c) => `${c[0]}.${c[1]}`);
    expect(callArgs).not.toContain('farcaster.farcaster_publish_cast');
    expect(callArgs).not.toContain('twitter.twitter_publish_tweet');

    // Should call web create with PENDING_REVIEW and flag for review
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_create_injury_post', expect.objectContaining({ status: 'PENDING_REVIEW' }));
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_flag_for_md_review', expect.any(Object));
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
            created_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6 hours ago
          },
        ];
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('duplicate');
    // Only the dedup check should have been called
    expect(mockCallTool).toHaveBeenCalledTimes(1);
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

  it('gracefully handles MCP server error during publish', async () => {
    mockCallTool.mockImplementation(async (server, tool) => {
      if (tool === 'web_list_posts') return [];
      if (server === 'farcaster') throw new Error('Farcaster timeout');
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const result = await publishInjuryPost(makeContent());

    expect(result.status).toBe('published');
    const farcasterResult = result.platform_results.find((r) => r.platform === 'farcaster');
    expect(farcasterResult?.success).toBe(false);
    expect(farcasterResult?.error).toContain('timeout');

    // Other platforms should still succeed
    const twitterResult = result.platform_results.find((r) => r.platform === 'twitter');
    expect(twitterResult?.success).toBe(true);
  });
});
