/**
 * The 8-week review gate (spec "Scale path → 8-week review gate"): six measures
 * recorded weekly from week 1 and read on the first Tuesday after week 8.
 *
 * Pure. Every input is already-fetched data; `src/scripts/ledger-gate-report.ts`
 * does the reading and `src/ledger/card-impressions.ts` the one write.
 *
 * Definitions (printed verbatim in the report header, so the numbers cannot be
 * read under a different rule than the one that produced them):
 *
 * - **Week.** Sunday–Saturday on the New York calendar, because the spec's week
 *   runs Sunday intake → Monday cards → Tuesday pass. Week 1 is 2026-10-04..10,
 *   the week PT-2026-001 published in; week 8 is 11-22..28, so the review falls
 *   on Tuesday 2026-12-01.
 * - **Tuesday pass.** For the week's Tuesday T: a proposal is DUE when it was
 *   filed before T 00:00 ET and still undecided at that moment. The pass is DONE
 *   when every due proposal was decided before Wednesday 06:00 ET and at least one
 *   decision landed in [Monday 18:00, Wednesday 06:00) ET — the window admits the
 *   pass that runs late Monday night or past midnight. Nothing due and no decision
 *   is NOTHING_DUE (week 1: PT-2026-001 published that Tuesday evening), not a
 *   miss.
 * - **Resolution card.** Checked beside the pass, never folded into it, so the
 *   weeks before the card was tracked keep the status they were recorded under.
 *   A card is POSTED when `data/ledger-resolution-cards.json` lists an X post for
 *   that Tuesday and X returns it created in [Monday 18:00 ET, the week's end). A
 *   card is expected for every pass that is done or missed; a NOTHING_DUE week
 *   expects none.
 * - **Entries / resolved.** Cumulative v1 `published_at` and resolution
 *   `confirmed_at` before the week ends. Voids are counted beside, not inside.
 * - **Impressions.** Each Tier 1 card's `impression_count` frozen once at ≥7 days
 *   old, bucketed by the week the card posted. "Rising" = the pooled median of
 *   weeks 5–8 cards is STRICTLY above weeks 1–4. A live (<7d) reading is shown but
 *   never enters a median, because counts are cumulative and a young card would
 *   pull its week down.
 * - **Reply rate.** Third-party replies per 1,000 impressions. `reply_count`
 *   includes our own self-reply, so our direct replies to a post are subtracted.
 * - **Loop time.** Active span: the gaps ≤ 20 min between a card's recorded
 *   events (draft audit rows through the X post), summed. It does NOT see film or
 *   research done before the draft is opened, a single stretch of more than 20 min
 *   without a save, or the 30-minute reply watch (outside the spec's 40).
 */
import { addDays, daysBetween, etCalendarDate, etToUtcIso, type IsoDate } from './dates.js';

export const GATE_VERSION = 1;
export const GATE_WEEK1_START: IsoDate = '2026-10-04';
export const GATE_WEEKS = 8;
export const LOOP_GAP_CAP_MIN = 20;
export const IMPRESSION_FREEZE_AGE_DAYS = 7;

export const GATE_THRESHOLDS = {
  tuesday_passes: 8,
  entries: 30,
  resolved: 60,
  loop_median_min: 40,
} as const;

// ── Weeks ─────────────────────────────────────────────────────────────

export function gateWeekStart(week: number): IsoDate {
  return addDays(GATE_WEEK1_START, 7 * (week - 1));
}

/** Gate week of an instant. 0 or below means before week 1. */
export function gateWeekOf(instant: string): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`not an instant: ${JSON.stringify(instant)}`);
  return Math.floor(daysBetween(GATE_WEEK1_START, etCalendarDate(new Date(ms))) / 7) + 1;
}

/** [start, end) of a gate week as UTC instants. */
export function gateWeekBounds(week: number): { start: string; end: string } {
  const s = gateWeekStart(week);
  return { start: etToUtcIso(s, '00:00'), end: etToUtcIso(addDays(s, 7), '00:00') };
}

