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
 *
 * The YEAR RESOLUTION bullets were added later, for a failure one layer down.
 * Getting the report date out of the way left the model free to pick a year for
 * a bare month, and it picked the wrong one every time: with today = 2026-09-09
 * three December injuries resolved to the December BEFORE the most recent one,
 * and every MD correction was exactly +1 year (Micah Parsons 2024-12-14 →
 * 2025-12-14, Patrick Mahomes 2024-12-15 → 2025-12-15, Noah Sewell 2024-12-28 →
 * 2025-12-28). Nothing here or in code had ever said that an NFL season
 * straddles the calendar year, that a bare month means the most recent past
 * occurrence, or that a Week number maps to a date. The arithmetic itself is
 * now done in code (season-calendar.ts) and handed over as a CALENDAR
 * REFERENCE block; these bullets tell the model that block outranks its own
 * reckoning. The block reference is phrased conditionally on purpose — agent.ts
 * interpolates this same constant and does not (yet) carry one.
 */
export const DATE_ANCHORING_SHARED = `DATE ANCHORING — CRITICAL:
- "Reported at" is when the SOURCE ARTICLE was published. "Current date" is today. Neither is automatically when the injury/surgery occurred — but "Reported at" IS the anchor for resolving relative date language in the source.
- Resolve relative date references in the source against "Reported at":
    - "today", "this morning", "earlier today" → the calendar date of "Reported at"
    - "yesterday" → one day before "Reported at"
    - A weekday name ("Wednesday", "Monday", etc.) → the most recent occurrence of that weekday on or before "Reported at". Example: if "Reported at" is Wed 2026-05-06 and the source says "the team announced Wednesday", the anchor date is 2026-05-06; if the source says "announced Monday", it is 2026-05-04.
    - "last week", "earlier this week", "recently" → ambiguous; do not set injury_date.
    - Resolve weekday names and "today"/"yesterday" against the LOCAL calendar date stated in the CALENDAR REFERENCE block, not against the UTC timestamp. A feed row stamped just after midnight UTC carries the PREVIOUS day's local date, and "the team announced Wednesday" means the local Wednesday.
- An ANNOUNCEMENT is not an OCCURRENCE. When a source says the team "announced [surgery/injury] [day]", that day anchors the ANNOUNCEMENT. Use it as the injury/surgery date ONLY when the source indicates the event itself is NEW — a fresh occurrence, a just-performed procedure, or a first disclosure. In that case a 1-2 day variance between announcement and procedure is negligible against a multi-week RTP window.
- If the source instead describes RECOVERY, REHAB, RETURN, CLEARANCE, or elapsed time since the injury — "works his way back from", "recovering from", "was activated off the PUP list", "cleared for practice", "tore it last season", "underwent surgery in December", "N months post-op", "missed the entire 2025 season", "sidelined since Aug. 3" — then the injury or surgery happened EARLIER and the report date is NOT the anchor. Resolve the ORIGINAL date from the narrative.
- NEVER fall back to the report date, the current date, or a feed row's last-updated timestamp for an injury the source describes as ongoing. If the only date you could produce is the report date and the source describes an ongoing recovery, produce NO date at all and set the confidence to 'unknown'. An absent date is recoverable downstream; a confidently wrong one is not — it silently shifts every week of the return-to-play projection.
- SOURCE KIND matters. For a structured injury FEED, "Reported at" is a row's last-refresh timestamp on a status table — the row is re-stamped every time the athlete's availability changes, and the same URL serves every athlete in the league. It anchors relative language INSIDE that row's text, and is never by itself evidence that the injury occurred then. For an ARTICLE, "Reported at" is a genuine publication time.
- A roster designation of PUP-P, PUP-R, NFI-A or NFI-R states, by league rule, that the injury PREDATES the current training period. Treat it as positive evidence that the report date is not the injury date.
- Extract or infer the actual injury/surgery date from absolute references too (e.g., "underwent surgery in January", "injured three weeks ago", "recovering since October", "tore his ACL in Week 4 of last season"). Set "injury_date" whenever determinable by any of these rules.
- YEAR RESOLUTION. A month or week reference carrying no year is the largest single error source here, and it fails SILENTLY: "December 14" resolved into the wrong year moves the anchor 365 days and every projected week with it. Resolve years by these rules, in order:
    - A bare month name means the MOST RECENT PAST-OR-CURRENT occurrence of that month relative to "Current date". Never a month in the future. Never a year earlier than that most recent occurrence unless the source states the year, or states an elapsed span that requires it ("two years ago", "in his rookie season").
    - NFL, NBA and Premier League seasons STRADDLE the calendar year. So "last season" names a SPAN, not a year, and a December inside a season belongs to the FIRST of that season's two calendar years.
    - "Week N" is an NFL regular-season week, not a calendar week. Week 1 is the season opener in early September; Week N falls roughly (N − 1) weeks after it.
    - A year you INFERRED rather than read is worth at most 'probable'. 'confirmed' requires the year to be stated in the source, or to be the unambiguous most-recent occurrence named in the CALENDAR REFERENCE block.
    - If a CALENDAR REFERENCE block appears in the user message, it is COMPUTED and AUTHORITATIVE. Read the year, the season spans and the local calendar date off it; do not redo that arithmetic yourself. A date you emit outside every span it lists needs explicit support in the source text.
- The injury date and the surgery date must fall in the SAME season unless the source says otherwise, and surgery is NEVER before the injury. If your two dates land roughly a year apart on or near the same calendar day, you have resolved one of them into the wrong year — re-read the source and fix it before emitting.`;

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

