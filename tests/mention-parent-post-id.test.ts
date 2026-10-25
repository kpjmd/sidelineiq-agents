/**
 * parentPostId must be the POST a mention replies to, because the reply agent
 * looks our post up by it. It was the replied-to AUTHOR's user id, so the
 * original-post context never loaded (LeBron mention 2114150143171977634,
 * 2026-10-24: inReplyToUserId was our account, the post was 2114149474805162247).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => false),
}));

import { toTwitterSocialMention, type TwitterMentionRaw } from '../src/agents/social/mention-monitor-loop.js';

const raw: TwitterMentionRaw = {
  id: '2114150143171977634',
  text: '@Paratrosinjury I think there sitting him on purpose',
  authorId: '999',
  authorUsername: 'Lebronin1',
  authorFollowerCount: 8515,
  conversationId: '2114149474805162247',
  inReplyToUserId: '1900000000000000001',
  inReplyToTweetId: '2114149474805162247',
  createdAt: '2026-10-25T00:20:47.000Z',
};

describe('toTwitterSocialMention', () => {
  it('takes parentPostId from the replied-to post, not the replied-to user', () => {
    const m = toTwitterSocialMention(raw);
    expect(m.parentPostId).toBe('2114149474805162247');
    expect(m.parentPostId).not.toBe(raw.inReplyToUserId);
  });

  it('leaves parentPostId undefined when the mcp does not send the post id', () => {
    const { inReplyToTweetId: _omit, ...older } = raw;
    expect(toTwitterSocialMention(older).parentPostId).toBeUndefined();
  });

  it('maps the remaining fields unchanged', () => {
    const m = toTwitterSocialMention(raw);
    expect(m).toMatchObject({
      platform: 'twitter',
      mentionId: raw.id,
      text: raw.text,
      authorHandle: 'Lebronin1',
      authorFollowerCount: 8515,
      conversationId: raw.conversationId,
      createdAt: raw.createdAt,
    });
    expect(m.rawPayload).toBe(raw);
  });
});
