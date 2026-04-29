import Anthropic from '@anthropic-ai/sdk';
import type { RawInjuryEvent, ClassificationResult, SportKey, ContentType, AthleteTier } from '../../types.js';
import { computeSignificance } from './significance.js';

const MODEL = 'claude-haiku-4-5-20251001';

const CLASSIFIER_TOOL = {
  name: 'classify_injury_event',
  description:
    'Classify a raw injury news item. Determine whether it is a real injury event and how it should be processed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      is_injury_event: {
        type: 'boolean',
        description:
          'True if this is a real injury event (not load management, trade news, personal news, etc.).',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the classification, 0 to 1.',
      },
      sport: {
        type: 'string',
        enum: ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'],
      },
      athlete_name: {
        type: 'string',
        description: 'The primary athlete affected by the injury.',
      },
      team: {
        type: 'string',
        description:
          'The athlete\'s team exactly as stated in the source. If the source does not name a team, return "Unknown". Do NOT guess or fill in from general knowledge — team corrections are handled downstream.',
      },
      injury_description: {
        type: 'string',
        description:
          'A short, normalized description of the injury suitable for feeding into downstream clinical analysis.',
      },
      content_type: {
        type: 'string',
        enum: ['BREAKING', 'TRACKING', 'DEEP_DIVE', 'CONFLICT_FLAG'],
        description:
          'Suggested initial content type. Use BREAKING for a new event. Use TRACKING if this is clearly an update to an existing story. CONFLICT_FLAG and DEEP_DIVE are rarely set at classification time — leave those to the agent.',
      },
      is_new: {
        type: 'boolean',
        description:
          'True if this appears to be a new injury event. False if it is an update to an existing/previously reported injury.',
      },
      information_specificity: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'How specific is the injury information? Score 0-100. ' +
          '90-100 = named structure + grade or mechanism confirmed (e.g. "complete patellar tendon rupture, surgical repair confirmed"). ' +
          '70-89 = named structure, no grade (e.g. "ACL tear", "Achilles rupture"). ' +
          '40-69 = named region with some specificity (e.g. "high ankle sprain", "knee bone bruise + hyperextension"). ' +
          '10-39 = vague body region only (e.g. "foot injury", "lower body", "knee soreness"). ' +
          '0-9 = no injury detail beyond status (e.g. "questionable, no further info").',
      },
      event_recency_novelty: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'How new or novel is this information? Score 0-100. ' +
          '90-100 = brand-new injury, surgery just confirmed, or new status change (IR placement, return timeline announced, MRI result disclosed). ' +
          '60-89 = first imaging or grade disclosure on a previously vague injury. ' +
          '30-59 = incremental update to a known injury (e.g. "progressing in rehab", "returned to practice"). ' +
          '0-29 = re-report of known info with no new signal ("still out, no update", stale offseason "Questionable" tag).',
      },
      specificity_rationale: {
        type: 'string',
        description: 'One-line justification for the specificity score (120 chars max). Used to audit calibration.',
      },
      recency_rationale: {
        type: 'string',
        description: 'One-line justification for the recency score (120 chars max).',
      },
    },
    required: [
      'is_injury_event',
      'confidence',
      'sport',
      'athlete_name',
      'team',
      'injury_description',
      'content_type',
      'is_new',
      'information_specificity',
      'event_recency_novelty',
      'specificity_rationale',
      'recency_rationale',
    ],
  },
};

const SYSTEM_PROMPT = `You are a sports injury news classifier. Your job is to take a raw news item and quickly determine:

1. Is this a real injury event? (Not trade news, contract news, load management, routine day-off, personal news, etc.)
2. Which sport does it belong to? (NFL, NBA, PREMIER_LEAGUE, UFC)
3. Who is the primary athlete and team?
4. Is this a new injury or an update to an existing one?
5. What is a short, clean description of the injury?

Be strict. Many news items look injury-adjacent but aren't real injuries:
- "Load management" or "rest day" → NOT an injury event
- "Personal reasons" → NOT an injury event
- "Did not practice" with no injury cause → NOT an injury event (confidence should be low)
- Soreness/tightness that is not expected to miss time → still classify as injury event but low severity
- Concussion protocol → IS an injury event

SIGNIFICANCE SCORING

In addition to the classification fields, score two signals on a 0-100 scale.
The platform uses these to filter out clinically thin reports before running full analysis.
Be calibrated, not generous — the goal is to identify genuinely informative events.

information_specificity (0-100):
  Does the source name a SPECIFIC structure (e.g., ACL, patellar tendon, Jones fracture,
  navicular stress fracture, MCL Grade 2) or just a vague body region ("foot injury",
  "lower body", "knee soreness")? Vague reports score low. Named structures with grade
  or mechanism score high. Surgery confirmed without procedure type named is medium (40-60),
  not high.

event_recency_novelty (0-100):
  Is this a brand-new injury, a status change (IR placement, surgery confirmed, timeline
  announced, MRI results disclosed), or a re-report of known info? "Questionable, will
  update next week" without new clinical content scores low. Stale offseason designations
  ("Questionable" in April for a known injury) score very low — they carry no new signal.

For each signal, provide a one-line rationale (120 chars max) so the platform can audit
calibration.

CALIBRATION ANCHORS

Score LOW (near-zero specificity/recency):
- "Garrett Wilson knee sprain, Questionable, offseason" — vague grade, stale tag
- "Mark Williams remains out with foot fracture" — no fracture type, no surgery info
- "Calvin Ridley recovering from lower leg surgery" — surgery type unknown

Score HIGH:
- "Donte DiVincenzo ruptured right Achilles, surgery scheduled, 10-month timeline"
- "Moses Moody complete patellar tendon rupture, surgical repair confirmed"
- "Anthony Edwards left knee bone bruise + hyperextension, OUT in playoffs"

Return your classification via the classify_injury_event tool.`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface TierContext {
  athleteTier: AthleteTier;
  athleteTierSource: 'lookup' | 'default';
}

