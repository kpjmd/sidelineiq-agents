import { describe, it, expect, afterEach } from 'vitest';
import {
  carriesReferralCta,
  formatForFarcaster,
  formatForTwitter,
  REFERRAL_CTA_MARKER,
} from '../src/utils/content-formatter.js';
import { reconstructPostContent } from '../src/utils/post-content.js';
import type { ContentType, InjuryPostContent } from '../src/types.js';

/**
 * The AequOs referral link may appear on an injury-TYPE-led DEEP_DIVE and
 * nowhere else — never on BREAKING, TRACKING or CONFLICT_FLAG, and never on a
 * DEEP_DIVE about one named athlete (CLAUDE.md, "AequOs Reference Rule";
 * monetization plan Phase 0.2, the CTA adjacency rule).
 *
 * The formatters have always honoured that, because the CTA lives inside the
 * DEEP_DIVE builders. The way it leaks is a lie about content_type upstream:
 * ApprovalSync's reconstruction hardcoded 'DEEP_DIVE', so a widened republish
 * filter would have reformatted breaking injury news as a deep-dive thread and
 * appended a referral link to it. These tests turn "the reconstruction must not
 * lie" from a code-reading argument into a checked property.
 */

// Taken from the formatter, never hardcoded. This file used to search for
// 'orthoiq.com' while production emitted orthoiq.io, so the guard below only held
// when the env matched the literal.
const CTA_MARKER = REFERRAL_CTA_MARKER;
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

describe('AequOs CTA — DEEP_DIVE only', () => {
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

  it('an injury-type-led DEEP_DIVE does carry the referral link, so these tests could fail', () => {
    const content = makeContent({ content_type: 'DEEP_DIVE', subject_kind: 'INJURY_TYPE' });
    const url = 'https://sidelineiq.vercel.app/post/slug';

    expect(joined(formatForFarcaster(content, url))).toContain(CTA_MARKER);

    process.env.TWITTER_CHAR_LIMIT = '25000';
    expect(joined(formatForTwitter(content, url))).toContain(CTA_MARKER);
  });
});

/**
 * The adjacency rule. Every DEEP_DIVE stores one athlete_name, so content_type
 * alone cannot tell "Hamstring Strains Are Clustering in the NBA" from "Moses
 * Moody Suffers Complete Patellar Tendon Rupture". subject_kind, recorded by
 * the producer, does. Every test in the first block FAILS on the pre-rule
 * formatter, which put the CTA on every DEEP_DIVE.
 */
describe('AequOs CTA — injury-type-led DEEP_DIVE only', () => {
  const originalLimit = process.env.TWITTER_CHAR_LIMIT;
  afterEach(() => {
    if (originalLimit === undefined) delete process.env.TWITTER_CHAR_LIMIT;
    else process.env.TWITTER_CHAR_LIMIT = originalLimit;
  });

  const url = 'https://sidelineiq.vercel.app/post/slug';
  const NOT_TYPE_LED: Array<[string, Partial<InjuryPostContent>]> = [
    ['ATHLETE', { subject_kind: 'ATHLETE' }],
    ['null (a pre-023 row)', { subject_kind: null }],
    ['absent', {}],
    ['an unrecognized value', { subject_kind: 'TOPIC' as unknown as 'ATHLETE' }],
  ];

  function allRenders(content: InjuryPostContent): string {
    delete process.env.TWITTER_CHAR_LIMIT;
    const short = [...formatForFarcaster(content, url), ...formatForTwitter(content, url)];
    const shortNoUrl = [...formatForFarcaster(content), ...formatForTwitter(content)];
    process.env.TWITTER_CHAR_LIMIT = '25000';
    const long = formatForTwitter(content, url);
    return joined([...short, ...shortNoUrl, ...long]);
  }

  it.each(NOT_TYPE_LED)('a DEEP_DIVE with subject_kind %s carries no referral link anywhere', (_label, kind) => {
    const content = makeContent({ content_type: 'DEEP_DIVE', ...kind });
    expect(allRenders(content)).not.toContain(CTA_MARKER);
  });

  it.each(NON_DEEP_DIVE)('%s marked INJURY_TYPE still carries no referral link', (contentType) => {
    const content = makeContent({ content_type: contentType, subject_kind: 'INJURY_TYPE' });
    expect(allRenders(content)).not.toContain(CTA_MARKER);
  });

  it('an athlete-led DEEP_DIVE still links to the full breakdown', () => {
    const content = makeContent({ content_type: 'DEEP_DIVE', subject_kind: 'ATHLETE' });
    expect(joined(formatForFarcaster(content, url))).toContain('sidelineiq.vercel.app/post/slug');
    process.env.TWITTER_CHAR_LIMIT = '25000';
    const long = formatForTwitter(content, url);
    expect(long).toHaveLength(2);
    expect(long[1]).toContain('sidelineiq.vercel.app/post/slug');
  });

  it('the type-led CTA stays on the final post only', () => {
    const content = makeContent({ content_type: 'DEEP_DIVE', subject_kind: 'INJURY_TYPE' });
    const casts = formatForFarcaster(content, url);
    expect(casts[casts.length - 1].toLowerCase()).toContain(CTA_MARKER);
    for (const c of casts.slice(0, -1)) expect(c.toLowerCase()).not.toContain(CTA_MARKER);
  });

  it('carriesReferralCta is exactly DEEP_DIVE + INJURY_TYPE', () => {
    const kinds = ['INJURY_TYPE', 'ATHLETE', null, undefined] as const;
    for (const content_type of ['DEEP_DIVE', ...NON_DEEP_DIVE] as ContentType[]) {
      for (const subject_kind of kinds) {
        expect(carriesReferralCta({ content_type, subject_kind })).toBe(
          content_type === 'DEEP_DIVE' && subject_kind === 'INJURY_TYPE',
        );
      }
    }
  });
});

