/**
 * Every brand string an AUDIENCE reads, in one place (Phase 1 rename,
 * SidelineIQ → ParatrOs, decided 2026-09-14).
 *
 * Only published text belongs here: post and reply copy, the signature, the
 * referral tag. Internal identifiers — the repo and package names, the MCP
 * client name, log prefixes, Railway service names — stay as they are. The
 * Railway private hostnames are derived from the service names, so renaming a
 * service breaks every MCP connection.
 *
 * "OrthoTriage Master" is retired as a persona. "OTM" survives only as the
 * internal name of the clinical framework in skills/ and in code comments; it
 * must not appear in anything that publishes.
 */

/** Brand text. The capital O is deliberate (parallel to AequOs). */
export const BRAND_NAME = 'ParatrOs';

/** Domain, handle, slug and tag contexts. */
export const BRAND_SLUG = 'paratros';

/**
 * The site origin every post link, IndexNow ping and republish uses.
 *
 * Canonical since the domain cutover (2026-09-17) is www.paratros.com — Vercel
 * 308s the apex to www, and sidelineiq.vercel.app 308s to the same path here,
 * so links in posts published before the cutover keep resolving. Production
 * sets SITE_URL; this is only the fallback, and it used to be copied into six
 * files.
 */
export const DEFAULT_SITE_URL = 'https://www.paratros.com';

/** SITE_URL, or the canonical default, with any trailing slash removed. */
export function siteOrigin(): string {
  return (process.env.SITE_URL ?? DEFAULT_SITE_URL).replace(/\/$/, '');
}

/** The byline on every post and reply. */
export const BRAND_SIGNATURE = `— ${BRAND_NAME} | AI-generated analysis. Physician-founded.`;

/** What our return-to-play estimate is called beside a team's timeline. */
export const BRAND_READ_LABEL = `${BRAND_NAME} read`;

/** The estimate window, as a phrase inside a sentence. */
export const BRAND_WINDOW_PHRASE = `the ${BRAND_NAME} window`;

/**
 * Rewrite the retired persona out of MODEL-WRITTEN prose.
 *
 * The prompt now says not to use it, but the skill files the model reads call
 * the clinical framework "OTM" throughout, and the model has always echoed
 * that into published text: 154 hits across 498 published posts, still 4 of 39
 * in September 2026 ("OTM is tracking…", "**OTM Three-Axis
 * Classification:**", "OTM's rules are clear"). A prompt instruction is a
 * request; this is the guarantee.
 *
 * Order matters:
 *  1. "OTM" naming the FRAMEWORK is dropped, not renamed — "the OTM three-axis
 *     system" becomes "the three-axis system".
 *  2. The possessive becomes "our", which reads naturally where "ParatrOs's"
 *     does not.
 *  3. Any remaining standalone "OTM" is the platform speaking, and becomes the
 *     brand. Word-bounded and case-sensitive, so "otm_projection" and words
 *     containing the letters are untouched.
 */
export function rebrandPersona(text: string): string {
  if (!text) return text;
  return text
    .replace(/\bOrthoTriage Master\s*\(OTM\)/g, BRAND_NAME)
    .replace(/\bOrthoTriage Master\b/g, BRAND_NAME)
    .replace(
      /\bOTM\s+(?=(?:three-axis|inference|classification|framework|taxonomy|protocol|tissue)\b)/gi,
      '',
    )
    .replace(/(^|[.!?]\s+|\n\s*)OTM(?:'|’)s\b/g, (_m, lead: string) => `${lead}Our`)
    .replace(/\bOTM(?:'|’)s\b/g, 'our')
    .replace(/\bOTM\b/g, BRAND_NAME);
}
