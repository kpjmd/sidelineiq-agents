import Anthropic from '@anthropic-ai/sdk';
import { DATE_ANCHORING_SHARED, chooseDateAnchor } from './date-anchoring.js';
import {
  computeConflictGap,
  isConflict,
  type ConflictGap,
} from '../../utils/conflict-gap.js';
import { loadSkillContext } from '../../utils/skill-loader.js';
import { validateRTPEstimate } from './rtp-estimator.js';
import type {
  ClassificationResult,
  InjuryPostContent,
  InjurySeverity,
  ContentType,
  ReturnToPlayEstimate,
  SportKey,
} from '../../types.js';

const MODEL = 'claude-sonnet-4-6';

/** Exported so tests can assert on the schema the model actually receives. */
export const AGENT_TOOL = {
  name: 'emit_injury_post',
  description:
    'Emit a structured injury post after completing the OTM three-axis classification, RTP estimation, and content drafting steps from SKILL.md.',
  input_schema: {
    type: 'object' as const,
    properties: {
      injury_type: {
        type: 'string',
        description:
          'Clinical injury type in OTM taxonomy (e.g., "High ankle sprain Grade 2", "ACL tear", "Grade 2 hamstring strain").',
      },
      injury_severity: {
        type: 'string',
        enum: ['MINOR', 'MODERATE', 'SEVERE', 'UNKNOWN'],
        description:
          'Severity per SKILL.md Section 1. MINOR = day-to-day, MODERATE = weeks, SEVERE = season-ending or surgical, UNKNOWN = insufficient info.',
      },
      content_type: {
        type: 'string',
        enum: ['BREAKING', 'TRACKING', 'DEEP_DIVE', 'CONFLICT_FLAG'],
        description:
          'Content type. Use the classifier hint unless a team timeline vs OTM estimate conflict is detected, in which case use CONFLICT_FLAG.',
      },
      headline: {
        type: 'string',
        description: 'A tight, neutral headline. No speculation.',
      },
      clinical_summary: {
        type: 'string',
        description:
          'The OTM clinical breakdown written as plain narrative prose for public consumption. Lead with 1-2 plain sentences describing the injury and its significance — these appear directly in social posts. Clinical reasoning and evidence basis may follow, but must be written as prose, not as labeled taxonomy headers. Never include "Axis N —", "Evidence Tier:", "SKILL.md", "OTM protocol", "MD review flagged", or escalation protocol language in this field. CONFIRMED and INFERRED may appear naturally in prose but not as classification headers.',
      },
      return_to_play: {
        type: 'object',
        properties: {
          // Described deliberately and distinctly. An undescribed numeric
          // field is exactly how the two confidence values collapsed onto one
          // number (PR #30) — and how 34-43 TOTAL weeks came to be read as
          // remaining time for an athlete nine months post-op.
          min_weeks: {
            type: 'number',
            description:
              'Lower bound of the return-to-play window, in weeks, measured as TOTAL time from the injury/surgery date (the injury_date field) — NOT remaining time from today. This is the literature floor for this injury per SKILL.md Section 2.3/2.4 and rtp-probability-tables.md, and it does not shrink as the athlete rehabs: an ACL reconstruction is roughly 39 whether the surgery was last week or nine months ago. Remaining time is derived downstream from injury_date; never pre-subtract elapsed time here.',
          },
          max_weeks: {
            type: 'number',
            description:
              'Upper bound of the return-to-play window, in weeks, measured as TOTAL time from the injury/surgery date — the same anchor and the same non-shrinking semantics as min_weeks. When the procedure type is undisclosed, widen THIS bound rather than lowering min_weeks.',
          },
          probability_week_2: { type: 'number' },
          probability_week_4: { type: 'number' },
          probability_week_8: { type: 'number' },
          confidence: {
            type: 'number',
            description:
              'Confidence in THIS RTP range specifically, 0 to 1 — how good the literature behind the timeline is, NOT how well-sourced the news report is. Anchor to the SKILL.md evidence tier for this injury: T1 (multiple RCTs or large prospective cohorts — ACL reconstruction, Achilles repair, Jones fracture) → 0.85-0.95. T2 (observational studies, expert consensus, established protocols — hamstring Grade 2, MCL sprain, high ankle sprain) → 0.65-0.85. T3 (limited studies, high variability — chondral injury, multi-ligament knee, turf toe Grade 3) → 0.40-0.65. T4 (biological anchor only, no reliable RTP literature) → 0.20-0.40. Set 0 for CONCUSSION and SYSTEMIC events, where no RTP estimate may be made at all.',
          },
        },
        required: [
          'min_weeks',
          'max_weeks',
          'probability_week_2',
          'probability_week_4',
          'probability_week_8',
          'confidence',
        ],
        description:
          'Return-to-play estimate per SKILL.md Section 3 and rtp-probability-tables.md. Probabilities must be monotonically non-decreasing across week_2 → week_4 → week_8.',
      },
      confidence: {
        type: 'number',
        description:
          'Confidence in the POST as a whole, 0 to 1. This is a DIFFERENT judgement from return_to_play.confidence and will usually be a different number — do not copy one into the other. Score what you know about the EVENT, not the strength of the literature: is the injury confirmed by imaging or a team statement rather than inferred from a mechanism; are the athlete, team and side unambiguous in the source; do the sources agree; is this a primary outlet or an aggregator repeating one. Start at 0.90 when the diagnosis is confirmed and the reporting is unambiguous, then subtract for each thing you are inferring rather than reading: about 0.10 for an inferred grade, 0.10 for unconfirmed laterality, 0.15 for a single anonymous-source report, 0.20 when sources conflict on the diagnosis itself. A low score routes the post to physician review before publication, so do not lower it to express ordinary clinical caution — return_to_play.confidence and the clinical_summary carry that. This field measures how sure you are of the facts.',
      },
      team: {
        type: 'string',
        description:
          'The athlete\'s current team. Use the source value if provided. If the source says "Unknown" or is blank, use your training knowledge to provide the correct current team name.',
      },
      conflict_reason: {
        type: 'string',
        description:
          'If content_type is CONFLICT_FLAG, a one-sentence explanation of the disagreement between team timeline and OTM estimate.',
      },
      team_timeline_weeks: {
        type: 'number',
        description:
          'Weeks the team or source says REMAIN before return, counted forward from the "Reported at" date — NOT total time since the injury, and NOT time since surgery. This is a DIFFERENT CLOCK from min_weeks/max_weeks, which are total from injury_date; downstream code converts this to a total by adding elapsed time, so a number that already includes elapsed time is counted twice. Examples: "2-4 weeks" → 3. "back in six weeks" → 6. "targeting Week 5" reported in Week 1 → 4. "now 33 weeks post-op, expected back in about 6" → 6, never 33 and never 39. OMIT this field entirely for: game-status designations (Questionable, Probable, Doubtful, Out, or day-to-day with no week count) — those are availability labels, not timelines; and season-ending statements (out for the season, PUP, IR, reserve/PUP) — those are administrative floors, not estimates. If you would have to ADD elapsed time to produce the number, you are computing the wrong quantity: omit the field instead.',
      },
      injury_date: {
        type: 'string',
        description:
          'ISO 8601 date (YYYY-MM-DD) when the injury or surgery ORIGINALLY occurred. Set this whenever the date is determinable — including when it is resolved from a relative reference in the source ("Wednesday", "yesterday", "today", "the team announced Wednesday") against the "Reported at" anchor per the DATE ANCHORING rules. The value must reflect when the injury/surgery itself happened, not the report date — resolving "Wednesday" against the report date IS a valid way to determine that, but only when the source describes the event as NEW. For a carryover injury — one the source describes as an ongoing recovery ("works his way back from", "activated off the PUP list", "tore it last season", "N months post-op") — this is the ORIGINAL injury or surgery date, never the date of the status update you are reading. If you cannot determine the original date, OMIT this field rather than substituting the report date.',
      },
    },
    required: [
      'injury_type',
      'injury_severity',
      'content_type',
      'headline',
      'clinical_summary',
      'return_to_play',
      'confidence',
    ],
  },
};

