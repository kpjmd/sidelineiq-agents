/**
 * publishApprovedReply posts only a claimed, approved proposal and records the
 * outcome; the request carries no text.
 */
import { describe, it, expect } from 'vitest';
import { publishApprovedReply, ReplyPublishRefused, type ReplyPublishDeps, type ReplyProposalRow } from '../src/ledger/publish-reply.js';
import { mcpText, mcpError } from './helpers/ledger-published-row.js';

const PID = '55555555-5555-4555-8555-555555555555';
const approved: ReplyProposalRow = { id: PID, platform: 'x', mention_id: '1972000000000000009', mention_url: null, proposed_text: 'Drafted text.', approved_text: 'Edited by the MD.', decision: 'approved', posted_id: null };

function harness(opts: { claim?: unknown; post?: unknown; unavailable?: string[] } = {}) {
  const calls: Array<{ server: string; tool: string; params: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const deps: ReplyPublishDeps = {
    callTool: async (server, tool, params) => {
      calls.push({ server, tool, params });
      if (tool === 'web_record_reply_post') {
        if (params.outcome === 'claim') return opts.claim ?? mcpText({ proposal: approved });
        return mcpText({ proposal: { ...approved, decision: params.outcome === 'posted' ? 'posted' : 'approved', posted_id: params.posted_id ?? null } });
      }
      if (tool === 'twitter_publish_tweet') return opts.post ?? mcpText({ id: 'reply-1' });
      if (tool === 'farcaster_publish_cast') return opts.post ?? mcpText({ hash: '0xreply' });
      throw new Error(`unexpected ${tool}`);
    },
    isServerAvailable: (s) => !(opts.unavailable ?? []).includes(s),
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs };
}

describe('publishApprovedReply', () => {
  it('claims, posts approved_text as a reply to the mention, records posted — in that order', async () => {
    const h = harness();
    const out = await publishApprovedReply(PID, h.deps);
    expect(out).toMatchObject({ success: true, platform: 'x', posted_id: 'reply-1', text: 'Edited by the MD.' });
    expect(h.calls.map((c) => `${c.tool}:${c.params.outcome ?? ''}`)).toEqual(['web_record_reply_post:claim', 'twitter_publish_tweet:', 'web_record_reply_post:posted']);
    expect(h.calls[1].params).toEqual({ text: 'Edited by the MD.', reply_to_id: '1972000000000000009' });
    expect(h.calls[2].params).toMatchObject({ posted_id: 'reply-1', posted_text: 'Edited by the MD.' });
  });

  it('falls back to proposed_text when the MD approved as drafted; farcaster replies with parent_cast_hash', async () => {
    const h = harness({ claim: mcpText({ proposal: { ...approved, platform: 'farcaster', approved_text: null, mention_id: '0xparent' } }) });
    const out = await publishApprovedReply(PID, h.deps);
    expect(out.text).toBe('Drafted text.');
    expect(h.calls[1]).toMatchObject({ server: 'farcaster', tool: 'farcaster_publish_cast', params: { text: 'Drafted text.', parent_cast_hash: '0xparent' } });
    expect(out.posted_id).toBe('0xreply');
  });

  it('a refused claim (pending, discarded, or already in flight) is 409 and posts nothing', async () => {
    const h = harness({ claim: mcpError('Reply proposal x is not approved, or a post attempt is already in flight') });
    await expect(publishApprovedReply(PID, h.deps)).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.calls.filter((c) => c.tool !== 'web_record_reply_post')).toEqual([]);
  });

  it('a post failure records failed (releasing the claim) and returns success:false', async () => {
    const h = harness({ post: mcpError('duplicate content') });
    const out = await publishApprovedReply(PID, h.deps);
    expect(out.success).toBe(false);
    expect(out.error).toBe('duplicate content');
    const last = h.calls[h.calls.length - 1];
    expect(last.params).toMatchObject({ outcome: 'failed', error: 'duplicate content' });
    expect(h.logs.some((l) => l.includes('REPLY POST FAILED'))).toBe(true);
  });

  it('forbidden words in the approved text refuse the post and release the claim', async () => {
    const h = harness({ claim: mcpText({ proposal: { ...approved, approved_text: 'You should fade this lock.' } }) });
    await expect(publishApprovedReply(PID, h.deps)).rejects.toBeInstanceOf(ReplyPublishRefused);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_record_reply_post', 'web_record_reply_post']);
    expect(h.calls[1].params.outcome).toBe('failed');
  });

  it('web unavailable is 503 before any claim; platform unavailable releases the claim', async () => {
    const down = harness({ unavailable: ['web'] });
    await expect(publishApprovedReply(PID, down.deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(down.calls).toEqual([]);
    const tw = harness({ unavailable: ['twitter'] });
    await expect(publishApprovedReply(PID, tw.deps)).rejects.toMatchObject({ httpStatus: 503 });
    expect(tw.calls[1].params.outcome).toBe('failed');
  });
});
