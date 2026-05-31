// Pure fact-validation module. Run AFTER classifier + significance gate,
// BEFORE Sonnet draft. Catches the "Luka tagged Lakers" class of failure
// at ingestion time so Tier 1 never publishes provably wrong content.
//
// Hard failures → drop the event (no Sonnet call, no publish).
// Soft failures → mark md_review_required=true with reason 'fact_soft_fail:<codes>'.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import type { RawInjuryEvent, SportKey } from '../../types.js';

export interface ResolvedPlayerInfo {
  player_id: string;
  full_name: string;
  current_team_id: string | null;
  current_team_name: string | null;
  current_team_abbreviation: string | null;
  prominence_tier: number | null;
  confidence: 'exact' | 'normalized' | 'ambiguous' | 'miss';
  match_count: number;
}

export type ValidationCode =
  // Hard codes
  | 'team_mismatch'
  | 'identity_unresolvable'
  | 'date_future'
  | 'date_stale_breaking'
  // Soft codes
  | 'identity_ambiguous'
  | 'laterality_inconsistent'
  | 'procedure_body_part_mismatch'
  | 'source_tier_low'
  | 'team_unverified';

export interface ValidationFailure {
  code: ValidationCode;
  detail: string;
}

export interface ValidationCorrection {
  field: 'team';
  from: string;
  to: string;
  reason: string;
}

export interface ExtractedInjuryMetadata {
  body_parts: string[];
  primary_body_part: string | null;
  laterality: 'LEFT' | 'RIGHT' | 'BILATERAL' | 'UNSPECIFIED';
  injury_type_hint: string | null;
}

export interface ValidationResult {
  passed: boolean;          // false iff hardFailures.length > 0
  hardFailures: ValidationFailure[];
  softFailures: ValidationFailure[];
  corrections: ValidationCorrection[];
  resolvedPlayer: ResolvedPlayerInfo | null;
  metadata: ExtractedInjuryMetadata;
}

// ── Source tier loader (hot-reloadable per validate call is overkill;
//    we cache for the process lifetime and refresh on signal) ────────────
interface SourceTiersFile {
  tiers: Record<'T1' | 'T2' | 'T3', string[]>;
}

interface ProcedureAllowlistFile {
  procedures: Record<string, string[]>;
}

let cachedTiers: SourceTiersFile | null = null;
let cachedProcedures: ProcedureAllowlistFile | null = null;

function dataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', '..', 'data');
}

async function loadTiers(): Promise<SourceTiersFile> {
  if (cachedTiers) return cachedTiers;
  const raw = await readFile(resolvePath(dataDir(), 'source-tiers.json'), 'utf-8');
  cachedTiers = JSON.parse(raw) as SourceTiersFile;
  return cachedTiers;
}

async function loadProcedures(): Promise<ProcedureAllowlistFile> {
  if (cachedProcedures) return cachedProcedures;
  const raw = await readFile(resolvePath(dataDir(), 'procedure-allowlist.json'), 'utf-8');
  cachedProcedures = JSON.parse(raw) as ProcedureAllowlistFile;
  return cachedProcedures;
}

export function clearFactValidatorCache(): void {
  cachedTiers = null;
  cachedProcedures = null;
}

// ── String similarity (Jaro-Winkler, small inline impl) ──────────────
function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  // Winkler boost (up to first 4 matching chars, scale 0.1)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Team-name match ────────────────────────────────────────────────────
const TEAM_MATCH_THRESHOLD = 0.85;

function teamMatches(reported: string, player: ResolvedPlayerInfo): boolean {
  if (!player.current_team_name && !player.current_team_abbreviation) return true; // can't check
  const reportedNorm = normalize(reported);
  const candidates = [
    player.current_team_name,
    player.current_team_abbreviation,
  ]
    .filter((x): x is string => Boolean(x))
    .map(normalize);

  for (const c of candidates) {
    if (!c) continue;
    if (reportedNorm.includes(c) || c.includes(reportedNorm)) return true;
    if (jaroWinkler(reportedNorm, c) >= TEAM_MATCH_THRESHOLD) return true;
  }
  return false;
}

