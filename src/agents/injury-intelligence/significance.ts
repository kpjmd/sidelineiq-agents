import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  AthleteTier,
  TriageDecision,
  SignificanceAssessment,
  SignificanceSubscores,
  ContentType,
  SportKey,
  RawInjuryEvent,
  PromotionScoreInput,
  PromotionScore,
  CorroborationTier,
} from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Works from both src/agents/injury-intelligence/ (dev) and dist/agents/injury-intelligence/ (compiled)
const DATA_DIR = join(__dirname, '../../../data');

// ── Data file shapes ─────────────────────────────────────────────────────────

interface AthleteTierEntry {
  name: string;
  team: string;
  sport: string;
  tier: AthleteTier;
}

interface AthleteTierDB {
  version: number;
  updated_at: string;
  athletes: AthleteTierEntry[];
}

interface ThresholdConfig {
  process?: number;
  defer?: number;
  require_tier_1_or_2?: boolean;
  /** Lowest-prominence tier still eligible to PROCESS; tiers above are blocked. */
  max_tier?: number;
  always_process?: boolean;
}

interface SportWindow {
  window: string;
  from: string; // "MM-DD"
  to: string;   // "MM-DD"
  // Points added to (or subtracted from) the PROCESS/DEFER thresholds inside this
  // window. Positive = pickier. This used to be a `multiplier` applied to the
  // score instead; that interacted non-linearly with tier and content-type prior
  // and silently made whole (content_type × tier) cells unreachable — a x0.7
  // offseason factor put PROCESS above the maximum achievable score for all
  // TRACKING and for tier-3/4 BREAKING, which stopped publishing entirely in
  // July 2026. Shifting the bar instead of scaling the score keeps the two
  // independent and lets the reachability test verify every cell.
  threshold_delta: number;
}

export interface DeferConfig {
  ttl_hours: number;
  promotion_cap: number;
  corroboration_bonus_per_source: number;
  corroboration_bonus_max: number;
}

interface SignificanceConfig {
  version: number;
  thresholds: {
    default: ThresholdConfig & { process: number; defer: number };
    BREAKING_T1?: ThresholdConfig;
    TRACKING?: ThresholdConfig;
    DEEP_DIVE?: ThresholdConfig;
    CONFLICT_FLAG?: ThresholdConfig;
  };
  sport_seasons: Partial<Record<SportKey, SportWindow[]>>;
  default_threshold_delta: number;
  concussion?: { require_tier_1_or_2?: boolean };
  defer: DeferConfig;
}

// ── Module-level cache ───────────────────────────────────────────────────────

let cachedTiers: AthleteTierDB | null = null;
let cachedConfig: SignificanceConfig | null = null;

// ── Hardcoded weights (research decisions — change requires code review) ─────

const WEIGHTS = { prominence: 0.35, specificity: 0.30, recency: 0.20, prior: 0.15 };

const TIER_TO_PROMINENCE: Record<AthleteTier, number> = { 1: 95, 2: 70, 3: 40, 4: 10 };

