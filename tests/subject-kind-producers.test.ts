import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * subject_kind is recorded by the code that PRODUCES a post, and the CTA
 * adjacency rule trusts nothing else. These pin both producers with the model
 * mocked, so a later edit to either one cannot silently change which posts may
 * carry the commercial CTA.
 *
 * The case that matters most is the DEEP_DIVE the athlete path can produce —
 * /test/deep-dive forces content_type onto a single-athlete post, and the model
 * may emit DEEP_DIVE on the poller path. It must stay ATHLETE.
 */

const create = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create } })),
}));
vi.mock('../src/utils/skill-loader.js', () => ({
  loadSkillContext: vi.fn(async () => ({ core: 'core', rtpTables: 'tables', sportReference: null })),
}));

import { processDeepDive, processInjuryEvent } from '../src/agents/injury-intelligence/agent.js';
import type { ClassificationResult } from '../src/types.js';

function emit(input: Record<string, unknown>) {
  create.mockResolvedValue({
    content: [{ type: 'tool_use', id: 't1', name: 'emit_injury_post', input }],
  });
}

const RTP = {
  min_weeks: 3,
  max_weeks: 6,
  probability_week_2: 0.1,
  probability_week_4: 0.5,
  probability_week_8: 0.9,
  confidence: 0.6,
};

describe('subject_kind producers', () => {
  beforeEach(() => create.mockReset());

  it('processDeepDive records INJURY_TYPE, even though it names a primary athlete', async () => {
    emit({
      injury_type: 'Hamstring strain',
      injury_severity: 'MODERATE',
      content_type: 'DEEP_DIVE',
      headline: 'Hamstring Strains Are Clustering in the NBA',
      clinical_summary: 'Educational analysis.',
      return_to_play: RTP,
      confidence: 0.8,
    });
    const post = await processDeepDive({
      injury_type: 'hamstring strain',
      sport: 'NBA',
      count: 3,
      athletes: ['Luka Doncic', 'Immanuel Quickley', 'Peyton Watson'],
      teams: ['Los Angeles Lakers', 'Toronto Raptors', 'Denver Nuggets'],
    });
    expect(post?.athlete_name).toBe('Luka Doncic');
    expect(post?.subject_kind).toBe('INJURY_TYPE');
  });

  it('asks for a topic-led headline', async () => {
    emit({ injury_type: 'x', headline: 'h', clinical_summary: 's', return_to_play: RTP, confidence: 0.8 });
    await processDeepDive({ injury_type: 'acl tear', sport: 'NFL', count: 3, athletes: ['A B'], teams: ['T'] });
    const { messages } = create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(messages[0].content).toMatch(/headline must lead with the injury type/i);
  });

  it.each(['BREAKING', 'DEEP_DIVE'] as const)(
    'processInjuryEvent records ATHLETE, including when content_type is %s',
    async (contentType) => {
      emit({
        injury_type: 'ACL tear',
        injury_severity: 'SEVERE',
        content_type: contentType,
        headline: 'Teddye Buchanan Tears ACL',
        clinical_summary: 'One athlete.',
        return_to_play: { ...RTP, min_weeks: 36, max_weeks: 52, probability_week_2: 0, probability_week_4: 0, probability_week_8: 0 },
        confidence: 0.8,
      });
      const classified = {
        is_injury_event: true,
        confidence: 0.95,
        sport: 'NFL',
        athlete_name: 'Teddye Buchanan',
        team: 'Baltimore Ravens',
        injury_description: 'ACL tear',
        content_type: contentType,
        is_new: true,
        raw_event: {
          athlete_name: 'Teddye Buchanan',
          sport: 'NFL',
          team: 'Baltimore Ravens',
          injury_description: 'ACL tear',
          source_url: 'test://deep-dive-endpoint',
          reported_at: new Date('2026-09-11T00:00:00Z'),
        },
      } as unknown as ClassificationResult;
      const post = await processInjuryEvent(classified);
      expect(post, 'processInjuryEvent returned null').not.toBeNull();
      expect(post?.content_type).toBe(contentType);
      expect(post?.subject_kind).toBe('ATHLETE');
    },
  );
});
