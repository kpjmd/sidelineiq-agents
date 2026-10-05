/**
 * proposeReply maps this repo's platform names onto the mcp's, builds a link
 * the physician can open, and surfaces an mcp rejection instead of swallowing it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => true),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { proposeReply, proposalPlatform, mentionUrl } from '../src/agents/social/reply-agent.js';
import type { SocialMention } from '../src/types.js';

const mockCallTool = vi.mocked(callTool);

const mention: SocialMention = {
  platform: 'twitter',
  mentionId: '1972000000000000009',
  text: 'How long is he out?',
  authorHandle: 'fan123',
  conversationId: 'c1',
  createdAt: '2026-10-05T00:00:00Z',
  rawPayload: {},
};

beforeEach(() => mockCallTool.mockReset());

describe('proposeReply', () => {
  it('files web_propose_reply with platform x, the mention link and the drafted text', async () => {
    mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ proposal: { id: 'p1' }, status: 'created' }) }] });
    const r = await proposeReply(mention, 'Reference-class estimate: 2-4 games.');
    expect(r).toEqual({ proposalId: 'p1', status: 'created' });
    expect(mockCallTool).toHaveBeenCalledWith('web', 'web_propose_reply', {
      platform: 'x',
      mention_id: '1972000000000000009',
      mention_url: 'https://x.com/i/web/status/1972000000000000009',
      mention_author: 'fan123',
      mention_text: 'How long is he out?',
      proposed_text: 'Reference-class estimate: 2-4 games.',
    });
  });

  it('an mcp rejection throws rather than reading as success', async () => {
    mockCallTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Input validation error: bad' }] });
    await expect(proposeReply(mention, 'x')).rejects.toThrow(/web_propose_reply: Input validation error/);
  });

  it('maps platforms and builds mention links', () => {
    expect(proposalPlatform('twitter')).toBe('x');
    expect(proposalPlatform('farcaster')).toBe('farcaster');
    expect(mentionUrl({ platform: 'farcaster', mentionId: '0xabc' })).toBe('https://warpcast.com/~/conversations/0xabc');
  });
});
