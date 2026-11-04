import { describe, it, expect } from 'vitest';
import {
  buildElapsedLine,
  checkElapsedClaims,
  extractElapsedClaims,
} from '../src/agents/injury-intelligence/elapsed-claims.js';

const IRVING =
  'Kyrie Irving remains out for the Dallas Mavericks as he continues recovering from his left knee injury, which was originally sustained on March 3, 2025, with surgery following on March 26, 2025. He is now approximately 31 weeks post-op, placing him well inside what the biology demands.';

describe('buildElapsedLine', () => {
  const thread = { injury_date: '2025-03-03', injury_date_confidence: 'confirmed', surgery_date: '2025-03-26' };

  it('prints both computed figures for an anchored thread', () => {
    const line = buildElapsedLine(thread, '2026-11-02');
    expect(line).toContain('87 weeks (about 20 months) since injury');
    expect(line).toContain('83 weeks (about 19 months) since surgery');
  });

  it.each(['possible', 'unknown'])('prints nothing at %s', (confidence) => {
    expect(buildElapsedLine({ ...thread, injury_date_confidence: confidence }, '2026-11-02')).toBe('');
  });

  it('prints nothing when there is no readable date', () => {
    expect(buildElapsedLine({ injury_date: null, injury_date_confidence: 'probable', surgery_date: null }, '2026-11-02')).toBe('');
  });

  it('omits a surgery date in the future rather than printing a negative', () => {
    const line = buildElapsedLine({ ...thread, surgery_date: '2027-01-01' }, '2026-11-02');
    expect(line).toContain('since injury');
    expect(line).not.toContain('since surgery');
  });
});

describe('checkElapsedClaims', () => {
  it('flags the Irving post, naming the closest computed figure', () => {
    const [m, ...rest] = checkElapsedClaims(IRVING, ['2025-03-03', '2025-03-26'], '2026-11-02');
    expect(rest).toEqual([]);
    expect(m.weeks).toBe(31);
    expect(m.computed_weeks).toBe(83);
    expect(m.anchor).toBe('2025-03-26');
  });

  it('passes the same sentence with the correct number', () => {
    const fixed = IRVING.replace('31 weeks', '83 weeks');
    expect(checkElapsedClaims(fixed, ['2025-03-03', '2025-03-26'], '2026-11-02')).toEqual([]);
  });

  it('passes a claim true of the OTHER anchor', () => {
    const text = 'He is now 87 weeks post-op.';
    expect(checkElapsedClaims(text, ['2025-03-03', '2025-03-26'], '2026-11-02')).toEqual([]);
  });

  it('allows a month claim anywhere inside its month', () => {
    expect(checkElapsedClaims('She is now 19 months post-op.', ['2025-03-26'], '2026-11-02')).toEqual([]);
  });

  it('flags a year-off claim stated in months', () => {
    expect(checkElapsedClaims('He is now 7 months post-op.', ['2025-03-26'], '2026-11-02')).toHaveLength(1);
  });

  it('reads word numbers', () => {
    expect(checkElapsedClaims('It has been seven months since surgery.', ['2025-03-26'], '2026-11-02')).toHaveLength(1);
  });

  it('flags nothing without a readable anchor', () => {
    expect(checkElapsedClaims(IRVING, [null, undefined], '2026-11-02')).toEqual([]);
  });
});

describe('extractElapsedClaims reads the present-tense forms the corpus uses', () => {
  it.each([
    ['At 43 weeks post-op, Parsons sits inside the window.', 43],
    ['He is 43 weeks removed from his confirmed surgery.', 43],
    ['Now 29 weeks post-op at the time of this report.', 29],
    ['2.5 weeks removed from the initial event.', 2.5],
    ['Roughly 21 weeks post-surgery as of this report.', 21],
  ])('%s', (text, weeks) => {
    expect(extractElapsedClaims(text).map((c) => c.weeks)).toEqual([weeks]);
  });
});

describe('extractElapsedClaims leaves forward-looking windows alone', () => {
  it.each([
    'Return is expected roughly 39-52 weeks from surgery.',
    'approximately 39 weeks from surgery',
    '12 months from surgery',
    '3–5 months post-op',
    'now 3-5 months post-op',
    '6 weeks from injury',
    'Week 5 is ~39 weeks post-op',
    'Most return by 8 weeks post-op.',
    'Athletes typically resume running at 12 weeks post-surgery.',
    'clearance usually comes at 4-6 weeks post-surgery',
    'At 12 weeks post-op, most athletes resume running.',
    '4-6 weeks post-op, Murray is expected back.',
    '8 to 12 weeks post-op, Slater is expected back.',
  ])('%s', (text) => {
    expect(extractElapsedClaims(text)).toEqual([]);
  });
});
