/**
 * Frozen 7-day impression readings for Tier 1 ledger cards (8-week review gate,
 * "median impressions per Tier 1 card, weeks 5–8 vs 1–4"; see src/ledger/gate.ts).
 *
 * X's `impression_count` is CUMULATIVE at read time, so a week-1 card read on
 * review day has had eight weeks to accrue and a week-8 card a few days. Reading
 * every card once, at the first daily cycle after it turns 7 days old, puts them
 * on one clock. A card already older than 7 when this first runs is read late, and
 * `age_days` records how late; for weeks 1–4 that biases the early median UP,
 * against "rising", which is the conservative direction.
 *
 * Storage is one social_state key, not metric_snapshots: that table is keyed
 * (metric, day) behind a CHECK allowlist and has no per-post key.
 *
 * Rules, the defer queue's (`src/monitoring/defer-queue.ts`):
 * - An unreadable store writes NOTHING. Writing over a store we could not read
 *   would erase every reading already frozen.
 * - A missing, `isError` or non-numeric count skips that card. It is never stored
 *   as 0: a 0 reads as "nobody saw it".
 * - Set once. A stored reading is never overwritten; that is what "frozen" means.
 *
 * Reads use `x_api` `get_posts_by_ids` (app bearer). Two traps, both recorded in
 * tests/fixtures/ledger-gate/: `ids` must be a COMMA-JOINED STRING (a JSON array
 * is a 400), and `non_public_metrics` is refused on this token. Do not use our
 * own `twitter_get_tweet` instead: it substitutes zeros when metrics are absent.
 */
import { callTool } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { readSocialState } from '../utils/social-state.js';
import { IMPRESSION_FREEZE_AGE_DAYS } from './gate.js';

export const CARD_IMPRESSIONS_KEY = 'ledger_card_impressions_7d';
const X_BATCH = 100;

export interface FrozenReading {
  entry_id: string;
  impressions: number;
  reply_count: number;
  posted_at: string;
  read_at: string;
  age_days: number;
}

export interface CardImpressionStore {
  version: 1;
  readings: Record<string, FrozenReading>;
}

