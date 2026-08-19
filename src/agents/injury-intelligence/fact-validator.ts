// Pure fact-validation module. Run AFTER classifier + significance gate,
// BEFORE Sonnet draft. Catches the "Luka tagged Lakers" class of failure
// at ingestion time so Tier 1 never publishes provably wrong content.
//
// Hard failures → drop the event (no Sonnet call, no publish).
// Soft failures → mark md_review_required=true with reason 'fact_soft_fail:<codes>'.
//
// Team-mismatch is tier-gated (guards against a stale roster silently dropping a
// real trade): a reported team that contradicts the roster HARD-fails only when the
// report is low-trust (T3/unknown → likely a mis-tag). A high-trust report (T1/T2 →
// likely a trade the roster hasn't caught up to) SOFT-fails as
// 'team_mismatch_unconfirmed' — routed to MD review with the reported (new) team
// preserved, never overwritten by the possibly-stale roster team.
//
// A team that cannot be checked at all is separate from one that contradicts:
// 'team_unverifiable' (player resolved, but carries no roster team) is soft and
// NOT tier-gated, because the defect is in our roster rather than in the report.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import type { RawInjuryEvent, SportKey } from '../../types.js';
import { hasRosterProvider, isTeamSport } from '../../monitoring/roster-sync.js';

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
  | 'date_future'
  | 'date_stale_breaking'
  // Soft codes
  | 'identity_unresolvable'
  | 'identity_ambiguous'
  | 'laterality_inconsistent'
  | 'procedure_body_part_mismatch'
  | 'source_tier_low'
  // 'team_unverified'   — the player is NOT in the roster store at all.
  // 'team_unverifiable' — the player IS in the roster store but carries no team
  //                       to check against. One letter apart, two different data
  //                       defects with two different remediations: the first is
  //                       fixed by a roster sync, the second by repairing that
  //                       player's current_team_id. Do not merge them.
  | 'team_unverified'
  | 'team_unverifiable'
  | 'team_mismatch_unconfirmed'
  // Not produced by validateEvent — the date resolver runs later in the poller
  // (it needs the resolved player) and synthesizes this code so the same
  // MD_REVIEW_ANNOTATE_ONLY_CODES lever governs it. See shouldForceDateReview.
  | 'injury_date_unresolved';

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
// A full-string Jaro-Winkler match is deliberately NOT used: same-city teams
// share a normalized prefix and the Winkler boost pushes pairs like
// "los angeles lakers" / "los angeles clippers" (JW ≈ 0.94) over any usable
// threshold — the exact class of failure the corroboration guard exists to
// catch. Instead we distinguish by the nickname token and by abbreviation
// initials, both of which differ between co-located teams.
const TEAM_MATCH_THRESHOLD = 0.85;

