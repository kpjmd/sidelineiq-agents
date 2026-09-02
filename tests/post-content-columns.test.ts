import { describe, it, expect } from 'vitest';
import {
  reconstructPostContent,
  describeReconstructFailure,
  type StoredPostRow,
} from '../src/utils/post-content.js';
import recordedRow from './fixtures/injury-post-row.json' with { type: 'json' };

/**
 * These tests exist because the previous suite could not have caught the bug
 * they cover. Every fixture in it was hand-written with the field names the
 * code already used, so the tests and the code agreed with each other while
 * both disagreed with the database.
 *
 * The fixture here is a RECORDED web_get_post payload (Luka Doncic DEEP_DIVE,
 * 2026-04-29 — the one post that actually went out reading 0%/0%/0%). Do not
 * hand-edit its column names: its only job is to be the schema's opinion rather
 * than the code's.
 */
describe('post-content reads real injury_posts columns', () => {
  const row = recordedRow as unknown as StoredPostRow;

  it('the fixture carries the real column names, not the ones the code used to read', () => {
    // If this fails, someone "fixed" the fixture to match the code again.
    expect(row).toHaveProperty('rtp_probability_week_2');
    expect(row).toHaveProperty('rtp_confidence');
    expect(row).toHaveProperty('md_review_confidence');
    expect(row).not.toHaveProperty('return_to_play_probability_week_2');
    expect(row).not.toHaveProperty('return_to_play_confidence');
    expect(row).not.toHaveProperty('confidence');
  });

  it('round-trips the stored probabilities instead of zeroing them', () => {
    const { content } = reconstructPostContent(row);

    // The live cast said 0% / 0% / 0%. These are the values it should have had.
    expect(content?.return_to_play.probability_week_2).toBe(0.55);
    expect(content?.return_to_play.probability_week_4).toBe(0.8);
    expect(content?.return_to_play.probability_week_8).toBe(0.97);
  });

  it('coerces the DECIMAL strings Postgres actually returns', () => {
    // Guards the Number() coercion: the driver hands back "0.550", not 0.55.
    expect(typeof (row as Record<string, unknown>).rtp_probability_week_2).toBe('string');
    const { content } = reconstructPostContent(row);
    expect(content?.return_to_play.probability_week_2).toBeTypeOf('number');
  });

  it('reads the confidence columns by their real names', () => {
    const { content } = reconstructPostContent(row);
    expect(content?.return_to_play.confidence).toBe(0.62);
    expect(content?.confidence).toBe(0.5);
  });

  it('renders the week line from stored values, not zeros', () => {
    const { content } = reconstructPostContent(row);
    const rtp = content!.return_to_play;
    const line = `Wk 2: ${Math.round(rtp.probability_week_2 * 100)}% | Wk 4: ${Math.round(
      rtp.probability_week_4 * 100,
    )}% | Wk 8: ${Math.round(rtp.probability_week_8 * 100)}%`;

    expect(line).toBe('Wk 2: 55% | Wk 4: 80% | Wk 8: 97%');
    expect(line).not.toBe('Wk 2: 0% | Wk 4: 0% | Wk 8: 0%');
  });
});

describe('post-content fails closed on missing probabilities', () => {
  const base = (contentType: string, extra: Record<string, unknown> = {}): StoredPostRow =>
    ({
      athlete_name: 'Coby Bryant',
      sport: 'NFL',
      team: 'Seattle Seahawks',
      injury_type: 'Knee hyperextension',
      injury_severity: 'MODERATE',
      content_type: contentType,
      headline: 'Coby Bryant knee hyperextension',
      clinical_summary: 'Bone bruise with capsular involvement.',
      return_to_play_min_weeks: 4,
      return_to_play_max_weeks: 8,
      ...extra,
    }) as StoredPostRow;

  const probabilities = {
    rtp_probability_week_2: '0.000',
    rtp_probability_week_4: '0.100',
    rtp_probability_week_8: '0.020',
  };

  it.each(['DEEP_DIVE', 'CONFLICT_FLAG'])(
    'refuses to reconstruct %s when the probability columns are absent',
    (contentType) => {
      const { content, reason } = reconstructPostContent(base(contentType));
      expect(content).toBeNull();
      expect(reason).toBe('missing_rtp_probabilities');
    },
  );

  it('refuses a row carrying only the old, non-existent column names', () => {
    // Exactly the shape the code used to read. Before the fix this produced a
    // publishable post reading 0%/0%/0%; now it must produce nothing.
    const { content, reason } = reconstructPostContent(
      base('DEEP_DIVE', {
        return_to_play_probability_week_2: 0.55,
        return_to_play_probability_week_4: 0.8,
        return_to_play_probability_week_8: 0.97,
      }),
    );
    expect(content).toBeNull();
    expect(reason).toBe('missing_rtp_probabilities');
  });

  it('still publishes a genuine stored zero', () => {
    // Moses Moody: complete patellar tendon rupture really is 0% at week 8.
    // A true 0.000 must not be mistaken for a missing column.
    const { content, reason } = reconstructPostContent(
      base('DEEP_DIVE', {
        rtp_probability_week_2: '0.000',
        rtp_probability_week_4: '0.000',
        rtp_probability_week_8: '0.000',
      }),
    );
    expect(reason).toBeUndefined();
    expect(content?.return_to_play.probability_week_8).toBe(0);
  });

  it.each(['BREAKING', 'TRACKING'])(
    'still reconstructs %s without probability columns',
    (contentType) => {
      // These formatters print the week window, never percentages, so blocking
      // them would break the approval path for breaking injury news.
      const { content, reason } = reconstructPostContent(base(contentType));
      expect(reason).toBeUndefined();
      expect(content?.content_type).toBe(contentType);
      expect(content?.return_to_play.min_weeks).toBe(4);
    },
  );

  it('reconstructs CONFLICT_FLAG once the probabilities are present', () => {
    const { content } = reconstructPostContent(base('CONFLICT_FLAG', probabilities));
    expect(content?.return_to_play.probability_week_4).toBe(0.1);
    expect(content?.return_to_play.probability_week_8).toBe(0.02);
  });

  it('restores injury_date, sliced back from the DB timestamp', () => {
    // FAILS against pre-fix code, which never read the column. Every
    // approval-republish formatted its RTP window as "start date unconfirmed"
    // while the stored row knew the date — and a republished CONFLICT_FLAG
    // could print no gap at all. Postgres DATE arrives as a full ISO stamp.
    const row = { ...base('CONFLICT_FLAG', probabilities), injury_date: '2025-11-02T00:00:00.000Z' };
    expect(reconstructPostContent(row).content?.injury_date).toBe('2025-11-02');
  });

  it('leaves injury_date undefined when the stored row has none', () => {
    // Fail-closed boundary: the recorded fixture carries injury_date null.
    expect(reconstructPostContent(base('CONFLICT_FLAG', probabilities)).content?.injury_date)
      .toBeUndefined();
  });

  it('reports the three failures distinguishably', () => {
    expect(describeReconstructFailure('missing_rtp_probabilities')).not.toBe(
      describeReconstructFailure('missing_rtp'),
    );
    expect(describeReconstructFailure('missing_rtp_probabilities')).toMatch(/rtp_probability/);
    expect(describeReconstructFailure('unknown_content_type')).toMatch(/content_type/);
  });
});
