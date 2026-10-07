/**
 * THE ONE FUNCTION in this repository that may reach a social tool with ledger
 * content (spec "Implementation handoff → Provenance" and "Automation boundary";
 * plan Part 4: "the mechanical consequences of one recorded confirmation, in a
 * fixed order that stops if the commit fails").
 *
 * Order, fail-closed:
 *   0. read the STORED row by id and `assertPublishable` it — the first line.
 *      Nothing below runs on a draft, an unhashed row, or a row nobody confirmed.
 *   1. render every text and run the vocabulary rule; a hit refuses the publish.
 *      Dry run (LEDGER_PUBLISH_DRY_RUN=true, or dry_run in the request; the env
 *      wins) returns here with the texts and the commit payload. Nothing is sent.
 *   2. commit forecasts/<entry_id>/v<n>.json to the ledger repository. No
 *      commit → no post. A different row already at that path → conflict, stop.
 *   3. X: the card text as a reply to the report post; then the self-reply with
 *      the ledger index and the commit URL. Reply-first (spec "Channel scope"),
 *      but X's API refuses a reply to or quote of a post whose author has not
 *      mentioned us (PT-2026-001, 2026-10-07). On exactly that refusal the card
 *      falls back to a standalone post automatically; force_standalone skips
 *      the attempt. Either way an audit row records the decision FIRST (no
 *      audit, no card), and the self-reply cites the report URL.
 *   4. Farcaster: the compact mirror with the entry URL embedded.
 *   5. web_record_ledger_provenance with whatever succeeded (COALESCE converges,
 *      so a re-run after a partial failure fills only the gaps).
 * A social failure AFTER the commit is reported as mirrored:false and logged
 * `[Ledger] SOCIAL FAILED`; the row is already public by its commit, and the
 * operator re-runs the same id to retry the missing platform.
 *
 * `twitter_publish_*` / `farcaster_publish_*` appear in src/ledger only here and
 * in publish-reply.ts; a test greps for that.
 */
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { assertPublishable, type LedgerForecastRow, type PublishedLedgerRow } from './publishable.js';
import { buildXSelfReplyText, renderLedgerTexts, tweetIdFromUrl, type RenderedLedgerTexts } from './post-text.js';
import {
  buildForecastFile,
  commitForecastFile,
  githubDepsFromEnv,
  LedgerCommitConflictError,
  LedgerCommitNotConfiguredError,
  type CommitOutcome,
  type ForecastFile,
  type GithubCommitDeps,
} from './github-commit.js';

export type CallTool = (server: 'web' | 'twitter' | 'farcaster', tool: string, params: Record<string, unknown>) => Promise<unknown>;

