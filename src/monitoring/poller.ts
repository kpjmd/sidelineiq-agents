import type {
  SportKey,
  RawInjuryEvent,
  SignificanceAssessment,
  InjuryPostContent,
  AthleteTier,
  ContentType,
  ClassificationResult,
} from '../types.js';
import { SPORT_SOURCES } from './sports/index.js';
import { formatSourceReports } from './sports/multi-source.js';
import { classifyEvent } from '../agents/injury-intelligence/classifier.js';
import {
  processInjuryEvent,
  parseTeamTimeline,
  assessTimelineAnchorAmbiguity,
  type InjuryThreadContext,
} from '../agents/injury-intelligence/agent.js';
import { chooseDateAnchor } from '../agents/injury-intelligence/date-anchoring.js';
import { resolveInjuryDate } from '../agents/injury-intelligence/date-resolution.js';
import type { DateConfidence } from '../agents/injury-intelligence/date-resolution.js';
import {
  detectCarryoverSignals,
  isGatingCarryover,
  type CarryoverSignals,
} from '../agents/injury-intelligence/carryover.js';
import { checkForExisting, parseListPostsResponse, type DedupResult } from './deduplicator.js';
import { publishInjuryPost, getMDReviewThreshold } from '../utils/publishing-pipeline.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
  isConcussionTierBlocked,
  isSameAthleteName,
  computeSignificance,
  getDeferConfig,
  tierMarker,
} from '../agents/injury-intelligence/significance.js';
import {
  applyAthleteReanchor,
  attemptAthleteReanchor,
  getReanchorMode,
  isSurnameReference,
} from './athlete-reanchor.js';
import { evictExpired, handleDeferDecision, type DeferOutcome } from './defer-queue.js';
import { maybeProposeReturnWatch } from './return-watch.js';
import { callTool, callToolWithRetry, isServerAvailable } from '../utils/mcp-client-manager.js';
import { isTeamSport, registersAthletesOnSight } from './roster-sync.js';
import {
  validateEvent,
  summarizeFailures,
  teamClaimCheck,
  type ResolvedPlayerInfo,
  type ValidationFailure,
  type ValidationResult,
} from '../agents/injury-intelligence/fact-validator.js';
import { refreshTierSnapshotsIfStale } from '../agents/injury-intelligence/tier-snapshots.js';

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const SPORT_KEYS: SportKey[] = ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'];

const SPORT_ENV_FLAGS: Record<SportKey, string> = {
  NFL: 'POLL_NFL',
  NBA: 'POLL_NBA',
  PREMIER_LEAGUE: 'POLL_PREMIER_LEAGUE',
  UFC: 'POLL_UFC',
};

// Default to launch order: NFL active, others opt-in until stable
const SPORT_DEFAULTS: Record<SportKey, boolean> = {
  NFL: true,
  NBA: false,
  PREMIER_LEAGUE: false,
  UFC: false,
};

interface Timers {
  [sport: string]: NodeJS.Timeout | null;
}

const timers: Timers = {};
let stopped = false;

function getPollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  if (!raw) return DEFAULT_POLL_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_INTERVAL_MS;
}

// ── Publish volume caps ──────────────────────────────────────────────────────
// The significance gate decides *what* is worth covering; these caps bound *how
// much* lands in a single cycle or day. Without them a loosened gate turns a
// 300-event ESPN feed into a posting burst and a Sonnet spend incident.

const DEFAULT_MAX_PUBLISHES_PER_CYCLE = 3; // per sport, per cycle
const DEFAULT_MAX_AGENT_CALLS_PER_CYCLE = 8; // per sport, per cycle
const DEFAULT_MAX_PUBLISHES_PER_DAY = 10; // global, rolling 24h

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface PublishBudgetState {
  /** Sonnet invocations already made this cycle for this sport. */
  agentCalls: number;
  /** Posts PUBLISHED this cycle for this sport. */
  cyclePublishes: number;
  /** Posts routed to MD review this cycle for this sport. */
  cycleReviews: number;
  /** Remaining publish slots in the rolling 24h window; Infinity when unknown. */
  dayPublishRemaining: number;
  /** Remaining review slots in the rolling 24h window; Infinity when unknown. */
  dayReviewRemaining: number;
}

export interface PublishBudgetLimits {
  maxAgentCallsPerCycle: number;
  maxPublishesPerCycle: number;
  maxReviewsPerCycle: number;
}

/**
 * Returns a human-readable reason when the budget is spent, or null to proceed.
 * Pure so it can be unit-tested without standing up the whole poll loop.
 *
 * PUBLISHING AND REVIEW ARE SEPARATE LANES. They used to share one counter, on
 * the reasoning that a review-queue row is output an MD may approve later. With
 * MAX_PUBLISHES_PER_CYCLE=1 that meant the first event routed to review spent
 * the cycle's only slot and nothing ever published — the pipeline went five days
 * without attempting a single cast in August 2026. A review is not an
 * audience-facing post and must not consume audience-facing budget.
 *
 * The gate is necessarily pre-hoc: which lane an event lands in depends on the
 * agent's confidence, which is not known until after the Sonnet call, and this
 * check deliberately runs before dedup so a capped event costs nothing (see the
 * call site). So it proceeds while EITHER lane has capacity and the outcome is
 * counted into the right lane afterwards. The per-cycle caps are therefore
 * throttles rather than hard ceilings — a run of same-lane outcomes can exceed
 * one by at most the other lane's remaining capacity. The rolling 24h caps are
 * the hard bound, re-derived from the database every cycle.
 */
export function publishBudgetExhausted(
  state: PublishBudgetState,
  limits: PublishBudgetLimits,
): string | null {
  if (state.agentCalls >= limits.maxAgentCallsPerCycle) {
    return `agent_call_cap:${state.agentCalls}/${limits.maxAgentCallsPerCycle}`;
  }

  const publishOpen =
    state.cyclePublishes < limits.maxPublishesPerCycle && state.dayPublishRemaining > 0;
  const reviewOpen =
    state.cycleReviews < limits.maxReviewsPerCycle && state.dayReviewRemaining > 0;

  if (!publishOpen && !reviewOpen) {
    return (
      `output_cap:publishes=${state.cyclePublishes}/${limits.maxPublishesPerCycle} ` +
      `reviews=${state.cycleReviews}/${limits.maxReviewsPerCycle} ` +
      `day_publish_left=${state.dayPublishRemaining === Infinity ? 'unknown' : state.dayPublishRemaining} ` +
      `day_review_left=${state.dayReviewRemaining === Infinity ? 'unknown' : state.dayReviewRemaining}`
    );
  }

  return null;
}

// ── Content-type drift ───────────────────────────────────────────────────────
// The significance gate scores classified.content_type, but the agent re-types
// posts after the gate has already run: a CONFLICT_FLAG with no parseable team
// timeline becomes TRACKING (agent.ts), and anything with a parent post becomes
// TRACKING. The tier rules are attached to the content type — TRACKING requires
// tier 1-2, tier 4 never publishes BREAKING, CONFLICT_FLAG skips scoring
// entirely — so a re-typed post has never been checked against the rules that
// govern what it actually became. A Haiku CONFLICT_FLAG on a depth player
// otherwise skips the gate, loses its conflict downstream, and publishes as
// exactly the tier-blocked TRACKING post the rules exclude.

export type ContentTypeDriftAction =
  | { action: 'proceed' }
  | { action: 'drop'; reason: string }
  | { action: 'md_review'; reason: string };

/**
 * Writes a promotion's re-scored assessment back onto the classified event.
 *
 * The discount that bought the promotion has to travel with it. Everything
 * after the gate reads the significance off `classified` — the drift re-check,
 * the validation audit row, the gate log line — and the old code discarded the
 * re-score, so a promoted event carried a DEFER decision and its pre-promotion
 * bar through the entire rest of the pipeline.
 *
 * Exported and pure so the write-back is testable without standing up a poll
 * cycle, the same reason checkContentTypeDrift below is.
 */
export function applyDeferOutcome(
  classified: ClassificationResult,
  outcome: Extract<DeferOutcome, { result: 'promoted' }>,
): SignificanceAssessment {
  classified.significance = outcome.significance;
  return outcome.significance;
}

/**
 * Says when the defer TTL cannot outlive the poll interval.
 *
 * This is the invariant that was silently false in production: ttl_hours 6
 * against POLL_INTERVAL_MS 6h meant every deferred entry was evicted at the
 * start of the very next cycle, before any second source could arrive. The
 * queue filled, expired and reported `defer_q=0` forever, and nothing in the
 * logs said the two settings contradicted each other. Same shape as
 * UNREACHABLE_THRESHOLD in significance.ts, for the same reason.
 */
export function checkDeferTtlReachable(
  ttlHours: number,
  pollIntervalMs: number,
): string | null {
  const ttlMs = ttlHours * 3_600_000;
  if (ttlMs <= pollIntervalMs) {
    return (
      `DEFER_TTL_UNREACHABLE ttl_hours=${ttlHours} (${ttlMs}ms) <= POLL_INTERVAL_MS=${pollIntervalMs} — ` +
      'no deferred event survives to a second cycle, so nothing can ever corroborate one. ' +
      'DEFER is DROP. Raise defer.ttl_hours in significance-config.json.'
    );
  }
  if (ttlMs < pollIntervalMs * 2) {
    return (
      `DEFER_TTL_SINGLE_WINDOW ttl_hours=${ttlHours} gives a deferred event only one ` +
      `corroboration opportunity at POLL_INTERVAL_MS=${pollIntervalMs}.`
    );
  }
  return null;
}