function lastToken(s: string): string {
  const parts = s.split(' ').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// A short, space-free string (e.g. "kc", "gsw") is treated as an abbreviation.
function looksLikeAbbrev(s: string): boolean {
  return s.length > 0 && s.length <= 4 && !s.includes(' ');
}

function wordInitials(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .join('');
}

// Is `sub` a subsequence of `full`? Used to match an abbreviation against the
// word-initials of a full name ("kc" ⊂ "kcc" for "kansas city chiefs";
// "nyj" ⊄ "nyg" so Jets never matches Giants).
function isSubsequence(sub: string, full: string): boolean {
  if (sub.length === 0) return false;
  let i = 0;
  for (let j = 0; j < full.length && i < sub.length; j++) {
    if (sub[i] === full[j]) i++;
  }
  return i === sub.length;
}

function normTeamMatches(reportedNorm: string, candidateNorm: string): boolean {
  if (!reportedNorm || !candidateNorm) return false;
  if (reportedNorm === candidateNorm) return true;

  // Abbreviation ↔ full-name via word-initials subsequence.
  if (looksLikeAbbrev(reportedNorm) && candidateNorm.includes(' ')) {
    if (isSubsequence(reportedNorm, wordInitials(candidateNorm))) return true;
  }
  if (looksLikeAbbrev(candidateNorm) && reportedNorm.includes(' ')) {
    if (isSubsequence(candidateNorm, wordInitials(reportedNorm))) return true;
  }

  // Nickname-token match — the distinguishing token between co-located teams.
  const rTok = lastToken(reportedNorm);
  const cTok = lastToken(candidateNorm);
  if (rTok.length >= 4 && cTok.length >= 4) {
    if (rTok === cTok) return true;
    if (jaroWinkler(rTok, cTok) >= TEAM_MATCH_THRESHOLD) return true;
  }

  // Substring only when the contained string is a real nickname (≥ 4 chars),
  // so a bare "la"/"ny" never matches every co-located team.
  if (reportedNorm.length >= 4 && candidateNorm.includes(reportedNorm)) return true;
  if (candidateNorm.length >= 4 && reportedNorm.includes(candidateNorm)) return true;

  return false;
}

// Tri-state, deliberately not a boolean. A boolean cannot distinguish "checked
// and matched" from "could not check", and collapsing the two is what let a
// resolved-but-teamless player pass with no verification at all.
export type TeamCheck = 'match' | 'mismatch' | 'uncheckable';

function checkTeam(reported: string, player: ResolvedPlayerInfo): TeamCheck {
  if (!player.current_team_name && !player.current_team_abbreviation) return 'uncheckable';
  const reportedNorm = normalize(reported);
  const candidates = [
    player.current_team_name,
    player.current_team_abbreviation,
  ]
    .filter((x): x is string => Boolean(x))
    .map(normalize);

  return candidates.some((c) => normTeamMatches(reportedNorm, c)) ? 'match' : 'mismatch';
}

// Public form for callers that need to re-check a team claim against a resolved
// player (e.g. the poller re-validating Sonnet's final team output, which is
// produced downstream of validateEvent). Callers must handle 'uncheckable'
// explicitly — that case is the model's invented team with nothing to compare
// it against, which is a review trigger, not a pass.
export function teamClaimCheck(reported: string, player: ResolvedPlayerInfo): TeamCheck {
  return checkTeam(reported, player);
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

// Four body-part names are also ordinary English words, and injury prose is full
// of them: "won't be BACK at practice", "HEAD coach said", "on the other HAND".
// Matching them as anatomy did real damage. Both of these are live cases:
//
//   Greenard — "Torso Pectoral Surgery … Greenard (pectoral) won't be back at
//   practice" produced primary_body_part 'back' (BODY_PARTS list order put
//   'back' ahead of 'pectoral'), and the entity minted from it has been
//   absorbing his pectoralis reports as a "back surgery" thread ever since.
//
//   Alec Pierce — "Left Leg Ankle Surgery … Head coach Shane Steichen said…"
//   extracted 'head', which is in SPINAL_PARTS, so a stated laterality of LEFT
//   became a laterality_inconsistent soft failure and a forced MD review, on an
//   ankle injury whose side ESPN had told us outright.
//
// These tokens now need a POSITIVE anatomical signal in the immediate
// neighbourhood, not merely the absence of a known false friend — a blocklist
// of "coach", "at practice" and the like only ever covers the phrasings we
// already saw fail. Adjacency (one or two words) rather than a proximity
// window, because a window wide enough to be useful also reaches the unrelated
// "Surgery" four words earlier in the Pierce string.
const AMBIGUOUS_PARTS = new Set(['back', 'head', 'hand', 'neck']);

// "lower back", "left hand", "cervical neck".
const ANATOMICAL_QUALIFIERS = new Set([
  'lower', 'upper', 'mid', 'middle', 'cervical', 'lumbar', 'thoracic', 'spinal',
  'left', 'right', 'bilateral',
]);

// "back surgery", "hand fracture", "neck strain".
const INJURY_NOUNS = new Set([
  'injury', 'injuries', 'surgery', 'surgical', 'procedure', 'strain', 'strains',
  'sprain', 'sprains', 'spasm', 'spasms', 'pain', 'soreness', 'stiffness',
  'tightness', 'contusion', 'fracture', 'fractures', 'laceration', 'discomfort',
  'issue', 'issues', 'problem', 'problems', 'tear', 'rupture', 'bruise',
  'herniation', 'impingement', 'inflammation', 'stinger', 'concussion',
  'trauma', 'wound', 'mri', 'scan',
]);

// "injured the back", "fractured the hand" — needed only for the article, which
// is otherwise far too weak a signal ("the head coach").
const INJURY_VERBS = new Set([
  'injured', 'hurt', 'broke', 'fractured', 'sprained', 'strained', 'dislocated',
  'tweaked', 'grabbed', 'holding', 'clutching', 'bruised', 'jammed', 'tore',
]);

// "landing hard on his back", "underwent a procedure on his back". A personal
// possessive in injury prose is about the person's anatomy; "the" is not, which
// is the entire difference between "his head" and "the head coach".
const PRONOUN_POSSESSIVES = new Set(['his', 'her', 'their']);

function isAnatomicalUse(words: string[], i: number): boolean {
  const prev = words[i - 1];
  const next = words[i + 1];
  if (prev && ANATOMICAL_QUALIFIERS.has(prev)) return true;
  if (next && INJURY_NOUNS.has(next)) return true;
  if (prev && PRONOUN_POSSESSIVES.has(prev)) return true;
  if (prev === 'the' && words[i - 2] && INJURY_VERBS.has(words[i - 2])) return true;
  return false;
}

// ESPN's house style names the injury in a bare parenthetical after the
// athlete: "Bates (back) returned to practice", "Carter (hand) was a full
// participant", "The Cardinals placed Blount (neck) on injured reserve". It is
// the single most common anatomical reference in their prose and no adjacency
// rule sees it — the neighbouring tokens are just a surname and a verb.
//
// Measured over the live NFL + NBA feeds (879 rows), this one pattern accounts
// for most of the ambiguous-token mentions that are genuinely anatomical.
// Nothing writes "(back)" or "(neck)" non-anatomically.
const PAREN_PART_RE = /\(\s*([a-z]+)\s*\)/g;

function parenAttestedParts(lower: string): Set<string> {
  const out = new Set<string>();
  for (const m of lower.matchAll(PAREN_PART_RE)) {
    if (AMBIGUOUS_PARTS.has(m[1])) out.add(m[1]);
  }
  return out;
}

// Letter runs only. Splitting on non-letters rather than whitespace is what
// makes token equality identical to the /\bpart\b/ test this replaces, while
// still exposing neighbours: "shoulder/arm" yields both parts, "(pectoral)"
// yields the part, "back-to-back" yields three tokens none of which is
// anatomical. Contractions split ("won't" → won, t), which can only ever break
// an adjacency match, never invent one.
function tokenize(lower: string): string[] {
  return lower.match(/[a-z]+/g) ?? [];
}

/**
 * Body parts named in `text`, in the order they appear.
 *
 * Order is load-bearing: callers read `parts[0]` as the primary body part, and
 * it keys entity matching. Returning them in BODY_PARTS declaration order meant
 * the primary was whichever part happened to sit highest in a hand-written
 * list, not the one the sentence was about.
 *
 * Ambiguous tokens without an anatomical signal are dropped rather than
 * guessed. That trades a false positive (a wrong thread, a spurious MD review)
 * for a false negative (no body part extracted) — which is a state this
 * pipeline already handles everywhere: a null body_part wildcards entity
 * matching and raises no soft failure.
 */
function extractBodyParts(text: string): string[] {
  const lower = text.toLowerCase();
  const words = tokenize(lower);
  const parenAttested = parenAttestedParts(lower);
  const found: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!BODY_PART_SET.has(word)) continue;
    if (AMBIGUOUS_PARTS.has(word) && !parenAttested.has(word) && !isAnatomicalUse(words, i)) {
      continue;
    }
    if (!found.includes(word)) found.push(word);
  }

  return found;
}

