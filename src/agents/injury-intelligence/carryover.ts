import type { RawInjuryEvent } from '../../types.js';

/**
 * Detects that a report describes an injury which occurred BEFORE the report
 * itself — a "carryover".
 *
 * This exists because ESPN's injuries endpoint is a STATUS TABLE, not a news
 * wire. Its per-row `date` is a last-refresh timestamp that moves every time
 * the player's availability changes, and it becomes `RawInjuryEvent.reported_at`
 * — which both DATE ANCHORING prompts describe as "when the SOURCE ARTICLE was
 * published". Over the live feed, of the 21 rows inside the production recency
 * window that carry an `injury_details` block, 20 use explicit elapsed-time
 * language and ZERO describe a fresh injury with no elapsed frame. Mykel
 * Williams' ACL surgery of 2025-11-02 was dated 2026-08-19 that way, and the
 * resulting projection put his return at 2027-05-15.
 *
 * DELIBERATELY NOT KEYED ON `details.returnDate`. That field is ESPN's lapsed
 * ESTIMATED return: 64 of 111 live rows carry one dated before the row itself,
 * median lag −2 days, and Williams' is −6 — indistinguishable from the pack.
 * Keying on it would flag more than half the feed. It is not even copied onto
 * RawInjuryEvent (see espn-base.ts), so this function cannot reach it.
 */

/**
 * 'structured' outranks 'prose': a roster designation is a league-rule fact,
 * whereas prose is inference from wording.
 */
export type CarryoverStrength = 'none' | 'prose' | 'structured';

export interface CarryoverSignals {
  strength: CarryoverStrength;
  /** Stable codes for the prompt, the log line and the audit payload. */
  codes: string[];
  /** Verbatim excerpts quoted into the resolver prompt (max 3, ≤180 chars). */
  evidence: string[];
}

/**
 * PUP-P / PUP-R / NFI-A / NFI-R. By NFL rule a player may only be placed on
 * preseason PUP for an injury sustained before training camp, and on the
 * non-football-injury list for one sustained away from the team — so these are
 * carryovers by definition, not by inference. All 26 live rows carrying one
 * were genuine carryovers.
 *
 * High precision, LOW recall: of the 6 in-window rows with detail "Surgery",
 * all 6 were carryovers and this matched 1. Bosa, Penix, Dell and Nabers were
 * all plain QUESTIONABLE. Recall comes from the prose patterns below.
 */
const CARRYOVER_DESIGNATION_RE = /^(PUP|NFI)\b/i;

/**
 * Words that make a nearby date a CLINICAL date rather than a biographical or
 * scheduling one. Shared by the date-adjacency patterns below.
 */
const INJURY_WORD =
  '(?:injur\\w+|surger\\w+|procedure|operat\\w+|tore|torn|tear|rupture[d]?|fractur\\w+|sprain\\w*|strain\\w*|dislocat\\w+|underwent|repaired|sustained|suffered|post-?op)';

const MONTHS =
  '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|ember|ober|tember)?';

/**
 * Ordered, named prose patterns. Each contributes a `prose:<code>` code and,
 * on first match, the sentence it matched as evidence.
 */
