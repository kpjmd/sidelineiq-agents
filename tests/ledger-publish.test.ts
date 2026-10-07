/**
 * publishLedgerForecast: the ONE social caller for ledger content. Pins the
 * refusals, the order commit → X → self-reply → Farcaster → provenance, the
 * dry run, and the fail-closed rule "no commit, no post".
 */
import { describe, it, expect, vi } from 'vitest';
import { publishLedgerForecast, LedgerPublishRefused, type PublishDeps } from '../src/ledger/publish.js';
import type { GithubCommitDeps } from '../src/ledger/github-commit.js';
import { publishedRow, mcpText, mcpError, FORECAST_ID } from './helpers/ledger-published-row.js';

const COMMIT_URL = 'https://github.com/kpjmd/paratros-ledger/commit/c0ffee1234567';

function githubOk(): GithubCommitDeps {
  return {
    fetch: async (_url, init) =>
      init?.method === 'GET'
        ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        : new Response(JSON.stringify({ commit: { sha: 'c0ffee1234567', html_url: COMMIT_URL } }), { status: 201 }),
    sleep: async () => {},
    token: 't',
    owner: 'kpjmd',
    repo: 'paratros-ledger',
    branch: 'main',
  };
}

function githubDown(): GithubCommitDeps {
  return { ...githubOk(), fetch: async () => new Response('{}', { status: 503 }), maxAttempts: 1 };
}

interface Harness {
  deps: PublishDeps;
  calls: Array<{ server: string; tool: string; params: Record<string, unknown> }>;
  logs: string[];
}

function harness(row: unknown, opts: { github?: GithubCommitDeps | null; env?: NodeJS.ProcessEnv; responses?: Record<string, unknown[]>; unavailable?: string[] } = {}): Harness {
  const calls: Harness['calls'] = [];
  const logs: string[] = [];
  const queues: Record<string, unknown[]> = { ...(opts.responses ?? {}) };
  let tweetN = 0;
  const callTool: PublishDeps['callTool'] = async (server, tool, params) => {
    calls.push({ server, tool, params });
    if (queues[tool]?.length) return queues[tool].shift();
    if (tool === 'web_get_ledger_forecast') return mcpText({ forecast: row });
    if (tool === 'twitter_publish_tweet') return mcpText({ id: `tweet-${++tweetN}`, url: 'https://x.com/paratros/status/1' });
    if (tool === 'farcaster_publish_cast') return mcpText({ hash: '0xcast', url: 'https://warpcast.com/paratros/0xcast' });
    if (tool === 'web_record_ledger_provenance') return mcpText({ forecast: { ...(row as object), ...params } });
    if (tool === 'web_audit_append') return mcpText({ id: 'audit-1', ts: '2026-10-07T00:00:00Z' });
    throw new Error(`unexpected tool ${tool}`);
  };
  const deps: PublishDeps = {
    callTool,
    isServerAvailable: (s) => !(opts.unavailable ?? []).includes(s),
    github: opts.github === undefined ? githubOk() : opts.github,
    env: opts.env ?? {},
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs };
}

const socialTools = (h: Harness) => h.calls.filter((c) => c.tool.startsWith('twitter_') || c.tool.startsWith('farcaster_')).map((c) => c.tool);

