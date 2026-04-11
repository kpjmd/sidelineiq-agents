import Anthropic from '@anthropic-ai/sdk';
import type { RawInjuryEvent, ClassificationResult, SportKey, ContentType } from '../../types.js';

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
          'The athlete\'s current team. If the source says "Unknown", "<UNKNOWN>", or is blank, use your training knowledge to provide the correct current team name. If genuinely unknown, return "Unknown".',
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

Return your classification via the classify_injury_event tool.`;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Fast Haiku-based triage of a raw injury event.
 * Returns ClassificationResult with is_injury_event=false if the event is noise.
 *
 * This is the first-pass filter before the full Sonnet-based agent runs,
 * so it needs to be fast, cheap, and aggressive about filtering noise.
 */
export async function classifyEvent(raw: RawInjuryEvent): Promise<ClassificationResult> {
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
      max_tokens: 512,
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

    return {
      is_injury_event: Boolean(input.is_injury_event),
      confidence: Number(input.confidence ?? 0),
      sport: (input.sport as SportKey) ?? raw.sport,
      athlete_name: String(input.athlete_name ?? raw.athlete_name),
      team: String(input.team ?? raw.team),
      injury_description: String(input.injury_description ?? raw.injury_description),
      content_type: (input.content_type as ContentType) ?? 'BREAKING',
      is_new: Boolean(input.is_new ?? !raw.is_update),
      raw_event: raw,
    };
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
