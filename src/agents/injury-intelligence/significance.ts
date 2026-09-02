import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  AthleteTier,
  AthleteTierSource,
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
  sport: string;
  tier: AthleteTier;
  // No `team`. It carried one until v3, read by nothing — the lookup is name +
  // sport — and stale on 68 of 189 rostered entries by the time it was dropped.
  // Its only conceivable use, telling two same-named athletes apart, does not
  // work either: the lookup is name-keyed, so a curated entry promotes both.
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
  /**
   * How long a deferred event waits for a second publisher.
   *
   * MUST exceed POLL_INTERVAL_MS, and it did not: 6 hours against a 6-hour
   * poll meant every entry was evicted at the start of the very next cycle,
   * before it could be corroborated even once. DEFER was DROP with extra
   * steps. 48h gives an entry one NewsAPI window (that source runs 1 cycle in
   * 6) and several ESPN and X ones. checkDeferTtlReachable in poller.ts warns
   * when this invariant breaks again.
   */
  ttl_hours: number;
  /** Max promotions per entry, a backstop under the family-adding rule. */
  promotion_cap: number;
  /**
   * Points taken OFF the PROCESS threshold per corroborating source family
   * beyond the first, and the cap on that.
   *
   * A DISCOUNT, not a score bonus, because the score is a property of the
   * event and pickiness lives in the threshold (see computeSignificance).
   * The predecessor added points to event_recency_novelty, which carries
   * weight 0.20 — so its advertised max of 20 moved the composite by 4, and
   * its real reach was 2. Config that could not do what it said.
   */
  corroboration_discount_per_source: number;
  corroboration_discount_max: number;
}

/**
 * Used when significance-config.json has not loaded, and field-by-field when
 * validateDeferConfig rejects a value.
 */
export const DEFAULT_DEFER_CONFIG: DeferConfig = {
  ttl_hours: 48,
  promotion_cap: 3,
  corroboration_discount_per_source: 10,
  corroboration_discount_max: 20,
};

/**
 * Salary floors, in whole USD, that promote an unlisted athlete out of the flat
 * default. Only tiers 1 and 2 can be named: see tierFromSalary for why there is
 * deliberately no tier_3_min or tier_4_min.
 *
 * A sport absent from `bands` has no salary signal at all and keeps the flat
 * default — PREMIER_LEAGUE and UFC are absent on purpose (ESPN's soccer roster
 * carries no contract field, and UFC fighters are not team-rostered).
 */
interface SalaryBand {
  tier_1_min: number;
  tier_2_min: number;
}

interface SalaryTierConfig {
  currency?: string;
  bands?: Partial<Record<SportKey, SalaryBand>>;
}

/**
 * Draft-position ceilings that promote an unlisted athlete out of the flat
 * default.
 *
 * LOWER IS BETTER here — the inverse of SalaryBand, where higher is better — so
 * tier_1_max_overall must be LESS than tier_2_max_overall. Getting that
 * comparison backwards is the easy mistake, and validateDraftTiers checks for
 * it by name.
 *
 * This exists because salary is undefined for the population that needs it
 * most: an athlete on a rookie contract. Rookie-scale money is structurally
 * below the NFL tier-2 band no matter how highly he was drafted — Malik Nabers
 * (2024 #6) and Christian Gonzalez (2023 #17, $2.81M) both sat at the flat
 * default, and TRACKING hard-drops tier 3, so their injury updates could never
 * publish. Draft position is what the league itself said an athlete was worth
 * before any market existed, and it is the only signal defined for a player
 * with no contract history.
 *
 * Only tiers 1 and 2 are expressible; see tierFromDraft for why there is
 * deliberately no tier_3_max_overall.
 *
 * `max_seasons_since_draft` is not a tuning knob — it is the whole staleness
 * story. See tierFromDraft.
 */
interface DraftBand {
  /** Shipped ABSENT on purpose. See tierFromDraft. */
  tier_1_max_overall?: number;
  tier_2_max_overall: number;
  max_seasons_since_draft: number;
}

interface DraftTierConfig {
  bands?: Partial<Record<SportKey, DraftBand>>;
}

/**
 * The non-salary prominence signals, one per sport that has no salary data.
 *
 * Salary is not a universal proxy for prominence — it is the proxy that happens
 * to be available in the two leagues ESPN publishes contracts for. The other
 * two sports each need a different one, and forcing them into salary-shaped
 * bands would be inventing data:
 *
 *  - PREMIER_LEAGUE ('club'): ESPN's soccer roster carries no contract field at
 *    all (0/35 athletes on 2026-08-12). Wages exist in the world but not in any
 *    feed we can reach, and PL wage variance between top and bottom clubs is so
 *    much wider than the NFL's or NBA's that one pair of league-wide bands would
 *    be a poor proxy even with the data. The club IS the signal that survives:
 *    it is in the roster we already sync every 6h, and it self-refreshes through
 *    transfers.
 *  - UFC ('card'): fighter pay is not merely missing, it is structurally
 *    undisclosed and always will be. Prominence in an individual sport is card
 *    position — a title fight, a pay-per-view main event — which ESPN publishes
 *    on the scoreboard for every event.
 *
 * A sport absent from this map has no derived signal, exactly as an absent
 * salary band means no salary signal. Both are promote-only.
 */
interface ClubDerivedConfig {
  kind: 'club';
  /** Clubs whose players are tier 2. ESPN team ids — names are for humans. */
  tier_2_clubs?: Array<{ espn_team_id: string; name?: string }>;
}

/**
 * Card slots, most prominent first.
 *
 * `champion` is a property of the FIGHTER, not the bout: ESPN attaches a
 * `{type:'Belt'}` accolade to the athlete, and it says "this person holds a
 * title" — not "this bout is for one". A champion in a non-title bout still
 * carries the accolade, and there is no field distinguishing the two, so the
 * honest reading is the athlete-level one. It outranks position because a
 * reigning champion is the sport's own answer to who matters, wherever they
 * have been placed on the card. Their opponent gets the positional slot, which
 * is the point of resolving this per fighter rather than per bout — otherwise a
 * co-main opponent inherits tier 1 from the belt across the cage.
 */
export type CardSlot =
  | 'champion'
  | 'ppv_main_event'
  | 'ppv_co_main'
  | 'ppv_main_card'
  | 'fight_night_main_event'
  | 'fight_night_co_main';

interface CardDerivedConfig {
  kind: 'card';
  /** How far back a card still confers prominence. Recovery outlives the fight. */
  window_days_back?: number;
  /** How far forward. An announced bout is why an injury matters *now*. */
  window_days_forward?: number;
  slot_tiers?: Partial<Record<CardSlot, number>>;
}