function buildSystemPrompt(core: string, rtpTables: string, sportReference: string | null): string {
  const sections = [
    core,
    '\n\n--- RTP PROBABILITY TABLES ---\n\n',
    rtpTables,
  ];
  if (sportReference) {
    sections.push('\n\n--- SPORT REFERENCE ---\n\n', sportReference);
  }
  sections.push(
    '\n\n--- OUTPUT INSTRUCTIONS ---\n\n',
    'You must call the emit_injury_post tool exactly once with your final structured output. ',
    'Complete the OTM three-axis classification before selecting an RTP range. ',
    'Never emit an RTP estimate for CONCUSSION or SYSTEMIC events — in those cases, set return_to_play probabilities to 0 and return_to_play.confidence to 0. The post-level confidence field is unaffected: it describes how sure you are of the reported facts, not of a timeline you are declining to give. ',
    'State whether the injury grade is CONFIRMED (imaging/team confirmed) or INFERRED (reasoned from mechanism and reporting) in the clinical_summary. ',
    'CRITICAL — clinical_summary format rules: The clinical_summary must be written as public-facing narrative prose throughout. ',
    'Do NOT include internal taxonomy labels such as "Axis 1 — Tissue:", "Axis 2 — Severity:", "Axis 3 — Region:", "Evidence Tier:", "Flag: ESCALATION", or "ESCALATION —". ',
    'Do NOT mention "SKILL.md", "OTM protocol", "MD review flagged per protocol", or "per OTM protocol" — these are internal processing notes and must never appear in published content. ',
    'CONFIRMED and INFERRED may appear naturally in prose (e.g., "the ACL tear is confirmed by imaging") but must not be formatted as classification headers. ',
    'End clinical_summary on the clinical take — never with an escalation flag, protocol note, or MD review reference.'
  );
  return sections.join('');
}

