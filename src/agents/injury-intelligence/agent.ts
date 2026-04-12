import Anthropic from '@anthropic-ai/sdk';
import { loadSkillContext } from '../../utils/skill-loader.js';
import { validateRTPEstimate } from './rtp-estimator.js';
import type {
  ClassificationResult,
  InjuryPostContent,
  InjurySeverity,
  ContentType,
  ReturnToPlayEstimate,
} from '../../types.js';

const MODEL = 'claude-sonnet-4-6';

const AGENT_TOOL = {
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
          'The OTM clinical breakdown suitable for public consumption. Lead with 1-2 plain narrative sentences describing the injury and its significance — these appear directly in social posts. Classification details (three-axis, evidence tier, confidence note) may follow but must never open the field. States whether the grade is CONFIRMED or INFERRED.',
      },
      return_to_play: {
        type: 'object',
        properties: {
          min_weeks: { type: 'number' },
          max_weeks: { type: 'number' },
          probability_week_2: { type: 'number' },
          probability_week_4: { type: 'number' },
          probability_week_8: { type: 'number' },
          confidence: { type: 'number' },
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
        description: 'Overall confidence in the post, 0 to 1. Below 0.75 routes to MD review.',
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
          'If a team-reported timeline is present, the parsed midpoint in weeks (e.g., "2-4 weeks" → 3).',
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
    'Never emit an RTP estimate for CONCUSSION or SYSTEMIC events — in those cases, set return_to_play probabilities to 0 and confidence to a low value. ',
    'State whether the injury grade is CONFIRMED (imaging/team confirmed) or INFERRED (reasoned from mechanism and reporting) in the clinical_summary.'
  );
  return sections.join('');
}

/**
 * Parses a team-reported timeline string into a midpoint number of weeks.
 * Examples:
 *   "2-4 weeks"       → 3
 *   "week to week"    → 1
 *   "day-to-day"      → 0.3
 *   "out for season"  → 24
 *   "6 weeks"         → 6
 * Returns null if unparseable.
 */
export function parseTeamTimeline(timeline: string): number | null {
  if (!timeline) return null;
  const t = timeline.toLowerCase().trim();

  if (/out\s+for\s+(the\s+)?season|season[- ]ending/.test(t)) return 24;
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
 * Detects a CONFLICT_FLAG between team timeline and OTM estimate.
 * Triggers when the gap exceeds 2 weeks in either direction.
 */
function detectConflict(
  teamTimelineWeeks: number | null,
  rtp: ReturnToPlayEstimate
): { conflict: boolean; reason?: string } {
  if (teamTimelineWeeks === null) return { conflict: false };

  const otmMid = (rtp.min_weeks + rtp.max_weeks) / 2;
  const gap = Math.abs(teamTimelineWeeks - otmMid);
  if (gap <= 2) return { conflict: false };

  const direction =
    teamTimelineWeeks < otmMid
      ? `team timeline (~${teamTimelineWeeks}w) is shorter than OTM estimate (${rtp.min_weeks}-${rtp.max_weeks}w)`
      : `team timeline (~${teamTimelineWeeks}w) is longer than OTM estimate (${rtp.min_weeks}-${rtp.max_weeks}w)`;
  return {
    conflict: true,
    reason: `Reporting conflict: ${direction}.`,
  };
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
  parentPostId?: string
): Promise<InjuryPostContent | null> {
  const raw = classified.raw_event;
  const context = `${classified.athlete_name} (${classified.sport}/${classified.team})`;

  try {
    const { core, rtpTables, sportReference } = await loadSkillContext(classified.sport);
    const system = buildSystemPrompt(core, rtpTables, sportReference);

    const userMessage = `Process this injury event into a structured post.

Sport: ${classified.sport}
Athlete: ${classified.athlete_name}
Team: ${classified.team}
Injury (raw): ${classified.injury_description}
${raw.team_timeline ? `Team-reported timeline: ${raw.team_timeline}` : 'Team timeline: not reported'}
Source: ${raw.source_url}
Reported at: ${raw.reported_at.toISOString()}
Classifier hint — content_type: ${classified.content_type}, is_new: ${classified.is_new}
${parentPostId ? `This is an UPDATE to an existing story (parent post id: ${parentPostId}).` : ''}

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

    if (teamTimelineWeeks !== undefined) {
      const { conflict, reason } = detectConflict(teamTimelineWeeks, validatedRTP);
      if (conflict) {
        contentType = 'CONFLICT_FLAG';
        conflictReason = conflictReason ?? reason;
      }
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
      confidence: Number(input.confidence ?? 0),
      ...(conflictReason && { conflict_reason: conflictReason }),
      ...(teamTimelineWeeks !== undefined && { team_timeline_weeks: teamTimelineWeeks }),
      ...(parentPostId && { parent_post_id: parentPostId }),
    };

    return post;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Failed to process event for ${context}: ${message}`);
    return null;
  }
}
