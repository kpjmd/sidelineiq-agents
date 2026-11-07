/**
 * Raw recorded responses → `GateInput` for `buildGateReport` (src/ledger/gate.ts).
 *
 * Pure, so the whole path from the exact text the tools returned to the printed
 * gate table runs in tests against `tests/fixtures/ledger-gate/<date>/`, which
 * `src/scripts/ledger-gate-report.ts --record-fixtures` writes from prod.
 */
import { isIsoDate } from './dates.js';
import { parseStore, parseXPost, type CardImpressionStore, type XPostMetrics } from './card-impressions.js';
import {
  gateWeekBounds,
  gateWeekOf,
  loopReading,
  type CardReading,
  type GateForecast,
  type GateInput,
  type GateProposal,
  type GateResolution,
  type LoopReading,
  type ResolutionCardPost,
  type TimelinePost,
} from './gate.js';

export interface GateRawResponses {
  /** MCP text of web_export_ledger. */
  export: string;
  /** MCP text of web_list_ledger_proposals, one per decision. */
  proposals: { pending: string; confirmed: string; rejected: string };
  /** MCP text of web_list_audit_entries, keyed by forecast id. */
  audit: Record<string, string>;
  /** MCP texts of x_api get_posts_by_ids for every card and open-question post. */
  x_posts: string[];
  /** MCP texts of x_api get_users_posts, one per page. null = could not be read. */
  timeline: string[] | null;
  timeline_error?: string;
  /** The whole MCP result of web_get_social_state (the envelope is parsed by parseStore). */
  store: unknown;
  /** Contents of data/ledger-open-question-posts.json, or null when unreadable. */
  open_question_file: { posts?: Array<{ x_post_id?: string; entry_id?: string }> } | null;
  /**
   * Contents of data/ledger-resolution-cards.json, or null when unreadable.
   * Absent in fixtures recorded before the file existed: read as an empty list.
   */
  resolution_card_file?: { cards?: Array<{ tuesday?: string; x_post_id?: string }> } | null;
}

/** A listed card's Tuesday must be a real Tuesday on the calendar (UTC noon avoids any DST edge). */
const isTuesday = (d: string) => isIsoDate(d) && new Date(`${d}T12:00:00Z`).getUTCDay() === 2;

export function listedResolutionCards(file: GateRawResponses['resolution_card_file']): {
  cards: Array<{ tuesday: string; x_post_id: string }> | null;
  ignored: string[];
} {
  if (file === null) return { cards: null, ignored: [] };
  const cards: Array<{ tuesday: string; x_post_id: string }> = [];
  const ignored: string[] = [];
  for (const [i, c] of (file?.cards ?? []).entries()) {
    if (!c || typeof c.tuesday !== 'string' || !isTuesday(c.tuesday)) ignored.push(`cards[${i}]: tuesday must be a YYYY-MM-DD Tuesday`);
    else if (typeof c.x_post_id !== 'string' || !/^\d+$/.test(c.x_post_id)) ignored.push(`cards[${i}]: x_post_id must be the numeric id from the post URL`);
    else cards.push({ tuesday: c.tuesday, x_post_id: c.x_post_id });
  }
  return { cards, ignored };
}

export interface AssembledGate {
  input: GateInput;
  store_status: 'ok' | 'unreadable';
  store_reason?: string;
  card_rows: Array<CardReading & { live_impressions: number | null }>;
  loop_rows: LoopReading[];
  unmeasured_cards: string[];
  /** Entries in data/ledger-resolution-cards.json that were malformed and skipped. */
  resolution_card_ignored: string[];
}

function postsFrom(texts: readonly string[]): Map<string, XPostMetrics> {
  const out = new Map<string, XPostMetrics>();
  for (const text of texts) {
    const body = JSON.parse(text) as { data?: unknown[] };
    for (const p of body.data ?? []) {
      const parsed = parseXPost(p);
      if (parsed) out.set(parsed.id, parsed);
    }
  }
  return out;
}

const toTimelinePost = (p: XPostMetrics): TimelinePost => ({
  id: p.id,
  created_at: p.created_at,
  impressions: p.impressions,
  reply_count: p.reply_count,
  replied_to: p.replied_to,
});