describe('refusals happen before anything is sent', () => {
  it('a draft is refused with 422 and no tool but the read is called', async () => {
    const h = harness(publishedRow({ status: 'draft', row_hash: null, confirmed_by: null }));
    await expect(publishLedgerForecast(FORECAST_ID, {}, h.deps)).rejects.toMatchObject({ httpStatus: 422 });
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast']);
    expect(h.logs.some((l) => l.includes('[Ledger] REFUSED'))).toBe(true);
  });

  it('a row whose stored hash does not re-derive is refused', async () => {
    const h = harness(publishedRow({ row_hash: 'f'.repeat(64) }));
    await expect(publishLedgerForecast(FORECAST_ID, {}, h.deps)).rejects.toThrow(/does not match/);
  });

  it('forbidden words in the rendered text refuse the publish', async () => {
    const h = harness(publishedRow({ what_moves_this: 'Whether the staff should lock him out.' }));
    const err = await publishLedgerForecast(FORECAST_ID, {}, h.deps).catch((e) => e as LedgerPublishRefused);
    expect(err).toBeInstanceOf(LedgerPublishRefused);
    expect(err.httpStatus).toBe(422);
    expect((err.detail as { forbidden: string[] }).forbidden).toEqual(expect.arrayContaining(['should', 'lock']));
    expect(socialTools(h)).toEqual([]);
  });

  it('an unparseable reply_to_url is refused unless force_standalone; a null one posts standalone with a warning', async () => {
    const bad = harness(publishedRow({ reply_to_url: 'https://x.com/AdamSchefter' }));
    await expect(publishLedgerForecast(FORECAST_ID, {}, bad.deps)).rejects.toThrow(/not a tweet URL/);
    expect(socialTools(bad)).toEqual([]);
    const forced = harness(publishedRow({ reply_to_url: 'https://x.com/AdamSchefter' }));
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true }, forced.deps);
    expect(out.x.reply_to_id).toBeNull();
    expect(forced.calls.find((c) => c.tool === 'twitter_publish_tweet')?.params).not.toHaveProperty('reply_to_id');
    const none = harness(publishedRow({ reply_to_url: null }));
    const out2 = await publishLedgerForecast(FORECAST_ID, {}, none.deps);
    expect(out2.warnings[0]).toMatch(/no reply_to_url/);
  });

  it('web unavailable → 503; a not-found row → 404', async () => {
    const h = harness(publishedRow(), { unavailable: ['web'] });
    await expect(publishLedgerForecast(FORECAST_ID, {}, h.deps)).rejects.toMatchObject({ httpStatus: 503 });
    const nf = harness(publishedRow(), { responses: { web_get_ledger_forecast: [mcpError('Ledger forecast x not found')] } });
    await expect(publishLedgerForecast(FORECAST_ID, {}, nf.deps)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('dry run', () => {
  it('env LEDGER_PUBLISH_DRY_RUN=true renders texts and the commit payload and sends nothing', async () => {
    const h = harness(publishedRow(), { env: { LEDGER_PUBLISH_DRY_RUN: 'true' }, github: null });
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(out.dry_run).toBe(true);
    expect(out.commit.status).toBe('dry_run');
    expect(out.commit.body).toContain('"row_hash"');
    expect(out.x.text).toContain('F4 games missed: 3 (2–5)');
    expect(out.x.reply_to_id).toBe('1972000000000000001');
    expect(out.farcaster.byte_length).toBeLessThanOrEqual(320);
    expect(out.farcaster.embeds).toEqual([{ url: 'https://www.paratros.com/ledger/PT-2026-001' }]);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast']);
    expect(out.warnings.some((w) => w.includes('LEDGER_GITHUB_TOKEN'))).toBe(true);
  });

  it('the env wins over a dry_run:false request', async () => {
    const h = harness(publishedRow(), { env: { LEDGER_PUBLISH_DRY_RUN: 'true' } });
    const out = await publishLedgerForecast(FORECAST_ID, { dryRun: false }, h.deps);
    expect(out.dry_run).toBe(true);
    expect(socialTools(h)).toEqual([]);
  });
});

describe('the real run', () => {
  it('commits, then X card reply, X self-reply (to the card), Farcaster with the entry embed, then provenance — in that order', async () => {
    const h = harness(publishedRow());
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(out.success).toBe(true);
    expect(out.mirrored).toBe(true);
    expect(out.commit).toMatchObject({ status: 'committed', sha: 'c0ffee1234567', url: COMMIT_URL });
    expect(h.calls.map((c) => c.tool)).toEqual([
      'web_get_ledger_forecast',
      'twitter_publish_tweet',
      'twitter_publish_tweet',
      'farcaster_publish_cast',
      'web_record_ledger_provenance',
    ]);
    const [card, self] = h.calls.filter((c) => c.tool === 'twitter_publish_tweet');
    expect(card.params.reply_to_id).toBe('1972000000000000001');
    expect(self.params.reply_to_id).toBe('tweet-1');
    expect(String(self.params.text)).toContain(COMMIT_URL);
    expect(String(self.params.text)).toContain('https://www.paratros.com/ledger');
    const cast = h.calls.find((c) => c.tool === 'farcaster_publish_cast')!;
    expect(cast.params.embeds).toEqual([{ url: 'https://www.paratros.com/ledger/PT-2026-001' }]);
    expect(cast.params).not.toHaveProperty('channel_id');
    const prov = h.calls.find((c) => c.tool === 'web_record_ledger_provenance')!;
    expect(prov.params).toEqual({ forecast_id: FORECAST_ID, commit_sha: 'c0ffee1234567', commit_url: COMMIT_URL, x_post_id: 'tweet-1', x_self_reply_id: 'tweet-2', farcaster_hash: '0xcast' });
    expect(h.logs.some((l) => l.startsWith('[Ledger] PUBLISHED PT-2026-001 v1'))).toBe(true);
  });

  it('LEDGER_FARCASTER_CHANNEL sets channel_id on the mirror', async () => {
    const h = harness(publishedRow(), { env: { LEDGER_FARCASTER_CHANNEL: 'nfl' } });
    await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(h.calls.find((c) => c.tool === 'farcaster_publish_cast')!.params.channel_id).toBe('nfl');
  });

  it('NO COMMIT, NO POST: a commit failure is 500 and no social tool is called', async () => {
    const h = harness(publishedRow(), { github: githubDown() });
    await expect(publishLedgerForecast(FORECAST_ID, {}, h.deps)).rejects.toMatchObject({ httpStatus: 500 });
    expect(socialTools(h)).toEqual([]);
    expect(h.logs.some((l) => l.includes('[Ledger] COMMIT FAILED'))).toBe(true);
  });

  it('a conflicting file at the path is 409 and no social tool is called', async () => {
    const gh: GithubCommitDeps = { ...githubOk(), fetch: async () => new Response(JSON.stringify({ content: Buffer.from(JSON.stringify({ row_hash: 'b'.repeat(64) })).toString('base64') }), { status: 200 }) };
    const h = harness(publishedRow(), { github: gh });
    await expect(publishLedgerForecast(FORECAST_ID, {}, h.deps)).rejects.toMatchObject({ httpStatus: 409 });
    expect(socialTools(h)).toEqual([]);
    expect(h.logs.some((l) => l.includes('[Ledger] COMMIT CONFLICT'))).toBe(true);
  });

  it('unconfigured GitHub refuses a real run before committing', async () => {
    const h = harness(publishedRow(), { github: null });
    await expect(publishLedgerForecast(FORECAST_ID, {}, h.deps)).rejects.toThrow(/not configured/);
    expect(socialTools(h)).toEqual([]);
  });

  it('an X failure after the commit still records the commit, skips the self-reply, mirrors to Farcaster, returns mirrored:false', async () => {
    const h = harness(publishedRow(), { responses: { twitter_publish_tweet: [mcpError('duplicate content')] } });
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(out.success).toBe(true);
    expect(out.mirrored).toBe(false);
    expect(out.x).toMatchObject({ status: 'failed', error: 'duplicate content' });
    expect(out.x_self_reply.status).toBe('skipped');
    expect(out.farcaster.status).toBe('ok');
    const prov = h.calls.find((c) => c.tool === 'web_record_ledger_provenance')!;
    expect(prov.params).toEqual({ forecast_id: FORECAST_ID, commit_sha: 'c0ffee1234567', commit_url: COMMIT_URL, farcaster_hash: '0xcast' });
    expect(h.logs.some((l) => l.includes('[Ledger] SOCIAL FAILED'))).toBe(true);
  });

  it('a re-run fills only the gaps: recorded commit and X are not redone, Farcaster is', async () => {
    const h = harness(publishedRow({ commit_sha: 'c0ffee1234567', commit_url: COMMIT_URL, x_post_id: 'tweet-1', x_self_reply_id: 'tweet-2' }));
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(out.commit.status).toBe('already_recorded');
    expect(out.x.status).toBe('already_recorded');
    expect(out.x_self_reply.status).toBe('already_recorded');
    expect(out.farcaster.status).toBe('ok');
    expect(out.mirrored).toBe(true);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast', 'farcaster_publish_cast', 'web_record_ledger_provenance']);
    expect(h.calls[2].params).toEqual({ forecast_id: FORECAST_ID, farcaster_hash: '0xcast' });
  });

  it('a provenance write rejection is reported, not hidden', async () => {
    const h = harness(publishedRow(), { responses: { web_record_ledger_provenance: [mcpError('Input validation error: x')] } });
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(out.provenance).toMatchObject({ recorded: false, error: 'Input validation error: x' });
    expect(h.logs.some((l) => l.includes('PROVENANCE WRITE FAILED'))).toBe(true);
  });
});

const X_REFUSAL = 'Twitter API forbidden: Authorization Error — You can only reply to or quote posts where you are mentioned or are the author.';

describe('force_standalone with a parseable reply_to_url (X refuses replies to posts that never mentioned us)', () => {
  const REPORT = 'https://x.com/AdamSchefter/status/1972000000000000001';

  it('audits the decision first, posts the card with no reply_to_id, and cites the report in the self-reply', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }));
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true }, h.deps);
    const tools = h.calls.map((c) => c.tool);
    expect(tools.indexOf('web_audit_append')).toBeLessThan(tools.indexOf('twitter_publish_tweet'));
    const audit = h.calls.find((c) => c.tool === 'web_audit_append')!;
    expect(audit.params).toMatchObject({ actor: 'system', actor_id: 'ledger-publish', entity_type: 'ledger_forecast', entity_id: FORECAST_ID, action: 'ledger_x_standalone' });
    expect(audit.params.payload).toMatchObject({ reply_to_url: REPORT, reply_to_id_parsed: '1972000000000000001', reason: 'force_standalone' });
    const [card, self] = h.calls.filter((c) => c.tool === 'twitter_publish_tweet');
    expect(card.params).not.toHaveProperty('reply_to_id');
    expect(self.params.reply_to_id).toBe('tweet-1');
    const selfText = self.params.text as string;
    expect(selfText).toContain('https://www.paratros.com/ledger');
    expect(selfText).toContain(`committed: ${COMMIT_URL}`);
    expect(selfText).toContain(`Report: ${REPORT}`);
    expect(selfText.trim().endsWith(REPORT)).toBe(false);
    expect(out.x.reply_to_id).toBeNull();
    expect(out.standalone).toEqual({ reason: 'force_standalone', report_url: REPORT, audited: true });
    expect(out.mirrored).toBe(true);
    expect(h.logs.some((l) => l.includes('standalone post forced by request'))).toBe(true);
  });

  it('NO AUDIT, NO CARD: a rejected audit write posts nothing to X; Farcaster and provenance still run', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }), { responses: { web_audit_append: [mcpError('Input validation error: x')] } });
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true }, h.deps);
    expect(socialTools(h)).toEqual(['farcaster_publish_cast']);
    expect(out.x.status).toBe('failed');
    expect(out.x.error).toMatch(/not audited/);
    expect(out.x_self_reply.status).toBe('skipped');
    expect(out.standalone).toMatchObject({ audited: false, error: 'Input validation error: x' });
    expect(h.logs.some((l) => l.includes('[Ledger] STANDALONE AUDIT FAILED'))).toBe(true);
  });

  it('a dry run renders the standalone variant and sends nothing, audit included', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }));
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true, dryRun: true }, h.deps);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast']);
    expect(out.x.reply_to_id).toBeNull();
    expect(out.x_self_reply.text).toContain(`Report: ${REPORT}`);
    expect(out.standalone).toEqual({ reason: 'force_standalone', report_url: REPORT, audited: false });
  });

  it('a re-run with x_post_id recorded neither audits nor reposts the card; the gap self-reply cites the report', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT, commit_sha: 'c0ffee1234567', commit_url: COMMIT_URL, x_post_id: 'card-9', farcaster_hash: '0xcast' }));
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true }, h.deps);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast', 'twitter_publish_tweet', 'web_record_ledger_provenance']);
    expect(h.calls[1].params).toMatchObject({ reply_to_id: 'card-9' });
    expect(out.x.status).toBe('already_recorded');
    expect(h.calls[2].params).toEqual({ forecast_id: FORECAST_ID, x_self_reply_id: 'tweet-1' });
  });

  it('a self-reply refused as a quote of the report retries once without the report line', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }), {
      responses: { twitter_publish_tweet: [mcpText({ id: 'card-1' }), mcpError(X_REFUSAL)] },
    });
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true }, h.deps);
    const tweets = h.calls.filter((c) => c.tool === 'twitter_publish_tweet');
    expect(tweets).toHaveLength(3);
    expect(tweets[1].params.text).toContain('Report:');
    expect(tweets[2].params.text).not.toContain('Report:');
    expect(tweets[2].params.text).toContain(`committed: ${COMMIT_URL}`);
    expect(out.x_self_reply.status).toBe('ok');
    expect(out.x_self_reply.text).not.toContain('Report:');
    expect(out.warnings.some((w) => w.includes('refused as a quote'))).toBe(true);
  });

  it('any other self-reply failure is not retried', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }), {
      responses: { twitter_publish_tweet: [mcpText({ id: 'card-1' }), mcpError('Twitter API rate limit exceeded')] },
    });
    const out = await publishLedgerForecast(FORECAST_ID, { forceStandalone: true }, h.deps);
    expect(h.calls.filter((c) => c.tool === 'twitter_publish_tweet')).toHaveLength(2);
    expect(out.x_self_reply).toMatchObject({ status: 'failed', error: 'Twitter API rate limit exceeded' });
  });
});

