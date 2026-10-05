/**
 * THE ONE SOURCE for every fixed string a ledger reader sees: the card
 * disclaimer strip, the full ledger-page disclaimer, the AI disclosure line,
 * the reliance line, the physician credit, the publisher line, the public bio,
 * the canned personal-question reply and the source-tier legend (spec:
 * "Liability framing → Disclaimer language", "AI disclosure", "Byline and
 * entity structure", "Wagering and licensing stance → Phase 1", "Voice and
 * social integration → Accountability line", "Card content spec → Static").
 *
 * Cards, posts and pages all render from here so the text cannot drift between
 * them. A byte-identical copy lives at `lib/ledger-copy.ts` in
 * sidelineiq-frontend; both are pinned by `tests/fixtures/ledger-copy.json`,
 * which is RECORDED from this module by `src/scripts/ledger-copy-fixture.ts`.
 * Change the text here, bump LEDGER_COPY_VERSION, re-record, copy both across.
 *
 * Deliberately separate from `src/config/brand.ts`. `BRAND_SIGNATURE`
 * ("AI-generated analysis. Physician-founded.") is the line on the autonomous
 * injury posts, which no physician reviews. The ledger's line says every
 * forecast IS reviewed and signed. The spec: "A card that has not been reviewed
 * does not carry the credential." Keeping the two in different modules is what
 * stops one being pasted where the other belongs.
 *
 * The disclaimer wording is the spec's, pending counsel. Counsel's edits land
 * here and nowhere else. No imports, so the frontend twin is a plain copy.
 */

export const LEDGER_COPY_VERSION = 1;

/** D8 (2026-10-04): name and degree only. No specialty, no certification claim. */
export const PHYSICIAN_CREDENTIAL = 'Keith P. Johnson, MD';

/** Brand case decided 2026-10-04: the site's styling, not the spec's lower-case p. */
export const LEDGER_BRAND = 'ParatrOs';

export const PUBLISHER_OF_RECORD = `Enovyr LLC, d/b/a ${LEDGER_BRAND}`;

/** As printed on cards. The link itself is siteOrigin() + LEDGER_PATH. */
export const LEDGER_URL_DISPLAY = 'paratros.com/ledger';
export const LEDGER_PATH = '/ledger';

/** The aequOs link in the canned reply. Direct, like every social CTA. */
export const AEQUOS_LINK = 'https://aequos.io?ref=paratros';

const CARD_DISCLAIMER =
  `Educational commentary on publicly reported injuries. ${PHYSICIAN_CREDENTIAL} has not examined this athlete, ` +
  `reviewed imaging, or spoken with any treating clinician. Estimates are population-based and are not medical advice, ` +
  `a diagnosis, or a prediction about any individual's care. No reliance: see ${LEDGER_URL_DISPLAY}.`;

const FULL_DISCLAIMER =
  `${CARD_DISCLAIMER} Published by ${PUBLISHER_OF_RECORD}; not affiliated with any team, league, player, agent or sportsbook. ` +
  `Forecasts are informational, provided as-is without warranty, and no one should rely on them for any decision. ` +
  `No physician-patient relationship is created by this content or by replies to it. ` +
  `Personal medical questions go to your own physician.`;

export const LEDGER_COPY = Object.freeze({
  /** "Forecast reviewed by [Name], MD" — on the card image, not only in the bio. */
  credit: `Forecast reviewed by ${PHYSICIAN_CREDENTIAL}`,
  /** The smaller line beneath the credit. */
  publisher: `Published by ${LEDGER_BRAND}`,
  /** One fixed line, everywhere. Never "AI physician". */
  ai_disclosure: `Drafted with AI assistance. Every forecast is reviewed and signed by ${PHYSICIAN_CREDENTIAL}.`,
  /** Phase 1 reliance language, on every card and the ledger page. "No reliance", never "never for wagering". */
  reliance: 'Informational. Provided as-is, without warranty. No reliance for any purpose.',
  /** The card strip, legible at feed size. */
  card_disclaimer: CARD_DISCLAIMER,
  /** The ledger-page version. */
  full_disclaimer: FULL_DISCLAIMER,
  /** Public bio on both platforms. "Autonomous" is retired from public copy. */
  bio: `AI sports injury intelligence. Every forecast reviewed by ${PHYSICIAN_CREDENTIAL}.`,
  /** The one answer to a personal-injury question. */
  canned_personal_reply: `I can't comment on individual situations here. See your own physician, or ${AEQUOS_LINK}.`,
  /** Source-tier legend (spec "Sourcing discipline"). */
  source_tiers: Object.freeze({
    A: 'team/official or confirmed surgery',
    B: 'national or beat reporter',
    C: 'film only',
  }),
  /** What a forecast is called in public copy until a documented method exists. */
  estimate_noun: 'ledger estimate',
});

export type SourceTier = keyof typeof LEDGER_COPY.source_tiers;

/**
 * Words that may not appear in anything the ledger publishes (spec "Sourcing
 * discipline": vocabulary is estimate/forecast/expected, never diagnosis,
 * prognosis, assessment, recommend, never "should"; "Wagering → Phase 1": no
 * odds, lines, picks, plays, fade, lock; "Accountability line": "autonomous" is
 * retired). Matched as whole words, case-insensitive. The product name
 * "Prognosis Ledger" is exempt by construction: the check runs on card and post
 * copy, not on the wordmark.
 */
export const FORBIDDEN_PUBLIC_WORDS: readonly string[] = Object.freeze([
  'diagnosis',
  'diagnose',
  'diagnosed',
  'prognosis',
  'assessment',
  'recommend',
  'recommends',
  'recommended',
  'recommendation',
  'should',
  'odds',
  'pick',
  'picks',
  'play of the day',
  'fade',
  'lock',
  'parlay',
  'spread',
  'sportsbook',
  'autonomous',
  'ai physician',
  'lying',
  'spinning',
  'wrong',
]);

/** The forbidden words a text contains, in order of first appearance. Empty = clean. */
export function findForbiddenWords(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: { idx: number; word: string }[] = [];
  for (const word of FORBIDDEN_PUBLIC_WORDS) {
    const re = new RegExp(`(^|[^a-z])${word.replace(/\s+/g, '\\s+')}([^a-z]|$)`);
    const m = re.exec(lower);
    if (m) hits.push({ idx: m.index, word });
  }
  return hits.sort((a, b) => a.idx - b.idx).map((h) => h.word);
}