let deferTtlWarned = false;

/** Emits checkDeferTtlReachable's finding at most once per process. The config
 *  only exists after loadSignificanceData, so this cannot live in startPolling. */
function warnOnceIfDeferTtlUnreachable(ttlHours: number): void {
  if (deferTtlWarned) return;
  deferTtlWarned = true;
  const warning = checkDeferTtlReachable(ttlHours, getPollIntervalMs());
  if (warning) console.warn(`[SignificanceGate] ${warning}`);
}

/**
 * Re-applies the significance gate under the post's FINAL content type.
 * Pure so it can be unit-tested without standing up the whole poll loop.
 */
export function checkContentTypeDrift(
  gatedType: ContentType,
  finalType: ContentType,
  sig: SignificanceAssessment,
  sport: SportKey,
  date: Date,
): ContentTypeDriftAction & { rescored?: SignificanceAssessment } {
  if (finalType === gatedType) return { action: 'proceed' };

  const rescored = computeSignificance(
    sig.athlete_tier,
    sig.athlete_tier_source,
    {
      information_specificity: sig.subscores.information_specificity,
      event_recency_novelty: sig.subscores.event_recency_novelty,
    },
    finalType,
    sport,
    date,
    // Corroboration is a fact about the REPORT — how many publishers said it —
    // and re-typing the post does not unsay any of them. Dropping it here would
    // have the drift check judge a promoted event against a bar the gate never
    // applied, which is the two-readers-of-one-fact divergence this repo keeps
    // rediscovering.
    {
      corroborationDiscount: sig.corroboration_discount,
      corroboratingSources: sig.corroborating_sources,
    },
  );

  if (rescored.triage_decision === 'PROCESS') return { action: 'proceed', rescored };

  // A tier-blocked cell is a flat editorial rule — no score clears it, so
  // dropping is the only honest outcome. A merely-low score is a judgement
  // call and the Sonnet call is already spent, so that goes to a human rather
  // than to social.
  const reason = `content_type_drift:${gatedType}->${finalType}`;
  return rescored.tier_blocked
    ? { action: 'drop', reason: `${reason}:tier_blocked`, rescored }
    : { action: 'md_review', reason, rescored };
}

// Statuses that count against the daily budget. PENDING_REVIEW is included on
// purpose: it consumed a Sonnet call and created a real row, and it matches how
// the in-cycle counter is incremented, so the two agree across cycle boundaries.
const BUDGETED_POST_STATUSES = new Set(['PUBLISHED', 'PENDING_REVIEW']);

/**
 * Counts posts created in the rolling 24h window across all sports.
 * Returns null when the count can't be established — callers fail OPEN on the
 * day cap (the per-cycle cap still bounds the blast radius) rather than going
 * silent every time the web MCP server hiccups.
 */
async function countRecentOutput(): Promise<{ published: number; review: number } | null> {
  if (!isServerAvailable('web')) return null;
  try {
    // web_list_posts is ORDER BY created_at DESC, so the newest 50 covers the
    // 24h window with wide margin at any sane MAX_PUBLISHES_PER_DAY.
    const res = await callTool('web', 'web_list_posts', { limit: 50 });
    const posts = parseListPostsResponse(res) as Array<{
      created_at?: string;
      status?: string;
    }>;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const counts = { published: 0, review: 0 };
    for (const p of posts) {
      if (p.status && !BUDGETED_POST_STATUSES.has(p.status)) continue;
      const t = p.created_at ? Date.parse(p.created_at) : NaN;
      if (!Number.isFinite(t) || t < cutoff) continue;
      // A row created as PENDING_REVIEW and approved since reads as PUBLISHED
      // here, so it counts against the publish lane. That is the right side to
      // err on: it did reach an audience.
      if (p.status === 'PENDING_REVIEW') counts.review++;
      else counts.published++;
    }
    return counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Poller] Daily output count unavailable, failing open: ${message}`);
    return null;
  }
}

function isSportEnabled(sport: SportKey): boolean {
  const envVar = SPORT_ENV_FLAGS[sport];
  const raw = process.env[envVar];
  if (raw === undefined) return SPORT_DEFAULTS[sport];
  return raw === 'true' || raw === '1';
}

// Events with clear injury signal — always pass to classifier regardless of other content.
// Stems need an explicit \w* — a bare stem plus \b never matches (see the note
// on INJURY_KEYWORD_RE in text-extraction.ts). Without it this anchor missed
// the word "injury" itself, making the non-injury pre-filter over-aggressive.
const INJURY_ANCHOR_RE = /\b(injur\w*|torn?|tear\w*|sprain\w*|fractur\w*|concuss\w*|sidelin\w*|surger\w*|strain\w*|ruptur\w*|acl|mcl|hamstring|achilles|tendon|ligament|hyperextension|disloc\w*|contusion|laceration|bruise|bone|stress fracture)\b/i;

// Non-injury signals — drop the event only when no injury anchor is present.
const NON_INJURY_RE = /\b(load management|personal reasons?|personal leave|family (matter|emergency|reasons?)|contract (extension|signing|negotiation)|suspended|suspension|ejected|ejection|paternity leave|bereavement|rest day)\b/i;

function isObviousNonInjury(event: RawInjuryEvent): boolean {
  if (INJURY_ANCHOR_RE.test(event.injury_description)) return false;
  return NON_INJURY_RE.test(event.injury_description);
}

interface PollSummary {
  fetched: number;
  classified_positive: number;
  pre_filtered: number;
  dropped_significance: number;
  date_carryover_review: number;
  timeline_anchor_review: number;
  timeline_anchor_annotated: number;
  date_carryover_annotated: number;
  /** Concussion-only events dropped by the tier rule, before any model call. */
  dropped_concussion: number;
  /** Events where the classifier's athlete disagreed with the source's. */
  athlete_name_drift: number;
  /** Drifted events re-pointed at the classifier's athlete after roster proof. */
  athlete_reanchored: number;
  /** Drift that was only a spelling difference — both names, one player row. */
  athlete_drift_spelling: number;
  /** Classifier answered with the source athlete's bare surname. Not drift. */
  athlete_surname_ref: number;
  /** Posts the agent re-typed after the gate had already scored the old type. */
  content_type_drift: number;
  dropped_fact_validation: number;
  soft_failed_fact_validation: number;
  deferred: number;
  promoted_from_defer: number;
  /** Promotions DEFER_CORROBORATION_MODE=shadow decided but did not act on. */
  would_promote_from_defer: number;
  expired_from_defer: number;
  /** Live defer-queue entries after eviction; -1 when the state store is down. */
  defer_queue_size: number;
  duplicates: number;
  published: number;
  pending_review: number;
  /** Review routings suppressed because an equivalent item was already queued.
   *  Kept out of `skipped` on purpose — this is the observable that says the
   *  MD-queue duplication fix is doing something. */
  review_suppressed: number;
  /** Review routings suppressed because the MD already rejected this exact
   *  question inside the 21-day window. Counted apart from review_suppressed
   *  because they answer different things: one says the MD has not looked yet,
   *  the other says they looked and said no. */
  rejection_suppressed: number;
  /** Pending review items retired because this publish covered them. */
  superseded: number;
  skipped: number;
  capped: number;
  /** Fetches that failed outright, as opposed to returning nothing. */
  source_errors: number;
  /** Classifier calls that errored — distinct from "classified as not an injury". */
  classifier_errors: number;
  errors: number;
}

interface ResolveResponse {
  resolved: boolean;
  player: ResolvedPlayerInfo | null;
}

interface MCPResultLike {
  content?: Array<{ text?: string }>;
}

function unwrapMCP<T>(res: unknown): T | null {
  try {
    const text = (res as MCPResultLike)?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function resolvePlayer(
  name: string,
  sport: SportKey,
  espnAthleteId?: string,
): Promise<ResolvedPlayerInfo | null> {
  if (!isServerAvailable('web')) return null;
  try {
    const res = await callTool('web', 'web_resolve_player', {
      name,
      sport,
      // The server tries the id first and falls back to the name, so passing it
      // can only ever resolve more. It is also the only way to separate two
      // athletes who share a name, which a name-only lookup reports as
      // 'ambiguous' and the caller then treats as unresolved.
      ...(espnAthleteId && { espn_athlete_id: espnAthleteId }),
    });
    const parsed = unwrapMCP<ResolveResponse>(res);
    return parsed?.resolved ? parsed.player : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[FactValidator] resolve_player failed for ${name}: ${message}`);
    return null;
  }
}

/**
 * Resolve an athlete, minting a player row from the source's own ESPN tag when
 * the roster has never heard of them.
 *
 * Only for sports whose roster is inherently incomplete — today UFC, whose card
 * window covers ±(180/90) days and therefore misses a fighter who has been
 * inactive for two years and just tore an ACL. Measured 2026-08-16: 68 of the
 * 87 fighters tagged in the live news feed were inside the window, so roughly
 * one in five injured fighters arrives this way.
 *
 * Requires the ESPN id, never a bare name. ESPN tagging an athlete on an
 * article is a positive identification from the source; a name that failed to
 * resolve is not evidence of anything, and minting from one would manufacture a
 * player out of a misspelling. Registration is also strictly additive — it
 * never clears a team, retires anyone, or touches an existing row's identity.
 */