const PROSE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // "last season", "the 2025 campaign", "in 2024"
  [
    'prior_season',
    /\b(?:last|previous|prior)\s+(?:season|year|campaign)\b|\b(?:the\s+)?20(?:1\d|2[0-5])\s+(?:season|campaign|regular season)\b|\bin\s+20(?:1\d|2[0-5])\b/i,
  ],
  // "surgery in December", "tore it on Jan. 11", "injured last September".
  //
  // The month MUST sit next to injury or procedure language. A bare month is
  // noise: ESPN's longComment routinely carries career biography ("an
  // undrafted free agent in April 2024") and forward-looking dates ("available
  // for the regular-season opener in September"), and matching those flagged
  // Marcus Mariota's three-day-old MCL sprain as a carryover. Abbreviated
  // months matter — Kittle's row says "suffered on Jan. 11" — as do the
  // modifiers in "in early June".
  ['dated_month', new RegExp(
    `\\b${INJURY_WORD}\\b[^.]{0,60}?\\b(?:in|since|on|from|last|during)\\s+(?:early\\s+|mid-?\\s*|late\\s+)?${MONTHS}\\.?(?:\\s+\\d{1,2})?\\b` +
    `|\\b(?:in|since|on|from|last|during)\\s+(?:early\\s+|mid-?\\s*|late\\s+)?${MONTHS}\\.?(?:\\s+\\d{1,2})?\\b[^.]{0,60}?\\b${INJURY_WORD}\\b`,
    'i',
  )],
  // "eight months after", "three weeks ago", "10 months post-op". Spelled-out
  // numerals matter: Buchanan's row says "eight months after tearing his ACL".
  [
    'elapsed_span',
    /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several)\s+(?:months?|weeks?)\s+(?:ago|after|since|removed|post|later|out)\b|\bpost-?op\b|\bsidelined since\b|\bhas(?:n['’]t| not) (?:practiced|played) since\b|\bfirst .{0,40}\bsince\b/i,
  ],
  // The rehab arc: the report is about getting back, not getting hurt.
  [
    'recovery_arc',
    /\bwork(?:s|ing|ed)?\s+(?:his|her|their)\s+way\s+back\b|\bcontinues?\s+to\s+(?:work|rehab|recover)\b|\bworks?\s+towards?\s+a\s+return\b|\broad\s+back\b|\b(?:has|have|had|is|was|been)\s+(?:fully\s+|just\s+)?recover(?:ing|ed)\s+from\b|\brecovery\s+from\b|\brehab(?:bing)?\s+(?:from|is|has|continues)\b|\bin\s+(?:his|her|their)\s+\w{0,12}\s?rehab\b|\breturn(?:ing|ed)\s+to\s+(?:the\s+)?(?:field|action|practice)\b|\bback\s+(?:on|at)\s+(?:the\s+)?(?:field|practice)\b|\bnearing\s+a\s+return\b|\bcleared\s+(?:to|for)\b|\bnon-contact\b|\bramp(?:ing)?\s+up\b/i,
  ],
  // Roster-list movement described in prose, for sources with no fielded
  // designation (news wires, X insiders).
  [
    'list_prose',
    /\bactive\/PUP\b|\bPUP\s+list\b|\bNFI\s+list\b|\bphysically unable to perform\b|\bnon-football injury\b|\bactivated\s+(?:from|off)\b|\bpassed\s+(?:his|her|their)\s+physical\b|\bremoved\s+from\s+the\b/i,
  ],
  // "missed the entire 2025 campaign"
  [
    'missed_span',
    /\bmissed\s+(?:the\s+)?(?:entire|entirety of|whole|final|remainder|rest)\b/i,
  ],
  // "underwent offseason surgery", "had surgery in the offseason"
  [
    'offseason_proc',
    /\b(?:off-?season)\s+(?:surgery|procedure|operation)\b|\b(?:surgery|procedure|injury)\s+(?:in|during)\s+the\s+off-?season\b|\bunderwent\s+[\w\s]{0,20}(?:surgery|procedure)\s+(?:in|last|back|during)\b|\b(?:suffered|sustained|injured|hurt|tore)\b[^.]{0,60}\b(?:training camp|OTAs?|minicamp|conditioning test)\b|\b(?:training camp|OTAs?|conditioning test)\b[^.]{0,40}\b(?:injury|injured|issue)\b/i,
  ],
];

/** Trim a matched region back to its sentence, capped for prompt budget. */
function excerpt(haystack: string, index: number): string {
  const start = Math.max(0, haystack.lastIndexOf('.', index) + 1);
  const dot = haystack.indexOf('.', index);
  const end = dot === -1 ? haystack.length : dot + 1;
  return haystack.slice(start, end).trim().slice(0, 180);
}