// A body-part lookup set for proximity matching below.
const BODY_PART_SET = new Set<string>(BODY_PARTS);

// Word-proximity window: "left"/"right" only counts as laterality when a
// recognized body part appears within this many words on either side.
// Prevents whole-string keyword matching from misreading non-anatomical uses
// like "left the floor" or "left the game" as a laterality signal — see
// skills/references/content-templates.md's own example: "Morant left the
// floor grabbing his right knee" (verb "left", unrelated to the injury side).
const LATERALITY_PROXIMITY_WINDOW = 4;

function extractLaterality(text: string): 'left' | 'right' | 'bilateral' | null {
  const lower = text.toLowerCase();
  if (/\bbilateral\b/.test(lower)) return 'bilateral';

  // Same tokenizer as extractBodyParts, so "grabbing his right shoulder/arm"
  // sees a body part next to the side word instead of one glued-together token.
  const words = tokenize(lower);
  let sawLeft = false;
  let sawRight = false;

  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'left' && words[i] !== 'right') continue;
    const start = Math.max(0, i - LATERALITY_PROXIMITY_WINDOW);
    const end = Math.min(words.length, i + LATERALITY_PROXIMITY_WINDOW + 1);
    const nearbyHasBodyPart = words.slice(start, end).some((w) => BODY_PART_SET.has(w));
    if (!nearbyHasBodyPart) continue;
    if (words[i] === 'left') sawLeft = true;
    else sawRight = true;
  }

  if (sawLeft && sawRight) return 'bilateral';
  if (sawLeft) return 'left';
  if (sawRight) return 'right';
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

