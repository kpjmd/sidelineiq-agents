/**
 * Canonical injury key for grouping DEEP_DIVE candidates.
 *
 * WHY THIS EXISTS. deep-dive-scheduler grouped candidates on
 * `injury_type.toLowerCase().trim()`, and injury_type is free model prose. On the
 * live corpus (2026-09-12) 272 of 332 distinct strings — 82% — appeared exactly
 * once ever, and "ankle" alone was spelled 55 ways. With production's
 * DEEP_DIVE_MIN_INJURY_COUNT=3 no string reached the bar after 2026-05-16, so the
 * scheduler logged "No injury type meets threshold" for four months and the only
 * content type carrying the referral CTA stopped existing. Lowering the count to 2
 * does not fix it (still dry since 2026-08-14): the strings keep getting longer.
 * See src/scripts/deep-dive-starvation-dryrun.ts.
 *
 * TWO TIERS, because list order is itself a known failure mode here.
 *   SPECIFIC structures win wherever they appear in the label. "left knee
 *   meniscus tear" is a meniscus story even though "knee" comes first; ordering
 *   by text position would bury the structure that makes it a distinct explainer.
 *   Declared order only breaks the rare tie between two specifics ("ACL and
 *   meniscus" is an ACL story).
 *   GENERAL regions resolve by TEXT POSITION, earliest wins — the same rule
 *   fact-validator's extractBodyParts uses, and for the same reason: BODY_PARTS
 *   declaration order once put 'back' ahead of 'pectoral' and minted Greenard's
 *   false back-surgery thread.
 *
 * FALSE FRIENDS. back / neck / hand are ordinary English words ("won't be BACK
 * at practice", "on the other HAND"). They are trusted from a clinical LABEL —
 * injury_type is one — but never from headline prose. Callers matching a
 * headline must pass { allowFalseFriends: false }. 'head' is deliberately not a
 * key at all: a head injury is not presumptively a concussion, and concussion
 * carries its own RTP prohibition.
 *
 * DELIBERATELY UNBUCKETED, from the live rows rather than by assumption:
 * abdominal/torso, pelvic, lower-leg-unspecified and eye/nasal labels are
 * overwhelmingly "surgery — procedure undisclosed". Grouping ten of those
 * yields a physician-branded explainer about nothing specific, and a rejected
 * DEEP_DIVE deliberately releases its cooldown, so a weak topic would come back
 * every scheduler cycle. Illness / systemic / appendectomy / "undisclosed" are
 * not musculoskeletal and stay out. Adding a key is a one-line change here.
 *
 * This is a GROUPING vocabulary. It is intentionally separate from
 * fact-validator's BODY_PARTS, which keys entity matching (parts[0]) — changing
 * that list moves which past reports match a thread. Unifying the two, and with
 * mcp desk-sections.ts RELEVANT_TOOL_KEYS (the kpjmd.com contract), is a later
 * consolidation with its own dry-run, not a side effect of this fix.
 *
 * Pure: no imports, so tests and dry-runs can use it without the MCP client.
 */

interface Rule {
  key: string;
  re: RegExp;
  /** An ordinary English word too — trusted from a clinical label only. */
  falseFriend?: boolean;
}

// Any position; declared order breaks ties. Most specific / most severe first.
const SPECIFIC: readonly Rule[] = [
  { key: 'acl', re: /\bacl\b|anterior cruciate/ },
  { key: 'achilles', re: /achilles/ },
  { key: 'meniscus', re: /menisc/ },
  { key: 'ucl', re: /\bucl\b|ulnar collateral|tommy john/ },
  { key: 'rotator-cuff', re: /rotator cuff/ },
  { key: 'labrum', re: /\blabr(?:um|al)\b/ },
  { key: 'patellar', re: /\bpatellar?\b/ },
  { key: 'pectoral', re: /pectoral|\bpecs?\b/ },
  { key: 'hamstring', re: /hamstring/ },
  { key: 'oblique', re: /\boblique/ },
  { key: 'fibula', re: /fibula/ },
  { key: 'concussion', re: /concussion/ },
];

// Earliest text position wins.
const GENERAL: readonly Rule[] = [
  { key: 'ankle', re: /\bankles?\b|syndesmo/ },
  { key: 'knee', re: /\bknees?\b|\bmcl\b|\bpcl\b|medial collateral|posterior cruciate/ },
  { key: 'foot', re: /\bfoot\b|\bfeet\b|plantar|lisfranc|jones fracture|metatarsal|\btoes?\b/ },
  { key: 'hip', re: /\bhip\b/ },
  { key: 'groin', re: /groin|adductor/ },
  { key: 'calf', re: /\bcalf\b|\bcalves\b|gastrocnemius|soleus/ },
  { key: 'quad', re: /\bquad(?:riceps)?\b/ },
  { key: 'shoulder', re: /shoulder|\bac joint\b|acromioclavicular|clavicle|collarbone/ },
  { key: 'elbow', re: /elbow/ },
  { key: 'wrist', re: /wrist/ },
  { key: 'hand', re: /\bhand\b/, falseFriend: true },
  { key: 'hand', re: /\bfingers?\b|\bthumbs?\b/ },
  { key: 'back', re: /\bback\b/, falseFriend: true },
  { key: 'back', re: /\blumbar\b|\bspine\b|\bspinal\b|vertebra|\bdiscs?\b/ },
  { key: 'neck', re: /\bneck\b/, falseFriend: true },
  { key: 'neck', re: /cervical|stinger|brachial plexus/ },
  { key: 'rib', re: /\bribs?\b/ },
  { key: 'arm', re: /\bbiceps?\b|\btriceps?\b|forearm|humerus/ },
];

export interface CanonicalKeyOptions {
  /**
   * Default true. Pass false for free prose (headlines), where back/neck/hand
   * are more likely English than anatomy.
   */
  allowFalseFriends?: boolean;
}

/** The canonical grouping key for an injury label, or null if it names no bucket. */
export function canonicalInjuryKey(
  text: string | null | undefined,
  options: CanonicalKeyOptions = {},
): string | null {
  if (!text) return null;
  const allowFalseFriends = options.allowFalseFriends ?? true;
  const haystack = text.toLowerCase();
  const usable = (r: Rule) => allowFalseFriends || !r.falseFriend;

  for (const rule of SPECIFIC) {
    if (usable(rule) && rule.re.test(haystack)) return rule.key;
  }

  let best: { key: string; at: number } | null = null;
  for (const rule of GENERAL) {
    if (!usable(rule)) continue;
    const at = haystack.search(rule.re);
    if (at >= 0 && (best === null || at < best.at)) best = { key: rule.key, at };
  }
  return best?.key ?? null;
}
