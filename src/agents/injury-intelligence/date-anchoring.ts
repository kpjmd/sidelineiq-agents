/**
 * The DATE ANCHORING rules, shared verbatim by the pre-OTM date resolver
 * (date-resolution.ts) and by OTM itself (agent.ts).
 *
 * They were duplicated by copy-paste and had already drifted by Aug 2026 —
 * three bullets differed in wording between the two copies, which is how a
 * resolver rule and an OTM rule came to disagree about what an announcement
 * date anchors. Import this; never re-type it.
 *
 * The rule that changed here, and why: the block used to say "The announcement
 * date is the operative anchor even if the procedure itself occurred 1-2 days
 * earlier — that variance is negligible against a multi-week RTP window." True
 * for breaking news. Nine months wrong for a status update on an old injury.
 * ESPN's injuries endpoint is a STATUS TABLE, not a news wire: its per-row date
 * is a last-refresh timestamp that moves whenever availability changes, and it
 * becomes `reported_at`. Mykel Williams' 2025-11-02 ACL reconstruction was
 * dated 2026-08-19 that way and projected a 2027-05-15 return for an athlete
 * being discussed for Week 1.
 */
export const DATE_ANCHORING_SHARED = `DATE ANCHORING — CRITICAL:
- "Reported at" is when the SOURCE ARTICLE was published. "Current date" is today. Neither is automatically when the injury/surgery occurred — but "Reported at" IS the anchor for resolving relative date language in the source.
- Resolve relative date references in the source against "Reported at":
    - "today", "this morning", "earlier today" → the calendar date of "Reported at"
    - "yesterday" → one day before "Reported at"
    - A weekday name ("Wednesday", "Monday", etc.) → the most recent occurrence of that weekday on or before "Reported at". Example: if "Reported at" is Wed 2026-05-06 and the source says "the team announced Wednesday", the anchor date is 2026-05-06; if the source says "announced Monday", it is 2026-05-04.
    - "last week", "earlier this week", "recently" → ambiguous; do not set injury_date.
- An ANNOUNCEMENT is not an OCCURRENCE. When a source says the team "announced [surgery/injury] [day]", that day anchors the ANNOUNCEMENT. Use it as the injury/surgery date ONLY when the source indicates the event itself is NEW — a fresh occurrence, a just-performed procedure, or a first disclosure. In that case a 1-2 day variance between announcement and procedure is negligible against a multi-week RTP window.
- If the source instead describes RECOVERY, REHAB, RETURN, CLEARANCE, or elapsed time since the injury — "works his way back from", "recovering from", "was activated off the PUP list", "cleared for practice", "tore it last season", "underwent surgery in December", "N months post-op", "missed the entire 2025 season", "sidelined since Aug. 3" — then the injury or surgery happened EARLIER and the report date is NOT the anchor. Resolve the ORIGINAL date from the narrative.
- NEVER fall back to the report date, the current date, or a feed row's last-updated timestamp for an injury the source describes as ongoing. If the only date you could produce is the report date and the source describes an ongoing recovery, produce NO date at all and set the confidence to 'unknown'. An absent date is recoverable downstream; a confidently wrong one is not — it silently shifts every week of the return-to-play projection.
- SOURCE KIND matters. For a structured injury FEED, "Reported at" is a row's last-refresh timestamp on a status table — the row is re-stamped every time the athlete's availability changes, and the same URL serves every athlete in the league. It anchors relative language INSIDE that row's text, and is never by itself evidence that the injury occurred then. For an ARTICLE, "Reported at" is a genuine publication time.
- A roster designation of PUP-P, PUP-R, NFI-A or NFI-R states, by league rule, that the injury PREDATES the current training period. Treat it as positive evidence that the report date is not the injury date.
- Extract or infer the actual injury/surgery date from absolute references too (e.g., "underwent surgery in January", "injured three weeks ago", "recovering since October", "tore his ACL in Week 4 of last season"). Set "injury_date" whenever determinable by any of these rules.`;

/** Confidence ladder for a resolved injury date, as stored on the thread. */
export type DateAnchorConfidence = 'unknown' | 'possible' | 'probable' | 'confirmed';

export interface DateAnchorThread {
  injury_date: string | null | undefined;
  injury_date_confidence?: DateAnchorConfidence | string | null;
}

/**
 * Pick the ONE injury date everything downstream measures from.
 *
 * Two dates exist and can disagree: the resolver writes one onto the thread
 * (it saw the source narrative and, on Pass 2, the open web) and OTM emits its
 * own from the short description. Prefer the resolver when it is confident,
 * fall back to OTM, then to a low-confidence resolver date, then to nothing.
 *
 * This lived inline in the poller, chosen AFTER `processInjuryEvent` had
 * already returned — which meant conflict detection inside the agent ran
 * against a different anchor than the one the post was ultimately formatted
 * with. Both callers now use this function so there is exactly one rule.
 */
export function chooseDateAnchor(
  thread: DateAnchorThread | undefined | null,
  modelInjuryDate: string | undefined | null,
): string | null {
  const confidence = thread?.injury_date_confidence;
  if (thread?.injury_date && (confidence === 'probable' || confidence === 'confirmed')) {
    return thread.injury_date;
  }
  return modelInjuryDate ?? thread?.injury_date ?? null;
}