export type DerivedTierConfig = ClubDerivedConfig | CardDerivedConfig;

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
  // Optional: a config without it behaves exactly as before this feature
  // existed, which is what lets the code ship ahead of the bands.
  salary_tiers?: SalaryTierConfig;
  /** Optional for the same reason salary_tiers is: a config without it behaves
   *  exactly as it did before this feature existed. */
  draft_tiers?: DraftTierConfig;
  // Optional for the same reason salary_tiers is: a config without it behaves
  // exactly as it did before derived tiers existed.
  derived_tiers?: Partial<Record<SportKey, DerivedTierConfig>>;
  concussion?: { require_tier_1_or_2?: boolean };
  defer: DeferConfig;
}

/**
 * The prominence signal attached to one athlete in the derived snapshot.
 *
 * The raw signal is stored, not the tier it maps to, for the same reason
 * players.salary holds dollars rather than a tier: re-banding then costs a
 * config edit instead of a re-fetch, and the dry-run can show what actually
 * drove each promotion.
 */
export type DerivedSignal =
  | { kind: 'club'; espn_team_id: string; team_name?: string }
  | { kind: 'card'; slot: CardSlot; event_name: string; event_date: string };

export interface DerivedRow {
  full_name: string;
  sport: string;
  signal: DerivedSignal;
}

interface DerivedIndexEntry {
  row: DerivedRow;
  count: number;
}
/** Same shape and same sport-scoping rule as SalaryIndex — see lookupSalaryRow. */
interface DerivedIndex {
  exactBySport: Map<string, DerivedIndexEntry>;
  looseBySport: Map<string, DerivedIndexEntry>;
  size: number;
}

/** One athlete's salary, as held in the snapshot index. */
interface SalaryRow {
  full_name: string;
  sport: string;
  salary: number;
}

/**
 * Name → salary lookup, built from a players-table snapshot.
 *
 * BOTH maps are sport-scoped, and there is deliberately no any-sport pair. The
 * lookup used to mirror athlete-tiers.json's precedence exactly — exact
 * sport-scoped, exact any-sport, loose sport-scoped, loose any-sport — and that
 * symmetry is what made a cross-league misattribution look principled. It is
 * not the same problem: see lookupSalaryRow.
 *
 * `count` exists so an ambiguous key can refuse to resolve instead of silently
 * returning whichever row was indexed first.
 */
interface SalaryIndexEntry {
  row: SalaryRow;
  count: number;
}
interface SalaryIndex {
  exactBySport: Map<string, SalaryIndexEntry>;
  looseBySport: Map<string, SalaryIndexEntry>;
  size: number;
}

// ── Module-level cache ───────────────────────────────────────────────────────

let cachedTiers: AthleteTierDB | null = null;
let cachedConfig: SignificanceConfig | null = null;
// null = no snapshot loaded. Every lookup then behaves exactly as it did before
// salary existed, which is both the failure mode and the default in tests.
let cachedSalaries: SalaryIndex | null = null;
// Same contract as cachedSalaries: null = no snapshot, every lookup behaves as
// it did before derived tiers existed.
let cachedDerived: DerivedIndex | null = null;

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
    cachedTiers = validateTiers(tiersResult.value);
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
    validateSalaryBands(cachedConfig);
    validateDraftTiers(cachedConfig);
    validateDerivedTiers(cachedConfig);
    validateDeferConfig(cachedConfig);
  } else {
    const reason = configResult.reason instanceof Error ? configResult.reason.message : String(configResult.reason);
    console.error(`[Significance] Failed to load significance-config.json: ${reason}`);
    // Keep existing cache on error
  }
}

/**
 * Rejects malformed salary bands at load, in the spirit of the
 * `sport_multipliers` detection above: a band that silently half-applies is
 * worse than no band at all.
 *
 * Every rejection DROPS that sport's bands entirely rather than repairing them.
 * Dropping degrades to the flat tier-3 default, which is the previous
 * behaviour and therefore the safe direction; repairing would invent a policy
 * nobody reviewed.
 *
 * Mutates the cached config in place so that one bad sport cannot take the rest
 * of the file down with it.
 */
/**
 * Drops unusable athlete-tier rows and says so, loudly, by name.
 *
 * The tiers file is hand-curated — 219 rows a human edits — and until now it was
 * JSON.parsed straight into the cache with no validation at all, while its
 * sibling config got two checks. A typo here is not neutral in the direction you
 * would assume: a malformed TIER 4 row is a lost SUPPRESSION, and that athlete
 * silently rises to the tier-3 default, where BREAKING becomes scoreable instead
 * of dropped. Failing quietly upward is the expensive direction.
 *
 * Deliberately does not reject the whole file. A single bad row should cost that
 * row, not every athlete's tier — the same reasoning as the salary snapshot's
 * bad-row-vs-bad-page split. A file that parses but is entirely malformed still
 * ends up empty, which behaves exactly like the pre-file default.
 */
/** The four SportKeys, as a lookup. Kept here rather than imported from the
 *  classifier's KNOWN_SPORTS so validation cannot be broken by an edit there. */
const KNOWN_TIER_SPORTS = new Set<string>(['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC']);

export function validateTiers(db: AthleteTierDB): AthleteTierDB {
  if (!Array.isArray(db?.athletes)) {
    console.error('[Significance] athlete-tiers.json has no `athletes` array — treating as empty.');
    return { ...db, athletes: [] };
  }
  const kept: AthleteTierEntry[] = [];
  for (const entry of db.athletes) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const sport = typeof entry?.sport === 'string' ? entry.sport.trim() : '';
    const tier = entry?.tier;
    if (!name || !sport) {
      console.error(
        `[Significance] athlete-tiers.json: dropped an entry missing name or sport ` +
          `(${JSON.stringify(entry)}).`,
      );
      continue;
    }
    // The sport has to be one we actually poll. Until now any non-empty string
    // was accepted, and a plausible typo — "PL", "Premier League", "UCF" — is
    // invisible rather than wrong: lookupAthleteTier compares
    // `a.sport.toLowerCase() === sport.toLowerCase()`, so the row is kept, never
    // matches, and the athlete silently falls to the tier-3 default. That is the
    // failing-quietly-upward direction this validator exists to catch, and it
    // became a live risk the moment the file gained a third and fourth league.
    if (!KNOWN_TIER_SPORTS.has(sport.toUpperCase())) {
      console.error(
        `[Significance] athlete-tiers.json: dropped "${name}" — sport ${JSON.stringify(sport)} ` +
          `is not one of ${[...KNOWN_TIER_SPORTS].join(', ')}. It would never have matched a ` +
          `lookup, so they fall through to the tier-3 default.`,
      );
      continue;
    }
    if (tier !== 1 && tier !== 2 && tier !== 3 && tier !== 4) {
      console.error(
        `[Significance] athlete-tiers.json: dropped "${name}" (${sport}) — tier ${JSON.stringify(tier)} ` +
          `is not 1, 2, 3 or 4. They now fall through to the tier-3 default.`,
      );
      continue;
    }
    kept.push(entry);
  }
  if (kept.length !== db.athletes.length) {
    console.error(
      `[Significance] athlete-tiers.json: ${db.athletes.length - kept.length} of ` +
        `${db.athletes.length} entries dropped as malformed.`,
    );
  }
  return { ...db, athletes: kept };
}