describe('X refuses the reply (report author never mentioned us): automatic standalone fallback', () => {
  const REPORT = 'https://x.com/AdamSchefter/status/1972000000000000001?s=20';

  it('reply attempted → audit (reply_refused, X\'s wording) → standalone card → self-reply citing the report → Farcaster → provenance', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }), { responses: { twitter_publish_tweet: [mcpError(X_REFUSAL)] } });
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    const seq = h.calls.map((c) => c.tool).filter((t) => t !== 'web_get_ledger_forecast');
    expect(seq).toEqual(['twitter_publish_tweet', 'web_audit_append', 'twitter_publish_tweet', 'twitter_publish_tweet', 'farcaster_publish_cast', 'web_record_ledger_provenance']);
    const [attempt, card, self] = h.calls.filter((c) => c.tool === 'twitter_publish_tweet');
    expect(attempt.params.reply_to_id).toBe('1972000000000000001');
    expect(card.params).not.toHaveProperty('reply_to_id');
    expect(card.params.text).toBe(attempt.params.text);
    expect(self.params.reply_to_id).toBe('tweet-1');
    expect(self.params.text).toContain('Report: https://x.com/AdamSchefter/status/1972000000000000001\n');
    expect(self.params.text).toContain(`committed: ${COMMIT_URL}`);
    const audit = h.calls.find((c) => c.tool === 'web_audit_append')!;
    expect(audit.params).toMatchObject({ action: 'ledger_x_standalone', entity_id: FORECAST_ID });
    expect(audit.params.payload).toMatchObject({ reason: 'reply_refused', reply_to_url: REPORT, reply_to_id_parsed: '1972000000000000001', prior_error: X_REFUSAL });
    expect(out.x).toMatchObject({ status: 'ok', post_id: 'tweet-1', reply_to_id: null });
    expect(out.standalone).toMatchObject({ reason: 'reply_refused', report_url: REPORT, audited: true, prior_error: X_REFUSAL });
    expect(out.mirrored).toBe(true);
    expect(h.calls.at(-1)!.params).toMatchObject({ x_post_id: 'tweet-1', x_self_reply_id: 'tweet-2' });
    expect(h.logs.some((l) => l.includes('X refused the reply'))).toBe(true);
  });

  it('a reply X accepts posts as a reply: no audit, no report line', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }));
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(h.calls.some((c) => c.tool === 'web_audit_append')).toBe(false);
    expect(out.x.reply_to_id).toBe('1972000000000000001');
    expect(out.standalone).toBeUndefined();
    expect(out.x_self_reply.text).not.toContain('Report:');
  });

  it.each([['Twitter API rate limit exceeded'], ['duplicate content'], ['Twitter API forbidden: You have been blocked from replying']])(
    'any other X error (%s) does not fall back: one attempt, no audit, failed',
    async (msg) => {
      const h = harness(publishedRow({ reply_to_url: REPORT }), { responses: { twitter_publish_tweet: [mcpError(msg)] } });
      const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
      expect(h.calls.filter((c) => c.tool === 'twitter_publish_tweet')).toHaveLength(1);
      expect(h.calls.some((c) => c.tool === 'web_audit_append')).toBe(false);
      expect(out.x).toMatchObject({ status: 'failed', error: msg });
      expect(out.standalone).toBeUndefined();
    },
  );

  it('NO AUDIT, NO CARD on the fallback too', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }), {
      responses: { twitter_publish_tweet: [mcpError(X_REFUSAL)], web_audit_append: [mcpError('db down')] },
    });
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(h.calls.filter((c) => c.tool === 'twitter_publish_tweet')).toHaveLength(1);
    expect(out.x).toMatchObject({ status: 'failed' });
    expect(out.x.error).toMatch(/not audited: db down/);
    expect(out.x_self_reply.status).toBe('skipped');
    expect(out.farcaster.status).toBe('ok');
    expect(h.logs.some((l) => l.includes('[Ledger] STANDALONE AUDIT FAILED'))).toBe(true);
  });

  it('a failure of the standalone card itself is reported, not retried again', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }), {
      responses: { twitter_publish_tweet: [mcpError(X_REFUSAL), mcpError('Twitter API request failed')] },
    });
    const out = await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(h.calls.filter((c) => c.tool === 'twitter_publish_tweet')).toHaveLength(2);
    expect(out.x).toMatchObject({ status: 'failed', error: 'Twitter API request failed', reply_to_id: null });
    expect(out.standalone).toMatchObject({ reason: 'reply_refused', audited: true });
  });

  it('a re-run with x_post_id recorded makes no reply attempt and no audit', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT, commit_sha: 'c0ffee1234567', commit_url: COMMIT_URL, x_post_id: 'card-9', x_self_reply_id: 'self-9', farcaster_hash: '0xcast' }));
    await publishLedgerForecast(FORECAST_ID, {}, h.deps);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast']);
  });

  it('a dry run sends nothing and warns about the fallback', async () => {
    const h = harness(publishedRow({ reply_to_url: REPORT }));
    const out = await publishLedgerForecast(FORECAST_ID, { dryRun: true }, h.deps);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_get_ledger_forecast']);
    expect(out.x.reply_to_id).toBe('1972000000000000001');
    expect(out.warnings.some((w) => w.includes('if X refuses the reply'))).toBe(true);
  });
});

describe('only two files in src/ledger call a social tool', () => {
  it('twitter_publish_* / farcaster_publish_* appear in publish.ts and publish-reply.ts and nowhere else under src/ledger or the reply agent', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../src/ledger/', import.meta.url));
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !['publish.ts', 'publish-reply.ts'].includes(f))
      .filter((f) => /twitter_publish_|farcaster_publish_/.test(readFileSync(dir + f, 'utf8')));
    expect(offenders).toEqual([]);
    const replyAgent = readFileSync(fileURLToPath(new URL('../src/agents/social/reply-agent.ts', import.meta.url)), 'utf8');
    expect(replyAgent).not.toMatch(/twitter_publish_|farcaster_publish_/);
    expect(replyAgent).toContain('web_propose_reply');
    void vi;
  });
});