const ms = (iso: string) => Date.parse(iso);
const before = (a: string | null | undefined, bound: string) => !!a && ms(a) < ms(bound);

// ── Tuesday pass ──────────────────────────────────────────────────────

export interface GateProposal {
  entry_id: string;
  field: string;
  proposed_at: string;
  decided_at: string | null;
  decision: string;
}

export interface GateResolution {
  entry_id: string;
  field: string;
  status: string;
  confirmed_at: string | null;
}

export type TuesdayStatus = 'done' | 'missed' | 'nothing_due' | 'not_yet';

export interface TuesdayPass {
  week: number;
  tuesday: IsoDate;
  status: TuesdayStatus;
  due: number;
  due_decided_late: number;
  due_undecided: number;
  decisions_in_window: number;
}

export function tuesdayPass(
  week: number,
  proposals: readonly GateProposal[],
  resolutions: readonly GateResolution[],
  asOf: string,
): TuesdayPass {
  const tuesday = addDays(gateWeekStart(week), 2);
  const tStart = etToUtcIso(tuesday, '00:00');
  const windowStart = etToUtcIso(addDays(tuesday, -1), '18:00');
  const windowEnd = etToUtcIso(addDays(tuesday, 1), '06:00');

  const due = proposals.filter((p) => before(p.proposed_at, tStart) && !before(p.decided_at, tStart));
  const late = due.filter((p) => p.decided_at && !before(p.decided_at, windowEnd)).length;
  const undecided = due.filter((p) => !p.decided_at).length;

  const decisions = new Set<string>();
  for (const p of proposals) if (p.decided_at) decisions.add(p.decided_at);
  for (const r of resolutions) if (r.confirmed_at) decisions.add(r.confirmed_at);
  const inWindow = [...decisions].filter((d) => !before(d, windowStart) && before(d, windowEnd)).length;

  let status: TuesdayStatus;
  if (!before(windowEnd, asOf)) status = 'not_yet';
  else if (due.length === 0 && inWindow === 0) status = 'nothing_due';
  else if (inWindow > 0 && late === 0 && undecided === 0) status = 'done';
  else status = 'missed';

  return {
    week,
    tuesday,
    status,
    due: due.length,
    due_decided_late: late,
    due_undecided: undecided,
    decisions_in_window: inWindow,
  };
}

// ── Resolution card ───────────────────────────────────────────────────

export interface ResolutionCardPost {
  tuesday: IsoDate;
  x_post_id: string;
  /** The post's created_at on X; null = X returned no such post. */
  created_at: string | null;
}

export type ResolutionCardStatus =
  | 'posted'
  | 'not_listed'
  | 'not_on_x'
  | 'outside_window'
  | 'not_expected'
  | 'list_unreadable';

export interface ResolutionCardCheck {
  status: ResolutionCardStatus;
  x_post_id?: string;
  posted_at?: string;
}

/** Whether the week's resolution card was posted. `listed` null = the list file was unreadable. */
export function resolutionCardCheck(tp: TuesdayPass, listed: readonly ResolutionCardPost[] | null): ResolutionCardCheck {
  const expected = tp.status === 'done' || tp.status === 'missed';
  if (listed === null) return { status: expected ? 'list_unreadable' : 'not_expected' };
  const mine = listed.filter((c) => c.tuesday === tp.tuesday);
  if (mine.length === 0) return { status: expected ? 'not_listed' : 'not_expected' };
  const start = etToUtcIso(addDays(tp.tuesday, -1), '18:00');
  const end = gateWeekBounds(gateWeekOf(start)).end;
  const hit = mine.find((c) => c.created_at && !before(c.created_at, start) && before(c.created_at, end));
  if (hit) return { status: 'posted', x_post_id: hit.x_post_id, posted_at: hit.created_at! };
  const onX = mine.find((c) => c.created_at);
  if (onX) return { status: 'outside_window', x_post_id: onX.x_post_id, posted_at: onX.created_at! };
  return { status: 'not_on_x', x_post_id: mine[0].x_post_id };
}