const CONTENT_TYPE_PRIOR: Record<ContentType, number> = {
  BREAKING: 75,
  TRACKING: 30,
  DEEP_DIVE: 80,
  CONFLICT_FLAG: 85,
};

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'with', 'and', 'or', 'for', 'of', 'in', 'on', 'at',
  'to', 'is', 'are', 'has', 'have', 'been', 'was', 'were', 'his', 'her',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mmDD(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isInDateWindow(current: string, from: string, to: string): boolean {
  if (from <= to) {
    return current >= from && current <= to;
  }
  // Window wraps year boundary (e.g., from=09-01 to=02-28)
  return current >= from || current <= to;
}

// ── Public: data loading ─────────────────────────────────────────────────────

export async function loadSignificanceData(): Promise<void> {
  const [tiersResult, configResult] = await Promise.allSettled([
    readFile(join(DATA_DIR, 'athlete-tiers.json'), 'utf-8').then((s) => JSON.parse(s) as AthleteTierDB),
    readFile(join(DATA_DIR, 'significance-config.json'), 'utf-8').then((s) => JSON.parse(s) as SignificanceConfig),
  ]);

  if (tiersResult.status === 'fulfilled') {
    cachedTiers = tiersResult.value;
  } else {
    const reason = tiersResult.reason instanceof Error ? tiersResult.reason.message : String(tiersResult.reason);
    console.error(`[Significance] Failed to load athlete-tiers.json: ${reason}`);
    // Keep existing cache on error
  }

  if (configResult.status === 'fulfilled') {
    cachedConfig = configResult.value;
    // A partial rollback that restores the old score-multiplier config would
    // otherwise be silent: the unknown key is ignored, every window resolves to
    // delta 0, and the seasonal signal just disappears. Make it loud.
    if ('sport_multipliers' in (configResult.value as object)) {
      console.error(
        '[Significance] significance-config.json still has the legacy `sport_multipliers` key — ' +
          'seasonal thresholds are NOT being applied. Migrate it to `sport_seasons` with `threshold_delta`.',
      );
    }
  } else {
    const reason = configResult.reason instanceof Error ? configResult.reason.message : String(configResult.reason);
    console.error(`[Significance] Failed to load significance-config.json: ${reason}`);
    // Keep existing cache on error
  }
}

// ── Public: lookup and scoring ───────────────────────────────────────────────

export function lookupAthleteTier(
  name: string,
  sport: SportKey
): { tier: AthleteTier; source: 'lookup' | 'default' } {
  if (!cachedTiers) return { tier: 3, source: 'default' };

  const normName = normalizeText(name);
  const normSport = sport.toLowerCase();

  // Try exact sport+name match first, then name-only fallback
  const match =
    cachedTiers.athletes.find(
      (a) => normalizeText(a.name) === normName && a.sport.toLowerCase() === normSport
    ) ??
    cachedTiers.athletes.find((a) => normalizeText(a.name) === normName);

  return match ? { tier: match.tier, source: 'lookup' } : { tier: 3, source: 'default' };
}

// Suffixes that vary freely between sources for the same person.
const NAME_SUFFIX_RE = /\b(jr|sr|ii|iii|iv)\b/g;

/**
 * Whether two spellings denote the same athlete, tolerant of the differences
 * sources actually disagree on: punctuation ("A.J." vs "AJ"), generational
 * suffixes, and spacing.
 *
 * Matters because the athlete tier — and therefore 35% of the significance
 * score — is resolved from the SOURCE's name before classification, while the
 * post is written about the CLASSIFIER's name. When those denote different
 * people the score was computed for someone other than the post's subject.
 */
export function isSameAthleteName(a: string, b: string): boolean {
  const key = (s: string) =>
    normalizeText(s).replace(NAME_SUFFIX_RE, '').replace(/\s+/g, '');
  return key(a) === key(b);
}

export function getDeferConfig(): DeferConfig {
  if (!cachedConfig) {
    return { ttl_hours: 6, promotion_cap: 3, corroboration_bonus_per_source: 5, corroboration_bonus_max: 20 };
  }
  return cachedConfig.defer;
}

export interface SeasonDelta {
  /** Window name for logging/audit, or 'none' when no window matched. */
  window: string;
  /** Points added to the PROCESS/DEFER thresholds. Positive = pickier. */
  delta: number;
}

export function resolveSeasonDelta(sport: SportKey, date: Date): SeasonDelta {
  if (!cachedConfig) return { window: 'none', delta: 0 };

  const windows = cachedConfig.sport_seasons?.[sport];
  const fallback = cachedConfig.default_threshold_delta ?? 0;
  if (!windows) return { window: 'none', delta: fallback };

  const current = mmDD(date);
  for (const w of windows) {
    if (isInDateWindow(current, w.from, w.to)) return { window: w.window, delta: w.threshold_delta };
  }

  return { window: 'none', delta: fallback };
}

// ── Concussion policy ────────────────────────────────────────────────────────
//
// Concussion is the one category where OTM cannot deliver its core output:
// SKILL.md makes "no RTP estimate for CONCUSSION" a non-negotiable boundary.
// What remains is an explanation of league protocol, which is the same for
// every athlete — so the post's interest rides almost entirely on who was hurt.
// For a depth player that is noise, and it publishes readily because the
// classifier tends to score "in concussion protocol" as highly specific even
// though a concussion has no grade or structure to disclose.
//
// Gated on tier for the same reason TRACKING is.

const CONCUSSION_RE =
  /\b(concuss\w*|head injur\w*|traumatic brain injur\w*|CTE|sub-?concussive)\b/i;

// Non-head injury signals. When one is present the event is not purely a
// concussion story — "back from concussion protocol, now a hamstring strain"
// is a hamstring story and must not be dropped by this rule.
const NON_HEAD_INJURY_RE =
  /\b(acl|mcl|pcl|ucl|hamstring|achilles|tendon|ligament|meniscus|labrum|rotator cuff|fractur\w*|sprain\w*|strain\w*|ruptur\w*|disloc\w*|tear\w*|torn|surger\w*|contusion|laceration)\b/i;

/** True when the text is about a head injury and nothing else. */
export function isConcussionOnlyEvent(text: string): boolean {
  return CONCUSSION_RE.test(text) && !NON_HEAD_INJURY_RE.test(text);
}

/**
 * Whether a concussion-only event should be dropped for this athlete's tier.
 * Config-driven so the policy can be relaxed without a deploy.
 */
export function isConcussionTierBlocked(text: string, tier: AthleteTier): boolean {
  const required = cachedConfig?.concussion?.require_tier_1_or_2 ?? true;
  if (!required) return false;
  return tier > 2 && isConcussionOnlyEvent(text);
}

/**
 * The highest composite an event of this shape can ever score — prominence and
 * content-type prior are fixed by (tier, content_type), so only specificity and
 * recency are free, and both max at 100.
 *
 * A PROCESS threshold at or above this number makes the cell unreachable: no
 * event of that shape can ever publish, no matter how significant it is.
 */
export function maxAchievableScore(contentType: ContentType, tier: AthleteTier): number {
  return computeRawScore({
    athlete_prominence: TIER_TO_PROMINENCE[tier],
    information_specificity: 100,
    event_recency_novelty: 100,
    content_type_prior: CONTENT_TYPE_PRIOR[contentType],
  });
}

/**
 * Headroom a PROCESS threshold must leave below `maxAchievableScore`. A bar set
 * at exactly the maximum is technically reachable but requires perfect 100/100
 * subscores, which Haiku never emits in practice.
 */
export const REACHABILITY_MARGIN = 5;

/**
 * Applies the seasonal delta, then clamps so the bar can never exceed what this
 * (content_type, tier) can actually score. The clamp is a production safety net;
 * tests/significance-reachability.test.ts is what keeps the checked-in config
 * from needing it.
 */
function effectiveProcessThreshold(
  base: number,
  delta: number,
  contentType: ContentType,
  tier: AthleteTier,
): number {
  const ceiling = maxAchievableScore(contentType, tier) - REACHABILITY_MARGIN;
  const wanted = base + delta;
  if (wanted > ceiling) {
    console.warn(
      `[Significance] UNREACHABLE_THRESHOLD ct=${contentType} tier=${tier} wanted=${wanted} ` +
        `clamped=${ceiling} — fix significance-config.json`,
    );
    return ceiling;
  }
  return wanted;
}

export function computeRawScore(subscores: SignificanceSubscores): number {
  const raw =
    subscores.athlete_prominence      * WEIGHTS.prominence  +
    subscores.information_specificity * WEIGHTS.specificity +
    subscores.event_recency_novelty   * WEIGHTS.recency     +
    subscores.content_type_prior      * WEIGHTS.prior;
  return clamp(Math.round(raw), 0, 100);
}

export interface EffectiveThresholds {
  /** Score needed to PROCESS, after the season delta and reachability clamp.
   *  null when the content type always processes (CONFLICT_FLAG). */
  process: number | null;
  /** Score needed to DEFER rather than DROP. null when always processing. */
  defer: number | null;
  /** True when the tier rule blocks PROCESS regardless of score. */
  tier_blocked: boolean;
}

/**
 * The bar this specific event has to clear. Exported so the poll log can print
 * `score=41 bar=45` — the gap between the two is the only thing that tells you
 * whether a threshold is set sensibly or is quietly unreachable.
 */
export function effectiveThresholds(
  contentType: ContentType,
  tier: AthleteTier,
  seasonDelta = 0,
): EffectiveThresholds {
  const cfg = cachedConfig?.thresholds;
  const bar = (base: number) => effectiveProcessThreshold(base, seasonDelta, contentType, tier);
  // The DEFER floor moves with the season too, but it is never clamped — an
  // unreachable defer floor just means "DROP instead", which is a safe outcome.
  const floor = (base: number) => base + seasonDelta;

  if (contentType === 'CONFLICT_FLAG' && (!cfg || cfg.CONFLICT_FLAG?.always_process !== false)) {
    return { process: null, defer: null, tier_blocked: false };
  }

  if (contentType === 'TRACKING') {
    const t = cfg?.TRACKING;
    const tierRequired = t?.require_tier_1_or_2 ?? true;
    if (tierRequired && tier > 2) {
      // The tier rule decides these outright, so no threshold is consulted.
      // Running them through the clamp would emit an UNREACHABLE_THRESHOLD
      // warning about a bar that is never applied — noise on every low-tier
      // TRACKING event, which is most of the feed.
      return { process: null, defer: null, tier_blocked: true };
    }
    return {
      process: bar(t?.process ?? 70),
      defer: floor(t?.defer ?? 35),
      tier_blocked: false,
    };
  }

  if (contentType === 'DEEP_DIVE') {
    const t = cfg?.DEEP_DIVE;
    return { process: bar(t?.process ?? 40), defer: floor(t?.defer ?? 25), tier_blocked: false };
  }

  if (contentType === 'BREAKING' && tier === 1) {
    const t = cfg?.BREAKING_T1;
    return { process: bar(t?.process ?? 45), defer: floor(t?.defer ?? 30), tier_blocked: false };
  }

  // Default (BREAKING non-T1, and any unhandled content type)
  const d = cfg?.default ?? { process: 55, defer: 35 };
  // Tier 4 is the "deep depth / explicitly deprioritised" bucket, and its
  // ceiling (60) sits below the offseason bar. Blocking it outright says so
  // honestly; letting the reachability clamp quietly lower the bar instead
  // would be the same silent-unreachability failure this guardrail exists for.
  if (d.max_tier !== undefined && tier > d.max_tier) {
    return { process: null, defer: null, tier_blocked: true };
  }
  return { process: bar(d.process), defer: floor(d.defer), tier_blocked: false };
}

export function decideTriage(
  compositeScore: number,
  contentType: ContentType,
  tier: AthleteTier,
  seasonDelta = 0,
): TriageDecision {
  const t = effectiveThresholds(contentType, tier, seasonDelta);

  // Must precede the `process === null` check — a tier-blocked cell also has no
  // threshold, and reading that as "always processes" would invert the rule.
  //
  // Deferring a tier-blocked event is pure waste: the defer queue re-scores with
  // the same tier, so the block holds forever and the entry just churns MCP
  // state until its TTL expires. Drop it now.
  if (t.tier_blocked) return 'DROP';

  if (t.process === null) return 'PROCESS'; // CONFLICT_FLAG always processes

  if (compositeScore >= t.process) return 'PROCESS';
  if (t.defer !== null && compositeScore >= t.defer) return 'DEFER';
  return 'DROP';
}

export function computeFingerprint(event: RawInjuryEvent): string {
  const name = normalizeText(event.athlete_name);
  const desc = normalizeText(event.injury_description)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 4)
    .sort()
    .join('-');
  return `${name}:${desc}`;
}

