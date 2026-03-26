import { describe, it, expect, beforeEach } from 'vitest';
import { formatForFarcaster, formatForTwitter, formatForWeb } from '../src/utils/content-formatter.js';
import type { InjuryPostContent } from '../src/types.js';

function makeContent(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Patrick Mahomes',
    sport: 'NFL',
    team: 'Kansas City Chiefs',
    injury_type: 'High ankle sprain',
    injury_severity: 'MODERATE',
    content_type: 'BREAKING',
    headline: 'Patrick Mahomes suffers high ankle sprain in Week 12',
    clinical_summary:
      'MRI confirms a Grade 2 high ankle sprain involving the anterior tibiofibular ligament. This typically involves partial tearing with moderate instability. Initial treatment includes immobilization and progressive weight-bearing.',
    return_to_play: {
      timeline: '4-6 weeks',
      probability: 0.85,
      factors: ['Grade of sprain', 'Player age', 'Rehabilitation protocol'],
    },
    source_url: 'https://example.com/mahomes-injury',
    confidence: 0.92,
    ...overrides,
  };
}

describe('formatForFarcaster', () => {
  it('formats BREAKING as single cast within 320 chars', () => {
    const result = formatForFarcaster(makeContent());
    expect(result).toHaveLength(1);
    expect(result[0].length).toBeLessThanOrEqual(320);
    expect(result[0]).toContain('🚨');
    expect(result[0]).toContain('Mahomes');
  });

  it('formats TRACKING as single cast with UPDATE prefix', () => {
    const result = formatForFarcaster(makeContent({ content_type: 'TRACKING' }));
    expect(result).toHaveLength(1);
    expect(result[0].length).toBeLessThanOrEqual(320);
    expect(result[0]).toContain('UPDATE');
  });

  it('formats DEEP_DIVE as thread of 3-5 casts', () => {
    const result = formatForFarcaster(
      makeContent({
        content_type: 'DEEP_DIVE',
        clinical_summary:
          'The anterior cruciate ligament is one of the key stabilizing ligaments in the knee. ACL injuries are common in contact sports and typically occur during sudden stops or changes in direction. Surgical reconstruction is often recommended for athletes who wish to return to high-level competition. Recovery involves extensive rehabilitation over 9-12 months.',
      })
    );
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.length).toBeLessThanOrEqual(5);
    result.forEach((cast) => {
      expect(cast.length).toBeLessThanOrEqual(320);
    });
  });

  it('appends OrthoIQ referral on final DEEP_DIVE cast only', () => {
    const result = formatForFarcaster(makeContent({ content_type: 'DEEP_DIVE' }));
    const lastCast = result[result.length - 1];
    expect(lastCast).toContain('OrthoIQ');

    // No other cast should have OrthoIQ
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]).not.toContain('OrthoIQ');
    }
  });

  it('does NOT append OrthoIQ referral on BREAKING', () => {
    const result = formatForFarcaster(makeContent({ content_type: 'BREAKING' }));
    result.forEach((cast) => {
      expect(cast).not.toContain('OrthoIQ');
    });
  });

  it('does NOT append OrthoIQ referral on TRACKING', () => {
    const result = formatForFarcaster(makeContent({ content_type: 'TRACKING' }));
    result.forEach((cast) => {
      expect(cast).not.toContain('OrthoIQ');
    });
  });
});

describe('formatForTwitter', () => {
  it('formats BREAKING within 280 chars', () => {
    const result = formatForTwitter(makeContent());
    expect(result).toHaveLength(1);
    expect(result[0].length).toBeLessThanOrEqual(280);
  });

  it('formats DEEP_DIVE as thread within 280 char limit per tweet', () => {
    const result = formatForTwitter(makeContent({ content_type: 'DEEP_DIVE' }));
    expect(result.length).toBeGreaterThanOrEqual(3);
    result.forEach((tweet) => {
      expect(tweet.length).toBeLessThanOrEqual(280);
    });
  });

  it('truncates long content with ellipsis', () => {
    const longSummary = 'A'.repeat(500);
    const result = formatForTwitter(makeContent({ clinical_summary: longSummary }));
    expect(result[0].length).toBeLessThanOrEqual(280);
    expect(result[0]).toContain('...');
  });
});

describe('formatForWeb', () => {
  it('returns full structured object', () => {
    const result = formatForWeb(makeContent());
    expect(result).toEqual({
      athlete_name: 'Patrick Mahomes',
      sport: 'NFL',
      team: 'Kansas City Chiefs',
      injury_type: 'High ankle sprain',
      injury_severity: 'MODERATE',
      content_type: 'BREAKING',
      headline: 'Patrick Mahomes suffers high ankle sprain in Week 12',
      clinical_summary: expect.any(String),
      return_to_play_timeline: '4-6 weeks',
      return_to_play_probability: 0.85,
      return_to_play_factors: ['Grade of sprain', 'Player age', 'Rehabilitation protocol'],
      source_url: 'https://example.com/mahomes-injury',
      confidence: 0.92,
      status: 'PUBLISHED',
    });
  });

  it('sets status to PENDING_REVIEW when specified', () => {
    const result = formatForWeb(makeContent(), 'PENDING_REVIEW');
    expect(result.status).toBe('PENDING_REVIEW');
  });

  it('sets source_url to null when not provided', () => {
    const result = formatForWeb(makeContent({ source_url: undefined }));
    expect(result.source_url).toBeNull();
  });
});