export interface XPostMetrics {
  id: string;
  created_at: string;
  impressions: number;
  reply_count: number;
  replied_to: string | null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function mcpText(raw: unknown): string | null {
  return (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? null;
}

/** Parse one X post object. null when any needed field is absent or not a count. */
export function parseXPost(p: unknown): XPostMetrics | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, any>;
  const pm = o.public_metrics;
  if (typeof o.id !== 'string' || typeof o.created_at !== 'string' || !pm) return null;
  if (!isCount(pm.impression_count) || !isCount(pm.reply_count)) return null;
  const ref = Array.isArray(o.referenced_tweets) ? o.referenced_tweets.find((r: any) => r?.type === 'replied_to') : null;
  return { id: o.id, created_at: o.created_at, impressions: pm.impression_count, reply_count: pm.reply_count, replied_to: ref?.id ?? null };
}

/**
 * Read metrics for a set of post ids. A failed batch throws: callers either
 * abort (the capture writes nothing) or say "not measurable" (the report).
 * Ids X does not return (deleted, or a per-post error) are simply absent.
 */
export async function readXPosts(ids: readonly string[]): Promise<Map<string, XPostMetrics>> {
  const out = new Map<string, XPostMetrics>();
  for (let i = 0; i < ids.length; i += X_BATCH) {
    const batch = ids.slice(i, i + X_BATCH);
    const raw = await callTool('x_api', 'get_posts_by_ids', {
      ids: batch.join(','),
      'post.fields': 'created_at,public_metrics,referenced_tweets',
    });
    if (isMCPError(raw)) throw new Error(`get_posts_by_ids failed: ${extractMCPErrorMessage(raw)}`);
    const text = mcpText(raw);
    if (!text) throw new Error('get_posts_by_ids returned no content');
    const body = JSON.parse(text) as { data?: unknown[] };
    if (!Array.isArray(body.data)) throw new Error(`get_posts_by_ids returned no data array: ${text.slice(0, 200)}`);
    for (const p of body.data) {
      const parsed = parseXPost(p);
      if (parsed) out.set(parsed.id, parsed);
    }
  }
  return out;
}

export type StoreRead = { status: 'ok'; store: CardImpressionStore } | { status: 'unreadable'; reason: string };

export function parseStore(raw: unknown): StoreRead {
  const read = readSocialState(raw);
  if (read.status === 'unreadable') return { status: 'unreadable', reason: read.reason };
  if (read.status === 'absent') return { status: 'ok', store: { version: 1, readings: {} } };
  try {
    const v = JSON.parse(read.value) as Partial<CardImpressionStore>;
    if (v?.version !== 1 || !v.readings || typeof v.readings !== 'object') {
      return { status: 'unreadable', reason: 'stored value is not a version-1 card impression store' };
    }
    return { status: 'ok', store: v as CardImpressionStore };
  } catch {
    return { status: 'unreadable', reason: 'stored value is not JSON' };
  }
}

export async function readCardImpressionStore(): Promise<StoreRead> {
  try {
    return parseStore(await callTool('web', 'web_get_social_state', { key: CARD_IMPRESSIONS_KEY }));
  } catch (err) {
    return { status: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

interface ExportForecast {
  entry_id: string;
  version: number;
  tier: number;
  x_post_id: string | null;
}

export interface CaptureSummary {
  status: 'written' | 'nothing_new' | 'skipped' | 'aborted';
  frozen_now: number;
  already_frozen: number;
  too_young: number;
  unreadable_posts: number;
  reason?: string;
}

/** Cards eligible to freeze now: Tier 1, carrying a post id, not yet stored. */
export function pendingCards(forecasts: readonly ExportForecast[], store: CardImpressionStore): ExportForecast[] {
  const seen = new Set<string>();
  return forecasts.filter((f) => {
    if (f.tier !== 1 || !f.x_post_id || store.readings[f.x_post_id] || seen.has(f.x_post_id)) return false;
    seen.add(f.x_post_id);
    return true;
  });
}

export async function captureCardImpressions(now: Date = new Date()): Promise<CaptureSummary> {
  const empty = { frozen_now: 0, already_frozen: 0, too_young: 0, unreadable_posts: 0 };
  if ((process.env.LEDGER_CARD_IMPRESSIONS_MODE ?? 'on') === 'off') {
    return { status: 'skipped', ...empty, reason: 'LEDGER_CARD_IMPRESSIONS_MODE=off' };
  }
  const abort = (reason: string): CaptureSummary => {
    console.error(`[CardImpressions] ABORTED — nothing written: ${reason}`);
    return { status: 'aborted', ...empty, reason };
  };

  const storeRead = await readCardImpressionStore();
  if (storeRead.status === 'unreadable') return abort(`store unreadable (${storeRead.reason})`);
  const store = storeRead.store;

  let forecasts: ExportForecast[];
  try {
    const raw = await callTool('web', 'web_export_ledger', {});
    if (isMCPError(raw)) return abort(`web_export_ledger: ${extractMCPErrorMessage(raw)}`);
    const text = mcpText(raw);
    if (!text) return abort('web_export_ledger returned no content');
    forecasts = (JSON.parse(text) as { forecasts: ExportForecast[] }).forecasts;
    if (!Array.isArray(forecasts)) return abort('web_export_ledger has no forecasts array');
  } catch (err) {
    return abort(`web_export_ledger: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pending = pendingCards(forecasts, store);
  const already = Object.keys(store.readings).length;
  if (pending.length === 0) {
    console.log(`[CardImpressions] nothing new frozen=${already}`);
    return { status: 'nothing_new', ...empty, already_frozen: already };
  }

  let posts: Map<string, XPostMetrics>;
  try {
    posts = await readXPosts(pending.map((f) => f.x_post_id!));
  } catch (err) {
    return abort(err instanceof Error ? err.message : String(err));
  }

  let frozenNow = 0;
  let tooYoung = 0;
  let unreadable = 0;
  const readings = { ...store.readings };
  for (const f of pending) {
    const p = posts.get(f.x_post_id!);
    if (!p) { unreadable++; continue; }
    const ageDays = (now.getTime() - Date.parse(p.created_at)) / 86_400_000;
    if (ageDays < IMPRESSION_FREEZE_AGE_DAYS) { tooYoung++; continue; }
    readings[p.id] = {
      entry_id: f.entry_id,
      impressions: p.impressions,
      reply_count: p.reply_count,
      posted_at: p.created_at,
      read_at: now.toISOString(),
      age_days: Math.round(ageDays * 10) / 10,
    };
    frozenNow++;
  }

  const counts = { frozen_now: frozenNow, already_frozen: already, too_young: tooYoung, unreadable_posts: unreadable };
  if (frozenNow === 0) {
    console.log(`[CardImpressions] nothing new frozen=${already} too_young=${tooYoung} unreadable=${unreadable}`);
    return { status: 'nothing_new', ...counts };
  }

  const value: CardImpressionStore = { version: 1, readings };
  try {
    const res = await callTool('web', 'web_set_social_state', { key: CARD_IMPRESSIONS_KEY, value: JSON.stringify(value) });
    if (isMCPError(res)) return abort(`web_set_social_state: ${extractMCPErrorMessage(res)}`);
  } catch (err) {
    return abort(`web_set_social_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(
    `[CardImpressions] froze=${frozenNow} total=${already + frozenNow} too_young=${tooYoung} unreadable=${unreadable}`,
  );
  return { status: 'written', ...counts };
}