function validateSalaryBands(config: SignificanceConfig | null): void {
  const bands = config?.salary_tiers?.bands;
  if (!config?.salary_tiers) return; // Absent is valid: no sport gets a band.
  if (!bands || Object.keys(bands).length === 0) {
    console.error(
      '[Significance] significance-config.json has `salary_tiers` but no `bands` — ' +
        'no athlete will ever be promoted by salary. Remove the key or populate it.',
    );
    return;
  }

  for (const [sport, band] of Object.entries(bands) as [SportKey, SalaryBand][]) {
    const drop = (why: string): void => {
      console.error(
        `[Significance] salary band for ${sport} is invalid (${why}) — dropping it. ` +
          `${sport} athletes will use the flat tier-3 default.`,
      );
      delete bands[sport];
    };

    // Tier 4 is the "deep depth / explicitly deprioritised" bucket and tier 3
    // is the default; neither is reachable by salary, by design. A band naming
    // them is someone trying to make salary DEMOTE, which would break the
    // promote-only guarantee this whole feature is built on. tierFromSalary's
    // return type makes it impossible in code; this makes it loud in config.
    const named = Object.keys(band ?? {}).filter((k) => /^tier_[34]_min$/.test(k));
    if (named.length > 0) {
      drop(`names ${named.join(', ')}; salary can only promote, never demote`);
      continue;
    }

    const t1 = band?.tier_1_min;
    const t2 = band?.tier_2_min;
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 <= 0 || t2 <= 0) {
      drop('tier_1_min and tier_2_min must both be positive numbers');
      continue;
    }
    if (t1 <= t2) {
      drop(`tier_1_min (${t1}) must be greater than tier_2_min (${t2})`);
    }
  }

  // Logged every load for the same reason the roster-sync coverage line exists:
  // a band that quietly failed to apply has no other symptom.
  const summary = Object.entries(bands)
    .map(([s, b]) => `${s} t1>=$${(b.tier_1_min / 1e6).toFixed(1)}M t2>=$${(b.tier_2_min / 1e6).toFixed(1)}M`)
    .join(' | ');
  console.log(`[Significance] salary bands: ${summary || '(none)'}`);
}

/**
 * The draft snapshot, name-keyed per sport, plus the class year it is anchored
 * to. Installed wholesale by setDraftSnapshot; never mutated in place.
 */
export interface DraftPick {
  year: number;
  round: number;
  /** Overall selection number — the ordinal the bands key on. */
  overall: number;
}

interface DraftRow {
  full_name: string;
  sport: string;
  draft: DraftPick;
}

let cachedDraft: DraftRow[] | null = null;
let draftAnchorSeason: number | null = null;

/**
 * Install (or clear) the draft index.
 *
 * The anchor season is derived here as max(class year) rather than from the
 * clock, so every scrap of calendar logic stays out of the lookup path and no
 * date has to be threaded through lookupAthleteTier's dozen call sites. It is
 * safe because the loader keeps only completed selections, and an unheld future
 * draft returns zero picks — so an early-published shell cannot move the anchor
 * and silently expire the oldest class.
 */
export function setDraftSnapshot(rows: DraftRow[] | null): void {
  cachedDraft = rows;
  const years = (rows ?? []).map((r) => r.draft?.year).filter((y): y is number => Number.isFinite(y));
  draftAnchorSeason = years.length > 0 ? Math.max(...years) : null;
}

export function _setDraftSnapshotForTesting(rows: DraftRow[] | null): void {
  setDraftSnapshot(rows);
}

/**
 * Name-keyed draft lookup, sport-scoped, with the same two-stage matching and
 * the same uniqueness guard as lookupSalaryRow.
 *
 * The guard is load-bearing rather than defensive here: draft records carry the
 * athlete's COLLEGE-era name while pro rosters add generational suffixes, so a
 * measured 11 of 319 R1/R2 picks only match on the loose key ("Anthony
 * Richardson" -> "Anthony Richardson Sr.", "Nolan Smith" -> "Nolan Smith Jr.",
 * "DJ Turner" -> "DJ Turner II"). A further 11 roster loose-keys are ambiguous,
 * which is exactly the cross-athlete misattribution this refuses to guess at.
 */
function lookupDraftPick(name: string, sport: SportKey): DraftPick | null {
  if (!cachedDraft) return null;
  const normSport = sport.toLowerCase();
  const normName = normalizeText(name);

  const exact = cachedDraft.filter(
    (r) => r.sport.toLowerCase() === normSport && normalizeText(r.full_name) === normName,
  );
  if (exact.length === 1) return exact[0].draft;
  if (exact.length > 1) return null;

  const looseKey = looseNameKey(name);
  const loose = cachedDraft.filter(
    (r) => r.sport.toLowerCase() === normSport && looseNameKey(r.full_name) === looseKey,
  );
  return loose.length === 1 ? loose[0].draft : null;
}

/**
 * Map a draft slot to a tier. Promote-only: the `1 | 2 | null` return type IS
 * the invariant, exactly as tierFromSalary and tierFromDerived. There is
 * deliberately no way to express tier 3 — returning 3 and returning null would
 * be behaviourally identical, and two spellings of the same thing is what
 * invites a tier_3_max_overall later.
 *
 * A draft slot is a league's PREDICTION about an athlete before any market
 * existed, so this is a DEFAULT and never an override. It systematically
 * over-rates busts, which is what max_seasons_since_draft is for: measured over
 * the 2019 class, 16 of the 23 surviving first-rounders are already covered by
 * salary or curation, so a recency window discards mostly athletes the market
 * has already answered for and retains only the ones no other provider can see
 * — who are, by construction, the busts.
 *
 * It also says nothing about an undrafted or late-round star (Brock Purdy, R7;
 * Patrick Mekari, UDFA). Those are what athlete-tiers.json is for, and it is
 * consulted first.
 */
/** The validated draft bands, so the loader never fetches for a band that
 *  validateDraftTiers rejected. Mirrors getLoadedDerivedConfig. */
export function getLoadedDraftBands(): Partial<Record<SportKey, DraftBand>> {
  return cachedConfig?.draft_tiers?.bands ?? {};
}

export function tierFromDraft(
  pick: DraftPick | null | undefined,
  sport: SportKey,
): 1 | 2 | null {
  if (!pick) return null;
  const band = cachedConfig?.draft_tiers?.bands?.[sport];
  if (!band) return null;
  if (draftAnchorSeason === null) return null;

  const seasonsSince = draftAnchorSeason - pick.year;
  if (seasonsSince < 0 || seasonsSince > band.max_seasons_since_draft) return null;

  if (band.tier_1_max_overall !== undefined && pick.overall <= band.tier_1_max_overall) return 1;
  if (pick.overall <= band.tier_2_max_overall) return 2;
  return null;
}

/**
 * Same shape of guard as validateSalaryBands, with the comparison inverted:
 * for draft position LOWER is better, so tier_1_max_overall must be LESS than
 * tier_2_max_overall.
 */
