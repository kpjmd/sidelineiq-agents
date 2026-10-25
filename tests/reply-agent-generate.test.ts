/**
 * generateReply gets its JSON through structured outputs, never a forced tool
 * call: claude-sonnet-5-5 answers tool_choice "tool"/"any" with a 400, which is
 * how every reply draft failed after the move off claude-sonnet-4-20250514.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));
vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => false),
}));

import { generateReply } from '../src/agents/social/reply-agent.js';
import type { SocialMention } from '../src/types.js';

const mention: SocialMention = {
  platform: 'twitter',
  mentionId: '2114150143171977634',
  text: 'How long is he out?',
  authorHandle: 'fan123',
  conversationId: 'c1',
  createdAt: '2026-10-24T00:00:00Z',
  rawPayload: {},
};

function textResponse(json: unknown, stop_reason = 'end_turn') {
  return { stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(json) }] };
}

beforeEach(() => mockCreate.mockReset());

describe('generateReply', () => {
  it('sends a json_schema output format and no tools or tool_choice', async () => {
    mockCreate.mockResolvedValue(textResponse({ reply_text: 'About 2-4 weeks.' }));

    const result = await generateReply(mention, 'CLINICAL_QUESTION');

    expect(result).toEqual({ replyText: 'About 2-4 weeks.' });
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params).not.toHaveProperty('tool_choice');
    expect(params).not.toHaveProperty('tools');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.output_config.format.schema.required).toEqual(['reply_text']);
    expect(params.output_config.format.schema.additionalProperties).toBe(false);
  });

  it('parses the correction shape for CORRECTION', async () => {
    mockCreate.mockResolvedValue(
      textResponse({ reply_text: 'Corrected.', correction_field: 'player_team', old_value: 'LAL', new_value: 'CLE' }),
    );

    const result = await generateReply(mention, 'CORRECTION');

    expect(result).toEqual({
      replyText: 'Corrected.',
      correctionData: { field: 'player_team', oldValue: 'LAL', newValue: 'CLE' },
    });
    expect(mockCreate.mock.calls[0][0].output_config.format.schema.required).toContain('correction_field');
  });

  it.each(['refusal', 'max_tokens'])('throws on stop_reason=%s', async (stop) => {
    mockCreate.mockResolvedValue(textResponse({ reply_text: 'x' }, stop));
    await expect(generateReply(mention, 'ENGAGEMENT')).rejects.toThrow(`stop_reason=${stop}`);
  });
});
