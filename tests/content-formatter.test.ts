import { describe, it, expect, beforeEach } from 'vitest';
import { formatForFarcaster, formatForTwitter, formatForWeb } from '../src/utils/content-formatter.js';
import type { InjuryPostContent } from '../src/types.js';

function makeContent(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Patrick Mahomes',
    sport: 'NFL',
    team: 'Kansas City Chiefs',
    injury_type: 'High ankle sprain',
    injury_severity: 'MODERATE' as const,
    content_type: 'BREAKING',
    headline: 'Patrick Mahomes suffers high ankle sprain in Week 12',
    clinical_summary:
      'MRI confirms a Grade 2 high ankle sprain involving the anterior tibiofibular ligament. This typically involves partial tearing with moderate instability. Initial treatment includes immobilization and progressive weight-bearing.',
    return_to_play: {
      min_weeks: 4,
      max_weeks: 6,
      probability_week_2: 0.20,
      probability_week_4: 0.65,
      probability_week_8: 0.95,
      confidence: 0.85,
    },
    source_url: 'https://example.com/mahomes-injury',
    confidence: 0.92,
    ...overrides,
  };
}

describe('formatForFarcaster', () => {
  it('formats BREAKING as 2-cast thread within 320 chars each', () => {
    const result = formatForFarcaster(makeContent());
    expect(result).toHaveLength(2);
    result.forEach((cast) => expect(cast.length).toBeLessThanOrEqual(320));
    expect(result[0]).toContain('🚨');
    expect(result[0]).toContain('Mahomes');
    expect(result[1]).toContain('RTP');
  });

  it('formats TRACKING as 2-cast thread with UPDATE prefix', () => {
    const result = formatForFarcaster(makeContent({ content_type: 'TRACKING' }));
    expect(result).toHaveLength(2);
    result.forEach((cast) => expect(cast.length).toBeLessThanOrEqual(320));
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
  it('formats BREAKING as 2-tweet thread within 280 chars each', () => {
    const result = formatForTwitter(makeContent());
    expect(result).toHaveLength(2);
    result.forEach((tweet) => expect(tweet.length).toBeLessThanOrEqual(280));
    expect(result[0]).toContain('🚨');
    expect(result[1]).toContain('RTP');
  });

  it('formats DEEP_DIVE as thread within 280 char limit per tweet', () => {
    const result = formatForTwitter(makeContent({ content_type: 'DEEP_DIVE' }));
    expect(result.length).toBeGreaterThanOrEqual(3);
    result.forEach((tweet) => {
      expect(tweet.length).toBeLessThanOrEqual(280);
    });
  });

  it('handles very long clinical summary without exceeding char limit', () => {
    // Long summary should be truncated in post 2 but post 1 is always clean
    const longSummary = 'A very detailed clinical note. '.repeat(20);
    const result = formatForTwitter(makeContent({ clinical_summary: longSummary }));
    expect(result).toHaveLength(2);
    result.forEach((tweet) => expect(tweet.length).toBeLessThanOrEqual(280));
  });

  it('preserves OTM signature on DEEP_DIVE final tweet when postUrl is present', () => {
    // Regression: raw-length truncation was clipping OTM_SIGNATURE into
    // "Physicia..." because the post URL + OrthoIQ URL consumed ~220 chars of
    // raw string before Twitter's t.co shortening. The final cast should now
    // be gauged against Twitter's effective length (URLs = 23 chars each).
    const longPostUrl =
      'https://sidelineiq-frontend.vercel.app/posts/nfl/patrick-mahomes-high-ankle-sprain-week-12-2025';
    const result = formatForTwitter(
      makeContent({ content_type: 'DEEP_DIVE' }),
      longPostUrl
    );
    const finalTweet = result[result.length - 1];
    expect(finalTweet).toContain('Physician-founded.');
    expect(finalTweet).not.toContain('...');

    // Effective tweet length (URLs counted as 23 chars) must fit in 280
    const urls = finalTweet.match(/https?:\/\/\S+/g) ?? [];
    const rawUrlChars = urls.reduce((sum, u) => sum + u.length, 0);
    const effectiveLen = finalTweet.length - rawUrlChars + urls.length * 23;
    expect(effectiveLen).toBeLessThanOrEqual(280);
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
      injury_severity: 'MODERATE' as const,
      content_type: 'BREAKING',
      headline: 'Patrick Mahomes suffers high ankle sprain in Week 12',
      clinical_summary: expect.any(String),
      return_to_play_estimate: {
        min_weeks: 4,
        max_weeks: 6,
        probability_week_2: 0.20,
        probability_week_4: 0.65,
        probability_week_8: 0.95,
        confidence: 0.85,
      },
      source_url: 'https://example.com/mahomes-injury',
      confidence: 0.92,
      status: 'PUBLISHED',
    });
  });

  it('sets status to PENDING_REVIEW when specified', () => {
    const result = formatForWeb(makeContent(), 'PENDING_REVIEW');
    expect(result.status).toBe('PENDING_REVIEW');
  });

  it('omits source_url when not provided', () => {
    const result = formatForWeb(makeContent({ source_url: undefined }));
    expect(result).not.toHaveProperty('source_url');
  });

  it('includes parent_post_id when set', () => {
    const result = formatForWeb(makeContent({ parent_post_id: 'post-uuid-123' }));
    expect(result.parent_post_id).toBe('post-uuid-123');
  });

  it('omits parent_post_id when not provided', () => {
    const result = formatForWeb(makeContent());
    expect(result).not.toHaveProperty('parent_post_id');
  });
});