/**
 * The two confidences at which `chooseDateAnchor` already treats the thread's
 * date as authoritative. ONE list, so "settled" and "wins the anchor" can never
 * come to mean different things.
 */
const ANCHOR_CONFIDENCES = new Set<string>(['probable', 'confirmed']);

export interface SettledDateThread {
  injury_date?: string | null;
  injury_date_confidence?: DateAnchorConfidence | string | null;
  date_resolution_sources?: Array<{ stage?: string | null } | null> | null;
}

/** Has an MD hand-entered this thread's date? Keyed on provenance, not value. */
export function hasManualDate(thread: SettledDateThread | null | undefined): boolean {
  return (thread?.date_resolution_sources ?? []).some((s) => s?.stage === 'md_manual');
}

export type SettledReason = 'md_manual' | 'anchored';

/**
 * Is this thread's injury date SETTLED — i.e. is re-running the resolver
 * against it work whose result is already discarded?
 *
 * `resolveInjuryDate` is two Sonnet calls (up to four, with a web search) and
 * the poller ran it on EVERY cycle that reached it, with no "already resolved"
 * check anywhere. Because the call is nondeterministic, the same event resolved
 * to a different date on different cycles: Patrick Mahomes went 2025-12-14 →
 * 2025-12-15 → 2024-12-15 → 2025-12-15 across three system writes six hours
 * apart, all at web_search=false, so it is plain sampling variance rather than
 * anything the web told us. Danny Pinter flipped 08-19 ↔ 08-20 four times.
 * Worse, the system twice reverted a date an MD had hand-corrected (Alvin
 * Kamara, Jayden Higgins), and on Micah Parsons it did so seven minutes after
 * the edit.
 *
 * Two ways to be settled, and they are settled for different reasons:
 *
 *  - `md_manual` — an MD's date, at ANY confidence and even with a NULL date.
 *    `updateThreadDates` on the MCP side already nulls out every date field of
 *    a system write once md_manual provenance is stored, so resolving again
 *    cannot change anything. Skipping is not a policy change here; it is
 *    deleting work whose result is thrown away.
 *  - `anchored` — a real date at probable/confirmed. That is exactly the state
 *    in which `chooseDateAnchor` above already ignores whatever the resolver
 *    says this cycle, so re-resolving can only ever produce a write that
 *    changes the stored date out from under a projection frozen against it.
 *
 * A thread with NO date is never settled, whatever its confidence claims — so
 * first establishment always resolves, and `updateThreadDates`' first
 * `otm_projection_reanchored` still fires.
 *
 * The trade-off, stated plainly: a first-pass wrong-but-confident date now
 * freezes instead of getting another roll of the dice. That is deliberate. The
 * re-roll was never a repair mechanism — 31 reanchor rows across 13 threads
 * converged on nothing — and what defends against a wrong date settling is
 * upstream: validateResolvedDates caps an incoherent emit below `probable`, and
 * assessAnchorDivergence below un-settles a thread whose date disagrees with
 * OTM's by a year.
 */
export function isSettledThreadDate(
  thread: SettledDateThread | null | undefined,
): { settled: boolean; reason: SettledReason | null } {
  if (!thread) return { settled: false, reason: null };
  if (hasManualDate(thread)) return { settled: true, reason: 'md_manual' };
  // web_thread_get normalizes to YYYY-MM-DD, but timestamps have leaked in on
  // other paths before (see the mcp date-normalization tests), so slice rather
  // than trust.
  const iso = typeof thread.injury_date === 'string' ? thread.injury_date.slice(0, 10) : '';
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const anchored = ANCHOR_CONFIDENCES.has(String(thread.injury_date_confidence ?? ''));
  return dated && anchored
    ? { settled: true, reason: 'anchored' }
    : { settled: false, reason: null };
}