export function computeSignificance(
  tier: AthleteTier,
  tierSource: 'lookup' | 'default',
  haikuSubscores: { information_specificity: number; event_recency_novelty: number },
  contentType: ContentType,
  sport: SportKey,
  date: Date
): SignificanceAssessment {
  const subscores: SignificanceSubscores = {
    athlete_prominence:      TIER_TO_PROMINENCE[tier],
    information_specificity: clamp(Math.round(haikuSubscores.information_specificity), 0, 100),
    event_recency_novelty:   clamp(Math.round(haikuSubscores.event_recency_novelty), 0, 100),
    content_type_prior:      CONTENT_TYPE_PRIOR[contentType],
  };

  const raw_score = computeRawScore(subscores);
  // The score is a property of the event alone. Seasonal pickiness lives in the
  // threshold, not here — see the SportWindow comment for why.
  const composite_score = raw_score;
  const season = resolveSeasonDelta(sport, date);
  const thresholds = effectiveThresholds(contentType, tier, season.delta);
  const triage_decision = decideTriage(composite_score, contentType, tier, season.delta);

  const rationale = [
    `${triage_decision} score=${composite_score}`,
    season.delta !== 0 ? `(${season.window} bar${season.delta > 0 ? '+' : ''}${season.delta})` : '',
    `tier=${tier}${tierSource === 'default' ? '?' : ''}`,
    `spec=${subscores.information_specificity}`,
    `rec=${subscores.event_recency_novelty}`,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);

  return {
    raw_score,
    season_window: season.window,
    season_threshold_delta: season.delta,
    composite_score,
    process_threshold: thresholds.process,
    defer_threshold: thresholds.defer,
    tier_blocked: thresholds.tier_blocked,
    triage_decision,
    athlete_tier: tier,
    athlete_tier_source: tierSource,
    subscores,
    rationale,
  };
}