function validateDraftTiers(config: SignificanceConfig | null): void {
  const bands = config?.draft_tiers?.bands;
  if (!config?.draft_tiers) return; // Absent is valid: no sport gets a band.
  if (!bands || Object.keys(bands).length === 0) {
    console.error(
      '[Significance] significance-config.json has `draft_tiers` but no `bands` — ' +
        'no athlete will ever be promoted by draft position. Remove the key or populate it.',
    );
    return;
  }

  for (const [sport, band] of Object.entries(bands) as [SportKey, DraftBand][]) {
    const drop = (why: string): void => {
      console.error(
        `[Significance] draft band for ${sport} is invalid (${why}) — dropping it. ` +
          `${sport} athletes will use the flat tier-3 default.`,
      );
      delete bands[sport];
    };

    // Same reasoning as the salary equivalent: a band naming tier 3 or 4 is
    // someone trying to make draft position DEMOTE. tierFromDraft's return type
    // makes it impossible in code; this makes it loud in config.
    const named = Object.keys(band ?? {}).filter((k) => /^tier_[34]_max_overall$/.test(k));
    if (named.length > 0) {
      drop(`names ${named.join(', ')}; draft position can only promote, never demote`);
      continue;
    }

    const t2 = band?.tier_2_max_overall;
    const seasons = band?.max_seasons_since_draft;
    if (!Number.isFinite(t2) || (t2 as number) <= 0) {
      drop('tier_2_max_overall must be a positive number');
      continue;
    }
    if (!Number.isFinite(seasons) || (seasons as number) < 0) {
      drop('max_seasons_since_draft must be a non-negative number');
      continue;
    }
    const t1 = band?.tier_1_max_overall;
    if (t1 !== undefined) {
      if (!Number.isFinite(t1) || t1 <= 0) {
        drop('tier_1_max_overall must be a positive number when present');
        continue;
      }
      if (t1 >= (t2 as number)) {
        drop(
          `tier_1_max_overall (${t1}) must be LESS than tier_2_max_overall (${t2}) — ` +
            `lower overall picks are better`,
        );
      }
    }
  }

  const summary = Object.entries(bands)
    .map(([s, b]) => {
      const t1 = b.tier_1_max_overall !== undefined ? `t1<=#${b.tier_1_max_overall} ` : '';
      return `${s} ${t1}t2<=#${b.tier_2_max_overall} within ${b.max_seasons_since_draft} seasons`;
    })
    .join(' | ');
  console.log(`[Significance] draft bands: ${summary || '(none)'}`);
}

/**
 * Rejects malformed derived-tier config at load, mirroring validateSalaryBands.
 *
 * The one rule worth stating twice: a slot or a club may map to 1 or 2 and
 * nothing else. tierFromDerived's return type makes 3 and 4 impossible in code;
 * this makes an attempt loud in config, because a derived 4 would not
 * reprioritise an athlete — it would DELETE their coverage, since tier 4 sits
 * above thresholds.default.max_tier and drops BREAKING outright.
 *
 * Rejection drops the sport's whole entry, degrading to the flat tier-3 default
 * — the previous behaviour, and therefore the safe direction.
 */
function validateDerivedTiers(config: SignificanceConfig | null): void {
  const derived = config?.derived_tiers;
  if (!derived) return; // Absent is valid: no sport gets a derived signal.

  const summary: string[] = [];
  for (const [sport, entry] of Object.entries(derived) as [SportKey, DerivedTierConfig][]) {
    const drop = (why: string): void => {
      console.error(
        `[Significance] derived tier config for ${sport} is invalid (${why}) — dropping it. ` +
          `${sport} athletes will use the flat tier-3 default.`,
      );
      delete derived[sport];
    };

    if (entry?.kind === 'club') {
      const clubs = entry.tier_2_clubs ?? [];
      const usable = clubs.filter((c) => typeof c?.espn_team_id === 'string' && c.espn_team_id.trim());
      if (usable.length !== clubs.length) {
        console.error(
          `[Significance] derived tier config for ${sport}: ${clubs.length - usable.length} club ` +
            `entries have no espn_team_id and were ignored. Names are for humans; the id is the key.`,
        );
        entry.tier_2_clubs = usable;
      }
      if (usable.length === 0) {
        drop('no usable tier_2_clubs');
        continue;
      }
      summary.push(`${sport} club: ${usable.length} tier-2 clubs`);
    } else if (entry?.kind === 'card') {
      const slots = entry.slot_tiers ?? {};
      for (const [slot, tier] of Object.entries(slots) as [CardSlot, number][]) {
        if (tier !== 1 && tier !== 2) {
          console.error(
            `[Significance] derived tier config for ${sport}: slot "${slot}" maps to tier ` +
              `${JSON.stringify(tier)} — only 1 and 2 can be derived, so it was dropped. ` +
              `A derived tier 3 is the default anyway, and a derived tier 4 would remove ` +
              `coverage rather than reprioritise it.`,
          );
          delete slots[slot];
        }
      }
      if (Object.keys(slots).length === 0) {
        drop('no usable slot_tiers');
        continue;
      }
      const back = entry.window_days_back ?? 0;
      const forward = entry.window_days_forward ?? 0;
      if (!(back > 0) && !(forward > 0)) {
        drop('window_days_back and window_days_forward are both zero — no card would ever match');
        continue;
      }
      summary.push(`${sport} card: ${Object.keys(slots).length} slots, -${back}d/+${forward}d`);
    } else {
      drop(`unknown kind ${JSON.stringify((entry as { kind?: unknown })?.kind)}`);
    }
  }

  // Logged every load, for the same reason the salary-band line is: config that
  // quietly failed to apply has no other symptom.
  console.log(`[Significance] derived tiers: ${summary.join(' | ') || '(none)'}`);
}

/** Whether a sport has salary bands configured. Used by roster-sync to decide
 *  whether a collapse in salary coverage is worth warning about. */
export function hasSalaryBands(sport: SportKey): boolean {
  return cachedConfig?.salary_tiers?.bands?.[sport] !== undefined;
}

// ── Public: lookup and scoring ───────────────────────────────────────────────

// Suffixes that vary freely between sources for the same person.
const NAME_SUFFIX_RE = /\b(jr|sr|ii|iii|iv)\b/g;

/**
 * Punctuation-, suffix- and spacing-insensitive identity key for an athlete
 * name. "A.J. Brown", "AJ Brown" and "A J Brown" all collapse to "ajbrown".
 *
 * Shared deliberately by isSameAthleteName and lookupAthleteTier: those two
 * both answer "is this the same athlete?" and used to answer it with different
 * normalizations, so the drift check would call two spellings identical while
 * the tier lookup treated one of them as an unknown athlete and defaulted it
 * to tier 3.
 */
export function looseNameKey(s: string): string {
  return normalizeText(s).replace(NAME_SUFFIX_RE, '').replace(/\s+/g, '');
}

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
  return looseNameKey(a) === looseNameKey(b);
}