// ── Entries and resolved fields ───────────────────────────────────────

export interface GateForecast {
  id: string;
  entry_id: string;
  version: number;
  tier: number;
  published_at: string;
  created_at: string;
  x_post_id: string | null;
  x_self_reply_id: string | null;
}

export function entriesBefore(forecasts: readonly GateForecast[], bound: string): number {
  return new Set(forecasts.filter((f) => f.version === 1 && before(f.published_at, bound)).map((f) => f.entry_id)).size;
}

export function resolvedBefore(resolutions: readonly GateResolution[], bound: string): { resolved: number; void: number } {
  let resolved = 0;
  let voided = 0;
  for (const r of resolutions) {
    if (!before(r.confirmed_at, bound)) continue;
    if (r.status === 'resolved') resolved++;
    else if (r.status === 'void') voided++;
  }
  return { resolved, void: voided };
}

// ── Helpers ───────────────────────────────────────────────────────────

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Impressions ───────────────────────────────────────────────────────

export interface CardReading {
  entry_id: string;
  x_post_id: string;
  posted_at: string;
  impressions: number;
  reply_count: number;
  age_days: number;
  /** true = the stored ≥7-day reading; false = read live, younger than 7 days. */
  frozen: boolean;
}

export interface ImpressionComparison {
  early_median: number | null;
  late_median: number | null;
  early_n: number;
  late_n: number;
  verdict: 'rising' | 'not_rising' | 'not_measurable';
  reason?: string;
}

export function compareImpressions(readings: readonly CardReading[]): ImpressionComparison {
  const frozen = readings.filter((r) => r.frozen);
  const early = frozen.filter((r) => { const w = gateWeekOf(r.posted_at); return w >= 1 && w <= 4; }).map((r) => r.impressions);
  const late = frozen.filter((r) => { const w = gateWeekOf(r.posted_at); return w >= 5 && w <= 8; }).map((r) => r.impressions);
  const out = { early_median: median(early), late_median: median(late), early_n: early.length, late_n: late.length };
  if (early.length === 0) return { ...out, verdict: 'not_measurable', reason: 'no frozen readings for weeks 1–4' };
  if (late.length === 0) return { ...out, verdict: 'not_measurable', reason: 'no frozen readings for weeks 5–8 yet' };
  return { ...out, verdict: out.late_median! > out.early_median! ? 'rising' : 'not_rising' };
}

// ── Reply rate ────────────────────────────────────────────────────────

export interface TimelinePost {
  id: string;
  created_at: string;
  impressions: number;
  reply_count: number;
  /** id of the post this one replies to, if any. */
  replied_to: string | null;
}

/** reply_count minus our own direct replies to that post, floored at 0. */
export function thirdPartyReplies(post: TimelinePost, ownPosts: readonly TimelinePost[]): number {
  const own = ownPosts.filter((p) => p.replied_to === post.id).length;
  return Math.max(0, post.reply_count - own);
}

export interface ReplyRate {
  posts: number;
  impressions: number;
  third_party_replies: number;
  per_1000: number | null;
}

export function replyRate(posts: readonly TimelinePost[], ownPosts: readonly TimelinePost[]): ReplyRate {
  const impressions = posts.reduce((a, p) => a + p.impressions, 0);
  const replies = posts.reduce((a, p) => a + thirdPartyReplies(p, ownPosts), 0);
  return {
    posts: posts.length,
    impressions,
    third_party_replies: replies,
    per_1000: impressions > 0 ? Math.round((replies / impressions) * 1000 * 100) / 100 : null,
  };
}

// ── Loop time ─────────────────────────────────────────────────────────