/**
 * Fast Haiku-based triage of a raw injury event.
 * Returns ClassificationResult with is_injury_event=false if the event is noise.
 * When is_injury_event=true, also computes a SignificanceAssessment.
 *
 * The tier context must be pre-resolved by the caller (poller) using lookupAthleteTier
 * so that Haiku never infers athlete prominence — that judgment is unreliable.
 */
export async function classifyEvent(raw: RawInjuryEvent, tierContext: TierContext): Promise<ClassificationResult> {
  const anthropic = getClient();

  const userMessage = `Classify this injury news item:

Sport: ${raw.sport}
Athlete: ${raw.athlete_name}
Team: ${raw.team}
Description: ${raw.injury_description}
${raw.team_timeline ? `Team timeline: ${raw.team_timeline}` : ''}
Source: ${raw.source_url}
Reported: ${raw.reported_at.toISOString()}
${raw.is_update ? 'Marker: source flagged this as a status update.' : ''}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 768,
      system: SYSTEM_PROMPT,
      tools: [CLASSIFIER_TOOL],
      tool_choice: { type: 'tool', name: 'classify_injury_event' },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('Classifier did not return a tool_use block');
    }

    const input = toolUse.input as Record<string, unknown>;

    // Reject sport-league names returned as team (Haiku sometimes hallucinates the league name)
    const SPORT_LEAGUE_NAMES = new Set(['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC', 'MLB', 'NHL', 'MLS', 'WNBA']);
    const classifiedTeam = String(input.team ?? '').trim();
    const validTeam =
      classifiedTeam && !SPORT_LEAGUE_NAMES.has(classifiedTeam.toUpperCase())
        ? classifiedTeam
        : raw.team;

    const isInjuryEvent = Boolean(input.is_injury_event);
    const contentType = (input.content_type as ContentType) ?? 'BREAKING';
    const sport = (input.sport as SportKey) ?? raw.sport;

    const base: ClassificationResult = {
      is_injury_event: isInjuryEvent,
      confidence: Number(input.confidence ?? 0),
      sport,
      athlete_name: String(input.athlete_name ?? raw.athlete_name),
      team: validTeam,
      injury_description: String(input.injury_description ?? raw.injury_description),
      content_type: contentType,
      is_new: Boolean(input.is_new ?? !raw.is_update),
      raw_event: raw,
    };

    if (isInjuryEvent) {
      // Clamp sub-scores from Haiku — guard against malformed output (e.g. 150 or "high")
      const rawSpec = Number(input.information_specificity ?? 50);
      const rawRec = Number(input.event_recency_novelty ?? 50);
      const spec = Number.isFinite(rawSpec) ? rawSpec : 50;
      const rec = Number.isFinite(rawRec) ? rawRec : 50;

      base.significance = computeSignificance(
        tierContext.athleteTier,
        tierContext.athleteTierSource,
        { information_specificity: spec, event_recency_novelty: rec },
        contentType,
        sport,
        new Date()
      );
    }

    return base;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Classifier] Failed to classify event for ${raw.athlete_name}: ${message}`);
    // Return a "not an injury" result so the pipeline skips it safely
    return {
      is_injury_event: false,
      confidence: 0,
      sport: raw.sport,
      athlete_name: raw.athlete_name,
      team: raw.team,
      injury_description: raw.injury_description,
      content_type: 'BREAKING',
      is_new: !raw.is_update,
      raw_event: raw,
    };
  }
}