// ESPN's structured `details` block, when the source carries one. These are
// fielded values the source asserts outright — {type:"Ankle", location:"Leg",
// side:"Left"} — so they beat scraping the same facts back out of the prose
// summary built from them, which is what buildDescription() does and what every
// caller here was reading. `side` uses the literal "Not Specified" rather than
// omitting itself, and that is not the same as LEFT/RIGHT/BILATERAL: it means
// the source declined to say, so the text still gets its turn.
type StructuredDetails = NonNullable<RawInjuryEvent['injury_details']>;

function partsFromStructured(details: StructuredDetails | undefined): string[] {
  if (!details) return [];
  const out: string[] = [];
  // type before location: ESPN's `type` is the specific part ("Pectoral",
  // "Ankle") and `location` the coarse region ("Torso", "Leg"), so type is the
  // better primary. Both are scanned — some rows only fill one.
  for (const field of [details.type, details.location]) {
    for (const word of tokenize((field ?? '').toLowerCase())) {
      if (BODY_PART_SET.has(word) && !out.includes(word)) out.push(word);
    }
  }
  return out;
}

function lateralityFromStructured(
  details: StructuredDetails | undefined,
): 'LEFT' | 'RIGHT' | 'BILATERAL' | null {
  const side = details?.side?.trim().toLowerCase();
  if (side === 'left') return 'LEFT';
  if (side === 'right') return 'RIGHT';
  if (side === 'bilateral') return 'BILATERAL';
  return null;
}