async function resolveOrRegisterPlayer(
  event: RawInjuryEvent,
  sport: SportKey,
): Promise<ResolvedPlayerInfo | null> {
  const resolved = await resolvePlayer(event.athlete_name, sport, event.espn_athlete_id);
  if (resolved) return resolved;
  if (!event.espn_athlete_id || !registersAthletesOnSight(sport)) return resolved;
  if (!isServerAvailable('web')) return resolved;

  try {
    await callToolWithRetry('web', 'web_upsert_player', {
      sport,
      espn_athlete_id: event.espn_athlete_id,
      full_name: event.athlete_name,
      prominence_source: 'espn',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Poller] ${sport} — register-on-sight failed for ${event.athlete_name} ` +
        `(espn=${event.espn_athlete_id}): ${message}`,
    );
    return resolved;
  }

  const after = await resolvePlayer(event.athlete_name, sport, event.espn_athlete_id);
  if (after) {
    console.log(
      `[Poller] ${sport} — registered on sight: ${event.athlete_name} ` +
        `(espn=${event.espn_athlete_id}, player=${after.player_id})`,
    );
  }
  return after;
}

/**
 * Whether this event reports something NEW about an injury already tracked.
 *
 * Two signals, in order of authority:
 *   1. The SOURCE, when it has a status field to speak with. ESPN's structured
 *      injuries table sets is_update either way, and its answer is final.
 *   2. The CLASSIFIER, when the source left is_update undefined because it has
 *      no status field at all — every news source. Haiku already judges
 *      `is_new` ("False if it is an update to an existing/previously reported
 *      injury") before dedup runs, and that judgement is the news-source
 *      analogue of a status change.
 *
 * Without (2) a sport sourced purely from news is silenced for the whole 21-day
 * entity window after its first post: with an entity matched and no signal able
 * to open the escape, "McGregor to undergo surgery" five days after the ACL
 * report never publishes. That is the opposite failure from the daily
 * republishing the same-article guard fixed, and equally wrong.
 *
 * Applied to every source class rather than to UFC alone, because the condition
 * is about the SOURCE, not the sport — keying it on the sport would rebuild the
 * carve-out this change removes. It can only ever ADD pass-throughs, and each
 * one still faces the TRACKING tier gate, the bar of 70, the content-type drift
 * re-check and the 5-day cadence throttle.
 */
export function resolveUpdateSignal(
  event: RawInjuryEvent,
  classifiedIsNew: boolean | undefined,
): { isUpdate: boolean; updateSignal: 'source' | 'classifier' | 'none' } {
  if (event.is_update !== undefined) {
    return { isUpdate: event.is_update, updateSignal: 'source' };
  }
  if (classifiedIsNew === false) {
    return { isUpdate: true, updateSignal: 'classifier' };
  }
  return { isUpdate: false, updateSignal: 'none' };
}

// Frozen OTM projection captured at thread open. Mirrors the MCP web server's
// OtmProjection shape (persisted as JSONB on injury_entities.otm_projection).
interface OtmProjection {
  min_weeks: number;
  max_weeks: number;
  probability_week_2?: number;
  probability_week_4?: number;
  probability_week_8?: number;
  projected_return_date?: string | null;
  created_at?: string;
}

// X-sourced events are held for MD review regardless of confidence score.
// This is orthogonal to (not a substitute for) the classifier's confidence-
// vagueness gate: a spoofed but well-written tweet from an impersonator
// account can score high on information_specificity and still be fake.
// Gate on source identity, not text quality. Tunable off via
// X_INSIDER_FORCE_MD_REVIEW=false once impersonation-defense confidence grows.
export function shouldForceMDReviewForXSource(sourceName: string | undefined): string | undefined {
  if (!sourceName?.startsWith('X:')) return undefined;
  if (process.env.X_INSIDER_FORCE_MD_REVIEW === 'false') return undefined;
  return `x_insider_unverified_source:${sourceName}`;
}

/**
 * Split fact-validator soft failures into the ones that force MD review and the
 * ones the operator has downgraded to an annotation.
 *
 * Every soft code forces review by default; MD_REVIEW_ANNOTATE_ONLY_CODES is an
 * explicit, per-code opt-out set in Railway (comma-separated, e.g.
 * `source_tier_low`). It exists because a soft failure becomes
 * forceMDReviewReason, which short-circuits needsMDReview entirely — so with no
 * lever, a single noisy code silently gates every post regardless of confidence
 * or severity, and only a deploy can change that.
 *
 * Downgraded codes are not discarded: they are logged and written to the
 * validation audit row, so a published post still carries the record of what
 * was known to be unverified about it.
 */
export function parseAnnotateOnlyCodes(
  env: string | undefined = process.env.MD_REVIEW_ANNOTATE_ONLY_CODES,
): Set<string> {
  return new Set(
    (env ?? '')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function partitionSoftFailures(
  failures: ValidationFailure[],
  env: string | undefined = process.env.MD_REVIEW_ANNOTATE_ONLY_CODES,
): { forcing: ValidationFailure[]; annotateOnly: ValidationFailure[] } {
  const allowed = parseAnnotateOnlyCodes(env);
  if (allowed.size === 0) return { forcing: failures, annotateOnly: [] };
  return {
    forcing: failures.filter((f) => !allowed.has(f.code.toLowerCase())),
    annotateOnly: failures.filter((f) => allowed.has(f.code.toLowerCase())),
  };
}

/** The code recorded on forceMDReviewReason, in the audit row, and in the log. */
export const DATE_REVIEW_CODE = 'injury_date_unresolved';

/**
 * Force MD review when the source shows a CARRYOVER injury AND the date
 * resolver could not pin the original date down.
 *
 * Deliberately narrow: an unresolved date on a genuinely new injury is normal
 * traffic and publishes exactly as before. It is the COMBINATION that produces
 * a wrong anchor, and a wrong anchor silently shifts every week of the RTP
 * projection — Mykel Williams' nine-month-old ACL, dated to the day ESPN
 * re-stamped his row, projected a 2027-05-15 return.
 *
 * `possible` is included alongside `unknown` because `possible` means "only a
 * vague window" — precisely the confidence a carryover with "last season" and
 * no resolvable date produces, and the one that would otherwise publish a
 * plausible-looking guess.
 *
 * Downgradeable without a deploy via MD_REVIEW_ANNOTATE_ONLY_CODES, the same
 * lever the fact-validator soft codes use.
 */
export function shouldForceDateReview(
  carryover: CarryoverSignals,
  event: RawInjuryEvent,
  confidence: DateConfidence,
  env: string | undefined = process.env.MD_REVIEW_ANNOTATE_ONLY_CODES,
): { fires: boolean; force: boolean; annotate: boolean } {
  const fires =
    isGatingCarryover(carryover, event) &&
    (confidence === 'unknown' || confidence === 'possible');
  if (!fires) return { fires: false, force: false, annotate: false };
  const annotateOnly = parseAnnotateOnlyCodes(env).has(DATE_REVIEW_CODE);
  return { fires: true, force: !annotateOnly, annotate: annotateOnly };
}

/** The code recorded when the team timeline's own clock is in doubt. */
export const TIMELINE_ANCHOR_CODE = 'team_timeline_anchor_ambiguous';

/**
 * Force MD review when `team_timeline_weeks` is as plausible a TOTAL as it is a
 * REMAINING count, and the two readings disagree about whether this is a
 * conflict.
 *
 * The field is specified as remaining-from-report, but the model has emitted it
 * as at least three different quantities — a real remaining figure (Bosa: 1),
 * a total post-surgery count it computed itself (Kittle: 33 at 33 weeks
 * elapsed; Parsons: "Week 5 is ~39 weeks post-op" → 39), and a season length.
 * Fixing the arithmetic on top of a field holding three quantities would turn
 * an obviously wrong number into a confidently wrong one, so where the reading
 * changes the verdict a human decides.
 *
 * Inert on fresh injuries, which is the population the old code got right:
 * assessTimelineAnchorAmbiguity requires two weeks elapsed before it can fire.
 * Downgradeable without a deploy via MD_REVIEW_ANNOTATE_ONLY_CODES.
 */
export function shouldForceTimelineAnchorReview(
  post: InjuryPostContent,
  dateAnchor: string | null,
  env: string | undefined = process.env.MD_REVIEW_ANNOTATE_ONLY_CODES,
): { fires: boolean; force: boolean; annotate: boolean; detail?: string } {
  const weeks = post.team_timeline_weeks;
  if (typeof weeks !== 'number' || !Number.isFinite(weeks)) {
    return { fires: false, force: false, annotate: false };
  }
  const { ambiguous, remaining, total } = assessTimelineAnchorAmbiguity(
    weeks,
    post.return_to_play,
    { injury_date: dateAnchor },
  );
  if (!ambiguous) return { fires: false, force: false, annotate: false };
  const annotateOnly = parseAnnotateOnlyCodes(env).has(TIMELINE_ANCHOR_CODE);
  return {
    fires: true,
    force: !annotateOnly,
    annotate: annotateOnly,
    detail:
      `team_timeline_weeks=${weeks} reads as remaining (total ${remaining.team_total_weeks}w, ` +
      `${remaining.status}) or as already-total (${total.status}) at ` +
      `${remaining.elapsed_weeks}w elapsed`,
  };
}

export function addWeeksIso(baseIso: string, weeks: number): string | null {
  // baseIso may arrive as 'YYYY-MM-DD' OR a full ISO timestamp — the DB DATE
  // column comes back through MCP JSON as 'YYYY-MM-DDT00:00:00.000Z'. new Date
  // parses both; slicing the result normalizes back to a plain date.
  const t = new Date(baseIso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

// Build the projection to freeze on the thread once OTM has produced the post.
function buildOtmProjection(post: InjuryPostContent, injuryDate: string | null): OtmProjection {
  const rtp = post.return_to_play;
  const mid = (rtp.min_weeks + rtp.max_weeks) / 2;
  return {
    min_weeks: rtp.min_weeks,
    max_weeks: rtp.max_weeks,
    probability_week_2: rtp.probability_week_2,
    probability_week_4: rtp.probability_week_4,
    probability_week_8: rtp.probability_week_8,
    projected_return_date: injuryDate ? addWeeksIso(injuryDate, mid) : null,
    created_at: new Date().toISOString(),
  };
}

// Exported for tests (like shouldForceMDReviewForXSource / checkContentTypeDrift).
export async function maintainEntity(
  event: RawInjuryEvent,
  player: ResolvedPlayerInfo,
  metadata: import('../agents/injury-intelligence/fact-validator.js').ExtractedInjuryMetadata,
  dedup: DedupResult,
  postId: string,
  teamTimelineWeeks: number | undefined,
  otmMinWeeks: number | undefined,
  severity: string,
  // When the Injury Thread Manager already created/matched the entity pre-OTM,
  // reuse its id (avoids a duplicate entity) and freeze the OTM projection.
  opts?: { entityId?: string; otmProjection?: OtmProjection },
): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    let entityId = opts?.entityId ?? dedup.entityId;
    // A reused entity (created pre-publish by the Injury Thread Manager, or
    // matched by dedup) has no canonical_post_id — it was created before any
    // post existed. Backfill it with the first post that lands, otherwise the
    // column stays NULL forever and every follow-up loses its parent_post_id,
    // which silently exempts the thread from the cadence throttle.
    const reusedEntity = Boolean(entityId);
    if (!entityId) {
      const createRes = await callTool('web', 'web_create_injury_entity', {
        player_id: player.player_id,
        body_part: metadata.primary_body_part ?? undefined,
        laterality: metadata.laterality,
        injury_type: metadata.injury_type_hint ?? undefined,
        canonical_post_id: postId,
      });
      const parsed = unwrapMCP<{ entity: { id: string } }>(createRes);
      entityId = parsed?.entity?.id;
    }
    if (!entityId) return;
    const updateKind =
      dedup.decision === 'entity_match_pass_through' ? 'TRACKING' : 'INITIAL';
    await callTool('web', 'web_append_injury_update', {
      entity_id: entityId,
      post_id: postId,
      update_kind: updateKind,
      severity_at_time: severity,
      team_timeline_weeks: teamTimelineWeeks,
      otm_min_weeks: otmMinWeeks,
      source_url: event.source_url,
      description: event.injury_description.slice(0, 500),
    });
    // Freeze the OTM projection and backfill the canonical post in one call
    // (dates are left untouched via COALESCE). canonical_post_id is fill-if-null
    // server-side, so re-sending it on a later post is a no-op — the thread
    // keeps pointing at its originating post, not its most recent one.
    const threadPatch: Record<string, unknown> = {};
    if (reusedEntity) threadPatch.canonical_post_id = postId;
    if (opts?.otmProjection) threadPatch.otm_projection = opts.otmProjection;
    if (Object.keys(threadPatch).length > 0) {
      await callTool('web', 'web_thread_update_dates', {
        entity_id: entityId,
        ...threadPatch,
      });
    }
    try {
      await maybeProposeReturnWatch(entityId, updateKind, {
        athleteName: event.athlete_name,
        sport: event.sport,
        sourceUrl: event.source_url,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[EntityMaint] Return Watch check failed for entity=${entityId}: ${message}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[EntityMaint] failed for post=${postId}: ${message}`);
  }
}