export type AnchorDivergenceKind = 'none' | 'year_apart' | 'other';

export interface AnchorDivergence {
  kind: AnchorDivergenceKind;
  days_apart: number | null;
  resolver_date: string | null;
  otm_date: string | null;
}

const YEAR_APART_MIN_DAYS = 300;
const YEAR_APART_MAX_DAYS = 430;

/**
 * How far apart on the month/day circle two dates may sit and still read as
 * "the same time of year, one year apart".
 *
 * 30 rather than a few days because the two sides are not the same quantity:
 * the resolver emits an injury date while OTM's `post.injury_date` is whatever
 * OTM anchored on, which is sometimes the surgery. Micah Parsons is the case
 * that sets this number — resolver 2024-12-14 against OTM 2025-12-29, 380 days
 * apart and 15 days apart on the calendar. A ±5 bar caught Mahomes and missed
 * him.
 *
 * Note this is deliberately LOOSER than validateResolvedDates' equivalent
 * check, which compares an injury and a surgery date from ONE emit. There a
 * genuine delayed procedure a year later is common, so only a near-identical
 * calendar day is evidence of a year error. Here both numbers are answers to
 * the same question, so mere same-time-of-year already is.
 */
const SAME_TIME_OF_YEAR_TOLERANCE_DAYS = 30;

function utcMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return t;
}

/** Distance between two dates on the month/day circle alone, ignoring year. */
function calendarDayGap(aMs: number, bMs: number): number {
  const dayOf = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(2001, d.getUTCMonth(), Math.min(d.getUTCDate(), 28)) / 86_400_000;
  };
  const raw = Math.abs(dayOf(aMs) - dayOf(bMs));
  return Math.min(raw, 365 - raw);
}

/**
 * Compare the resolver's injury date against the one OTM emitted for the same
 * event, and name the disagreement.
 *
 * The poller already LOGGED this divergence and then always preferred the
 * resolver. Both live wrong-year cases announced themselves on that line and
 * nothing acted on it:
 *
 *   [Poller] date anchor divergence for Micah Parsons: OTM said 2025-12-29,
 *     resolver said 2024-12-14 (confidence confirmed) — using the resolver's
 *   [Poller] date anchor divergence for Patrick Mahomes: OTM said 2025-12-15,
 *     resolver said 2024-12-15 (confidence confirmed) — using the resolver's
 *
 * OTM had the year right both times; the Parsons post's own prose said
 * "December 29, 2025 … approximately 35 weeks post-op" beside an injury_date
 * column reading 2024-12-14.
 *
 * `year_apart` requires BOTH a ~year gap AND the same time of year. A genuinely
 * delayed procedure does happen about a year later; it virtually never lands
 * near the same calendar day. That conjunction is what separates a year error
 * from a real interval, and it is why the bar is not simply "> 300 days apart".
 *
 * This function does NOT pick a winner. A divergence is evidence that one of
 * the two is wrong, not evidence of which — with n = 2 on OTM being right,
 * silently inverting the preference would trade one unexamined rule for
 * another. The caller downgrades and asks a human.
 */
export function assessAnchorDivergence(
  resolverDate: string | null | undefined,
  otmDate: string | null | undefined,
): AnchorDivergence {
  const r = typeof resolverDate === 'string' ? resolverDate.slice(0, 10) : null;
  const o = typeof otmDate === 'string' ? otmDate.slice(0, 10) : null;
  const rMs = utcMs(r);
  const oMs = utcMs(o);
  if (rMs === null || oMs === null) {
    return { kind: 'none', days_apart: null, resolver_date: r, otm_date: o };
  }
  const days = Math.abs(Math.round((oMs - rMs) / 86_400_000));
  if (days === 0) return { kind: 'none', days_apart: 0, resolver_date: r, otm_date: o };
  const kind: AnchorDivergenceKind =
    days >= YEAR_APART_MIN_DAYS &&
    days <= YEAR_APART_MAX_DAYS &&
    calendarDayGap(rMs, oMs) <= SAME_TIME_OF_YEAR_TOLERANCE_DAYS
      ? 'year_apart'
      : 'other';
  return { kind, days_apart: days, resolver_date: r, otm_date: o };
}