export function extractInjuryMetadata(
  description: string,
  details?: StructuredDetails,
): ExtractedInjuryMetadata {
  const structuredParts = partsFromStructured(details);
  const textParts = extractBodyParts(description);
  // Structured parts lead; text parts follow so nothing the prose adds is lost.
  const parts = [...structuredParts, ...textParts.filter((p) => !structuredParts.includes(p))];

  const lat = extractLaterality(description);
  const textLaterality =
    lat === 'bilateral' ? 'BILATERAL' : lat === 'left' ? 'LEFT' : lat === 'right' ? 'RIGHT' : 'UNSPECIFIED';

  return {
    body_parts: parts,
    primary_body_part: parts[0] ?? null,
    laterality: lateralityFromStructured(details) ?? textLaterality,
    // `detail` is the source's own procedure/mechanism word ("Surgery",
    // "Sprain"). Still passed through the same keyword list, so an unrecognized
    // value falls through to the description rather than becoming the hint.
    injury_type_hint:
      extractInjuryTypeHint(details?.detail ?? '') ??
      extractInjuryTypeHint(details?.type ?? '') ??
      extractInjuryTypeHint(description),
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

export type SourceTier = 'T1' | 'T2' | 'T3' | 'unknown';

/**
 * Tier for events fetched through the curated X insider allowlist.
 *
 * T2, not T1: T1 is publisher-of-record (nfl.com, AP, Reuters, ESPN). A named
 * insider breaking news AHEAD of official confirmation is highly reliable but
 * still single-source and pre-confirmation, which is exactly what T2 means in
 * this file. T2 is also what keeps a roster team mismatch on the SOFT path —
 * see the tier gate in the team-corroboration block, where T3/unknown hard-drops
 * the event instead. A trade-plus-injury scoop is the thing these accounts break
 * most often, so hard-dropping it was the worse of the two bugs here.
 */
const X_INSIDER_SOURCE_TIER: SourceTier = 'T2';

function sourceTier(url: string, tiers: SourceTiersFile): SourceTier {
  const host = hostnameFromUrl(url);
  if (!host) return 'unknown';
  let best: SourceTier = 'unknown';
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

// Public accessor for the source corroboration tier of a URL. Single source
// of truth (same source-tiers.json + matching logic the validator uses), so
// promotion scoring and the replay harness don't re-implement tiering.
export async function resolveSourceTier(url: string | null | undefined): Promise<SourceTier> {
  if (!url) return 'unknown';
  const tiers = await loadTiers();
  return sourceTier(url, tiers);
}

/**
 * Tier for a whole event — provenance first, hostname second.
 *
 * X insider events carry `https://x.com/<handle>/status/<id>` as their URL, and
 * x.com is DELIBERATELY absent from data/source-tiers.json. Tiering it by
 * hostname would promote every x.com URL, including ones that never passed the
 * insider allowlist (the mention monitor, user-submitted corrections). Parsing
 * the handle back out of the URL is worse still: src/config/x-insiders.ts exists
 * specifically because handle-spoofing of verified-looking accounts is the
 * documented attack, and identity there is the numeric userId ONLY.
 *
 * `source_name` is the trustworthy signal. Our own fetcher sets it to
 * `X:<handle>` (x-insider-base.ts) only AFTER the numeric-userId allowlist check
 * has passed, so no upstream can forge it — the same reasoning, and the same
 * `startsWith('X:')` test, that shouldForceMDReviewForXSource already uses.
 *
 * Everything else falls through to hostname tiering unchanged.
 */
export function resolveEventSourceTier(
  event: Pick<RawInjuryEvent, 'source_url' | 'source_name'>,
  tiers: SourceTiersFile,
): SourceTier {
  if (event.source_name?.startsWith('X:')) return X_INSIDER_SOURCE_TIER;
  return sourceTier(event.source_url, tiers);
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
    // Exempt only for a sport with no roster to miss. UFC used to qualify and
    // no longer does: fighters are synced from ESPN's card window and minted
    // on sight from an article's own athlete tag, so an unresolved fighter now
    // means something went wrong rather than something being absent by design
    // — and, more importantly, that this event will get no entity, no thread
    // and no laterality check. That is worth a human look, exactly as it is
    // for the team sports.
    if (hasRosterProvider(event.sport)) {
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
  const rosterTeam = resolved?.current_team_name ?? resolved?.current_team_abbreviation ?? null;
  if (resolved && resolved.confidence !== 'ambiguous') {
    // NOTE: rosterTeam is checked INSIDE this branch, not in its condition.
    // Hoisting it back into the `if` reopens the hole this structure closes:
    // a resolved player with a null team failed `rosterTeam` here and failed
    // `!resolved` below, so neither branch ran and the event was published
    // with a completely unverified team and no failure code of any kind.
    const reportedNorm = normalize(event.team ?? '');
    const reportedIsUnknown = reportedNorm === '' || reportedNorm === 'unknown';
    if (!rosterTeam) {
      // The player is in the roster store but carries no team. That is a gap in
      // OUR data, not a contradiction from the source, so it is soft and it is
      // NOT tier-gated: source tier speaks to the reporter's reliability, and a
      // T1 report is exactly as uncheckable against a null as a T3 one. Hard-
      // dropping here would also be stricter than the treatment of a genuine
      // conflict below, which would be incoherent.
      // Individual sports are exempt — a fighter having no team is the sport's
      // structure, not a gap in our data, and the whole point of this code is
      // to distinguish those two. This is the branch UFC events land in now
      // that fighters resolve: without the exemption every single UFC post
      // would carry fact_soft_fail:team_unverifiable straight to MD review.
      if (isTeamSport(event.sport)) {
        softFailures.push({
          code: 'team_unverifiable',
          detail: `Cannot verify team "${event.team}" — ${resolved.full_name} resolved but carries no roster team (player_id=${resolved.player_id})`,
        });
      }
    } else if (reportedIsUnknown) {
      // The source named no team (common for NewsAPI items whose body text
      // never states one). This is a gap, not a contradiction — fill it from
      // the roster and let the event through. NOT a hard failure.
      corrections.push({
        field: 'team',
        from: event.team,
        to: rosterTeam,
        reason: `reported team unknown; filled from roster (player_id=${resolved.player_id})`,
      });
    } else if (checkTeam(event.team, resolved) === 'mismatch') {
      // The reported team contradicts the roster. Tier-gate the response: a
      // high-trust source (T1/T2) reporting a different team is more likely a
      // real trade our roster hasn't caught up to than a mis-tag, so route it to
      // MD review with the reported (new) team preserved rather than hard-drop it.
      // A low-trust source (T3/unknown) is most likely the "wrong team tagged"
      // failure this guard exists for → keep the hard drop + roster correction.
      const reportTier = resolveEventSourceTier(event, tiers);
      if (reportTier === 'T1' || reportTier === 'T2') {
        softFailures.push({
          code: 'team_mismatch_unconfirmed',
          detail: `Reported team "${event.team}" contradicts ${resolved.full_name}'s roster team "${rosterTeam}", but source is tier ${reportTier} (possible trade) — routing to MD review (player_id=${resolved.player_id})`,
        });
        // Intentionally NO team correction: the reported team must survive to
        // Sonnet and MD review; overwriting it with the possibly-stale roster
        // team is exactly the false-drop this branch prevents.
      } else {
        hardFailures.push({
          code: 'team_mismatch',
          detail: `Reported team "${event.team}" does not match ${resolved.full_name}'s current team "${rosterTeam}"`,
        });
        corrections.push({
          field: 'team',
          from: event.team,
          to: rosterTeam,
          reason: `roster lookup (player_id=${resolved.player_id})`,
        });
      }
    }
  } else if (isTeamSport(event.sport) && !resolved) {
    softFailures.push({
      code: 'team_unverified',
      detail: `Cannot verify team "${event.team}" — player not in roster store`,
    });
  }

  // ── Body part / laterality / spine-laterality nonsense ───────────────
  // Extracted ONCE and reused for both checks below and for the returned
  // metadata. These used to be three separate extractions off the same string,
  // free to disagree: the checks read the raw description while the metadata
  // (which keys entity matching) could be computed from the structured fields.
  const metadata = extractInjuryMetadata(event.injury_description, event.injury_details);
  const bodyParts = metadata.body_parts;
  const laterality = metadata.laterality === 'UNSPECIFIED' ? null : metadata.laterality;
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
  const tier = resolveEventSourceTier(event, tiers);
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
    metadata,
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