export interface PublishDeps {
  callTool: CallTool;
  isServerAvailable: (server: 'web' | 'twitter' | 'farcaster') => boolean;
  /** null = not configured; the publish refuses before committing, unless it is a dry run. */
  github: GithubCommitDeps | null;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export interface PublishOptions {
  dryRun?: boolean;
  /**
   * Skip the reply attempt and post the card standalone: required when
   * reply_to_url is unparseable. Not needed when X refuses the reply ("You can
   * only reply to or quote posts where you are mentioned or are the author") —
   * that falls back to standalone on its own. The row's reply_to_url is frozen,
   * so this is a request option, never an edit. Audited before the card posts;
   * the self-reply cites the report URL.
   */
  forceStandalone?: boolean;
}

type StepStatus = 'ok' | 'failed' | 'skipped' | 'dry_run';

export interface LedgerPublishOutcome {
  success: boolean;
  dry_run: boolean;
  /** True only when the commit and all three social posts succeeded (or are already recorded). */
  mirrored: boolean;
  forecast: { id: string; entry_id: string; version: number; row_hash: string };
  commit: { path: string; message: string; status: CommitOutcome['status'] | 'dry_run' | 'already_recorded'; sha?: string; url?: string; body?: string };
  x: { text: string; reply_to_id: string | null; status: StepStatus | 'already_recorded'; post_id?: string; error?: string };
  x_self_reply: { text: string; status: StepStatus | 'already_recorded'; id?: string; error?: string };
  /** Present when the card posts standalone although the row names a report post. */
  standalone?: { reason: 'force_standalone' | 'reply_refused'; report_url: string; audited: boolean; prior_error?: string; error?: string };
  farcaster: { text: string; embeds: Array<{ url: string }>; channel_id: string | null; byte_length: number; status: StepStatus | 'already_recorded'; hash?: string; error?: string };
  provenance: { recorded: boolean; error?: string };
  warnings: string[];
}

/** Errors the route maps to HTTP statuses. */
export class LedgerPublishRefused extends Error {
  readonly httpStatus: number;
  readonly detail: unknown;
  constructor(httpStatus: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'LedgerPublishRefused';
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export function publishDepsFromEnv(callTool: CallTool, isServerAvailable: PublishDeps['isServerAvailable'], env: NodeJS.ProcessEnv = process.env): PublishDeps {
  let github: GithubCommitDeps | null = null;
  try {
    github = githubDepsFromEnv(env);
  } catch (err) {
    if (!(err instanceof LedgerCommitNotConfiguredError)) throw err;
    github = null;
  }
  return { callTool, isServerAvailable, github, env, log: (line) => console.log(line) };
}

function parseToolText<T>(raw: unknown): T | null {
  try {
    const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

async function fetchRow(deps: PublishDeps, forecastId: string): Promise<LedgerForecastRow> {
  if (!deps.isServerAvailable('web')) throw new LedgerPublishRefused(503, 'Web MCP server unavailable');
  const raw = await deps.callTool('web', 'web_get_ledger_forecast', { forecast_id: forecastId });
  if (isMCPError(raw)) {
    const msg = extractMCPErrorMessage(raw);
    throw new LedgerPublishRefused(/not found/i.test(msg) ? 404 : 502, `web_get_ledger_forecast: ${msg}`);
  }
  const payload = parseToolText<{ forecast?: LedgerForecastRow }>(raw);
  if (!payload?.forecast) throw new LedgerPublishRefused(502, 'web_get_ledger_forecast returned no forecast');
  return payload.forecast;
}

/** X's wording for its reply/quote restriction (mcp twitter client surfaces it). */
export const X_REPLY_RESTRICTED_RE = /only reply to or quote posts where you are mentioned/i;

async function postTweet(deps: PublishDeps, text: string, replyToId: string | null): Promise<string> {
  const raw = await deps.callTool('twitter', 'twitter_publish_tweet', { text, ...(replyToId ? { reply_to_id: replyToId } : {}) });
  if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
  const id = parseToolText<{ id?: string }>(raw)?.id;
  if (!id) throw new Error('tweet id missing from response');
  return id;
}

/**
 * One audit row recording that the card goes out standalone although the row
 * names a report post, written BEFORE the card posts. Returns false (and sets
 * outcome.standalone.error) when the write fails or is rejected.
 */
async function auditStandalone(deps: PublishDeps, row: PublishedLedgerRow, outcome: LedgerPublishOutcome, tag: string): Promise<boolean> {
  const standalone = outcome.standalone!;
  try {
    const raw = await deps.callTool('web', 'web_audit_append', {
      actor: 'system',
      actor_id: 'ledger-publish',
      entity_type: 'ledger_forecast',
      entity_id: row.id,
      action: 'ledger_x_standalone',
      payload: {
        entry_id: row.entry_id,
        version: row.version,
        reply_to_url: standalone.report_url,
        reply_to_id_parsed: tweetIdFromUrl(standalone.report_url),
        reason: standalone.reason,
        ...(standalone.prior_error ? { prior_error: standalone.prior_error } : {}),
      },
    });
    if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
    standalone.audited = true;
    return true;
  } catch (err) {
    standalone.error = err instanceof Error ? err.message : String(err);
    deps.log(`[Ledger] STANDALONE AUDIT FAILED ${tag}: ${standalone.error}`);
    return false;
  }
}

function isDryRun(deps: PublishDeps, opts: PublishOptions): boolean {
  return deps.env.LEDGER_PUBLISH_DRY_RUN === 'true' || opts.dryRun === true;
}

export async function publishLedgerForecast(forecastId: string, opts: PublishOptions, deps: PublishDeps): Promise<LedgerPublishOutcome> {
  const row = await fetchRow(deps, forecastId);
  try {
    assertPublishable(row);
  } catch (err) {
    const reasons = (err as { reasons?: string[] }).reasons ?? [String(err)];
    deps.log(`[Ledger] REFUSED ${forecastId}: ${reasons.join('; ')}`);
    throw new LedgerPublishRefused(422, `row is not publishable: ${reasons.join('; ')}`, { reasons });
  }
  const published: PublishedLedgerRow = row;
  const dryRun = isDryRun(deps, opts);
  const tag = `${published.entry_id} v${published.version}`;
  const warnings: string[] = [];

  // The reply target is decided before the texts render (a standalone card's
  // self-reply cites the report) and before the commit, so a bad URL never
  // leaves an orphaned commit behind.
  let replyToId: string | null = null;
  let reportUrl: string | null = null;
  if (published.reply_to_url) {
    replyToId = tweetIdFromUrl(published.reply_to_url);
    if (replyToId === null) {
      if (!opts.forceStandalone) {
        throw new LedgerPublishRefused(422, `reply_to_url is not a tweet URL: ${published.reply_to_url}. Pass force_standalone to post the card on its own.`);
      }
      warnings.push(`reply_to_url unparseable (${published.reply_to_url}); posting standalone by request`);
      deps.log(`[Ledger] ${tag}: reply_to_url unparseable, standalone post forced`);
    } else if (opts.forceStandalone) {
      replyToId = null;
      warnings.push(`reply_to_url present (${published.reply_to_url}); posting standalone by request, report cited in the self-reply`);
      deps.log(`[Ledger] ${tag}: reply_to_url present, standalone post forced by request`);
    }
    if (replyToId === null) reportUrl = published.reply_to_url;
    else warnings.push('if X refuses the reply (the report author never mentioned us), the card posts standalone and the self-reply cites the report');
  } else {
    warnings.push('no reply_to_url; the card posts standalone (ledger-only entry)');
    deps.log(`[Ledger] ${tag}: standalone post (no reply_to_url)`);
  }

  // 1. Texts and the vocabulary rule, before anything leaves.
  let texts: RenderedLedgerTexts;
  try {
    texts = renderLedgerTexts(published, published.commit_url, reportUrl);
  } catch (err) {
    throw new LedgerPublishRefused(422, `could not render post text: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (texts.forbidden.length > 0) {
    deps.log(`[Ledger] REFUSED ${tag}: forbidden words in rendered text: ${texts.forbidden.join(', ')}`);
    throw new LedgerPublishRefused(422, `rendered text contains forbidden words: ${texts.forbidden.join(', ')}`, { forbidden: texts.forbidden, texts });
  }

  const file: ForecastFile = buildForecastFile(published);
  const channelId = deps.env.LEDGER_FARCASTER_CHANNEL || null;

  const outcome: LedgerPublishOutcome = {
    success: true,
    dry_run: dryRun,
    mirrored: false,
    forecast: { id: published.id, entry_id: published.entry_id, version: published.version, row_hash: published.row_hash },
    commit: { path: file.path, message: file.message, status: 'dry_run', body: dryRun ? file.body : undefined },
    x: { text: texts.x_card, reply_to_id: replyToId, status: 'dry_run' },
    x_self_reply: { text: texts.x_self_reply, status: 'dry_run' },
    farcaster: { text: texts.farcaster, embeds: [{ url: texts.entry_url }], channel_id: channelId, byte_length: texts.farcaster_bytes, status: 'dry_run' },
    provenance: { recorded: false },
    warnings,
    ...(reportUrl ? { standalone: { reason: 'force_standalone' as const, report_url: reportUrl, audited: false } } : {}),
  };

  if (dryRun) {
    if (!deps.github) warnings.push('LEDGER_GITHUB_TOKEN / LEDGER_GITHUB_REPO unset: a real run would refuse before committing');
    deps.log(`[Ledger] DRY RUN ${tag}: rendered ${texts.x_card.length} X chars, ${texts.farcaster_bytes} Farcaster bytes, commit ${file.path}; nothing sent`);
    return outcome;
  }

  // 2. Commit. No commit, no post.
  if (published.commit_sha && published.commit_url) {
    outcome.commit = { path: file.path, message: file.message, status: 'already_recorded', sha: published.commit_sha, url: published.commit_url };
  } else {
    if (!deps.github) throw new LedgerPublishRefused(500, 'ledger commit is not configured (LEDGER_GITHUB_TOKEN / LEDGER_GITHUB_REPO)');
    let committed: CommitOutcome;
    try {
      committed = await commitForecastFile(deps.github, file, published.row_hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof LedgerCommitConflictError) {
        deps.log(`[Ledger] COMMIT CONFLICT ${tag}: ${message}`);
        throw new LedgerPublishRefused(409, message);
      }
      deps.log(`[Ledger] COMMIT FAILED ${tag}: ${message}`);
      throw new LedgerPublishRefused(500, `commit failed, nothing posted: ${message}`);
    }
    outcome.commit = { path: file.path, message: file.message, status: committed.status, sha: committed.sha, url: committed.html_url };
    deps.log(`[Ledger] COMMITTED ${tag} ${committed.status} ${committed.sha} ${committed.html_url}`);
  }
  const commitUrl = outcome.commit.url as string;

  // 3. X: card reply, then the self-reply.
  if (published.x_post_id) {
    outcome.x = { ...outcome.x, status: 'already_recorded', post_id: published.x_post_id };
  } else if (!deps.isServerAvailable('twitter')) {
    outcome.x = { ...outcome.x, status: 'failed', error: 'Twitter MCP server unavailable' };
  } else if (outcome.standalone && !(await auditStandalone(deps, published, outcome, tag))) {
    // The record precedes the act: no audit row, no standalone card.
    outcome.x = { ...outcome.x, status: 'failed', error: `standalone decision not audited: ${outcome.standalone.error}` };
  } else {
    try {
      outcome.x = { ...outcome.x, status: 'ok', post_id: await postTweet(deps, texts.x_card, replyToId) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (replyToId && published.reply_to_url && X_REPLY_RESTRICTED_RE.test(message)) {
        // X's reply restriction, not a fault: fall back to standalone, audited first.
        replyToId = null;
        reportUrl = published.reply_to_url;
        outcome.x = { ...outcome.x, reply_to_id: null };
        outcome.standalone = { reason: 'reply_refused', report_url: reportUrl, audited: false, prior_error: message };
        warnings.push('X refused the reply (the report author never mentioned us); posted standalone, report cited in the self-reply');
        deps.log(`[Ledger] ${tag}: X refused the reply (author never mentioned us), posting standalone`);
        if (!(await auditStandalone(deps, published, outcome, tag))) {
          outcome.x = { ...outcome.x, status: 'failed', error: `standalone decision not audited: ${outcome.standalone.error}` };
        } else {
          try {
            outcome.x = { ...outcome.x, status: 'ok', post_id: await postTweet(deps, texts.x_card, null) };
          } catch (err2) {
            outcome.x = { ...outcome.x, status: 'failed', error: err2 instanceof Error ? err2.message : String(err2) };
          }
        }
      } else {
        outcome.x = { ...outcome.x, status: 'failed', error: message };
      }
    }
  }
  // Built after the card step: a refusal above turns on the report citation.
  outcome.x_self_reply.text = buildXSelfReplyText(published, commitUrl, reportUrl);
  const cardTweetId = outcome.x.post_id ?? null;
  if (published.x_self_reply_id) {
    outcome.x_self_reply = { ...outcome.x_self_reply, status: 'already_recorded', id: published.x_self_reply_id };
  } else if (!cardTweetId) {
    outcome.x_self_reply = { ...outcome.x_self_reply, status: 'skipped', error: 'no card tweet to reply to' };
  } else {
    try {
      let id: string;
      try {
        id = await postTweet(deps, outcome.x_self_reply.text, cardTweetId);
      } catch (err) {
        // X may read the cited report URL as a quote of a post that did not
        // mention us and refuse it under the same rule as the reply. The card
        // is already live, so retry once without the citation rather than
        // leave the row without its commit link.
        if (!reportUrl || !X_REPLY_RESTRICTED_RE.test(err instanceof Error ? err.message : String(err))) throw err;
        const bare = buildXSelfReplyText(published, commitUrl);
        warnings.push('self-reply citing the report was refused as a quote; posted without the report line');
        deps.log(`[Ledger] ${tag}: self-reply report citation refused by X, retrying without it`);
        outcome.x_self_reply.text = bare;
        id = await postTweet(deps, bare, cardTweetId);
      }
      outcome.x_self_reply = { ...outcome.x_self_reply, status: 'ok', id };
    } catch (err) {
      outcome.x_self_reply = { ...outcome.x_self_reply, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 4. Farcaster mirror.
  if (published.farcaster_hash) {
    outcome.farcaster = { ...outcome.farcaster, status: 'already_recorded', hash: published.farcaster_hash };
  } else if (!deps.isServerAvailable('farcaster')) {
    outcome.farcaster = { ...outcome.farcaster, status: 'failed', error: 'Farcaster MCP server unavailable' };
  } else {
    try {
      const raw = await deps.callTool('farcaster', 'farcaster_publish_cast', {
        text: texts.farcaster,
        embeds: [{ url: texts.entry_url }],
        ...(channelId ? { channel_id: channelId } : {}),
      });
      if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
      const hash = parseToolText<{ hash?: string }>(raw)?.hash;
      if (!hash) throw new Error('cast hash missing from response');
      outcome.farcaster = { ...outcome.farcaster, status: 'ok', hash };
    } catch (err) {
      outcome.farcaster = { ...outcome.farcaster, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 5. Provenance: whatever succeeded, set once.
  const provenance: Record<string, string> = {};
  if (outcome.commit.status === 'committed' || outcome.commit.status === 'already_committed') {
    provenance.commit_sha = outcome.commit.sha as string;
    provenance.commit_url = outcome.commit.url as string;
  }
  if (outcome.x.status === 'ok' && outcome.x.post_id) provenance.x_post_id = outcome.x.post_id;
  if (outcome.x_self_reply.status === 'ok' && outcome.x_self_reply.id) provenance.x_self_reply_id = outcome.x_self_reply.id;
  if (outcome.farcaster.status === 'ok' && outcome.farcaster.hash) provenance.farcaster_hash = outcome.farcaster.hash;
  if (Object.keys(provenance).length > 0) {
    try {
      const raw = await deps.callTool('web', 'web_record_ledger_provenance', { forecast_id: published.id, ...provenance });
      if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
      outcome.provenance = { recorded: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[Ledger] PROVENANCE WRITE FAILED ${tag}: ${message}`);
      outcome.provenance = { recorded: false, error: message };
    }
  } else {
    outcome.provenance = { recorded: true };
  }

  const socialOk = (s: string) => s === 'ok' || s === 'already_recorded';
  outcome.mirrored = socialOk(outcome.x.status) && socialOk(outcome.x_self_reply.status) && socialOk(outcome.farcaster.status);
  if (!outcome.mirrored) {
    const failed = [
      outcome.x.status !== 'ok' && outcome.x.status !== 'already_recorded' ? `x=${outcome.x.error ?? outcome.x.status}` : null,
      !socialOk(outcome.x_self_reply.status) ? `x_self_reply=${outcome.x_self_reply.error ?? outcome.x_self_reply.status}` : null,
      !socialOk(outcome.farcaster.status) ? `farcaster=${outcome.farcaster.error ?? outcome.farcaster.status}` : null,
    ].filter(Boolean);
    deps.log(`[Ledger] SOCIAL FAILED ${tag} (row is public by commit ${outcome.commit.sha}): ${failed.join('; ')}`);
  } else {
    deps.log(`[Ledger] PUBLISHED ${tag}: x=${outcome.x.post_id} self=${outcome.x_self_reply.id} farcaster=${outcome.farcaster.hash}`);
  }
  return outcome;
}