/**
 * Parses a team-reported timeline string into a midpoint number of weeks
 * REMAINING from the report date — the same clock as `team_timeline_weeks`.
 * Examples:
 *   "2-4 weeks"       → 3
 *   "week to week"    → 1
 *   "day-to-day"      → 0 (sub-week; the DB column is an integer)
 *   "out for season"  → null (a floor, not an estimate)
 *   "6 weeks"         → 6
 * Returns null if unparseable.
 */
export function parseTeamTimeline(timeline: string): number | null {
  if (!timeline) return null;
  const t = timeline.toLowerCase().trim();

  // Season-ending, PUP and IR are administrative FLOORS, not return estimates.
  // Reading one as "24 weeks" made a fresh season-ending ACL look like the team
  // was 15 weeks faster than the literature — a manufactured conflict against a
  // statement that made no timeline claim at all. SKILL.md Rule 5 cannot be
  // "faster or slower" than a floor.
  if (/out\s+for\s+(the\s+)?season|season[- ]ending/.test(t)) return null;
  if (/day[- ]to[- ]day/.test(t)) return 0; // sub-week; round to 0 for DB integer column
  if (/week[- ]to[- ]week/.test(t)) return 1;
  if (/questionable|probable/.test(t)) return null; // game-status, not a timeline estimate

  // "2-4 weeks", "2 to 4 weeks"
  const range = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*week/);
  if (range) {
    const lo = parseFloat(range[1]);
    const hi = parseFloat(range[2]);
    return Math.round((lo + hi) / 2);
  }

  // "6 weeks", "2 months"
  const single = t.match(/(\d+(?:\.\d+)?)\s*(week|month)/);
  if (single) {
    const n = parseFloat(single[1]);
    return Math.round(single[2].startsWith('month') ? n * 4 : n);
  }

  return null;
}

/**
 * Detects TIMELINE COMPRESSION across a thread's reported timelines: when the
 * team has shortened the reported return window faster than calendar time can
 * explain (you cannot heal faster than time passes). Longitudinal — needs >= 2
 * dated reports. Returns false when no thread history is supplied, so the
 * single-snapshot behavior is unchanged for callers that omit it.
 */