// ── Injury Thread Manager: pre-OTM date resolution + thread assembly ────
// Runs behind DATE_RESOLUTION_ENABLED, after fact-validation + dedup, before
// OTM. Resolves the injury/surgery date (with a web-search fallback), persists
// it to the thread, and assembles the InjuryThreadContext OTM consumes. Returns
// null (→ OTM runs thread-less, i.e. today's behavior) on any failure.
interface ThreadEntityRow {
  injury_date: string | null;
  injury_date_confidence: 'unknown' | 'possible' | 'probable' | 'confirmed';
  surgery_date: string | null;
  surgery_confirmed: boolean;
  status: 'ACTIVE' | 'RESOLVED' | 'RETIRED';
  body_part: string | null;
  laterality: 'LEFT' | 'RIGHT' | 'BILATERAL' | 'UNSPECIFIED' | null;
}
interface ThreadUpdateRow {
  team_timeline_weeks: number | null;
  otm_min_weeks: number | null;
  severity_at_time: string | null;
  created_at: string;
}

async function resolveThreadAndDates(
  event: RawInjuryEvent,
  validation: ValidationResult,
  dedup: DedupResult,
): Promise<{
  entityId: string;
  thread: InjuryThreadContext;
  carryover: CarryoverSignals;
  /**
   * THIS cycle's resolution confidence, not the thread's. The thread read-back
   * lets a persisted entity value win (see below), so a stale 'confirmed' from
   * an earlier cycle would otherwise mask a resolution that just failed.
   */
  resolvedConfidence: DateConfidence;
} | null> {
  const player = validation.resolvedPlayer;
  if (!player) return null;
  const metadata = validation.metadata;
  const carryover = detectCarryoverSignals(event);
  try {
    // 1. Resolve-or-create the entity early. No canonical_post_id yet — no post
    //    exists at this point; maintainEntity() backfills it post-publish.
    let entityId = dedup.entityId;
    if (!entityId) {
      const createRes = await callTool('web', 'web_create_injury_entity', {
        player_id: player.player_id,
        body_part: metadata.primary_body_part ?? undefined,
        laterality: metadata.laterality,
        injury_type: metadata.injury_type_hint ?? undefined,
      });
      entityId = unwrapMCP<{ entity: { id: string } }>(createRes)?.entity?.id;
    }
    if (!entityId) return null;

    // 2. Resolve the injury/surgery date (Pass 1 source-only, Pass 2 web search).
    const resolution = await resolveInjuryDate({
      event,
      player,
      metadata,
      reportedAt: event.reported_at,
      today: new Date().toISOString().slice(0, 10),
    });

    // 3. Persist dates + provenance; flag for MD review when still unknown.
    await callTool('web', 'web_thread_update_dates', {
      entity_id: entityId,
      injury_date: resolution.injury_date ?? undefined,
      injury_date_confidence: resolution.injury_date_confidence,
      surgery_date: resolution.surgery_date ?? undefined,
      surgery_confirmed: resolution.surgery_confirmed,
      date_resolution_sources: resolution.sources,
      // A carryover whose original date resolved only to a vague window is
      // just as unusable as no date at all — put it on the MD worklist too.
      needs_date_review:
        resolution.injury_date_confidence === 'unknown' ||
        (carryover.strength !== 'none' &&
          resolution.injury_date_confidence === 'possible'),
    });

    const webSources = resolution.sources.filter((s) => s.stage === 'web_search').length;
    console.log(
      `[ThreadManager] ${event.athlete_name} (${event.sport}) — entity=${entityId} ` +
        `injury_date=${resolution.injury_date ?? 'none'} confidence=${resolution.injury_date_confidence} ` +
        `surgery=${resolution.surgery_confirmed ? (resolution.surgery_date ?? 'confirmed') : 'no'} ` +
        `web_search=${resolution.used_web_search} web_sources=${webSources} ` +
        `carryover=${carryover.strength}${carryover.codes.length ? `[${carryover.codes.join('|')}]` : ''}`,
    );

    // 4. Read the thread back (entity with dates + trajectory) and assemble context.
    const getRes = await callTool('web', 'web_thread_get', { entity_id: entityId });
    const thread = unwrapMCP<{ entity: ThreadEntityRow; updates: ThreadUpdateRow[] }>(getRes);

    const priorFromDb = (thread?.updates ?? [])
      .map((u) => ({
        reported_weeks: u.team_timeline_weeks ?? null,
        otm_min_weeks: u.otm_min_weeks ?? null,
        severity: u.severity_at_time ?? null,
        at: u.created_at,
      }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); // list is newest-first

    // Append the current event's reported timeline in-memory (the persisted row
    // is written post-publish by maintainEntity) so compression detection sees it.
    const currentReported = event.team_timeline
      ? parseTeamTimeline(event.team_timeline)
      : null;
    const priorTimelines = [
      ...priorFromDb,
      {
        reported_weeks: currentReported,
        otm_min_weeks: null,
        severity: null,
        at: event.reported_at.toISOString(),
      },
    ];

    const entity = thread?.entity;
    return {
      entityId,
      thread: {
        injury_date: entity?.injury_date ?? resolution.injury_date,
        injury_date_confidence: entity?.injury_date_confidence ?? resolution.injury_date_confidence,
        surgery_date: entity?.surgery_date ?? resolution.surgery_date,
        surgery_confirmed: entity?.surgery_confirmed ?? resolution.surgery_confirmed,
        status: entity?.status ?? 'ACTIVE',
        // Prefer the entity's stored (established) values over this event's
        // freshly-extracted ones — the thread's history is the ground truth.
        body_part: entity?.body_part ?? metadata.primary_body_part ?? null,
        laterality: entity?.laterality ?? metadata.laterality ?? null,
        prior_timelines: priorTimelines,
      },
      carryover,
      resolvedConfidence: resolution.injury_date_confidence,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ThreadManager] date resolution failed for ${event.athlete_name}: ${message}`);
    return null;
  }
}

/**
 * Record a carryover-date detection on the thread's audit trail, whether it
 * gated or was downgraded to an annotation. Mirrors auditValidation: a
 * downgraded signal is not discarded, so a published post still carries the
 * record of what was known to be unverified about its date anchor.
 */
async function auditCarryover(
  event: RawInjuryEvent,
  entityId: string,
  resolved: { carryover: CarryoverSignals; resolvedConfidence: DateConfidence },
  gate: { force: boolean; annotate: boolean },
): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    await callTool('web', 'web_audit_append', {
      actor: 'system',
      actor_id: 'date-resolver',
      entity_type: 'injury_thread',
      entity_id: entityId,
      action: 'date_carryover_detected',
      payload: {
        athlete: event.athlete_name,
        sport: event.sport,
        strength: resolved.carryover.strength,
        codes: resolved.carryover.codes,
        evidence: resolved.carryover.evidence,
        injury_date_confidence: resolved.resolvedConfidence,
        roster_designation: event.roster_designation ?? null,
        gated: gate.force,
        annotate_only: gate.annotate,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ThreadManager] carryover audit failed for ${event.athlete_name}: ${message}`);
  }
}