/**
 * The salary → tier mapping. The ONLY place it exists.
 *
 * Returns 1, 2, or null — never 3 and never 4. The narrow return type IS the
 * promote-only invariant: a later edit that tries to return 4 is a compile
 * error rather than a silent policy change that quietly stops publishing every
 * depth player's injuries. (Tier 4 is blocked outright for BREAKING by
 * thresholds.default.max_tier, so a salary-assigned 4 would DELETE coverage,
 * not merely reprioritise it.)
 *
 * null means "no promotion — fall through to whatever the caller's default is".
 * There is deliberately no way to express "tier 3" here: returning 3 and
 * returning null would be behaviourally identical, and having two spellings of
 * the same thing is what invites someone to add a tier_3_min later.
 *
 * Salary measures market value, not fame, so this is a DEFAULT and never an
 * override. Rookie-scale deals systematically understate the highest-profile
 * draftees (Luther Burden III $1.34M, Drake Maye $4.1M) and restructured
 * veteran deals understate stars in decline (Damian Lillard $13.4M). Those
 * cases are what athlete-tiers.json is for, and it is consulted first.
 */
export function tierFromSalary(
  salary: number | null | undefined,
  sport: SportKey,
): 1 | 2 | null {
  if (typeof salary !== 'number' || !Number.isFinite(salary) || salary <= 0) return null;
  const band = cachedConfig?.salary_tiers?.bands?.[sport];
  if (!band) return null; // Sport has no salary signal (PREMIER_LEAGUE, UFC).
  if (salary >= band.tier_1_min) return 1;
  if (salary >= band.tier_2_min) return 2;
  return null;
}

/**
 * The derived signal → tier mapping. The ONLY place it exists, and the exact
 * counterpart of tierFromSalary — including the `1 | 2 | null` return type,
 * which IS the promote-only invariant. Returning 4 here would be a compile
 * error rather than a silent policy change that stops publishing a whole sport.
 *
 * A club confers tier 2 and never tier 1. Tier 1 swaps the BREAKING bar to
 * BREAKING_T1's 45, the loosest in the config, so a false tier 1 is the
 * expensive error — and "plays for Arsenal" is true of the academy goalkeeper
 * as well as of Saka. Tier 1 for a footballer stays hand-curated in
 * athlete-tiers.json, which is consulted first.
 *
 * A card slot can confer tier 1, because unlike a club it is a statement about
 * this fighter on this night: main-eventing a numbered pay-per-view, or holding
 * a belt, is the sport's own declaration of who the audience came for.
 */
export function tierFromDerived(
  signal: DerivedSignal | null | undefined,
  sport: SportKey,
): 1 | 2 | null {
  const cfg = cachedConfig?.derived_tiers?.[sport];
  if (!cfg || !signal) return null; // Sport has no derived signal (NFL, NBA).
  if (cfg.kind === 'club' && signal.kind === 'club') {
    const listed = (cfg.tier_2_clubs ?? []).some((c) => c.espn_team_id === signal.espn_team_id);
    return listed ? 2 : null;
  }
  if (cfg.kind === 'card' && signal.kind === 'card') {
    const tier = cfg.slot_tiers?.[signal.slot];
    return tier === 1 || tier === 2 ? tier : null;
  }
  // Snapshot and config disagree about what this sport's signal is. That means
  // a config edit landed without a snapshot refresh; refuse rather than guess.
  return null;
}

/**
 * Installs a derived-signal snapshot. Pass null to clear.
 *
 * Index built HERE for the same reason setSalarySnapshot builds its own: it
 * keeps normalizeText and looseNameKey private to this file, so there is
 * exactly one answer to "is this the same athlete?".
 *
 * Sport-scoped with no any-sport fallback, and `count` guards ambiguity — a
 * squad list is a machine index like the salary one, not a curated file, so two
 * players sharing a name are two different people. Premier League squads
 * genuinely contain them (Danny Ward, Joe Gomez / Joe Rodon collisions across
 * clubs), and promoting the wrong one on the other's club is exactly the Braden
 * Smith bug in a new sport.
 */
export function setDerivedTierSnapshot(rows: DerivedRow[] | null): void {
  if (!rows) {
    cachedDerived = null;
    return;
  }
  const index: DerivedIndex = { exactBySport: new Map(), looseBySport: new Map(), size: 0 };
  const add = (map: Map<string, DerivedIndexEntry>, key: string, row: DerivedRow): void => {
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { row, count: 1 });
  };
  for (const row of rows) {
    if (!row?.full_name || !row.signal) continue;
    const sportKey = row.sport?.toLowerCase() ?? '';
    const exact = normalizeText(row.full_name);
    if (!exact) continue;
    add(index.exactBySport, `${sportKey}|${exact}`, row);
    add(index.looseBySport, `${sportKey}|${looseNameKey(row.full_name)}`, row);
    index.size++;
  }
  cachedDerived = index;
}

/** Number of athletes carrying a derived signal. For logging/audit. */
export function derivedSnapshotSize(): number {
  return cachedDerived?.size ?? 0;
}

/** The unique derived signal for a name IN THAT SPORT — see lookupSalaryRow. */
function lookupDerivedSignal(name: string, sport: SportKey): DerivedSignal | null {
  if (!cachedDerived) return null;
  const normSport = sport.toLowerCase();
  const tryKey = (map: Map<string, DerivedIndexEntry>, key: string): DerivedRow | null => {
    const hit = map.get(key);
    return hit && hit.count === 1 ? hit.row : null;
  };
  const row =
    tryKey(cachedDerived.exactBySport, `${normSport}|${normalizeText(name)}`) ??
    tryKey(cachedDerived.looseBySport, `${normSport}|${looseNameKey(name)}`);
  return row?.signal ?? null;
}

/**
 * Installs a players-table snapshot as the salary source. Pass null to clear.
 *
 * The index is built HERE, not in the fetcher, so that normalizeText and
 * looseNameKey stay private to this file. Two places answering "is this the
 * same athlete?" with different normalizations is the exact defect the
 * looseNameKey comment above documents; a salary index keyed by its own
 * normalizer would reintroduce it one layer down.
 *
 * Only rows carrying a salary are indexed. That is not just an optimisation —
 * it is what disambiguates an athlete's ESPN-sourced row from the no-ESPN-id
 * row that import-athlete-tiers.ts creates for the same person. Only the
 * former has a salary, so the pair does not read as an ambiguous duplicate.
 */
export function setSalarySnapshot(rows: SalaryRow[] | null): void {
  if (!rows) {
    cachedSalaries = null;
    return;
  }
  const index: SalaryIndex = {
    exactBySport: new Map(),
    looseBySport: new Map(),
    size: 0,
  };
  const add = (map: Map<string, SalaryIndexEntry>, key: string, row: SalaryRow): void => {
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { row, count: 1 });
  };
  for (const row of rows) {
    if (!row?.full_name || typeof row.salary !== 'number' || !(row.salary > 0)) continue;
    const sportKey = row.sport?.toLowerCase() ?? '';
    const exact = normalizeText(row.full_name);
    const loose = looseNameKey(row.full_name);
    if (!exact) continue;
    add(index.exactBySport, `${sportKey}|${exact}`, row);
    add(index.looseBySport, `${sportKey}|${loose}`, row);
    index.size++;
  }
  cachedSalaries = index;
}