export function detectCarryoverSignals(event: RawInjuryEvent): CarryoverSignals {
  const codes: string[] = [];
  const evidence: string[] = [];

  const designation = event.roster_designation ?? '';
  const structured = CARRYOVER_DESIGNATION_RE.test(designation);
  if (structured) codes.push(`roster_designation:${designation}`);

  // Prefer the long narrative — that is where the historical anchor lives. Fall
  // back to the description for sources that have no separate narrative field.
  const haystack = event.injury_description_long
    ? `${event.injury_description} ${event.injury_description_long}`
    : event.injury_description;

  for (const [code, re] of PROSE_PATTERNS) {
    const m = re.exec(haystack);
    if (!m) continue;
    codes.push(`prose:${code}`);
    if (evidence.length < 3) evidence.push(excerpt(haystack, m.index));
  }

  const hasProse = codes.some((c) => c.startsWith('prose:'));
  return {
    strength: structured ? 'structured' : hasProse ? 'prose' : 'none',
    codes,
    evidence,
  };
}

/**
 * A structural marker that the injury is significant enough that a wrong date
 * anchor does real clinical damage. Used to narrow the MD-review gate.
 */
const MAJOR_INJURY_RE =
  /\bACL\b|\bPCL\b|\bMCL\b|\bAchilles\b|patellar|pectoral|Lisfranc|rupture|fracture|torn|tear/i;

/**
 * The report announces a NEW clinical event anchored to a recent day: a
 * just-performed procedure, a fresh roster move onto IR, or an injury the
 * source is disclosing for the first time. Here the report date IS a sound
 * anchor and the gate must stay out of the way.
 *
 * Needed because ESPN's longComment almost always closes with a paragraph of
 * career history ("appeared in nine regular-season games last year", "Chicago's
 * prized offseason signing") that trips the prose patterns on rows describing
 * a brand-new injury. Measured against the live feed this veto removes exactly
 * the false positives it was written for — Coby Bryant ("had surgery Friday"),
 * Bryan Bresee and Matt Henningsen (both "placed on injured reserve" days
 * earlier) — and removes none of the true carryovers.
 *
 * Applies to prose-only rows ONLY. A PUP/NFI designation is a league-rule fact
 * about when the injury happened and outranks any inference drawn from wording.
 */
const FRESH_EVENT_RE =
  /\b(?:had|underwent|received)\s+(?:successful\s+)?[\w\s]{0,20}?(?:surgery|procedure)\s+(?:on\s+)?(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\bwill\s+(?:have|undergo|need)\s+[\w\s]{0,20}?(?:surgery|procedure)\b|\bplaced\s+(?:\w+\s+){0,4}on\s+(?:the\s+)?(?:reserve\/)?injured\s+reserve\b|\bwill\s+miss\s+[^.]{0,60}\bwith\s+a\b|\b(?:suffered|sustained|tore|broke|fractured|dislocated)\s+[^.]{0,50}\b(?:on\s+)?(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day(?:'s)?\b/i;

/**
 * The narrower predicate that gates MD review, as distinct from the broader one
 * that shapes the resolver prompt.
 *
 * A prose match alone is too noisy to gate on — `dated_month` and `prior_season`
 * fire on any sentence mentioning a month or a past campaign, including snap
 * counts and contract history. Requiring a structural marker alongside it keeps
 * the gate on the cases where a nine-month date error becomes a published
 * clinical timeline, and lets everything else publish as before.
 */
export function isGatingCarryover(
  signals: CarryoverSignals,
  event: RawInjuryEvent,
): boolean {
  if (signals.strength === 'structured') return true;
  if (signals.strength !== 'prose') return false;
  // A fresh-event announcement vetoes a prose-only inference: the report date
  // really is the anchor, and gating it would route a genuine breaking injury
  // to MD review for no reason.
  const haystack = event.injury_description_long
    ? `${event.injury_description} ${event.injury_description_long}`
    : event.injury_description;
  if (FRESH_EVENT_RE.test(haystack)) return false;
  const details = event.injury_details;
  return (
    details?.detail === 'Surgery' ||
    MAJOR_INJURY_RE.test(details?.type ?? '') ||
    MAJOR_INJURY_RE.test(event.injury_description)
  );
}