async function auditValidation(
  event: RawInjuryEvent,
  result: ValidationResult,
  action: 'fact_validate_drop' | 'fact_validate_soft_fail' | 'fact_validate_pass',
  // A re-anchor rewrites the event's identity upstream of this call, so without
  // it the audit row would record the corrected athlete with no trace of the
  // one the source actually tagged. Carried here rather than written at the
  // re-anchor site because that site is above the publish budget cap, where
  // side effects would repeat every cycle for a capped event.
  extra?: { athlete_reanchor?: Record<string, string>; annotate_only?: string },
): Promise<void> {
  if (!isServerAvailable('web')) return;
  try {
    await callTool('web', 'web_audit_append', {
      actor: 'system',
      actor_id: 'fact-validator',
      entity_type: 'injury_event',
      action,
      payload: {
        athlete_name: event.athlete_name,
        sport: event.sport,
        team_reported: event.team,
        source_url: event.source_url,
        hard_failures: result.hardFailures,
        soft_failures: result.softFailures,
        corrections: result.corrections,
        resolved_player_id: result.resolvedPlayer?.player_id ?? null,
        ...(extra?.athlete_reanchor && { athlete_reanchor: extra.athlete_reanchor }),
        ...(extra?.annotate_only && { annotate_only: extra.annotate_only }),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[FactValidator] audit append failed: ${message}`);
  }
}

function logGateDecision(sport: SportKey, athleteName: string, sig: SignificanceAssessment): void {
  const { triage_decision, composite_score, raw_score, season_window, season_threshold_delta, process_threshold, defer_threshold, tier_blocked, athlete_tier, athlete_tier_source, subscores } = sig;
  console.log(
    `[SignificanceGate] decision=${triage_decision} score=${composite_score} raw=${raw_score} bar=${tier_blocked ? 'tier_blocked' : process_threshold ?? 'always'} defer_bar=${tier_blocked ? 'n/a' : defer_threshold ?? 'n/a'} season=${season_window}${season_threshold_delta !== 0 ? `(${season_threshold_delta > 0 ? '+' : ''}${season_threshold_delta})` : ''} athlete="${athleteName}" tier=${athlete_tier}${tierMarker(athlete_tier_source)} sport=${sport} ct_prior=${subscores.content_type_prior} prom=${subscores.athlete_prominence} spec=${subscores.information_specificity} rec=${subscores.event_recency_novelty}`
  );
}

export async function pollSport(sport: SportKey): Promise<PollSummary> {
  const summary: PollSummary = {
    fetched: 0,
    classified_positive: 0,
    pre_filtered: 0,
    dropped_significance: 0,
    date_carryover_review: 0,
    timeline_anchor_review: 0,
    timeline_anchor_annotated: 0,
    date_carryover_annotated: 0,
    dropped_concussion: 0,
    athlete_name_drift: 0,
    athlete_reanchored: 0,
    athlete_drift_spelling: 0,
    athlete_surname_ref: 0,
    content_type_drift: 0,
    dropped_fact_validation: 0,
    soft_failed_fact_validation: 0,
    deferred: 0,
    promoted_from_defer: 0,
    would_promote_from_defer: 0,
    expired_from_defer: 0,
    defer_queue_size: 0,
    duplicates: 0,
    published: 0,
    pending_review: 0,
    review_suppressed: 0,
    rejection_suppressed: 0,
    superseded: 0,
    skipped: 0,
    capped: 0,
    source_errors: 0,
    classifier_errors: 0,
    errors: 0,
  };

  const gateEnabled = process.env.SIGNIFICANCE_GATE_ENABLED !== 'false';
  // Pre-OTM date resolution is opt-in (default off) until validated in prod.
  const dateResolutionEnabled = process.env.DATE_RESOLUTION_ENABLED === 'true';

  // Refresh significance data (athlete tiers + config) at the start of every cycle
  await loadSignificanceData();
  // Separate call, and separate TTL: the tier/config files are local reads that
  // are cheap every cycle, while the salary snapshot is ~18 MCP calls over data
  // that only changes when roster-sync runs. No-ops inside its window.
  await refreshTierSnapshotsIfStale();

  if (!gateEnabled) {
    console.warn(
      `[SignificanceGate] ${sport} — gate BYPASSED (SIGNIFICANCE_GATE_ENABLED=false); all classified events will reach Sonnet`
    );
  }

  // Evict TTL-expired defer queue entries for this sport
  try {
    const { evicted, size, available } = await evictExpired(sport);
    summary.expired_from_defer = evicted;
    // -1 rather than 0 so "store unreachable" is never mistaken for "queue empty".
    summary.defer_queue_size = available ? size : -1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[SignificanceGate] ${sport} — defer eviction failed: ${message}`);
  }

  const source = SPORT_SOURCES[sport];
  if (!source) {
    console.warn(`[Poller] No source registered for ${sport}`);
    return summary;
  }

  console.log(`[Poller] ${sport} — fetching from ${source.name}`);
  let events: RawInjuryEvent[] = [];
  try {
    const fetchResult = await source.fetchLatestEventsWithReport();
    events = fetchResult.events;
    summary.source_errors = fetchResult.errorCount;
    summary.errors += fetchResult.errorCount;
    console.log(`[Poller] ${sport} — sources: ${formatSourceReports(fetchResult.reports)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Poller] ${sport} — source fetch failed: ${message}`);
    // Without this the whole-source failure is invisible: fetched=0 errors=0
    // reads identically to "upstream had nothing", which is how three weeks of
    // silence went unnoticed.
    summary.errors++;
    summary.source_errors++;
    return summary;
  }

  summary.fetched = events.length;
  console.log(`[Poller] ${sport} — ${events.length} raw events to process`);

  const deferConfig = getDeferConfig();
  warnOnceIfDeferTtlUnreachable(deferConfig.ttl_hours);

  // Volume budget for this cycle. The day count is global (all sports share the
  // rolling 24h window); the cycle counts are per-sport.
  const maxPublishesPerCycle = envInt('MAX_PUBLISHES_PER_CYCLE', DEFAULT_MAX_PUBLISHES_PER_CYCLE);
  const maxPerDay = envInt('MAX_PUBLISHES_PER_DAY', DEFAULT_MAX_PUBLISHES_PER_DAY);
  const limits: PublishBudgetLimits = {
    maxAgentCallsPerCycle: envInt('MAX_AGENT_CALLS_PER_CYCLE', DEFAULT_MAX_AGENT_CALLS_PER_CYCLE),
    maxPublishesPerCycle,
    // The review lane defaults to the same allowance as the publish lane, so
    // splitting the budgets cannot silently change total volume by more than a
    // factor of two on an existing deployment.
    maxReviewsPerCycle: envInt('MAX_REVIEWS_PER_CYCLE', maxPublishesPerCycle),
  };
  const maxReviewsPerDay = envInt('MAX_REVIEWS_PER_DAY', maxPerDay);
  const recent = await countRecentOutput();
  const budget: PublishBudgetState = {
    agentCalls: 0,
    cyclePublishes: 0,
    cycleReviews: 0,
    dayPublishRemaining: recent === null ? Infinity : Math.max(0, maxPerDay - recent.published),
    dayReviewRemaining: recent === null ? Infinity : Math.max(0, maxReviewsPerDay - recent.review),
  };
  // md_review_bar is printed alongside the caps because it is the other lever
  // that decides whether a post reaches social, and it lives in an env var that
  // is otherwise invisible in the logs — it sat at 0.60 rather than the
  // documented 0.75 default for an unknown period without anything saying so.
  console.log(
    `[Poller] ${sport} — budget: cycle_publishes=${limits.maxPublishesPerCycle} cycle_reviews=${limits.maxReviewsPerCycle} agent_calls=${limits.maxAgentCallsPerCycle} day_publish_left=${budget.dayPublishRemaining === Infinity ? 'unknown' : budget.dayPublishRemaining} day_review_left=${budget.dayReviewRemaining === Infinity ? 'unknown' : budget.dayReviewRemaining} md_review_bar=${getMDReviewThreshold()}`,
  );

  // Sequential to avoid races on dedup lookups for the same athlete
  for (const event of events) {
    // Rebuilt if the athlete re-anchor re-points this event at another player —
    // otherwise every log line below would keep naming the mis-tagged athlete.
    let context = `${event.athlete_name} (${sport}/${event.team})`;
    let forceMDReviewReason: string | undefined = shouldForceMDReviewForXSource(event.source_name);
    // Set by a successful re-anchor; folded into the fact-validation audit row
    // rather than written here, because this point is upstream of the publish
    // budget cap and a capped event must stay free of side effects.
    let reanchorAudit: Record<string, string> | undefined;
    try {
      if (isObviousNonInjury(event)) {
        summary.pre_filtered++;
        continue;
      }

      // Resolve athlete tier before classifying — Haiku must not infer prominence
      const tierInfo = lookupAthleteTier(event.athlete_name, event.sport);

      // Concussion on a non-star: OTM cannot produce an RTP for a head injury
      // (SKILL.md treats that as non-negotiable), so the post is league-protocol
      // boilerplate whose interest depends entirely on the athlete. Dropped here
      // rather than at the gate so it costs neither a Haiku nor a Sonnet call.
      //
      // Only when the tier is CONFIRMED from athlete-tiers.json, though. A
      // `default` tier means the source's spelling simply missed the lookup, and
      // hard-dropping on that guess would bury a star's concussion outright —
      // the same distrust of the source's name that routes drift to MD review.
      // Those events are re-checked below with the classifier's spelling too.
      //
      // 'salary' is DELIBERATELY absent from this condition, and the omission is
      // load-bearing rather than an oversight — do not "complete" the union.
      // Salary is promote-only, so a salary-sourced tier is always <= 3, which
      // means adding it here could never RESCUE a concussion (tiers 1-2 already
      // fail isConcussionTierBlocked) and could only ever create NEW pre-model
      // drops: every salary-tier-3 athlete — the majority, since most salaries
      // sit below both bands — would stop reaching the post-classification
      // re-check they get today. That is the one way this feature could take
      // away coverage that currently publishes, so it stays out.
      const concussionBlocked =
        gateEnabled && isConcussionTierBlocked(event.injury_description, tierInfo.tier);
      if (concussionBlocked && tierInfo.source === 'lookup') {
        summary.dropped_concussion++;
        console.log(
          `[SignificanceGate] decision=DROP reason=concussion_tier athlete="${event.athlete_name}" tier=${tierInfo.tier} sport=${sport}`,
        );
        continue;
      }

      const classified = await classifyEvent(event, {
        athleteTier: tierInfo.tier,
        athleteTierSource: tierInfo.source,
      });

      // A classifier failure returns a synthetic is_injury_event:false, so
      // without this check an expired API key or a retired model id would show
      // up as "nothing was newsworthy" — skipped high, errors zero.
      if (classified.classification_error) {
        summary.classifier_errors++;
        summary.errors++;
        continue;
      }

      if (!classified.is_injury_event) {
        summary.skipped++;
        continue;
      }
      summary.classified_positive++;

      // Concussion re-check, for the events the pre-classification pass let
      // through because the source-name tier was only a guess. The classifier
      // normalizes spelling, so its name may resolve where the source's did
      // not; take the more prominent of the two and apply the tier rule to
      // that. A star whose source spelling missed the DB survives; a genuine
      // depth player still drops, one Haiku call later.
      if (concussionBlocked) {
        // classified.athlete_name with event.sport, not classified.sport. The
        // rescue is about the NAME — the classifier normalizes spelling the
        // source got wrong. The sport is incidental cargo, and it is the one
        // field here that a model can get plausibly wrong in a way validation
        // cannot catch. event.sport is the source class's own constant.
        const classifierTier = lookupAthleteTier(classified.athlete_name, event.sport);
        const bestTier = Math.min(tierInfo.tier, classifierTier.tier) as AthleteTier;
        if (isConcussionTierBlocked(event.injury_description, bestTier)) {
          summary.dropped_concussion++;
          console.log(
            `[SignificanceGate] decision=DROP reason=concussion_tier source_athlete="${event.athlete_name}" ` +
              `classifier_athlete="${classified.athlete_name}" tier=${bestTier}? sport=${sport}`,
          );
          continue;
        }
        // Note the residual: significance was already scored with the SOURCE's
        // tier inside classifyEvent, so a rescued event is under-scored and the
        // gate below may still drop it. That is deliberate — raising prominence
        // after the fact would let one athlete's score be rewritten by a second
        // lookup, which is the failure this whole area is recovering from. The
        // names necessarily differ for the rescue to have fired, so the drift
        // check below routes it to MD review anyway.
        console.log(
          `[SignificanceGate] concussion_tier not applied — "${classified.athlete_name}" resolves to ` +
            `tier=${bestTier} via the classifier's spelling (source "${event.athlete_name}" did not resolve)`,
        );
      }

      // The tier — and so athlete_prominence, 35% of the significance score —
      // was resolved from the SOURCE's name before classification. If the
      // classifier came back with a different athlete, the score belongs to
      // someone other than the post's subject, and the post may be about the
      // wrong player entirely.
      //
      // Drift is not always the classifier being wrong, though. An ESPN
      // injuries row for a HEALTHY athlete carries news about a teammate, and
      // a news source's tag is a first-capitalized-bigram guess. When the
      // roster can confirm the classifier named a different, real, unambiguous
      // player that the source text actually mentions, follow it: re-point the
      // event before anything downstream reads an identity off it. Otherwise
      // fall through to the review that has always happened here.
      //
      // First, the case that is not drift at all: sources name the athlete by
      // surname alone as a matter of house style ("Kittle (Achilles) said
      // Sunday…"), and a classifier following the description's wording answers
      // in kind. Restore the source's full name and carry on. NOT gated on the
      // re-anchor mode — no identity changes here, and leaving it would publish
      // a post whose athlete_name, dedup key, player row and entity all read
      // "Kittle".
      if (isSurnameReference(event.athlete_name, classified.athlete_name)) {
        summary.athlete_surname_ref++;
        console.log(
          `[Poller] ${sport} — classifier named "${classified.athlete_name}" for ` +
            `"${event.athlete_name}"; same athlete, short form — using the source's full name`,
        );
        classified.athlete_name = event.athlete_name;
      } else if (!isSameAthleteName(event.athlete_name, classified.athlete_name)) {
        summary.athlete_name_drift++;
        const outcome = await attemptAthleteReanchor(event, classified, {
          resolvePlayer: (name, forSport) => resolvePlayer(name, forSport),
          cycleEvents: events,
        });
        // shadow means shadow: EVERY behaviour change below is gated on 'on',
        // including the two that look obviously safe. A mode whose observable
        // effects depend on which branch fired teaches the operator nothing
        // about what flipping it to 'on' will do.
        const applying = getReanchorMode() === 'on' && outcome.kind !== 'review';

        if (!applying) {
          if (outcome.kind !== 'review') {
            console.warn(
              `[Reanchor] ${sport} — shadow: would ${outcome.kind} ` +
                `"${event.athlete_name}" → "${outcome.to}" — routing to MD review anyway`,
            );
          }
          console.warn(
            `[Poller] ${sport} — athlete name drift: source="${event.athlete_name}" classifier="${classified.athlete_name}" (tier resolved from source) — routing to MD review` +
              ` [reanchor:${outcome.kind === 'review' ? outcome.reason : 'shadow'}]`,
          );
          forceMDReviewReason = forceMDReviewReason
            ? `${forceMDReviewReason},athlete_name_drift`
            : 'athlete_name_drift';
        } else if (outcome.kind === 'skip') {
          console.log(
            `[Reanchor] ${sport} — "${event.athlete_name}" row is second-hand news about ` +
              `"${outcome.to}", who has their own event this cycle — skipping`,
          );
          summary.skipped++;
          continue;
        } else if (outcome.kind === 'spelling_variant') {
          // Same player row, two spellings. Nothing to review; adopt the
          // roster's spelling so the post and the thread agree.
          summary.athlete_drift_spelling++;
          console.log(
            `[Reanchor] ${sport} — "${event.athlete_name}" and "${classified.athlete_name}" are ` +
              `the same player (${outcome.player.player_id}); using "${outcome.player.full_name}"`,
          );
          event.athlete_name = outcome.player.full_name;
          classified.athlete_name = outcome.player.full_name;
          context = `${event.athlete_name} (${sport}/${event.team})`;
        } else {
          applyAthleteReanchor(event, classified, outcome);
          summary.athlete_reanchored++;
          reanchorAudit = {
            from: outcome.from,
            to: outcome.to,
            player_id: outcome.player.player_id,
            method: outcome.candidateFrom,
          };
          context = `${event.athlete_name} (${sport}/${event.team})`;
          console.log(
            `[Reanchor] ${sport} — re-anchored "${outcome.from}" → "${outcome.to}" ` +
              `(player=${outcome.player.player_id} via=${outcome.candidateFrom} ` +
              `tier=${outcome.tier.tier}/${outcome.tier.source}) — no MD review`,
          );
        }
      }

      // ── Significance gate ────────────────────────────────────────────────
      // `let`, not `const`: a promotion out of the defer queue replaces this
      // with the discounted assessment, and the drift re-check below reads it.
      let sig = classified.significance!;
      logGateDecision(sport, classified.athlete_name, sig);

      if (gateEnabled) {
        if (sig.triage_decision === 'DROP') {
          summary.dropped_significance++;
          continue;
        }

        if (sig.triage_decision === 'DEFER') {
          let deferResult: DeferOutcome = { result: 'deferred' };
          try {
            deferResult = await handleDeferDecision(sport, event, classified, deferConfig);
          } catch (deferErr) {
            const message = deferErr instanceof Error ? deferErr.message : String(deferErr);
            console.warn(`[SignificanceGate] ${sport} — defer queue op failed for ${context}: ${message}`);
            // On failure, treat as deferred (conservative — event skips this cycle)
          }

          if (deferResult.result === 'promoted') {
            summary.promoted_from_defer++;
            // Everything downstream reads the significance off `classified`, so
            // the promotion's discounted assessment has to replace the DEFER one
            // here — and `sig` is re-bound with it, since the drift check below
            // captured the old object.
            sig = applyDeferOutcome(classified, deferResult);
            logGateDecision(sport, classified.athlete_name, sig);
            // Fall through to dedup + agent processing below
          } else {
            if (deferResult.would_promote) summary.would_promote_from_defer++;
            summary.deferred++;
            continue;
          }
        }
        // triage_decision === 'PROCESS' or promoted from defer → fall through
      }
      // ── End significance gate ────────────────────────────────────────────

      // Budget check goes here — after every step that is both free and free of
      // side effects, and before the first one that is neither. It used to sit
      // below dedup, which made "a capped event costs nothing" untrue: entity
      // dedup appends an injury_updates row on every match, and ESPN re-serves
      // the same event every cycle for MAX_EVENT_AGE_DAYS, so a capped event
      // added a duplicate timeline row every 15 minutes until the budget freed
      // — rows that then feed compression detection and entity staleness. Fact
      // validation likewise writes an audit row per pass. Capped here, the
      // event really does cost nothing and is picked up next cycle.
      const capReason = publishBudgetExhausted(budget, limits);
      if (capReason) {
        summary.capped++;
        console.log(`[Poller] ${sport} — ${capReason}, deferring ${context} to next cycle`);
        continue;
      }

      // ── Fact validation ──────────────────────────────────────────────
      // Runs BEFORE Sonnet so hard failures don't burn agent tokens.
      // Hard fail → drop the event. Soft fail → route post to MD review.
      const resolved = await resolveOrRegisterPlayer(event, sport);
      const validation = await validateEvent(event, resolved, {
        contentTypeHint: classified.content_type,
      });

      const audited = reanchorAudit ? { athlete_reanchor: reanchorAudit } : undefined;

      if (!validation.passed) {
        const codes = summarizeFailures(validation.hardFailures);
        console.warn(
          `[FactValidator] ${sport} DROP — ${context} — codes=${codes}`,
        );
        summary.dropped_fact_validation++;
        await auditValidation(event, validation, 'fact_validate_drop', audited);
        continue;
      }
      if (validation.softFailures.length > 0) {
        // MD_REVIEW_ANNOTATE_ONLY_CODES lets the operator downgrade named soft
        // codes to an annotation without a deploy. Empty by default — every
        // code forces review exactly as before.
        const { forcing, annotateOnly } = partitionSoftFailures(validation.softFailures);
        summary.soft_failed_fact_validation++;

        if (forcing.length > 0) {
          const codes = summarizeFailures(forcing);
          const reason = `fact_soft_fail:${codes}`;
          forceMDReviewReason = forceMDReviewReason ? `${forceMDReviewReason},${reason}` : reason;
          console.log(
            `[FactValidator] ${sport} SOFT — ${context} — codes=${codes} (routing to MD review)`,
          );
        }
        if (annotateOnly.length > 0) {
          console.log(
            `[FactValidator] ${sport} SOFT (annotate-only) — ${context} — ` +
              `codes=${summarizeFailures(annotateOnly)} (publishing; recorded in the audit trail)`,
          );
        }
        await auditValidation(event, validation, 'fact_validate_soft_fail', {
          ...audited,
          ...(annotateOnly.length > 0 && {
            annotate_only: summarizeFailures(annotateOnly),
          }),
        });
      } else {
        await auditValidation(event, validation, 'fact_validate_pass', audited);
      }

      // Apply any roster-derived team correction before Sonnet runs. validateEvent
      // records the authoritative roster team in corrections[] when the source named
      // no team (or a blank/"Unknown" one); carrying that forward stops the agent
      // from inventing a team downstream. Hard team_mismatch events already dropped above.
      const teamCorrection = validation.corrections.find((c) => c.field === 'team');
      if (teamCorrection && teamCorrection.to) {
        console.log(
          `[FactValidator] ${sport} — applying team correction for ${context}: "${teamCorrection.from}" → "${teamCorrection.to}"`,
        );
        classified.team = teamCorrection.to;
      }
      // ── End fact validation ─────────────────────────────────────────

      const { isUpdate, updateSignal } = resolveUpdateSignal(event, classified.is_new);
      const dedup = await checkForExisting(event, {
        resolvedPlayer: validation.resolvedPlayer,
        metadata: validation.metadata,
        isUpdate,
        updateSignal,
      });
      if (dedup.isDuplicate) {
        summary.duplicates++;
        console.log(
          `[Poller] ${sport} — duplicate skipped: ${context} (decision=${dedup.decision} update_signal=${updateSignal})`,
        );
        continue;
      }
      if (dedup.decision === 'entity_match_pass_through') {
        console.log(
          `[Poller] ${sport} — follow-up on entity ${dedup.entityId}: ${context} (update_signal=${updateSignal})`,
        );
      }

      // Laterality drift check: the entity match (if any) carries the thread's
      // established side. If this event's freshly-extracted side contradicts it,
      // don't let the contradiction silently overwrite the thread — route to review.
      if (
        dedup.matchedLaterality &&
        dedup.matchedLaterality !== 'UNSPECIFIED' &&
        validation.metadata.laterality !== 'UNSPECIFIED' &&
        dedup.matchedLaterality !== validation.metadata.laterality
      ) {
        console.warn(
          `[FactValidator] ${sport} — laterality mismatch for ${context}: thread established "${dedup.matchedLaterality}", new report says "${validation.metadata.laterality}" — routing to MD review`,
        );
        if (!forceMDReviewReason) {
          forceMDReviewReason = 'fact_soft_fail:laterality_thread_mismatch';
        } else if (!forceMDReviewReason.includes('laterality_thread_mismatch')) {
          forceMDReviewReason = `${forceMDReviewReason},laterality_thread_mismatch`;
        }
      }

      // ── Injury Thread Manager: resolve dates + assemble thread (pre-OTM) ──
      // Behind DATE_RESOLUTION_ENABLED (default off). When disabled or on any
      // failure, `thread` stays undefined → OTM runs exactly as before.
      let thread: InjuryThreadContext | undefined;
      let threadEntityId: string | undefined;
      if (dateResolutionEnabled && isServerAvailable('web') && validation.resolvedPlayer) {
        const resolved = await resolveThreadAndDates(event, validation, dedup);
        if (resolved) {
          thread = resolved.thread;
          threadEntityId = resolved.entityId;

          // A carryover injury dated to the day it was re-reported produces a
          // confident, precise, WRONG clinical timeline. Gate on the pair —
          // carryover evidence AND an unresolved date — not on either alone.
          const dateGate = shouldForceDateReview(
            resolved.carryover,
            event,
            resolved.resolvedConfidence,
          );
          if (dateGate.force) {
            summary.date_carryover_review++;
            console.warn(
              `[ThreadManager] ${sport} — carryover injury with unresolved date for ${context}: ` +
                `strength=${resolved.carryover.strength} codes=${resolved.carryover.codes.join('|')} ` +
                `confidence=${resolved.resolvedConfidence} — routing to MD review`,
            );
            if (!forceMDReviewReason) forceMDReviewReason = DATE_REVIEW_CODE;
            else if (!forceMDReviewReason.includes(DATE_REVIEW_CODE))
              forceMDReviewReason = `${forceMDReviewReason},${DATE_REVIEW_CODE}`;
          } else if (dateGate.annotate) {
            summary.date_carryover_annotated++;
            console.log(
              `[ThreadManager] ${sport} — carryover date unresolved (annotate-only) — ${context} — ` +
                `codes=${resolved.carryover.codes.join('|')} confidence=${resolved.resolvedConfidence} ` +
                `(publishing; recorded in the audit trail)`,
            );
          }
          if (dateGate.fires) {
            await auditCarryover(event, resolved.entityId, resolved, dateGate);
          }
        }
      }

      budget.agentCalls++;
      const post = await processInjuryEvent(classified, dedup.existingPostId, thread);
      if (!post) {
        summary.errors++;
        continue;
      }

      // OTM emits its own injury_date (agent.ts) and the resolver produced one
      // too; nothing used to reconcile them. The projection was frozen from the
      // resolver's date while the post was formatted from OTM's, so the elapsed
      // time a reader sees and projected_return_date could be measured from
      // different anchors. Prefer the resolver when it is confident — it saw the
      // source narrative and, on Pass 2, the open web; OTM saw only the short
      // description. One anchor, chosen before either is used — and chosen by
      // chooseDateAnchor, the same function the agent uses for conflict
      // detection, so the gap and the post can never disagree about elapsed
      // time.
      const dateAnchor = chooseDateAnchor(thread, post.injury_date);
      if (post.injury_date && dateAnchor && post.injury_date !== dateAnchor) {
        console.warn(
          `[Poller] ${sport} — date anchor divergence for ${context}: OTM said ` +
            `${post.injury_date}, resolver said ${dateAnchor} ` +
            `(confidence ${thread?.injury_date_confidence}) — using the resolver's`,
        );
      }
      post.injury_date = dateAnchor ?? undefined;

      // The team timeline's own clock is in doubt on this post — decide before
      // the drift check, so a post that ends up dropped never reaches here.
      const timelineGate = shouldForceTimelineAnchorReview(post, dateAnchor);
      if (timelineGate.force) {
        summary.timeline_anchor_review++;
        console.warn(
          `[Poller] ${sport} — team timeline anchor ambiguous for ${context}: ` +
            `${timelineGate.detail} — routing to MD review`,
        );
        if (!forceMDReviewReason) forceMDReviewReason = TIMELINE_ANCHOR_CODE;
        else if (!forceMDReviewReason.includes(TIMELINE_ANCHOR_CODE))
          forceMDReviewReason = `${forceMDReviewReason},${TIMELINE_ANCHOR_CODE}`;
      } else if (timelineGate.annotate) {
        summary.timeline_anchor_annotated++;
        console.log(
          `[Poller] ${sport} — team timeline anchor ambiguous (annotate-only) — ${context} — ` +
            `${timelineGate.detail} (publishing; recorded in the audit trail)`,
        );
      }

      // ── Content-type drift re-check (see checkContentTypeDrift) ──────
      if (gateEnabled && post.content_type !== classified.content_type) {
        summary.content_type_drift++;
        const drift = checkContentTypeDrift(
          classified.content_type,
          post.content_type,
          sig,
          classified.sport,
          new Date(),
        );
        const rescored = drift.rescored;
        console.warn(
          `[SignificanceGate] content_type drift ${classified.content_type}->${post.content_type} for ${context}: ` +
            `re-scored=${rescored?.composite_score} bar=${rescored?.tier_blocked ? 'tier_blocked' : rescored?.process_threshold ?? 'always'} ` +
            `decision=${rescored?.triage_decision} action=${drift.action}`,
        );
        if (drift.action === 'drop') {
          summary.dropped_significance++;
          console.log(`[SignificanceGate] decision=DROP reason=${drift.reason} ${context}`);
          continue;
        }
        if (drift.action === 'md_review') {
          forceMDReviewReason = forceMDReviewReason
            ? `${forceMDReviewReason},${drift.reason}`
            : drift.reason;
        }
      }

      // Re-check Sonnet's final team against the roster. The agent is told to fill
      // an unknown team from its own knowledge, which reintroduces the wrong-team
      // failure mode downstream of the fact validator. On a contradiction, route to
      // MD review rather than drop — Sonnet may know of a trade the roster missed.
      if (validation.resolvedPlayer && validation.resolvedPlayer.confidence !== 'ambiguous') {
        const postTeamCheck = teamClaimCheck(post.team, validation.resolvedPlayer);
        if (postTeamCheck === 'mismatch') {
          console.warn(
            `[FactValidator] ${sport} — post team "${post.team}" mismatches roster for ${context} — routing to MD review`,
          );
          // The pre-Sonnet tier gate already flags this exact reported-vs-roster
          // contradiction as team_mismatch_unconfirmed; don't double-count it here.
          if (!forceMDReviewReason) {
            forceMDReviewReason = 'fact_soft_fail:post_team_mismatch';
          } else if (!forceMDReviewReason.includes('team_mismatch_unconfirmed')) {
            forceMDReviewReason = `${forceMDReviewReason},post_team_mismatch`;
          }
        } else if (postTeamCheck === 'uncheckable' && isTeamSport(sport)) {
          // Sonnet invented a team and the roster carries nothing to compare it
          // against. Previously this returned true and published unchecked.
          // validateEvent already emits team_unverifiable for the same roster
          // gap pre-Sonnet, so suppress the duplicate the way the mismatch
          // branch above suppresses its own.
          console.warn(
            `[FactValidator] ${sport} — post team "${post.team}" is unverifiable (no roster team) for ${context} — routing to MD review`,
          );
          if (!forceMDReviewReason) {
            forceMDReviewReason = 'fact_soft_fail:post_team_unverifiable';
          } else if (!forceMDReviewReason.includes('team_unverifiable')) {
            forceMDReviewReason = `${forceMDReviewReason},post_team_unverifiable`;
          }
        }
      }

      const result = await publishInjuryPost(
        post,
        forceMDReviewReason ? { forceMDReviewReason } : {},
      );
      if (result.status === 'published') summary.published++;
      else if (result.status === 'pending_review') summary.pending_review++;
      else if (result.reason === 'already_pending_review') summary.review_suppressed++;
      else if (result.reason === 'rejected_recently') summary.rejection_suppressed++;
      else summary.skipped++;
      summary.superseded += result.superseded_post_ids?.length ?? 0;

      // Each outcome spends its OWN lane. A review-queue row is real output and
      // is still budgeted, but it is not audience-facing and must not consume a
      // publish slot — sharing one counter is what starved publishing for five
      // days in August 2026 with MAX_PUBLISHES_PER_CYCLE=1.
      if (result.status === 'published') {
        budget.cyclePublishes++;
        if (budget.dayPublishRemaining !== Infinity) budget.dayPublishRemaining--;
      } else if (result.status === 'pending_review') {
        budget.cycleReviews++;
        if (budget.dayReviewRemaining !== Infinity) budget.dayReviewRemaining--;
      }

      // ── Entity bookkeeping (after the post lands) ────────────────────
      // On entity miss → create the entity + INITIAL update linked to the post.
      // On entity match (status-update pass-through) → append a TRACKING
      // update tied to the new post so the timeline reflects it. When the thread
      // was resolved pre-OTM, reuse its entity id and freeze the OTM projection.
      if (result.post_id && validation.resolvedPlayer) {
        await maintainEntity(
          event,
          validation.resolvedPlayer,
          validation.metadata,
          dedup,
          result.post_id,
          post.team_timeline_weeks,
          post.return_to_play.min_weeks,
          post.injury_severity,
          threadEntityId
            ? {
                entityId: threadEntityId,
                otmProjection: buildOtmProjection(post, dateAnchor),
              }
            : undefined,
        );
      }
    } catch (err) {
      summary.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Poller] ${sport} — event failed for ${context}: ${message}`);
    }
  }

  console.log(
    `[Poller] ${sport} — summary: fetched=${summary.fetched} pre_filtered=${summary.pre_filtered} classified+=${summary.classified_positive} dropped_sig=${summary.dropped_significance} date_carry_review=${summary.date_carryover_review} date_carry_annot=${summary.date_carryover_annotated} tl_anchor_review=${summary.timeline_anchor_review} tl_anchor_annot=${summary.timeline_anchor_annotated} dropped_concussion=${summary.dropped_concussion} name_drift=${summary.athlete_name_drift} reanchored=${summary.athlete_reanchored} drift_spelling=${summary.athlete_drift_spelling} surname_ref=${summary.athlete_surname_ref} ct_drift=${summary.content_type_drift} dropped_fact=${summary.dropped_fact_validation} soft_fact=${summary.soft_failed_fact_validation} deferred=${summary.deferred} promoted=${summary.promoted_from_defer} would_promote=${summary.would_promote_from_defer} expired=${summary.expired_from_defer} defer_q=${summary.defer_queue_size} dupes=${summary.duplicates} published=${summary.published} review=${summary.pending_review} review_supp=${summary.review_suppressed} reject_supp=${summary.rejection_suppressed} superseded=${summary.superseded} skipped=${summary.skipped} capped=${summary.capped} source_err=${summary.source_errors} classifier_err=${summary.classifier_errors} errors=${summary.errors}`
  );
  return summary;
}

function scheduleNext(sport: SportKey, intervalMs: number): void {
  if (stopped) return;
  timers[sport] = setTimeout(() => {
    void runAndReschedule(sport, intervalMs);
  }, intervalMs);
}

async function runAndReschedule(sport: SportKey, intervalMs: number): Promise<void> {
  try {
    await pollSport(sport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Poller] ${sport} — poll cycle crashed: ${message}`);
  } finally {
    scheduleNext(sport, intervalMs);
  }
}

/**
 * Starts the autonomous polling loop for all enabled sports.
 * Each sport runs on its own timer so a slow sport does not delay others.
 * Uses setTimeout chaining (not setInterval) so runs never overlap.
 */
export function startPolling(): void {
  if (process.env.POLLING_ENABLED === 'false') {
    console.log('[Poller] POLLING_ENABLED=false — skipping startup');
    return;
  }

  stopped = false;
  const intervalMs = getPollIntervalMs();
  const enabled = SPORT_KEYS.filter(isSportEnabled);

  if (enabled.length === 0) {
    console.log('[Poller] No sports enabled — polling idle');
    return;
  }

  console.log(
    `[Poller] Starting — interval=${intervalMs}ms sports=${enabled.join(',')}`
  );

  for (const sport of enabled) {
    // Fire each sport immediately on startup, then chain via scheduleNext
    void runAndReschedule(sport, intervalMs);
  }
}

/**
 * Stops all polling timers. Safe to call multiple times.
 */
export function stopPolling(): void {
  stopped = true;
  for (const sport of Object.keys(timers) as SportKey[]) {
    const timer = timers[sport];
    if (timer) {
      clearTimeout(timer);
      timers[sport] = null;
    }
  }
  console.log('[Poller] Stopped');
}