export function assembleGate(raw: GateRawResponses, asOf: string): AssembledGate {
  const exp = JSON.parse(raw.export) as { forecasts: GateForecast[]; resolutions: GateResolution[] };
  const proposals: GateProposal[] = [];
  for (const k of ['pending', 'confirmed', 'rejected'] as const) {
    proposals.push(...(JSON.parse(raw.proposals[k]) as { proposals: GateProposal[] }).proposals);
  }

  const storeRead = parseStore(raw.store);
  const store: CardImpressionStore = storeRead.status === 'ok' ? storeRead.store : { version: 1, readings: {} };
  const xPosts = postsFrom(raw.x_posts);
  const asOfMs = Date.parse(asOf);

  // As-of view: nothing published, decided or read after `asOf` exists yet.
  const forecasts = exp.forecasts.filter((f) => Date.parse(f.published_at) <= asOfMs);
  const resolutions = exp.resolutions.map((r) =>
    r.confirmed_at && Date.parse(r.confirmed_at) > asOfMs ? { ...r, status: 'open', confirmed_at: null } : r,
  );
  const props = proposals
    .filter((p) => Date.parse(p.proposed_at) <= asOfMs)
    .map((p) => (p.decided_at && Date.parse(p.decided_at) > asOfMs ? { ...p, decided_at: null, decision: 'pending' } : p));

  const cards = forecasts.filter((f) => f.tier === 1 && f.x_post_id && f.version === 1);
  const cardRows: AssembledGate['card_rows'] = [];
  const loopRows: LoopReading[] = [];
  const unmeasured: string[] = [];

  for (const f of cards) {
    const id = f.x_post_id!;
    const live = xPosts.get(id) ?? null;
    const stored = store.readings[id];
    const frozen = stored && Date.parse(stored.read_at) <= asOfMs ? stored : null;
    const postedAt = frozen?.posted_at ?? live?.created_at ?? null;
    if (frozen) {
      cardRows.push({
        entry_id: f.entry_id, x_post_id: id, posted_at: frozen.posted_at, impressions: frozen.impressions,
        reply_count: frozen.reply_count, age_days: frozen.age_days, frozen: true, live_impressions: live?.impressions ?? null,
      });
    } else if (live) {
      const age = Math.round(((asOfMs - Date.parse(live.created_at)) / 86_400_000) * 10) / 10;
      cardRows.push({
        entry_id: f.entry_id, x_post_id: id, posted_at: live.created_at, impressions: live.impressions,
        reply_count: live.reply_count, age_days: age, frozen: false, live_impressions: live.impressions,
      });
    } else {
      unmeasured.push(f.entry_id);
    }

    const auditText = raw.audit[f.id];
    if (auditText) {
      const entries = (JSON.parse(auditText) as { entries: Array<{ ts: string; action: string }> }).entries;
      const loop = loopReading(f, entries, postedAt);
      if (loop) loopRows.push(loop);
    }
  }

  // Reply rate: open-question posts from the hand-kept list; baseline = the
  // account's other top-level posts from week 1 to as_of.
  const listed = (raw.open_question_file?.posts ?? []).map((p) => p.x_post_id).filter((x): x is string => !!x);
  const listedSet = new Set(listed);
  const oqPosts = listed.map((id) => xPosts.get(id)).filter((p): p is XPostMetrics => !!p && Date.parse(p.created_at) <= asOfMs);

  let baseline: GateInput['baseline'];
  if (raw.timeline === null) {
    baseline = { posts: [], own: [], reason: `account timeline unreadable: ${raw.timeline_error ?? 'unknown error'}` };
  } else {
    const start = Date.parse(gateWeekBounds(1).start);
    const all = postsFrom(raw.timeline);
    const own = [...all.values()].map(toTimelinePost);
    const posts = own.filter((p) => {
      const t = Date.parse(p.created_at);
      return !p.replied_to && !listedSet.has(p.id) && t >= start && t <= asOfMs && gateWeekOf(p.created_at) >= 1;
    });
    baseline = { posts, own };
  }

  // Resolution cards: the hand-kept list, each id checked against X (the batch
  // read first, the account timeline as a second source).
  const timelinePosts = raw.timeline === null ? new Map<string, XPostMetrics>() : postsFrom(raw.timeline);
  const rc = listedResolutionCards(raw.resolution_card_file);
  const rcPosts: ResolutionCardPost[] | null = rc.cards === null ? null : rc.cards.map((c) => {
    const p = xPosts.get(c.x_post_id) ?? timelinePosts.get(c.x_post_id) ?? null;
    return { tuesday: c.tuesday, x_post_id: c.x_post_id, created_at: p && Date.parse(p.created_at) <= asOfMs ? p.created_at : null };
  });

  return {
    input: {
      as_of: asOf,
      forecasts,
      resolutions,
      proposals: props,
      cards: cardRows,
      loops: loopRows,
      open_question: {
        posts: oqPosts.map(toTimelinePost),
        reason: raw.open_question_file === null
          ? 'data/ledger-open-question-posts.json unreadable'
          : listed.length === 0 ? 'no open-question posts listed in data/ledger-open-question-posts.json'
          : oqPosts.length === 0 ? `none of the ${listed.length} listed open-question posts could be read on X` : undefined,
      },
      baseline,
      resolution_cards: {
        posts: rcPosts,
        reason: rcPosts === null ? 'data/ledger-resolution-cards.json unreadable' : undefined,
      },
    },
    store_status: storeRead.status,
    store_reason: storeRead.status === 'unreadable' ? storeRead.reason : undefined,
    card_rows: cardRows,
    loop_rows: loopRows,
    unmeasured_cards: unmeasured,
    resolution_card_ignored: rc.ignored,
  };
}