/** Number of salary-bearing athletes currently indexed. For logging/audit. */
export function salarySnapshotSize(): number {
  return cachedSalaries?.size ?? 0;
}

/**
 * The unique salary row for a name IN THAT SPORT, or null when unknown or
 * ambiguous. Exact-normalized first, then loose — both sport-scoped.
 *
 * THE SPORT SCOPE IS LOAD-BEARING. This used to fall back to an any-sport key
 * when the sport-scoped one missed, on the same reasoning the override file
 * uses: sources mislabel the league more often than they mislabel the person.
 * That reasoning does not survive contact with this data:
 *
 *   • Nothing on the hot path can mislabel the league. Every polled event's
 *     sport is a hardcoded per-source class constant equal to the poller's own
 *     loop variable (poller.ts, return-watch.ts) — no source parses a league
 *     out of news text. The index side is the same shape: salary-snapshot.ts
 *     pages web_list_players per sport, with a sport filter, in its own loop.
 *     A sport-scoped lookup is therefore exact by construction.
 *
 *   • The uniqueness guard does not catch the cross-league case. The NBA's
 *     Braden Smith has no NBA salary, so the NFL Colts tackle of the same name
 *     was the only salaried "Braden Smith", count === 1, and an unrostered-in-
 *     the-NBA athlete was confidently promoted to tier 2 on another man's
 *     contract. Across ~2,200 salaried names dominated by Smith/Williams/
 *     Johnson/Brown, that is the base rate, not bad luck.
 *
 *   • It was also the ONLY way a PREMIER_LEAGUE or UFC event could receive a
 *     salary tier at all, since neither league has a row in this index —
 *     making 100% of those promotions misattributions from NFL/NBA rows, in a
 *     lookup whose bands deliberately say those sports have no salary signal.
 *
 * The override file KEEPS its any-sport fallback, and that is not an
 * inconsistency: 219 hand-curated rows where a cross-sport name collision is a
 * curation bug a human notices, versus a ~3,500-row machine index where it is
 * simply two different people. Same code shape, opposite base rates.
 *
 * Uniqueness is required at the EXACT stage too, which the override path does
 * not do (it uses .find(), first-wins) — same asymmetry, same reason. Being
 * stricter here can only ever produce FEWER promotions, so it cannot break
 * additivity.
 */
function lookupSalaryRow(name: string, sport: SportKey): SalaryRow | null {
  if (!cachedSalaries) return null;
  const normSport = sport.toLowerCase();
  const tryKey = (map: Map<string, SalaryIndexEntry>, key: string): SalaryRow | null => {
    const hit = map.get(key);
    return hit && hit.count === 1 ? hit.row : null;
  };
  return (
    tryKey(cachedSalaries.exactBySport, `${normSport}|${normalizeText(name)}`) ??
    tryKey(cachedSalaries.looseBySport, `${normSport}|${looseNameKey(name)}`)
  );
}

export function lookupAthleteTier(
  name: string,
  sport: SportKey,
  opts?: { allowSalary?: boolean; allowDerived?: boolean; allowDraft?: boolean },
): { tier: AthleteTier; source: AthleteTierSource } {
  if (!cachedTiers) return { tier: 3, source: 'default' };

  const normName = normalizeText(name);
  const normSport = sport.toLowerCase();

  // Exact normalized match first — sport-scoped, then name-only.
  const exact =
    cachedTiers.athletes.find(
      (a) => normalizeText(a.name) === normName && a.sport.toLowerCase() === normSport
    ) ??
    cachedTiers.athletes.find((a) => normalizeText(a.name) === normName);
  if (exact) return { tier: exact.tier, source: 'lookup' };

  // Loose fallback for the spelling variants sources genuinely disagree on.
  // normalizeText turns "A.J. Brown" into "a j brown" and "AJ Brown" into
  // "aj brown", so an exact-only lookup misses every punctuation and suffix
  // variant and reports tier 3 `default` for a listed star.
  //
  // Only accepted when unambiguous: stripping suffixes can merge genuinely
  // different people (Marvin Harrison Jr. and Marvin Harrison are father and
  // son), and guessing between them is worse than admitting we don't know.
  const looseKey = looseNameKey(name);
  const looseMatches = cachedTiers.athletes.filter((a) => looseNameKey(a.name) === looseKey);
  const sportScoped = looseMatches.filter((a) => a.sport.toLowerCase() === normSport);
  const candidates = sportScoped.length > 0 ? sportScoped : looseMatches;
  if (candidates.length === 1) return { tier: candidates[0].tier, source: 'lookup' };

  // Not in the override file. Before falling back to the flat default, ask what
  // the athlete is paid. This is the whole point of the salary layer: without
  // it, "tier 3" is not a statement about an athlete but the absence of one,
  // and A.J. Brown scores identically to a practice-squad receiver.
  //
  // Strictly a promotion. tierFromSalary cannot return 3 or 4, so an athlete's
  // tier here is either better than the default or unchanged — no event that
  // publishes today stops publishing because of this block.
  if (opts?.allowSalary !== false) {
    const row = lookupSalaryRow(name, sport);
    if (row) {
      // `sport`, not `row.sport`. A salary is denominated in the economy of the
      // league that pays it — $20M is a tier-1 NFL salary and a middling NBA
      // one — so the two must never diverge. They cannot: lookupSalaryRow is
      // sport-scoped, so the matched row's sport IS the queried sport. Reading
      // it back off the row would restore the appearance of supporting a
      // cross-league match, which is exactly what was wrong before.
      const tier = tierFromSalary(row.salary, sport);
      if (tier !== null) return { tier, source: 'salary' };
    }
  }

  // The same question for the sports salary cannot answer. Order relative to
  // salary is irrelevant in practice — no sport has both a salary band and a
  // derived config, and validate* would have to be edited for one to — but it
  // is stated rather than assumed, and pinned by a test: money first, because
  // where a contract exists it is the more direct measure of how a league
  // values an athlete.
  //
  // Promote-only, exactly as above: tierFromDerived cannot return 3 or 4, so
  // nothing that publishes today stops publishing because of this block.
  // After salary, before club/card. The order relative to salary is NOT
  // arbitrary and is pinned by a test: a contract is the market's verdict on an
  // athlete TODAY, a draft slot is a league's PREDICTION about him years ago,
  // and where both speak the newer signal wins. Promote-only, so nothing that
  // publishes today can stop publishing because of this block.
  if (opts?.allowDraft !== false) {
    const pick = lookupDraftPick(name, sport);
    const tier = tierFromDraft(pick, sport);
    if (tier !== null) return { tier, source: 'draft' };
  }

  if (opts?.allowDerived !== false) {
    const signal = lookupDerivedSignal(name, sport);
    const tier = tierFromDerived(signal, sport);
    if (tier !== null && signal) return { tier, source: signal.kind };
  }

  return { tier: 3, source: 'default' };
}