/** Sum of the gaps between consecutive instants that are ≤ capMin, in minutes. */
export function activeSpanMinutes(instants: readonly string[], capMin = LOOP_GAP_CAP_MIN): number {
  const t = instants.map(ms).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  let sum = 0;
  for (let i = 1; i < t.length; i++) {
    const gap = (t[i] - t[i - 1]) / 60_000;
    if (gap <= capMin) sum += gap;
  }
  return Math.round(sum * 10) / 10;
}

export interface LoopReading {
  entry_id: string;
  published_at: string;
  active_min: number;
  wall_min: number;
  events: number;
}

/**
 * One card's loop. Events run from the draft's creation to the card's X post
 * (the tweet's created_at, else the first provenance audit row). Anything after
 * the post — a later linkage, a correction — is not part of the loop and is cut.
 */
export function loopReading(
  forecast: GateForecast,
  auditInstants: readonly { ts: string; action: string }[],
  tweetCreatedAt: string | null,
): LoopReading | null {
  const provenance = auditInstants.filter((a) => a.action === 'ledger_provenance').map((a) => a.ts).sort((a, b) => ms(a) - ms(b))[0];
  const end = tweetCreatedAt ?? provenance ?? null;
  if (!end) return null;
  const events = [forecast.created_at, ...auditInstants.map((a) => a.ts), end].filter((t) => ms(t) <= ms(end));
  return {
    entry_id: forecast.entry_id,
    published_at: forecast.published_at,
    active_min: activeSpanMinutes(events),
    wall_min: Math.round(((ms(end) - ms(forecast.created_at)) / 60_000) * 10) / 10,
    events: events.length,
  };
}

// ── The table ─────────────────────────────────────────────────────────

export type Cell<T> = { value: T } | { not_measurable: string };

export interface GateInput {
  as_of: string;
  forecasts: readonly GateForecast[];
  resolutions: readonly GateResolution[];
  proposals: readonly GateProposal[];
  cards: readonly CardReading[];
  loops: readonly LoopReading[];
  /** null = the open-question list could not be read, or is empty. */
  open_question: { posts: readonly TimelinePost[]; reason?: string };
  baseline: { posts: readonly TimelinePost[]; own: readonly TimelinePost[]; reason?: string };
  /** posts null = data/ledger-resolution-cards.json could not be read. */
  resolution_cards: { posts: readonly ResolutionCardPost[] | null; reason?: string };
}

export interface GateWeekRow {
  week: number;
  start: IsoDate;
  tuesday: TuesdayPass;
  card: ResolutionCardCheck;
  passes_done: number;
  passes_counted: number;
  entries: number;
  resolved: number;
  void: number;
  cards_frozen: number;
  cards_live: number;
  impressions_median: number | null;
  loop_median_active: number | null;
  loop_median_wall: number | null;
  loop_n: number;
}

export interface GateReport {
  version: number;
  as_of: string;
  current_week: number;
  weeks: GateWeekRow[];
  gate: {
    tuesday_passes: Cell<{ done: number; counted: number; nothing_due: number }>;
    resolution_cards: Cell<{ posted: number; expected: number }>;
    entries: Cell<number>;
    resolved: Cell<number>;
    impressions: Cell<ImpressionComparison>;
    reply_rate: Cell<{ open_question: ReplyRate; baseline: ReplyRate; above: boolean }>;
    loop_time: Cell<{ median_active: number; median_wall: number; n: number }>;
  };
}