// ── Promotion scoring (Phase 1: queue → Injury Desk candidate) ───────────────
//
// Separate objective from the significance score above. The composite carries
// the base "how much does this matter" signal; the promotion model adds the
// things that specifically make an injury worth a *physician* breakdown: a
// live team-vs-OTM conflict, strong source corroboration, and freshness (a
// stale entity that nobody is still talking about is a poor desk subject).
//
// Weights are expressed as fractions that sum to 1.0, so the weighted blend of
// 0..1 component values scales cleanly to a 0-100 score. Hardcoded here (like
// WEIGHTS above) because changing them is a research decision, not config.
//
// The conflict signal has two parts: presence (is there a team-vs-OTM flag at
// all) and magnitude (how large the divergence is). Magnitude is the strongest
// "deserves a physician breakdown" signal — a team calling a season-ending ACL
// "questionable" is far more desk-worthy than a 1-week star day-to-day — so it
// carries more weight than presence alone.
const PROMOTION_WEIGHTS = {
  composite:          0.40, // base significance / prominence (normalized 0..1)
  conflict_presence:  0.15, // any team-vs-OTM conflict flag is present
  conflict_magnitude: 0.20, // size of the divergence, normalized & capped
  corroboration:      0.15, // T1 → full, T2 → half, T3/unknown → none
  staleness:          0.10, // freshness: full at 0 days → 0 at STALENESS_FLOOR_DAYS
};

