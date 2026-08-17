import { describe, it, expect, afterEach } from 'vitest';
import { formatForFarcaster, formatForTwitter } from '../src/utils/content-formatter.js';
import { reconstructPostContent } from '../src/utils/post-content.js';
import type { ContentType, InjuryPostContent } from '../src/types.js';

/**
 * The OrthoIQ referral link may appear on DEEP_DIVE content and nowhere else —
 * never on BREAKING or TRACKING (CLAUDE.md, "OrthoIQ Reference Rule").
 *
 * The formatters have always honoured that, because the CTA lives inside the
 * DEEP_DIVE builders. The way it leaks is a lie about content_type upstream:
 * ApprovalSync's reconstruction hardcoded 'DEEP_DIVE', so a widened republish
 * filter would have reformatted breaking injury news as a deep-dive thread and
 * appended a referral link to it. These tests turn "the reconstruction must not
 * lie" from a code-reading argument into a checked property.
 */

const CTA_MARKER = 'orthoiq.com';
const NON_DEEP_DIVE: ContentType[] = ['BREAKING', 'TRACKING', 'CONFLICT_FLAG'];

function makeContent(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Jaren Kanak',
    sport: 'NFL',
    team: 'Kansas City Chiefs',
    injury_type: 'Hamstring strain',
    injury_severity: 'MODERATE',
    content_type: 'BREAKING',
    headline: 'Jaren Kanak suffers hamstring strain in preseason',
    clinical_summary:
      'A Grade 2 hamstring strain involving the biceps femoris. Partial fibre disruption with pain on resisted knee flexion. Progressive loading is the mainstay of rehabilitation.',
    return_to_play: {
      min_weeks: 3,
      max_weeks: 5,
      probability_week_2: 0.15,
      probability_week_4: 0.6,
      probability_week_8: 0.95,
      confidence: 0.8,
    },
    conflict_reason: 'Team says 1 week; the literature says 3-5.',
    team_timeline_weeks: 1,
    confidence: 0.85,
    ...overrides,
  };
}

function joined(parts: string[]): string {
  return parts.join('\n').toLowerCase();
}

describe('OrthoIQ CTA — DEEP_DIVE only', () => {
  const originalLimit = process.env.TWITTER_CHAR_LIMIT;

  afterEach(() => {
    if (originalLimit === undefined) delete process.env.TWITTER_CHAR_LIMIT;
    else process.env.TWITTER_CHAR_LIMIT = originalLimit;
  });

  describe.each(['', 'https://sidelineiq.vercel.app/post/slug'])(
    'postUrl=%s',
    (postUrl) => {
      it.each(NON_DEEP_DIVE)('%s carries no referral link on Farcaster', (contentType) => {
        const parts = formatForFarcaster(makeContent({ content_type: contentType }), postUrl);
        expect(joined(parts)).not.toContain(CTA_MARKER);
      });

      it.each(NON_DEEP_DIVE)('%s carries no referral link on X (280-char)', (contentType) => {
        delete process.env.TWITTER_CHAR_LIMIT;
        const parts = formatForTwitter(makeContent({ content_type: contentType }), postUrl);
        expect(joined(parts)).not.toContain(CTA_MARKER);
      });

      it.each(NON_DEEP_DIVE)('%s carries no referral link on X (long-form)', (contentType) => {
        // TWITTER_CHAR_LIMIT is 25000 in production, so this is the live path.
        process.env.TWITTER_CHAR_LIMIT = '25000';
        const parts = formatForTwitter(makeContent({ content_type: contentType }), postUrl);
        expect(joined(parts)).not.toContain(CTA_MARKER);
      });
    },
  );

  it('DEEP_DIVE does carry the referral link, so these tests could fail', () => {
    const content = makeContent({ content_type: 'DEEP_DIVE' });
    const url = 'https://sidelineiq.vercel.app/post/slug';

    expect(joined(formatForFarcaster(content, url))).toContain(CTA_MARKER);

    process.env.TWITTER_CHAR_LIMIT = '25000';
    expect(joined(formatForTwitter(content, url))).toContain(CTA_MARKER);
  });
});

describe('reconstructPostContent', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    athlete_name: 'Jaren Kanak',
    sport: 'NFL',
    team: 'Kansas City Chiefs',
    injury_type: 'Hamstring strain',
    injury_severity: 'MODERATE',
    content_type: 'BREAKING',
    headline: 'Jaren Kanak suffers hamstring strain',
    clinical_summary: 'Grade 2 biceps femoris strain.',
    confidence: 0.85,
    return_to_play_min_weeks: 3,
    return_to_play_max_weeks: 5,
    ...overrides,
  });

  it.each(['BREAKING', 'TRACKING', 'DEEP_DIVE', 'CONFLICT_FLAG'])(
    'round-trips %s rather than fabricating a type',
    (contentType) => {
      const { content } = reconstructPostContent(row({ content_type: contentType }));
      expect(content?.content_type).toBe(contentType);
    },
  );

  it('normalizes case', () => {
    const { content } = reconstructPostContent(row({ content_type: 'breaking' }));
    expect(content?.content_type).toBe('BREAKING');
  });

  it('fails closed on an unrecognized content_type instead of defaulting', () => {
    const { content, reason } = reconstructPostContent(row({ content_type: 'HOT_TAKE' }));
    expect(content).toBeNull();
    expect(reason).toBe('unknown_content_type');
  });

  it('fails closed on a missing content_type', () => {
    const { content, reason } = reconstructPostContent(row({ content_type: undefined }));
    expect(content).toBeNull();
    expect(reason).toBe('unknown_content_type');
  });

  it('reports missing RTP separately from an unknown type', () => {
    const { content, reason } = reconstructPostContent(
      row({ return_to_play_min_weeks: undefined }),
    );
    expect(content).toBeNull();
    expect(reason).toBe('missing_rtp');
  });

  it('prefers the nested RTP shape but falls back per field', () => {
    const { content } = reconstructPostContent(
      row({
        return_to_play_estimate: { min_weeks: 8, probability_week_4: 0.25 },
        return_to_play_max_weeks: 12,
      }),
    );
    expect(content?.return_to_play.min_weeks).toBe(8);
    expect(content?.return_to_play.probability_week_4).toBe(0.25);
    // Nested shape omitted max_weeks — the flat column still answers.
    expect(content?.return_to_play.max_weeks).toBe(12);
  });

  it('carries the optional fields only when present', () => {
    const bare = reconstructPostContent(row()).content;
    expect(bare).not.toHaveProperty('conflict_reason');
    expect(bare).not.toHaveProperty('parent_post_id');

    const full = reconstructPostContent(
      row({ conflict_reason: 'Team says 1 week', team_timeline_weeks: 1, parent_post_id: 'p0' }),
    ).content;
    expect(full?.conflict_reason).toBe('Team says 1 week');
    expect(full?.team_timeline_weeks).toBe(1);
    expect(full?.parent_post_id).toBe('p0');
  });

  /** The end-to-end property: a stored BREAKING row can never emit the CTA. */
  it('a BREAKING row reconstructed and formatted carries no referral link', () => {
    const { content } = reconstructPostContent(row({ content_type: 'BREAKING' }));
    expect(content).not.toBeNull();
    const url = 'https://sidelineiq.vercel.app/post/slug';
    expect(joined(formatForFarcaster(content!, url))).not.toContain(CTA_MARKER);
    process.env.TWITTER_CHAR_LIMIT = '25000';
    expect(joined(formatForTwitter(content!, url))).not.toContain(CTA_MARKER);
  });
});
