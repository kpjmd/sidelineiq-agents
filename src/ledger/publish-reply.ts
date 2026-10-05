/**
 * Post a reply the physician has APPROVED (spec "Automation boundary": third-
 * party replies require the physician's confirmation; D6; mcp migration 027).
 * Reachable only from POST /admin/ledger/reply/:id. The other place a social
 * tool is called with ledger-adjacent content is publish.ts; nothing else.
 *
 * The request carries no text. What goes out is the row's approved_text (the
 * MD's final wording) or, failing that, the proposed_text the MD approved as
 * drafted — both already recorded, so the record precedes the act.
 *
 * Steps: claim (web_record_reply_post claim: one guarded UPDATE on an approved,
 * unclaimed row — a second request or a double click gets an error here and
 * posts nothing) → vocabulary rule → post → record 'posted' with the platform
 * id, or 'failed' with the error so the MD can retry.
 */
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { findForbiddenWords } from './copy.js';
import type { CallTool } from './publish.js';

export interface ReplyProposalRow {
  id: string;
  platform: 'x' | 'farcaster';
  mention_id: string;
  mention_url: string | null;
  proposed_text: string;
  approved_text: string | null;
  decision: string;
  posted_id: string | null;
}

export interface ReplyPublishDeps {
  callTool: CallTool;
  isServerAvailable: (server: 'web' | 'twitter' | 'farcaster') => boolean;
  log: (line: string) => void;
}

export interface ReplyPublishOutcome {
  success: boolean;
  proposal_id: string;
  platform: 'x' | 'farcaster';
  text: string;
  posted_id?: string;
  error?: string;
}

export class ReplyPublishRefused extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = 'ReplyPublishRefused';
    this.httpStatus = httpStatus;
  }
}

function parseToolText<T>(raw: unknown): T | null {
  try {
    const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

async function record(deps: ReplyPublishDeps, params: Record<string, unknown>): Promise<ReplyProposalRow> {
  const raw = await deps.callTool('web', 'web_record_reply_post', params);
  if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
  const p = parseToolText<{ proposal?: ReplyProposalRow }>(raw)?.proposal;
  if (!p) throw new Error('web_record_reply_post returned no proposal');
  return p;
}

export async function publishApprovedReply(proposalId: string, deps: ReplyPublishDeps): Promise<ReplyPublishOutcome> {
  if (!deps.isServerAvailable('web')) throw new ReplyPublishRefused(503, 'Web MCP server unavailable');

  // Claim first: this is the lock. Whatever happens after, a second request
  // finds the row claimed and is refused by the mcp.
  let proposal: ReplyProposalRow;
  try {
    proposal = await record(deps, { proposal_id: proposalId, outcome: 'claim' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`[Ledger] REPLY CLAIM REFUSED ${proposalId}: ${message}`);
    throw new ReplyPublishRefused(409, `reply proposal cannot be claimed: ${message}`);
  }

  const server = proposal.platform === 'x' ? 'twitter' : 'farcaster';
  const text = (proposal.approved_text ?? proposal.proposed_text).trim();
  const release = async (error: string) => {
    try {
      await record(deps, { proposal_id: proposalId, outcome: 'failed', error });
    } catch (err) {
      deps.log(`[Ledger] REPLY RELEASE FAILED ${proposalId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const forbidden = findForbiddenWords(text);
  if (forbidden.length > 0) {
    await release(`forbidden words: ${forbidden.join(', ')}`);
    throw new ReplyPublishRefused(422, `approved text contains forbidden words: ${forbidden.join(', ')}`);
  }
  if (!deps.isServerAvailable(server)) {
    await release(`${server} MCP server unavailable`);
    throw new ReplyPublishRefused(503, `${server} MCP server unavailable`);
  }

  try {
    let postedId: string | undefined;
    if (proposal.platform === 'x') {
      const raw = await deps.callTool('twitter', 'twitter_publish_tweet', { text, reply_to_id: proposal.mention_id });
      if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
      postedId = parseToolText<{ id?: string }>(raw)?.id;
    } else {
      const raw = await deps.callTool('farcaster', 'farcaster_publish_cast', { text, parent_cast_hash: proposal.mention_id });
      if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
      postedId = parseToolText<{ hash?: string }>(raw)?.hash;
    }
    if (!postedId) throw new Error('platform returned no id');
    await record(deps, { proposal_id: proposalId, outcome: 'posted', posted_id: postedId, posted_text: text });
    deps.log(`[Ledger] REPLY POSTED ${proposalId} ${proposal.platform} ${postedId}`);
    return { success: true, proposal_id: proposalId, platform: proposal.platform, text, posted_id: postedId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`[Ledger] REPLY POST FAILED ${proposalId} ${proposal.platform}: ${message}`);
    await release(message);
    return { success: false, proposal_id: proposalId, platform: proposal.platform, text, error: message };
  }
}
