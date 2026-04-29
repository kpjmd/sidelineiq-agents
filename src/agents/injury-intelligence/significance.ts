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
  always_process?: boolean;
}

interface SportWindow {
  window: string;
  from: string; // "MM-DD"
  to: string;   // "MM-DD"
  multiplier: number;
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
    default: { process: number; defer: number };
    BREAKING_T1?: ThresholdConfig;
    TRACKING?: ThresholdConfig;
    DEEP_DIVE?: ThresholdConfig;
    CONFLICT_FLAG?: ThresholdConfig;
  };
  sport_multipliers: Partial<Record<SportKey, SportWindow[]>>;
  default_sport_multiplier: number;
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

export function getDeferConfig(): DeferConfig {
  if (!cachedConfig) {
    return { ttl_hours: 6, promotion_cap: 3, corroboration_bonus_per_source: 5, corroboration_bonus_max: 20 };
  }
  return cachedConfig.defer;
}

export function resolveSportMultiplier(sport: SportKey, date: Date): number {
  if (!cachedConfig) return 1.0;

  const windows = cachedConfig.sport_multipliers[sport];
  if (!windows) return cachedConfig.default_sport_multiplier;

  const current = mmDD(date);
  for (const w of windows) {
    if (isInDateWindow(current, w.from, w.to)) return w.multiplier;
  }

  return cachedConfig.default_sport_multiplier;
}

export function computeRawScore(subscores: SignificanceSubscores): number {
  const raw =
    subscores.athlete_prominence      * WEIGHTS.prominence  +
    subscores.information_specificity * WEIGHTS.specificity +
    subscores.event_recency_novelty   * WEIGHTS.recency     +
    subscores.content_type_prior      * WEIGHTS.prior;
  return clamp(Math.round(raw), 0, 100);
}

export function decideTriage(
  compositeScore: number,
  contentType: ContentType,
  tier: AthleteTier
): TriageDecision {
  const cfg = cachedConfig?.thresholds;

  // CONFLICT_FLAG always processes when configured (or when no config)
  if (contentType === 'CONFLICT_FLAG') {
    if (!cfg || cfg.CONFLICT_FLAG?.always_process !== false) return 'PROCESS';
  }

  // TRACKING — stricter: require tier 1-2 for PROCESS
  if (contentType === 'TRACKING') {
    const t = cfg?.TRACKING;
    const processThreshold = t?.process ?? 70;
    const deferThreshold = t?.defer ?? 35;
    const tierRequired = t?.require_tier_1_or_2 ?? true;
    const tierOk = !tierRequired || tier <= 2;
    if (compositeScore >= processThreshold && tierOk) return 'PROCESS';
    if (compositeScore >= deferThreshold) return 'DEFER';
    return 'DROP';
  }

  // DEEP_DIVE — lower threshold
  if (contentType === 'DEEP_DIVE') {
    const t = cfg?.DEEP_DIVE;
    if (compositeScore >= (t?.process ?? 40)) return 'PROCESS';
    if (compositeScore >= (t?.defer ?? 25)) return 'DEFER';
    return 'DROP';
  }

  // BREAKING with Tier 1 athlete — lowered floor
  if (contentType === 'BREAKING' && tier === 1) {
    const t = cfg?.BREAKING_T1;
    if (compositeScore >= (t?.process ?? 45)) return 'PROCESS';
    if (compositeScore >= (t?.defer ?? 30)) return 'DEFER';
    return 'DROP';
  }

  // Default (BREAKING non-T1, and any unhandled content type)
  const d = cfg?.default ?? { process: 55, defer: 35 };
  if (compositeScore >= d.process) return 'PROCESS';
  if (compositeScore >= d.defer) return 'DEFER';
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
  const sport_multiplier = resolveSportMultiplier(sport, date);
  const composite_score = clamp(Math.round(raw_score * sport_multiplier), 0, 100);
  const triage_decision = decideTriage(composite_score, contentType, tier);

  const rationale = [
    `${triage_decision} score=${composite_score}`,
    sport_multiplier !== 1.0 ? `(raw=${raw_score}×${sport_multiplier})` : '',
    `tier=${tier}${tierSource === 'default' ? '?' : ''}`,
    `spec=${subscores.information_specificity}`,
    `rec=${subscores.event_recency_novelty}`,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 240);

  return {
    raw_score,
    sport_multiplier,
    composite_score,
    triage_decision,
    athlete_tier: tier,
    athlete_tier_source: tierSource,
    subscores,
    rationale,
  };
}

// ── Test helpers (not for production use) ────────────────────────────────────

export function _setTiersForTesting(tiers: AthleteTierDB | null): void {
  cachedTiers = tiers;
}

export function _setConfigForTesting(config: SignificanceConfig | null): void {
  cachedConfig = config;
}