const STALENESS_FLOOR_DAYS = 21; // an entity untouched this long contributes 0 freshness
const CONFLICT_GAP_CAP_WEEKS = 12; // a divergence this large (or larger) = full magnitude
export const PROMOTION_PROPOSE_THRESHOLD = 55; // 0-100; >= proposes a candidate

const CORROBORATION_FRACTION: Record<CorroborationTier, number> = {
  T1: 1.0,
  T2: 0.5,
  T3: 0.0,
  unknown: 0.0,
};

// Exposed so the replay/verify harness can reconstruct a composite proxy from
// athlete tier when the original Haiku subscores were never persisted on a post.
export function prominenceForTier(tier: AthleteTier): number {
  return TIER_TO_PROMINENCE[tier];
}

export function computePromotionScore(input: PromotionScoreInput): PromotionScore {
  const compositeFrac = clamp(input.composite, 0, 100) / 100;
  const presenceFrac = input.conflict_flag_present ? 1 : 0;
  // Magnitude only counts when a conflict is actually flagged. Positive gap =
  // OTM runs longer than the team admits; negatives and unknowns contribute 0.
  const gap = input.conflict_gap_weeks ?? 0;
  const magnitudeFrac = presenceFrac * (clamp(gap, 0, CONFLICT_GAP_CAP_WEEKS) / CONFLICT_GAP_CAP_WEEKS);
  const corroborationFrac = CORROBORATION_FRACTION[input.corroboration_tier] ?? 0;
  const freshnessFrac = 1 - clamp(input.entity_staleness_days, 0, STALENESS_FLOOR_DAYS) / STALENESS_FLOOR_DAYS;

  const terms = {
    composite:          PROMOTION_WEIGHTS.composite          * compositeFrac,
    conflict_presence:  PROMOTION_WEIGHTS.conflict_presence  * presenceFrac,
    conflict_magnitude: PROMOTION_WEIGHTS.conflict_magnitude * magnitudeFrac,
    corroboration:      PROMOTION_WEIGHTS.corroboration      * corroborationFrac,
    staleness:          PROMOTION_WEIGHTS.staleness          * freshnessFrac,
  };

  const total =
    terms.composite + terms.conflict_presence + terms.conflict_magnitude +
    terms.corroboration + terms.staleness;
  const score = clamp(Math.round(total * 100), 0, 100);

  const reasons = [
    `composite=${Math.round(input.composite)} (+${Math.round(terms.composite * 100)})`,
    input.conflict_flag_present
      ? `conflict_flag (+${Math.round(terms.conflict_presence * 100)})`
      : 'no_conflict_flag (+0)',
    input.conflict_flag_present
      ? `gap=${gap > 0 ? `+${gap}w` : 'n/a'} (+${Math.round(terms.conflict_magnitude * 100)})`
      : 'no_gap (+0)',
    `corroboration=${input.corroboration_tier} (+${Math.round(terms.corroboration * 100)})`,
    input.entity_staleness_days > 0
      ? `staleness=${input.entity_staleness_days}d (+${Math.round(terms.staleness * 100)})`
      : `fresh (+${Math.round(terms.staleness * 100)})`,
  ];

  return { score, proposed: score >= PROMOTION_PROPOSE_THRESHOLD, reasons };
}