// ── Body-part / laterality extraction ──────────────────────────────────
const BODY_PARTS = [
  'ankle',
  'knee',
  'hamstring',
  'shoulder',
  'elbow',
  'wrist',
  'hand',
  'foot',
  'hip',
  'groin',
  'calf',
  'achilles',
  'head',
  'neck',
  'back',
  'spine',
  'chest',
  'abdomen',
  'forearm',
  'thigh',
  'quad',
  'finger',
  'thumb',
  'toe',
  'rib',
  'pectoral',
  'biceps',
  'triceps',
] as const;

const SPINAL_PARTS = new Set(['back', 'spine', 'neck', 'head', 'chest', 'abdomen']);

function extractBodyParts(text: string): string[] {
  const lower = text.toLowerCase();
  return BODY_PARTS.filter((p) => new RegExp(`\\b${p}\\b`).test(lower));
}

function extractLaterality(text: string): 'left' | 'right' | 'bilateral' | null {
  const lower = text.toLowerCase();
  if (/\bbilateral\b/.test(lower)) return 'bilateral';
  const left = /\bleft\b/.test(lower);
  const right = /\bright\b/.test(lower);
  if (left && right) return 'bilateral';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

// Coarse injury-type hint extracted from raw description for entity matching.
// Returns the first matching keyword; null if nothing recognized. Fine-grained
// injury_type (e.g. "Grade 2 hamstring strain") is produced later by Sonnet.
const INJURY_TYPE_KEYWORDS = [
  'acl tear',
  'mcl tear',
  'pcl tear',
  'meniscus tear',
  'labrum tear',
  'achilles rupture',
  'achilles tear',
  'patellar tendon rupture',
  'patellar tendon tear',
  'quad tear',
  'hamstring strain',
  'hamstring tear',
  'groin strain',
  'high ankle sprain',
  'ankle sprain',
  'concussion',
  'fracture',
  'dislocation',
  'sprain',
  'strain',
  'tear',
  'rupture',
  'surgery',
  'arthroscopy',
] as const;

function extractInjuryTypeHint(text: string): string | null {
  const lower = text.toLowerCase();
  for (const kw of INJURY_TYPE_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

export function extractInjuryMetadata(description: string): ExtractedInjuryMetadata {
  const parts = extractBodyParts(description);
  const lat = extractLaterality(description);
  return {
    body_parts: parts,
    primary_body_part: parts[0] ?? null,
    laterality: lat === 'bilateral'
      ? 'BILATERAL'
      : lat === 'left'
        ? 'LEFT'
        : lat === 'right'
          ? 'RIGHT'
          : 'UNSPECIFIED',
    injury_type_hint: extractInjuryTypeHint(description),
  };
}

// ── Source tier lookup ────────────────────────────────────────────────
function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sourceTier(url: string, tiers: SourceTiersFile): 'T1' | 'T2' | 'T3' | 'unknown' {
  const host = hostnameFromUrl(url);
  if (!host) return 'unknown';
  let best: 'T1' | 'T2' | 'T3' | 'unknown' = 'unknown';
  let bestLen = 0;
  for (const tier of ['T1', 'T2', 'T3'] as const) {
    for (const suffix of tiers.tiers[tier]) {
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        if (suffix.length > bestLen) {
          best = tier;
          bestLen = suffix.length;
        }
      }
    }
  }
  return best;
}

// ── The validator itself ───────────────────────────────────────────────
export interface ValidateOptions {
  // BREAKING content has stricter date sanity than TRACKING/DEEP_DIVE
  contentTypeHint?: 'BREAKING' | 'TRACKING' | 'DEEP_DIVE' | 'CONFLICT_FLAG';
  // Allows tests to inject fixed "now" values
  now?: Date;
}

const BREAKING_MAX_AGE_DAYS = 14;
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000; // 1h skew

export async function validateEvent(
  event: RawInjuryEvent,
  resolved: ResolvedPlayerInfo | null,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const tiers = await loadTiers();
  const procedures = await loadProcedures();

  const hardFailures: ValidationFailure[] = [];
  const softFailures: ValidationFailure[] = [];
  const corrections: ValidationCorrection[] = [];

  // ── Identity ──────────────────────────────────────────────────────────
  if (!resolved) {
    // For UFC there's no roster — name miss is expected and not a hard fail.
    // For other sports, an unresolvable identity is a soft fail (route to review).
    if (event.sport !== 'UFC') {
      softFailures.push({
        code: 'identity_unresolvable',
        detail: `No roster match for athlete "${event.athlete_name}" in ${event.sport}`,
      });
    }
  } else if (resolved.confidence === 'ambiguous') {
    softFailures.push({
      code: 'identity_ambiguous',
      detail: `Athlete name "${event.athlete_name}" matches ${resolved.match_count} players in ${event.sport}`,
    });
  }

  // ── Team check (only meaningful when player resolved unambiguously) ──
  if (resolved && resolved.confidence !== 'ambiguous' && resolved.current_team_name) {
    if (!teamMatches(event.team, resolved)) {
      hardFailures.push({
        code: 'team_mismatch',
        detail: `Reported team "${event.team}" does not match ${resolved.full_name}'s current team "${resolved.current_team_name}"`,
      });
      corrections.push({
        field: 'team',
        from: event.team,
        to: resolved.current_team_name,
        reason: `roster lookup (player_id=${resolved.player_id})`,
      });
    }
  } else if (event.sport !== 'UFC' && !resolved) {
    softFailures.push({
      code: 'team_unverified',
      detail: `Cannot verify team "${event.team}" — player not in roster store`,
    });
  }

  // ── Body part / laterality / spine-laterality nonsense ───────────────
  const bodyParts = extractBodyParts(event.injury_description);
  const laterality = extractLaterality(event.injury_description);
  if (laterality && bodyParts.some((p) => SPINAL_PARTS.has(p))) {
    softFailures.push({
      code: 'laterality_inconsistent',
      detail: `Laterality "${laterality}" stated alongside spinal/axial body part(s): ${bodyParts.filter((p) => SPINAL_PARTS.has(p)).join(', ')}`,
    });
  }

  // ── Procedure plausibility ────────────────────────────────────────────
  const descLower = event.injury_description.toLowerCase();
  for (const [part, procList] of Object.entries(procedures.procedures)) {
    for (const proc of procList) {
      if (descLower.includes(proc)) {
        if (bodyParts.length > 0 && !bodyParts.some((p) => p === part || isAdjacentBodyPart(p, part))) {
          softFailures.push({
            code: 'procedure_body_part_mismatch',
            detail: `Procedure "${proc}" associated with ${part} but reported body part(s): ${bodyParts.join(', ')}`,
          });
        }
      }
    }
  }

  // ── Date sanity ───────────────────────────────────────────────────────
  const now = opts.now ?? new Date();
  if (event.reported_at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    hardFailures.push({
      code: 'date_future',
      detail: `reported_at ${event.reported_at.toISOString()} is in the future`,
    });
  }
  if (opts.contentTypeHint === 'BREAKING') {
    const ageDays = (now.getTime() - event.reported_at.getTime()) / 86_400_000;
    if (ageDays > BREAKING_MAX_AGE_DAYS) {
      hardFailures.push({
        code: 'date_stale_breaking',
        detail: `BREAKING event is ${Math.round(ageDays)}d old (limit ${BREAKING_MAX_AGE_DAYS}d)`,
      });
    }
  }

  // ── Source corroboration ──────────────────────────────────────────────
  const tier = sourceTier(event.source_url, tiers);
  if (tier === 'T3' || tier === 'unknown') {
    softFailures.push({
      code: 'source_tier_low',
      detail: `Source ${event.source_url} is tier ${tier} — single-source low-trust`,
    });
  }

  return {
    passed: hardFailures.length === 0,
    hardFailures,
    softFailures,
    corrections,
    resolvedPlayer: resolved,
    metadata: extractInjuryMetadata(event.injury_description),
  };
}

// Some procedures legitimately span multiple body parts (knee/quad, shoulder/biceps).
function isAdjacentBodyPart(a: string, b: string): boolean {
  const adjacencies: Record<string, string[]> = {
    knee: ['quad', 'thigh', 'hamstring'],
    quad: ['knee', 'thigh'],
    thigh: ['knee', 'quad', 'hamstring'],
    hamstring: ['knee', 'thigh'],
    shoulder: ['biceps', 'pectoral'],
    biceps: ['shoulder', 'forearm'],
    elbow: ['biceps', 'triceps', 'forearm'],
    foot: ['ankle', 'toe'],
    ankle: ['foot'],
    hand: ['wrist', 'finger', 'thumb'],
    wrist: ['hand', 'forearm'],
  };
  return adjacencies[a]?.includes(b) ?? false;
}

// Joins all failure codes into a single colon-delimited string for the
// md_review_reason column.
export function summarizeFailures(failures: ValidationFailure[]): string {
  return failures.map((f) => f.code).join(',');
}