function detectTimelineCompression(
  priorTimelines?: Array<{ reported_weeks: number | null; at: string }>
): boolean {
  if (!priorTimelines) return false;
  const pts = priorTimelines
    .filter((p) => p.reported_weeks !== null && !!p.at)
    .map((p) => ({ weeks: p.reported_weeks as number, t: Date.parse(p.at) }))
    .filter((p) => !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return false;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const elapsedWeeks = (last.t - first.t) / (7 * 86_400_000);
  const timelineDrop = first.weeks - last.weeks; // positive = window shrinking
  // Flag when the reported window shrank more than 2 weeks beyond what elapsed
  // calendar time can account for.
  return timelineDrop - elapsedWeeks > 2;
}

/** Where a conflict verdict is measured from. See chooseDateAnchor. */
export interface ConflictAnchor {
  /** The reconciled injury/surgery date. Null when unresolved. */
  injury_date: string | null | undefined;
  /** Injectable clock for tests; defaults to now. */
  now?: Date;
}

export interface ConflictVerdict {
  conflict: boolean;
  reason?: string;
  timeline_compression?: boolean;
  /** The arithmetic behind the verdict, for logging, display and the ambiguity guard. */
  gap: ConflictGap;
}

/**
 * Detects a CONFLICT_FLAG between team timeline and OTM estimate.
 *
 * The two numbers are on different clocks — `teamTimelineWeeks` is REMAINING
 * from the report, `rtp.min_weeks`/`max_weeks` are TOTAL from `injury_date` —
 * so the comparison runs through computeConflictGap, which converts the team's
 * disclosure to a total before comparing. See src/utils/conflict-gap.ts.
 *
 * Two behaviours changed when the anchor arrived, both deliberate:
 *   - The bar is the WINDOW, not its midpoint. SKILL.md Rule 5 says "faster or
 *     slower than literature minimum"; the midpoint rule flagged athletes
 *     sitting comfortably inside the literature range but off-centre.
 *   - Without an anchor there is no verdict. `no_anchor` returns no conflict
 *     rather than a number computed from a guess.
 *
 * Compression detection is anchor-INDEPENDENT — it compares successive
 * remaining-week disclosures against elapsed calendar time between the reports,
 * which is already an apples-to-apples comparison — so it still fires when
 * `injury_date` is unresolved.
 */
export function detectConflict(
  teamTimelineWeeks: number | null,
  rtp: ReturnToPlayEstimate,
  anchor: ConflictAnchor,
  priorTimelines?: Array<{ reported_weeks: number | null; at: string }>
): ConflictVerdict {
  const gap = computeConflictGap({
    team_timeline_weeks: teamTimelineWeeks,
    min_weeks: rtp.min_weeks,
    max_weeks: rtp.max_weeks,
    injury_date: anchor.injury_date,
    as_of: anchor.now ?? new Date(),
  });

  const snapshot = ((): { conflict: boolean; reason?: string } => {
    if (teamTimelineWeeks === null) return { conflict: false };

    // "day-to-day" parses to 0, but for serious injuries it means the team
    // hasn't disclosed a real timeline — not that the athlete returns in days.
    // Suppress conflict when OTM's minimum estimate is 4+ weeks.
    if (teamTimelineWeeks === 0 && rtp.min_weeks >= 4) return { conflict: false };

    if (!isConflict(gap)) return { conflict: false };

    const anchorPhrase =
      gap.elapsed_weeks !== null
        ? `~${teamTimelineWeeks}w remaining, ~${gap.team_total_weeks}w total from ${String(anchor.injury_date).slice(0, 10)}`
        : `~${teamTimelineWeeks}w remaining`;
    const direction =
      gap.status === 'shorter'
        ? `team timeline (${anchorPhrase}) is shorter than the OTM window (${rtp.min_weeks}-${rtp.max_weeks}w total from injury)`
        : `team timeline (${anchorPhrase}) is longer than the OTM window (${rtp.min_weeks}-${rtp.max_weeks}w total from injury)`;
    return {
      conflict: true,
      reason: `Reporting conflict: ${direction}.`,
    };
  })();

  if (detectTimelineCompression(priorTimelines)) {
    const compReason =
      'Timeline compression: the team has shortened the reported return window across successive reports faster than biological healing allows.';
    return {
      conflict: true,
      reason: snapshot.reason ? `${snapshot.reason} ${compReason}` : compReason,
      timeline_compression: true,
      gap,
    };
  }
  return { ...snapshot, gap };
}

/**
 * Is this `team_timeline_weeks` value ambiguous about which clock it is on?
 *
 * The model has emitted this field as at least three different quantities:
 * remaining weeks (the intended meaning), TOTAL weeks post-surgery when it
 * reasoned about the calendar itself ("Week 5 is ~39 weeks post-op" → 39), and
 * a season length. Correcting the arithmetic on top of a field holding three
 * quantities produces a confidently wrong number instead of an obviously wrong
 * one, so a value that is ALSO plausible as a total, and whose reading changes
 * the verdict, routes to a human instead.
 *
 * Inert on fresh injuries by construction: it requires two weeks elapsed, and
 * under two weeks the two readings cannot differ meaningfully anyway.
 */
export function assessTimelineAnchorAmbiguity(
  teamTimelineWeeks: number,
  rtp: ReturnToPlayEstimate,
  anchor: ConflictAnchor,
): { ambiguous: boolean; remaining: ConflictGap; total: ConflictGap } {
  const asOf = anchor.now ?? new Date();
  const asOfIso = asOf.toISOString().slice(0, 10);
  const remaining = computeConflictGap({
    team_timeline_weeks: teamTimelineWeeks,
    min_weeks: rtp.min_weeks,
    max_weeks: rtp.max_weeks,
    injury_date: anchor.injury_date,
    as_of: asOf,
  });
  // The "already a total" reading: elapsed forced to zero, so the number is
  // compared to the window as-is.
  const total = computeConflictGap({
    team_timeline_weeks: teamTimelineWeeks,
    min_weeks: rtp.min_weeks,
    max_weeks: rtp.max_weeks,
    injury_date: asOfIso,
    as_of: asOf,
  });

  const elapsed = remaining.elapsed_weeks;
  const ambiguous =
    remaining.status !== 'no_anchor' &&
    remaining.status !== 'no_timeline' &&
    elapsed !== null &&
    elapsed >= 2 &&
    // A total can never be less than the time already elapsed. One week of
    // slack absorbs the floor/rounding boundary.
    teamTimelineWeeks >= elapsed - 1 &&
    isConflict(remaining) !== isConflict(total);

  return { ambiguous, remaining, total };
}

export interface DeepDiveInput {
  injury_type: string;
  sport: SportKey;
  count: number;
  athletes: string[];
  teams: string[];
}

/**
 * Injury-thread context passed to OTM by the Injury Thread Manager (poller),
 * assembled from the persisted entity + its injury_updates trajectory. Optional
 * everywhere — when absent, processInjuryEvent behaves exactly as before.
 */
export interface InjuryThreadContext {
  injury_date: string | null;
  injury_date_confidence: 'unknown' | 'possible' | 'probable' | 'confirmed';
  surgery_date: string | null;
  surgery_confirmed: boolean;
  status: 'ACTIVE' | 'RESOLVED' | 'RETIRED';
  // The thread's established body part/side, set once when the entity was
  // first created. Anchors Sonnet against silently flipping the side on a
  // later report (each event is otherwise independently re-read from raw text).
  body_part: string | null;
  laterality: 'LEFT' | 'RIGHT' | 'BILATERAL' | 'UNSPECIFIED' | null;
  // Oldest→newest reported timelines for this injury (includes the current event).
  prior_timelines: Array<{
    reported_weeks: number | null;
    otm_min_weeks: number | null;
    severity: string | null;
    at: string; // ISO timestamp
  }>;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Core Injury Intelligence agent.
 *
 * Takes a classified injury event and produces a fully-formed InjuryPostContent
 * ready for the publishing pipeline. Uses the Sonnet model with the full skill
 * context (SKILL.md + sport reference + RTP tables).
 *
 * Returns null on failure so the poller can skip this event and retry next cycle.
 */
export async function processInjuryEvent(
  classified: ClassificationResult,
  parentPostId?: string,
  thread?: InjuryThreadContext
): Promise<InjuryPostContent | null> {
  const raw = classified.raw_event;
  const context = `${classified.athlete_name} (${classified.sport}/${classified.team})`;

  try {
    const { core, rtpTables, sportReference } = await loadSkillContext(classified.sport);
    const system = buildSystemPrompt(core, rtpTables, sportReference);

    const today = new Date().toISOString().split('T')[0];
    const month = new Date().getMonth() + 1; // 1-indexed
    const isNFLOffseason = classified.sport === 'NFL' && month >= 4 && month <= 8;

    // Prepend thread context when the Injury Thread Manager supplied it. When
    // `thread` is undefined this is '' → the prompt is byte-identical to before.
    const establishedSide =
      thread && thread.laterality && thread.laterality !== 'UNSPECIFIED'
        ? `${thread.laterality} ${thread.body_part ?? 'side'}`.trim()
        : null;

    const threadBlock = thread
      ? `[INJURY THREAD CONTEXT]
This athlete has an existing tracked injury thread for this injury.
Resolved injury date: ${thread.injury_date ?? 'not yet resolved'} (confidence: ${thread.injury_date_confidence})
${establishedSide ? `Established injury: ${establishedSide} (from prior reporting on this thread). Do not contradict this side without an explicit correction signal in the new source (e.g., "corrected to left wrist", "previously misreported").\n` : ''}${thread.surgery_date ? `Surgery date: ${thread.surgery_date}${thread.surgery_confirmed ? ' (confirmed)' : ' (unconfirmed)'}\n` : ''}${
          thread.prior_timelines.length
            ? `Prior reported timelines (oldest→newest): ${thread.prior_timelines
                .map(
                  (t) =>
                    `${t.reported_weeks ?? '?'}w team / ${t.otm_min_weeks ?? '?'}w OTM${t.severity ? ` [${t.severity}]` : ''} @ ${t.at.slice(0, 10)}`
                )
                .join('; ')}\n`
            : ''
        }Use the resolved injury date above as the DATE ANCHOR when its confidence is probable or confirmed — it overrides relative-date inference from this single source. min_weeks and max_weeks remain TOTAL time from that anchor — do not shorten them to reflect rehab already completed. State the elapsed time, and where in the window the athlete sits, in clinical_summary instead. Do not treat a possible/unknown-confidence date as authoritative.
[END INJURY THREAD CONTEXT]

`
      : '';

    const userMessage = threadBlock + `Process this injury event into a structured post.

Sport: ${classified.sport}
Athlete: ${classified.athlete_name}
Team: ${classified.team}
Injury (raw): ${classified.injury_description}
${raw.team_timeline ? `Team-reported timeline: ${raw.team_timeline}` : 'Team timeline: not reported'}
Source: ${raw.source_url}
Reported at: ${raw.reported_at.toISOString()}
Current date: ${today}
Classifier hint — content_type: ${classified.content_type}, is_new: ${classified.is_new}
${parentPostId ? `This is an UPDATE to an existing story (parent post id: ${parentPostId}).` : ''}
${isNFLOffseason ? `NFL offseason context: It is currently the NFL offseason (April–August). A "Questionable" or "day-to-day" game-status designation is meaningless during the offseason — it is not a recovery timeline disclosure. Do NOT classify as CONFLICT_FLAG based solely on a stale game-status term. If OTM's recovery estimate aligns with a return by September (week 1 of the NFL season), classify as TRACKING and note the recovery trajectory. Reserve CONFLICT_FLAG only for cases where the team has provided a specific week-based timeline that is biologically irreconcilable with the injury.` : ''}

${DATE_ANCHORING_SHARED}
- min_weeks and max_weeks in return_to_play are TOTAL recovery time measured FROM the injury/surgery date — the value you set in "injury_date" — NOT remaining time from today. They are the literature range for this injury per SKILL.md Section 2.4 and rtp-probability-tables.md, and they do NOT shrink as the athlete rehabs. Example: an ACL reconstruction performed 9 months ago with a 9-12 month literature window is min_weeks 39, max_weeks 52 — not 0-12. Remaining time is derived downstream from injury_date plus these weeks; never pre-subtract elapsed time here.
- team_timeline_weeks is on the OPPOSITE clock from min_weeks/max_weeks: it is the weeks the team says REMAIN, counted from "Reported at", never total time since the injury. Downstream code adds elapsed time to it, so a number that already includes elapsed time is counted twice and manufactures a conflict that does not exist. For an athlete 33 weeks post-op whose team expects him back in about 6 weeks, this field is 6 — not 33, not 39. Omit it entirely for game-status designations (Questionable/Probable/Doubtful/Out/day-to-day with no week count) and for season-ending, PUP or IR statements: those are availability labels and administrative floors, not timelines.
- Do NOT state a week-gap number in conflict_reason. Give the clinical reasoning for why the timelines diverge; the arithmetic is computed and printed downstream from injury_date, and a number written here will contradict it.
- clinical_summary MUST state the elapsed time since injury/surgery whenever injury_date is known (e.g., "now 10 months post-op, inside a 9-12 month window"), so a reader can see WHERE in the window the athlete sits. It must never present the report date or the current date as if it were the injury/surgery date.
- If no rule above resolves a date, omit "injury_date". min_weeks and max_weeks remain the TOTAL range from injury regardless; state explicitly in clinical_summary that the start date is unconfirmed.

SURGICAL PROCEDURE UNCERTAINTY:
- If the source confirms surgery occurred but does not name the specific procedure (e.g., "underwent knee surgery" without specifying ACL reconstruction vs. meniscectomy vs. cartilage repair), the clinical_summary must explicitly state that the procedure type is not publicly disclosed.
- Provide the plausible RTP range across likely procedures for that injury type and explain what drives the variance. Do not anchor to a single timeline as if the procedure were known.
- This is distinct from grade uncertainty (CONFIRMED/INFERRED) — procedure uncertainty affects the width of the RTP range and must be named explicitly.

Follow SKILL.md exactly. Emit your final answer via the emit_injury_post tool.`;

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system,
      tools: [AGENT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_injury_post' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      console.error(`[Agent] No tool_use block returned for ${context}`);
      return null;
    }

    const input = toolUse.input as Record<string, unknown>;
    const rtpRaw = input.return_to_play as Record<string, unknown> | undefined;
    if (!rtpRaw) {
      console.error(`[Agent] Missing return_to_play in agent output for ${context}`);
      return null;
    }

    const rtpEstimate: ReturnToPlayEstimate = {
      // DB schema stores these as INTEGER — round any fractional weeks Claude returns
      min_weeks: Math.round(Number(rtpRaw.min_weeks ?? 0)),
      max_weeks: Math.round(Number(rtpRaw.max_weeks ?? 0)),
      probability_week_2: Number(rtpRaw.probability_week_2 ?? 0),
      probability_week_4: Number(rtpRaw.probability_week_4 ?? 0),
      probability_week_8: Number(rtpRaw.probability_week_8 ?? 0),
      confidence: Number(rtpRaw.confidence ?? 0),
    };

    const injuryType = String(input.injury_type ?? classified.injury_description);
    const severity = (input.injury_severity as InjurySeverity) ?? 'UNKNOWN';
    const injuryDate = typeof input.injury_date === 'string' ? input.injury_date : undefined;

    const validation = validateRTPEstimate(rtpEstimate, injuryType, severity);
    if (!validation.valid) {
      console.error(
        `[Agent] RTP validation failed for ${context}: ${validation.warnings.join('; ')}`
      );
      return null;
    }
    const validatedRTP = validation.corrected ?? rtpEstimate;
    if (validation.warnings.length > 0) {
      console.warn(
        `[Agent] RTP auto-corrected for ${context}: ${validation.warnings.join('; ')}`
      );
    }
    const reviewFlags: string[] = [];
    if (validation.requiresReview) {
      reviewFlags.push('rtp_monotonicity_violation');
      console.warn(`[Agent] RTP monotonicity violation for ${context} — routing to MD review`);
    }

    // CONFLICT_FLAG detection: compare parsed team timeline to OTM estimate
    let contentType = (input.content_type as ContentType) ?? classified.content_type;
    let conflictReason = input.conflict_reason as string | undefined;
    const rawTimelineWeeks =
      typeof input.team_timeline_weeks === 'number'
        ? (input.team_timeline_weeks as number)
        : raw.team_timeline
          ? parseTeamTimeline(raw.team_timeline) ?? undefined
          : undefined;
    // DB column is INTEGER — always round before writing
    let teamTimelineWeeks =
      rawTimelineWeeks !== undefined ? Math.round(rawTimelineWeeks) : undefined;

    // The gap is measured from the same anchor the post will be formatted
    // with — chosen here rather than in the poller, which used to pick it only
    // AFTER this function had already returned its verdict.
    const conflictAnchor: ConflictAnchor = {
      injury_date: chooseDateAnchor(thread, injuryDate),
    };

    if (teamTimelineWeeks !== undefined) {
      const { conflict, reason, gap } = detectConflict(
        teamTimelineWeeks,
        validatedRTP,
        conflictAnchor,
        thread?.prior_timelines
      );
      if (conflict) {
        contentType = 'CONFLICT_FLAG';
        conflictReason = conflictReason ?? reason;
      } else if (contentType === 'CONFLICT_FLAG') {
        // THE CODE DECIDES. The model may self-flag CONFLICT_FLAG with a number
        // attached, and until the anchor existed nothing could contradict it:
        // detection could only ever UPGRADE. That is how a George Kittle post
        // reached the review queue asserting a conflict for an athlete whose
        // team-implied return sits inside the literature window. When the
        // anchored arithmetic does not confirm the flag, it is not one.
        // checkContentTypeDrift re-gates the downgraded type downstream.
        console.warn(
          `[Agent] CONFLICT_FLAG not confirmed for ${context}: team ${teamTimelineWeeks}w ` +
            `remaining vs OTM ${validatedRTP.min_weeks}-${validatedRTP.max_weeks}w ` +
            `(status ${gap.status}, elapsed ${gap.elapsed_weeks ?? 'unknown'}w, ` +
            `implied total ${gap.team_total_weeks ?? 'unknown'}w) — downgrading`,
        );
        contentType =
          classified.content_type === 'CONFLICT_FLAG' ? 'TRACKING' : classified.content_type;
        conflictReason = undefined;
      }
    }

    // If Claude self-flagged CONFLICT_FLAG but no parseable team timeline exists,
    // suppress it — real conflicts require a concrete team disclosure to compare
    // against. "Questionable" / "day-to-day" with no week number are not conflicts.
    if (contentType === 'CONFLICT_FLAG' && teamTimelineWeeks === undefined) {
      contentType = classified.content_type === 'CONFLICT_FLAG' ? 'TRACKING' : classified.content_type;
      conflictReason = undefined;
    }

    // If the poller is updating an existing story, mark as TRACKING
    // (unless a conflict was detected, which takes precedence).
    if (parentPostId && contentType !== 'CONFLICT_FLAG') {
      contentType = 'TRACKING';
    }

    const post: InjuryPostContent = {
      athlete_name: classified.athlete_name,
      sport: classified.sport,
      // Prefer Sonnet's corrected team over the classifier value (Haiku sometimes hallucinates)
      team: (typeof input.team === 'string' && input.team.trim() && input.team !== 'Unknown')
        ? input.team.trim()
        : classified.team,
      injury_type: injuryType,
      injury_severity: severity,
      content_type: contentType,
      headline: String(input.headline ?? ''),
      clinical_summary: String(input.clinical_summary ?? ''),
      return_to_play: validatedRTP,
      source_url: raw.source_url,
      // Fail closed: a non-finite confidence coerces to 0, which routes to MD
      // review rather than slipping past the `confidence < threshold` gate
      // (NaN < threshold is false).
      confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0,
      ...(conflictReason && { conflict_reason: conflictReason }),
      ...(teamTimelineWeeks !== undefined && { team_timeline_weeks: teamTimelineWeeks }),
      ...(parentPostId && { parent_post_id: parentPostId }),
      ...(injuryDate && { injury_date: injuryDate }),
      ...(reviewFlags.length > 0 && { md_review_flags: reviewFlags }),
    };

    return post;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Failed to process event for ${context}: ${message}`);
    return null;
  }
}

/**
 * Generates an educational DEEP_DIVE post for a high-frequency injury type.
 * Called by the deep-dive scheduler when an injury type has appeared >= N times
 * in the recent polling window.
 *
 * Differs from processInjuryEvent in several ways:
 * - Educational, physician-authored tone (not news-breaking)
 * - Injury TYPE as the subject, with recent athletes as real-world context
 * - Higher max_tokens (4096) for fuller clinical content
 * - content_type always forced to DEEP_DIVE
 */
export async function processDeepDive(input: DeepDiveInput): Promise<InjuryPostContent | null> {
  const context = `DEEP_DIVE: ${input.injury_type} (${input.sport}, ${input.count} cases)`;

  try {
    const { core, rtpTables, sportReference } = await loadSkillContext(input.sport);

    const sections = [
      core,
      '\n\n--- RTP PROBABILITY TABLES ---\n\n',
      rtpTables,
    ];
    if (sportReference) {
      sections.push('\n\n--- SPORT REFERENCE ---\n\n', sportReference);
    }
    sections.push(
      '\n\n--- OUTPUT INSTRUCTIONS ---\n\n',
      'You are writing a DEEP DIVE educational analysis about an injury type that has appeared multiple times recently. ',
      'Write as a physician-authored clinical explainer — educational tone, not news-breaking tone. ',
      'Focus on: mechanism of injury, anatomy involved, standard grading systems, surgical vs conservative treatment options, rehabilitation protocols, and return-to-play evidence. ',
      'The clinical_summary should be thorough (4–8 paragraphs) with clinical depth suitable for informed sports fans and fantasy managers. ',
      'Use the specific athletes listed as real-world context, but center the analysis on the injury type itself — not one athlete\'s case. ',
      'Complete the OTM three-axis classification before selecting an RTP range — classify for the typical presentation of this injury type. ',
      'Never emit an RTP estimate for CONCUSSION or SYSTEMIC events. ',
      'State whether the grade is CONFIRMED or INFERRED for each referenced athlete case. ',
      'You must call the emit_injury_post tool exactly once with your final structured output. ',
      'CRITICAL — clinical_summary format rules: The clinical_summary must be written as public-facing narrative prose throughout. ',
      'Do NOT include internal taxonomy labels such as "Axis 1 — Tissue:", "Axis 2 — Severity:", "Axis 3 — Region:", "Evidence Tier:", "Flag: ESCALATION", or "ESCALATION —". ',
      'Do NOT mention "SKILL.md", "OTM protocol", "MD review flagged per protocol", or "per OTM protocol" — these are internal processing notes and must never appear in published content. ',
      'CONFIRMED and INFERRED may appear naturally in prose but must not be formatted as classification headers. ',
      'End clinical_summary on the clinical take — never with an escalation flag, protocol note, or MD review reference.'
    );
    const system = sections.join('');

    const athleteList = input.athletes.slice(0, 5).map((a, i) =>
      `${i + 1}. ${a}${input.teams[i] ? ` (${input.teams[i]})` : ''}`
    ).join('\n');

    const primaryAthlete = input.athletes[0] || 'Multiple Athletes';
    const primaryTeam = input.teams[0] || 'Various';

    const userMessage = `Write a DEEP DIVE educational analysis about this injury type.

Injury type: ${input.injury_type}
Sport: ${input.sport}
Recent occurrences: ${input.count} cases in the last reporting window

Athletes affected:
${athleteList}

Write an in-depth clinical breakdown of "${input.injury_type}" as it affects ${input.sport} athletes. This is an educational deep-dive, not a breaking news post. Center the analysis on the injury type with these athletes as real-world context.

For the post structure fields (athlete_name, team), use "${primaryAthlete}" and "${primaryTeam}" as the primary reference. The clinical_summary should cover the injury type broadly, referencing the affected athletes where relevant.

Emit your final answer via the emit_injury_post tool with content_type: DEEP_DIVE.`;

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system,
      tools: [AGENT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_injury_post' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      console.error(`[Agent] No tool_use block returned for ${context}`);
      return null;
    }

    const toolInput = toolUse.input as Record<string, unknown>;
    const rtpRaw = toolInput.return_to_play as Record<string, unknown> | undefined;
    if (!rtpRaw) {
      console.error(`[Agent] Missing return_to_play in deep dive output for ${context}`);
      return null;
    }

    const rtpEstimate: ReturnToPlayEstimate = {
      min_weeks: Math.round(Number(rtpRaw.min_weeks ?? 0)),
      max_weeks: Math.round(Number(rtpRaw.max_weeks ?? 0)),
      probability_week_2: Number(rtpRaw.probability_week_2 ?? 0),
      probability_week_4: Number(rtpRaw.probability_week_4 ?? 0),
      probability_week_8: Number(rtpRaw.probability_week_8 ?? 0),
      confidence: Number(rtpRaw.confidence ?? 0),
    };

    const injuryType = String(toolInput.injury_type ?? input.injury_type);
    const severity = (toolInput.injury_severity as InjurySeverity) ?? 'UNKNOWN';

    const validation = validateRTPEstimate(rtpEstimate, injuryType, severity);
    if (!validation.valid) {
      console.error(`[Agent] RTP validation failed for ${context}: ${validation.warnings.join('; ')}`);
      return null;
    }
    const validatedRTP = validation.corrected ?? rtpEstimate;
    if (validation.warnings.length > 0) {
      console.warn(`[Agent] RTP auto-corrected for ${context}: ${validation.warnings.join('; ')}`);
    }
    const reviewFlags: string[] = [];
    if (validation.requiresReview) {
      reviewFlags.push('rtp_monotonicity_violation');
      console.warn(`[Agent] RTP monotonicity violation for ${context} — routing to MD review`);
    }

    const post: InjuryPostContent = {
      athlete_name: primaryAthlete,
      sport: input.sport,
      team: primaryTeam,
      injury_type: injuryType,
      injury_severity: severity,
      content_type: 'DEEP_DIVE',
      headline: String(toolInput.headline ?? ''),
      clinical_summary: String(toolInput.clinical_summary ?? ''),
      return_to_play: validatedRTP,
      confidence: Number.isFinite(Number(toolInput.confidence)) ? Number(toolInput.confidence) : 0,
      ...(reviewFlags.length > 0 && { md_review_flags: reviewFlags }),
    };

    return post;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Failed to process deep dive for ${context}: ${message}`);
    return null;
  }
}