describe('DEEP_DIVE post 1 framing', () => {
  const originalLimit = process.env.TWITTER_CHAR_LIMIT;
  afterEach(() => {
    if (originalLimit === undefined) delete process.env.TWITTER_CHAR_LIMIT;
    else process.env.TWITTER_CHAR_LIMIT = originalLimit;
  });

  const athleteLine = 'Jaren Kanak (Kansas City Chiefs)';

  it('an injury-type-led DEEP_DIVE opens on the topic, not "Athlete (Team)"', () => {
    const content = makeContent({
      content_type: 'DEEP_DIVE',
      subject_kind: 'INJURY_TYPE',
      headline: 'Hamstring Strains Are Clustering in the NFL',
    });
    delete process.env.TWITTER_CHAR_LIMIT;
    const first = [formatForFarcaster(content)[0], formatForTwitter(content)[0]];
    process.env.TWITTER_CHAR_LIMIT = '25000';
    first.push(formatForTwitter(content)[0]);
    for (const post of first) {
      expect(post).not.toContain(athleteLine);
      expect(post).toContain('Hamstring strain | Severity: MODERATE');
    }
  });

  it('an athlete-led DEEP_DIVE keeps its athlete line', () => {
    const content = makeContent({ content_type: 'DEEP_DIVE', subject_kind: 'ATHLETE' });
    expect(formatForFarcaster(content)[0]).toContain(athleteLine);
    process.env.TWITTER_CHAR_LIMIT = '25000';
    expect(formatForTwitter(content)[0]).toContain(athleteLine);
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
    md_review_confidence: 0.85,
    return_to_play_min_weeks: 3,
    return_to_play_max_weeks: 5,
    // Real injury_posts column names, as DECIMAL strings the way Postgres
    // returns them. DEEP_DIVE and CONFLICT_FLAG now fail closed without these,
    // because their formatters print the week-by-week percentages.
    rtp_probability_week_2: '0.100',
    rtp_probability_week_4: '0.400',
    rtp_probability_week_8: '0.850',
    rtp_confidence: '0.700',
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

  it.each([
    ['INJURY_TYPE', 'INJURY_TYPE'],
    ['ATHLETE', 'ATHLETE'],
    [null, null],
    [undefined, null],
    ['injury_type', null],
    ['TOPIC', null],
  ])('reconstructs subject_kind %s as %s — unknown becomes null, never a failure', (stored, expected) => {
    const { content } = reconstructPostContent(row({ content_type: 'DEEP_DIVE', subject_kind: stored }));
    expect(content).not.toBeNull();
    expect(content?.subject_kind).toBe(expected);
  });

  /**
   * The path that actually casts a DEEP_DIVE: every one routes to MD review, and
   * the approval republish rebuilds it from the stored row.
   */
  it('a stored type-led DEEP_DIVE keeps its CTA through reconstruction; a legacy one does not gain it', () => {
    const url = 'https://sidelineiq.vercel.app/post/slug';
    const typeLed = reconstructPostContent(row({ content_type: 'DEEP_DIVE', subject_kind: 'INJURY_TYPE' })).content!;
    const legacy = reconstructPostContent(row({ content_type: 'DEEP_DIVE' })).content!;
    process.env.TWITTER_CHAR_LIMIT = '25000';
    expect(joined(formatForTwitter(typeLed, url))).toContain(CTA_MARKER);
    expect(joined(formatForTwitter(legacy, url))).not.toContain(CTA_MARKER);
    expect(joined(formatForFarcaster(legacy, url))).not.toContain(CTA_MARKER);
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

describe('AequOs rebrand', () => {
  const ALL: ContentType[] = ['DEEP_DIVE', ...NON_DEEP_DIVE];

  it('derives the CTA marker from a URL that is not an OrthoIQ domain', () => {
    expect(CTA_MARKER).not.toBe('');
    expect(CTA_MARKER).not.toContain('orthoiq');
  });

  it.each(ALL)('never renders the retired OrthoIQ name or domain on %s', (content_type) => {
    const content = makeContent({ content_type });
    const text = joined([
      ...formatForFarcaster(content, 'https://sidelineiq.example/post/x'),
      ...formatForTwitter(content, 'https://sidelineiq.example/post/x'),
    ]);
    expect(text).not.toContain('orthoiq');
  });

  it('still renders the referral on DEEP_DIVE, so the check above is not vacuous', () => {
    const content = makeContent({ content_type: 'DEEP_DIVE', subject_kind: 'INJURY_TYPE' });
    const text = joined([
      ...formatForFarcaster(content, 'https://sidelineiq.example/post/x'),
      ...formatForTwitter(content, 'https://sidelineiq.example/post/x'),
    ]);
    expect(text).toContain(CTA_MARKER);
    expect(text).toContain('aequos');
  });
});