/**
 * Read-only view of the loaded config, for audit and for the reachability test
 * to enumerate every configured season window rather than hard-coding a list
 * that would drift from the data file.
 */
export function getLoadedConfig(): Readonly<SignificanceConfig> | null {
  return cachedConfig;
}

/** Base PROCESS threshold for a (content_type, tier), before the season delta. */
export function baseProcessThreshold(contentType: ContentType, tier: AthleteTier): number | null {
  const cfg = cachedConfig?.thresholds;
  if (contentType === 'CONFLICT_FLAG' && (!cfg || cfg.CONFLICT_FLAG?.always_process !== false)) {
    return null; // always processes — no threshold to check
  }
  if (contentType === 'TRACKING') return cfg?.TRACKING?.process ?? 70;
  if (contentType === 'DEEP_DIVE') return cfg?.DEEP_DIVE?.process ?? 40;
  if (contentType === 'BREAKING' && tier === 1) return cfg?.BREAKING_T1?.process ?? 45;
  return cfg?.default?.process ?? 55;
}

// ── Test helpers (not for production use) ────────────────────────────────────

export function _setTiersForTesting(tiers: AthleteTierDB | null): void {
  cachedTiers = tiers;
}

export function _setConfigForTesting(config: SignificanceConfig | null): void {
  cachedConfig = config;
}