/**
 * Rejects a malformed `defer` block field-by-field, degrading each bad value to
 * its default rather than dropping the whole block — the same spirit as
 * validateSalaryBands, applied to the settings that decide whether the defer
 * queue does anything at all.
 *
 * It exists because the shipped block was internally contradictory for months
 * with nothing to say so: `ttl_hours: 6` against a 6-hour poll meant no entry
 * ever survived to be corroborated, while `corroboration_bonus_max: 20`
 * described a ceiling that needed four corroborations to reach. Neither value
 * is wrong in isolation, and no code read them together.
 */
function validateDeferConfig(config: SignificanceConfig | null): void {
  if (!config) return;

  if (!config.defer || typeof config.defer !== 'object') {
    console.error(
      '[Significance] significance-config.json has no valid `defer` block — using defaults ' +
        `(ttl_hours=${DEFAULT_DEFER_CONFIG.ttl_hours}, ` +
        `discount=${DEFAULT_DEFER_CONFIG.corroboration_discount_per_source}/` +
        `${DEFAULT_DEFER_CONFIG.corroboration_discount_max}).`,
    );
    config.defer = { ...DEFAULT_DEFER_CONFIG };
    return;
  }

  const defer = config.defer;
  const fallback = (field: keyof DeferConfig, why: string): void => {
    const value = DEFAULT_DEFER_CONFIG[field];
    console.error(
      `[Significance] defer.${String(field)} is invalid (${why}) — using default ${value}.`,
    );
    (defer as unknown as Record<string, unknown>)[field as string] = value;
  };

  if (!Number.isFinite(defer.ttl_hours) || defer.ttl_hours <= 0) {
    fallback('ttl_hours', `${defer.ttl_hours}; must be a positive number of hours`);
  }
  if (!Number.isInteger(defer.promotion_cap) || defer.promotion_cap < 1) {
    fallback('promotion_cap', `${defer.promotion_cap}; must be an integer of at least 1`);
  }
  if (!Number.isFinite(defer.corroboration_discount_per_source) || defer.corroboration_discount_per_source < 0) {
    fallback(
      'corroboration_discount_per_source',
      `${defer.corroboration_discount_per_source}; corroboration may only lower a bar, never raise one`,
    );
  }
  if (!Number.isFinite(defer.corroboration_discount_max) || defer.corroboration_discount_max < 0) {
    fallback('corroboration_discount_max', `${defer.corroboration_discount_max}; must be zero or more`);
  }
  // A cap below one step makes the per-source value a lie — the dead-config
  // shape that made corroboration_bonus_max unreachable. Loud, then usable.
  if (defer.corroboration_discount_max < defer.corroboration_discount_per_source) {
    console.error(
      `[Significance] defer.corroboration_discount_max (${defer.corroboration_discount_max}) is below ` +
        `corroboration_discount_per_source (${defer.corroboration_discount_per_source}) — one corroborating ` +
        'source can never earn a full step. Raising the cap to one step.',
    );
    defer.corroboration_discount_max = defer.corroboration_discount_per_source;
  }

  if ('corroboration_bonus_per_source' in defer || 'corroboration_bonus_max' in defer) {
    console.warn(
      '[Significance] significance-config.json still has the legacy `corroboration_bonus_*` keys — ' +
        'they are IGNORED. Corroboration is now a threshold discount ' +
        '(`corroboration_discount_per_source` / `_max`), not a recency-subscore bonus.',
    );
  }

  // Not an error: the discount is clamped at the DEFER floor at apply time, so
  // an oversized cap costs nothing. Worth saying once, because it means the
  // configured maximum is not what those content types will actually see.
  const bands = Object.values(config.thresholds ?? {})
    .map((t) => (typeof t?.process === 'number' && typeof t?.defer === 'number' ? t.process - t.defer : null))
    .filter((w): w is number => w !== null && w >= 0);
  const narrowest = bands.length > 0 ? Math.min(...bands) : null;
  if (narrowest !== null && defer.corroboration_discount_max > narrowest) {
    console.warn(
      `[Significance] defer.corroboration_discount_max (${defer.corroboration_discount_max}) exceeds the ` +
        `narrowest DEFER band (${narrowest}); for those content types the discount stops at the defer floor.`,
    );
  }
}

export function getDeferConfig(): DeferConfig {
  if (!cachedConfig) return { ...DEFAULT_DEFER_CONFIG };
  return cachedConfig.defer;
}

/**
 * Corroboration's effect on the bar: nothing for the first family, then
 * `per_source` for each additional one, capped.
 *
 * Clamped at 0 at the bottom, so no config value and no caller can turn this
 * into a penalty — the whole mechanism is promote-only, and a negative
 * discount would raise a publishing bar on evidence that should lower it.
 */