export function buildGateReport(input: GateInput): GateReport {
  const current = Math.min(GATE_WEEKS, Math.max(1, gateWeekOf(input.as_of)));
  const weeks: GateWeekRow[] = [];
  let done = 0;
  let counted = 0;
  let nothingDue = 0;
  let cardsPosted = 0;
  let cardsExpected = 0;
  const asOfMs = ms(input.as_of);

  for (let w = 1; w <= current; w++) {
    const { end } = gateWeekBounds(w);
    const bound = ms(end) < asOfMs ? end : input.as_of;
    const tp = tuesdayPass(w, input.proposals, input.resolutions, input.as_of);
    if (tp.status === 'done') { done++; counted++; }
    else if (tp.status === 'missed') counted++;
    else if (tp.status === 'nothing_due') nothingDue++;
    const card = resolutionCardCheck(tp, input.resolution_cards.posts);
    // Counted only once the pass itself is counted, so posted ≤ expected.
    if (tp.status === 'done' || tp.status === 'missed') {
      cardsExpected++;
      if (card.status === 'posted') cardsPosted++;
    }
    const res = resolvedBefore(input.resolutions, bound);
    const weekCards = input.cards.filter((c) => gateWeekOf(c.posted_at) === w);
    const frozen = weekCards.filter((c) => c.frozen);
    const weekLoops = input.loops.filter((l) => gateWeekOf(l.published_at) === w);
    weeks.push({
      week: w,
      start: gateWeekStart(w),
      tuesday: tp,
      card,
      passes_done: done,
      passes_counted: counted,
      entries: entriesBefore(input.forecasts, bound),
      resolved: res.resolved,
      void: res.void,
      cards_frozen: frozen.length,
      cards_live: weekCards.length - frozen.length,
      impressions_median: median(frozen.map((c) => c.impressions)),
      loop_median_active: median(weekLoops.map((l) => l.active_min)),
      loop_median_wall: median(weekLoops.map((l) => l.wall_min)),
      loop_n: weekLoops.length,
    });
  }

  const last = weeks[weeks.length - 1];
  const imp = compareImpressions(input.cards);
  const allLoops = input.loops.filter((l) => ms(l.published_at) <= asOfMs);

  let reply: GateReport['gate']['reply_rate'];
  if (input.open_question.posts.length === 0) {
    const why = input.open_question.reason ?? 'no open-question posts listed in data/ledger-open-question-posts.json';
    // The baseline is still worth printing: it is the bar the mechanic will be judged against.
    const base = input.baseline.reason ? null : replyRate(input.baseline.posts, input.baseline.own);
    reply = {
      not_measurable: base
        ? `${why} (baseline so far: ${base.per_1000 ?? '—'} third-party replies per 1k over ${base.posts} posts, ${base.impressions} impressions)`
        : why,
    };
  } else if (input.baseline.reason) {
    reply = { not_measurable: input.baseline.reason };
  } else {
    const oq = replyRate(input.open_question.posts, input.baseline.own);
    const base = replyRate(input.baseline.posts, input.baseline.own);
    reply = oq.per_1000 === null || base.per_1000 === null
      ? { not_measurable: 'no impressions recorded on one side' }
      : { value: { open_question: oq, baseline: base, above: oq.per_1000 > base.per_1000 } };
  }

  return {
    version: GATE_VERSION,
    as_of: input.as_of,
    current_week: current,
    weeks,
    gate: {
      tuesday_passes: { value: { done, counted, nothing_due: nothingDue } },
      resolution_cards: input.resolution_cards.posts === null
        ? { not_measurable: input.resolution_cards.reason ?? 'data/ledger-resolution-cards.json unreadable' }
        : { value: { posted: cardsPosted, expected: cardsExpected } },
      entries: { value: last.entries },
      resolved: { value: last.resolved },
      impressions: imp.verdict === 'not_measurable' ? { not_measurable: imp.reason! } : { value: imp },
      reply_rate: reply,
      loop_time: allLoops.length === 0
        ? { not_measurable: 'no Tier 1 card with a recorded post time' }
        : {
            value: {
              median_active: median(allLoops.map((l) => l.active_min))!,
              median_wall: median(allLoops.map((l) => l.wall_min))!,
              n: allLoops.length,
            },
          },
    },
  };
}
