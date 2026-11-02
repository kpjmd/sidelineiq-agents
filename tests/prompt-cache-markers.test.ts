import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Caching is a byte-exact prefix match, and a prefix that stops matching fails
 * silently: the call succeeds and costs more. These pin the marker on the two
 * routes that repeat within a cycle, and pin that the cached text does not vary
 * with the event, which is what would quietly turn every read into a write.
 */

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create } })),
}));
vi.mock('../src/utils/skill-loader.js', () => ({
  loadSkillContext: vi.fn(async () => ({
    core: 'CORE_SKILL',
    rtpTables: 'RTP_TABLES',
    sportReference: 'SPORT_REF',
  })),
}));

import { classifyEvent } from '../src/agents/injury-intelligence/classifier.js';
import { processDeepDive, processInjuryEvent } from '../src/agents/injury-intelligence/agent.js';
import { drainLlmUsageLines } from '../src/utils/llm-usage.js';
import type { ClassificationResult, RawInjuryEvent } from '../src/types.js';

function rawEvent(athlete: string, description: string): RawInjuryEvent {
  return {
    sport: 'NFL',
    athlete_name: athlete,
    team: 'Baltimore Ravens',
    injury_description: description,
    source_url: 'https://example.com/a',
    source_name: 'espn-nfl',
    reported_at: new Date('2026-10-30T12:00:00Z'),
  } as unknown as RawInjuryEvent;
}

function classified(athlete: string, description: string): ClassificationResult {
  return {
    is_injury_event: true,
    confidence: 0.9,
    sport: 'NFL',
    athlete_name: athlete,
    team: 'Baltimore Ravens',
    injury_description: description,
    content_type: 'BREAKING',
    is_new: true,
    raw_event: rawEvent(athlete, description),
  } as unknown as ClassificationResult;
}

const POST = {
  injury_type: 'Ankle sprain',
  injury_severity: 'MODERATE',
  content_type: 'BREAKING',
  headline: 'Ankle sprain',
  clinical_summary: 'Summary.',
  return_to_play: {
    min_weeks: 3,
    max_weeks: 6,
    probability_week_2: 0.1,
    probability_week_4: 0.5,
    probability_week_8: 0.9,
    confidence: 0.6,
  },
  confidence: 0.8,
};

describe('prompt cache markers', () => {
  beforeEach(() => {
    create.mockReset();
    drainLlmUsageLines('NFL');
    drainLlmUsageLines('NBA');
  });

  it('the classifier caches a system prefix that does not vary with the event', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'classify_injury_event', input: { is_injury_event: false } }],
      usage: { input_tokens: 90, cache_read_input_tokens: 1900, output_tokens: 40 },
    });
    const tier = { athleteTier: 3, athleteTierSource: 'default' } as never;

    await classifyEvent(rawEvent('Lamar Jackson', 'Ankle'), tier);
    await classifyEvent(rawEvent('Derrick Henry', 'Hamstring'), tier);

    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(first.system).toHaveLength(1);
    expect(first.system[0].type).toBe('text');
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(first.system).toEqual(second.system);
    expect(first.tools).toEqual(second.tools);
    expect(first.system[0].text).not.toContain('Lamar Jackson');
    expect(first.messages[0].content).toContain('Lamar Jackson');
    expect(drainLlmUsageLines('NFL')).toEqual([
      '[Usage] NFL route=classifier calls=2 input=180 cache_write=0 cache_read=3800 output=80',
    ]);
  });

  it('CLASSIFIER_RATIONALES=off removes both fields and the sentence asking for them, and nothing else', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'classify_injury_event', input: { is_injury_event: false } }],
      usage: { input_tokens: 90, output_tokens: 40 },
    });
    const tier = { athleteTier: 3, athleteTierSource: 'default' } as never;

    await classifyEvent(rawEvent('Lamar Jackson', 'Ankle'), tier, undefined, 'on');
    await classifyEvent(rawEvent('Lamar Jackson', 'Ankle'), tier, undefined, 'off');

    const [on, off] = create.mock.calls.map((c) => c[0]);
    const onSchema = on.tools[0].input_schema;
    const offSchema = off.tools[0].input_schema;
    expect(Object.keys(onSchema.properties)).toEqual(
      expect.arrayContaining(['specificity_rationale', 'recency_rationale']),
    );
    expect(Object.keys(offSchema.properties)).toEqual(
      Object.keys(onSchema.properties).filter((key) => !key.endsWith('_rationale')),
    );
    expect(offSchema.required).toEqual(onSchema.required.filter((key: string) => !key.endsWith('_rationale')));
    expect(on.system[0].text).toContain('one-line rationale');
    // A prompt edit that stops matching would silently keep asking for fields the tool no longer has.
    expect(off.system[0].text).not.toContain('rationale');
    expect(on.system[0].text.length - off.system[0].text.length).toBeLessThan(120);
    expect(off.tool_choice).toEqual(on.tool_choice);
  });

  it('post generation caches the skill context, with the date and event outside it', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'emit_injury_post', input: POST }],
      usage: { input_tokens: 700, cache_creation_input_tokens: 15000, output_tokens: 900 },
    });

    await processInjuryEvent(classified('Lamar Jackson', 'Ankle sprain'));
    await processInjuryEvent(classified('Derrick Henry', 'Ankle sprain'));

    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(first.system).toHaveLength(1);
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(first.system).toEqual(second.system);
    expect(first.system[0].text).toContain('CORE_SKILL');
    expect(first.system[0].text).toContain('RTP_TABLES');
    expect(first.system[0].text).toContain('SPORT_REF');
    expect(first.system[0].text).not.toContain('Lamar Jackson');
    expect(first.system[0].text).not.toContain('Current date:');
    expect(first.messages[0].content).toContain('Current date:');
    expect(drainLlmUsageLines('NFL')).toEqual([
      '[Usage] NFL route=otm calls=2 input=1400 cache_write=30000 cache_read=0 output=1800',
    ]);
  });

  it('a type-led DEEP_DIVE stays uncached: it is too rare to earn the write premium', async () => {
    create.mockResolvedValue({
      content: [{ type: 'tool_use', id: 't', name: 'emit_injury_post', input: { ...POST, content_type: 'DEEP_DIVE' } }],
    });
    await processDeepDive({
      injury_type: 'hamstring strain',
      sport: 'NBA',
      count: 3,
      athletes: ['Luka Doncic', 'Immanuel Quickley', 'Peyton Watson'],
      teams: ['Los Angeles Lakers', 'Toronto Raptors', 'Denver Nuggets'],
    });
    expect(typeof create.mock.calls[0][0].system).toBe('string');
  });
});