export function computeCorroborationDiscount(
  distinctFamilies: number,
  config: DeferConfig,
): number {
  const steps = Math.max(0, distinctFamilies - 1);
  return clamp(steps * config.corroboration_discount_per_source, 0, config.corroboration_discount_max);
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
  /** Points corroboration actually took off `process` — after the defer-floor
   *  clamp, so this is what was applied, not what was requested. */
  corroboration_discount: number;
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
  corroborationDiscount = 0,
): EffectiveThresholds {
  const cfg = cachedConfig?.thresholds;
  // Corroboration lowers the PROCESS bar and nothing else.
  //
  // It goes here, in the same function as the season delta, because these are
  // the same kind of adjustment: neither says the event scored differently,
  // both say how picky we should be about it. Applying it anywhere else — as a
  // second opinion in the defer queue, say — would mean two readers of one
  // event disagreeing about its bar, and the delta and the reachability clamp
  // would apply to one of them and not the other.
  //
  // Never below the DEFER floor: an event that has not cleared the floor on its
  // own merits is not something two sources agreeing should publish, and the
  // floor is also what keeps an oversized discount_max harmless on the 15-point
  // BREAKING_T1 and DEEP_DIVE bands.
  const discount = Math.max(0, corroborationDiscount);
  let applied = 0;
  const bar = (base: number, deferBase: number) => {
    const seasoned = effectiveProcessThreshold(base, seasonDelta, contentType, tier);
    if (discount <= 0) return seasoned;
    // The floor is the DEFER threshold, not the undiscounted PROCESS bar.
    const discounted = Math.max(seasoned - discount, deferBase + seasonDelta);
    applied = seasoned - discounted;
    return discounted;
  };
  // The DEFER floor moves with the season too, but it is never clamped — an
  // unreachable defer floor just means "DROP instead", which is a safe outcome.
  const floor = (base: number) => base + seasonDelta;

  if (contentType === 'CONFLICT_FLAG' && (!cfg || cfg.CONFLICT_FLAG?.always_process !== false)) {
    return { process: null, defer: null, tier_blocked: false, corroboration_discount: 0 };
  }

  if (contentType === 'TRACKING') {
    const t = cfg?.TRACKING;
    const tierRequired = t?.require_tier_1_or_2 ?? true;
    if (tierRequired && tier > 2) {
      // The tier rule decides these outright, so no threshold is consulted.
      // Running them through the clamp would emit an UNREACHABLE_THRESHOLD
      // warning about a bar that is never applied — noise on every low-tier
      // TRACKING event, which is most of the feed.
      return { process: null, defer: null, tier_blocked: true, corroboration_discount: 0 };
    }
    const process = bar(t?.process ?? 70, t?.defer ?? 35);
    return {
      process,
      defer: floor(t?.defer ?? 35),
      tier_blocked: false,
      corroboration_discount: applied,
    };
  }

  if (contentType === 'DEEP_DIVE') {
    const t = cfg?.DEEP_DIVE;
    return {
      process: bar(t?.process ?? 40, t?.defer ?? 25),
      defer: floor(t?.defer ?? 25),
      tier_blocked: false,
      corroboration_discount: applied,
    };
  }

  if (contentType === 'BREAKING' && tier === 1) {
    const t = cfg?.BREAKING_T1;
    return {
      process: bar(t?.process ?? 45, t?.defer ?? 30),
      defer: floor(t?.defer ?? 30),
      tier_blocked: false,
      corroboration_discount: applied,
    };
  }

  // Default (BREAKING non-T1, and any unhandled content type)
  const d = cfg?.default ?? { process: 55, defer: 35 };
  // Tier 4 is the "deep depth / explicitly deprioritised" bucket, and its
  // ceiling (60) sits below the offseason bar. Blocking it outright says so
  // honestly; letting the reachability clamp quietly lower the bar instead
  // would be the same silent-unreachability failure this guardrail exists for.
  if (d.max_tier !== undefined && tier > d.max_tier) {
    return { process: null, defer: null, tier_blocked: true, corroboration_discount: 0 };
  }
  return {
    process: bar(d.process, d.defer),
    defer: floor(d.defer),
    tier_blocked: false,
    corroboration_discount: applied,
  };
}

export function decideTriage(
  compositeScore: number,
  contentType: ContentType,
  tier: AthleteTier,
  seasonDelta = 0,
  corroborationDiscount = 0,
): TriageDecision {
  const t = effectiveThresholds(contentType, tier, seasonDelta, corroborationDiscount);

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

export interface SignificanceOptions {
  /** Points to take off the PROCESS bar for corroboration. See DeferConfig. */
  corroborationDiscount?: number;
  /** The source families that earned it — recorded on the assessment so every
   *  later reader sees the evidence, not just the adjusted number. */
  corroboratingSources?: string[];
}

export function computeSignificance(
  tier: AthleteTier,
  tierSource: AthleteTierSource,
  haikuSubscores: { information_specificity: number; event_recency_novelty: number },
  contentType: ContentType,
  sport: SportKey,
  date: Date,
  options?: SignificanceOptions
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
  const discount = Math.max(0, options?.corroborationDiscount ?? 0);
  const thresholds = effectiveThresholds(contentType, tier, season.delta, discount);
  const triage_decision = decideTriage(composite_score, contentType, tier, season.delta, discount);

  const rationale = [
    `${triage_decision} score=${composite_score}`,
    season.delta !== 0 ? `(${season.window} bar${season.delta > 0 ? '+' : ''}${season.delta})` : '',
    // '?' = guessed (nothing resolved), '~' = derived from salary, '+' =
    // derived from club or card, bare = confirmed from athlete-tiers.json.
    // Four states, because "we know", "we inferred from what he's paid" and
    // "we inferred from who he plays for" are different claims, and the gate
    // log is where a miscalibration gets noticed.
    `tier=${tier}${tierMarker(tierSource)}`,
    `spec=${subscores.information_specificity}`,
    `rec=${subscores.event_recency_novelty}`,
    // Names the evidence, not just the number: a reader seeing a bar 10 points
    // below the configured one needs to know which publishers bought it.
    thresholds.corroboration_discount > 0
      ? `corr=-${thresholds.corroboration_discount}(${(options?.corroboratingSources ?? []).join(',')})`
      : '',
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
    ...(thresholds.corroboration_discount > 0
      ? {
          corroboration_discount: thresholds.corroboration_discount,
          corroborating_sources: options?.corroboratingSources ?? [],
        }
      : {}),
    rationale,
  };
}

/**
 * The defer queue's match key: one athlete in one sport.
 *
 * Deliberately NOT computeFingerprint, which mixes the athlete with the first
 * four words of the description. Two publishers never describe one injury the
 * same way — ESPN's table says "Ankle - Leg, Not Specified" and a tweet says
 * "placed on IR" — so a fingerprint could only ever match a source to itself,
 * and "corroboration" meant one feed re-serving the same row.
 *
 * Keyed on the CLASSIFIER's name, not the source's: for an ESPN row that is
 * really about a teammate, the classifier names the injured athlete while the
 * source names the healthy one it was filed under.
 */
export function computeAthleteKey(sport: SportKey, athleteName: string): string {
  return `${sport}|${normalizeText(athleteName)}`;
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
/**
 * One character summarising how much a logged tier can be trusted. Shared by
 * the rationale string and the gate log line so the two never drift.
 */
export function tierMarker(source: AthleteTierSource): string {
  if (source === 'default') return '?';
  if (source === 'salary') return '~';
  if (source === 'club' || source === 'card') return '+';
  if (source === 'draft') return '^';
  return '';
}

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

/**
 * The derived-tier providers, post-validation. The snapshot loader reads its
 * work list from here rather than from the file so that a config entry
 * validateDerivedTiers rejected is never fetched for.
 */
export function getLoadedDerivedConfig(): Readonly<Partial<Record<SportKey, DerivedTierConfig>>> | null {
  return cachedConfig?.derived_tiers ?? null;
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
  // Validate here too, not only in loadSignificanceData. Otherwise the seam is
  // a hole in the promote-only guarantee: a test (or a future non-file config
  // source) could install bands the real load path would have rejected, and
  // the thing being asserted would not be the thing that ships.
  validateSalaryBands(cachedConfig);
  validateDraftTiers(cachedConfig);
  validateDerivedTiers(cachedConfig);
  validateDeferConfig(cachedConfig);
}

/** Install (or clear) the salary snapshot. Clearing restores the exact
 *  behaviour this module had before salary existed. */
export function _setSalarySnapshotForTesting(rows: SalaryRow[] | null): void {
  setSalarySnapshot(rows);
}

/** Install (or clear) the derived-signal snapshot. Clearing restores the exact
 *  behaviour this module had before derived tiers existed. */
export function _setDerivedSnapshotForTesting(rows: DerivedRow[] | null): void {
  setDerivedTierSnapshot(rows);
}
