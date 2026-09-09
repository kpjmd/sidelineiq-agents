import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSettledThreadDate,
  hasManualDate,
  assessAnchorDivergence,
} from '../src/agents/injury-intelligence/date-anchoring.js';
import threadFixture from './fixtures/date-resolution-threads.json' with { type: 'json' };

const read = (rel: string): string =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8');

describe('isSettledThreadDate', () => {
  it('settles on a real date at probable or confirmed — the same bar chooseDateAnchor uses', () => {
    expect(isSettledThreadDate({ injury_date: '2025-11-02', injury_date_confidence: 'confirmed' }))
      .toEqual({ settled: true, reason: 'anchored' });
    // Danny Pinter, Ashton Jeanty, Alvin Kamara and Jayden Higgins all sat at
    // 'probable' while the system flip-flopped their dates, so a confirmed-only
    // bar would have left every adjacent-day case oscillating.
    expect(isSettledThreadDate({ injury_date: '2026-08-19', injury_date_confidence: 'probable' }))
      .toEqual({ settled: true, reason: 'anchored' });
  });

  it('does not settle below probable', () => {
    expect(isSettledThreadDate({ injury_date: '2026-08-19', injury_date_confidence: 'possible' }).settled)
      .toBe(false);
    expect(isSettledThreadDate({ injury_date: '2026-08-19', injury_date_confidence: 'unknown' }).settled)
      .toBe(false);
  });

  it('never settles without a date, whatever the confidence claims', () => {
    // Load-bearing: first establishment must always resolve, so
    // updateThreadDates' first otm_projection_reanchored still fires.
    expect(isSettledThreadDate({ injury_date: null, injury_date_confidence: 'confirmed' }).settled)
      .toBe(false);
    expect(isSettledThreadDate({ injury_date: '', injury_date_confidence: 'confirmed' }).settled)
      .toBe(false);
    expect(isSettledThreadDate({ injury_date: '2026-07', injury_date_confidence: 'confirmed' }).settled)
      .toBe(false);
  });

  it('settles on md_manual at any confidence, including with no date', () => {
    // The MCP guard already nulls every date field of a system write once
    // md_manual is stored, so resolving again cannot change anything.
    for (const confidence of ['unknown', 'possible', 'probable', 'confirmed'] as const) {
      expect(
        isSettledThreadDate({
          injury_date: null,
          injury_date_confidence: confidence,
          date_resolution_sources: [{ stage: 'md_manual' }],
        }),
      ).toEqual({ settled: true, reason: 'md_manual' });
    }
  });

  it('treats api/web_search provenance as ordinary', () => {
    expect(
      isSettledThreadDate({
        injury_date: '2026-08-19',
        injury_date_confidence: 'possible',
        date_resolution_sources: [{ stage: 'api' }, { stage: 'web_search' }],
      }).settled,
    ).toBe(false);
    expect(hasManualDate({ date_resolution_sources: [{ stage: 'api' }] })).toBe(false);
    expect(hasManualDate({ date_resolution_sources: [] })).toBe(false);
    expect(hasManualDate({})).toBe(false);
    expect(hasManualDate(null)).toBe(false);
  });

  it('tolerates a timestamp-shaped date coming back from the DB', () => {
    expect(
      isSettledThreadDate({
        injury_date: '2025-11-02T00:00:00.000Z',
        injury_date_confidence: 'confirmed',
      }),
    ).toEqual({ settled: true, reason: 'anchored' });
  });

  it('handles a missing thread', () => {
    expect(isSettledThreadDate(null)).toEqual({ settled: false, reason: null });
    expect(isSettledThreadDate(undefined)).toEqual({ settled: false, reason: null });
  });
});

describe('assessAnchorDivergence', () => {
  it('flags the two live wrong-year cases', () => {
    // Patrick Mahomes: OTM 2025-12-15, resolver 2024-12-15, confidence confirmed.
    expect(assessAnchorDivergence('2024-12-15', '2025-12-15').kind).toBe('year_apart');
    // Micah Parsons: OTM 2025-12-29, resolver 2024-12-14. 380 days apart and 15
    // apart on the calendar — a +-5 day bar would have missed him.
    expect(assessAnchorDivergence('2024-12-14', '2025-12-29').kind).toBe('year_apart');
  });

  it('leaves the benign injury-vs-surgery divergences alone', () => {
    // George Kittle: OTM 2026-01-14 (surgery), resolver 2026-01-11 (injury).
    expect(assessAnchorDivergence('2026-01-11', '2026-01-14').kind).toBe('other');
    // Nick Bosa: 2025-09-21 vs 2025-09-26.
    expect(assessAnchorDivergence('2025-09-21', '2025-09-26').kind).toBe('other');
    expect(assessAnchorDivergence('2025-12-14', '2025-12-29').kind).toBe('other');
  });

  it('does not flag a year-plus gap at a different time of year', () => {
    expect(assessAnchorDivergence('2024-08-20', '2025-11-02').kind).toBe('other');
  });

  it('reports none when either date is missing, unparseable or identical', () => {
    expect(assessAnchorDivergence(null, '2025-01-01').kind).toBe('none');
    expect(assessAnchorDivergence('2025-01-01', undefined).kind).toBe('none');
    expect(assessAnchorDivergence('2026-07', '2025-07-01').kind).toBe('none');
    expect(assessAnchorDivergence('2025-01-01', '2025-01-01')).toEqual({
      kind: 'none',
      days_apart: 0,
      resolver_date: '2025-01-01',
      otm_date: '2025-01-01',
    });
  });
});

describe('the settled rule lives in date-anchoring, not the poller', () => {
  it('the poller imports the predicate', () => {
    expect(read('src/monitoring/poller.ts')).toContain('isSettledThreadDate');
  });

  it('and still re-inlines no confidence ternary', () => {
    // date-anchor-choice.test.ts asserts the same thing; repeated here because
    // "settled" is the second rule that would be tempting to inline, and one
    // list of anchor confidences is the whole point.
    for (const path of ['src/monitoring/poller.ts', 'src/agents/injury-intelligence/agent.ts']) {
      expect(read(path)).not.toContain("injury_date_confidence === 'probable'");
    }
  });
});

describe('against recorded production rows', () => {
  // Recorded from the live DB by `date-resolution-dryrun --emit-fixture`, never
  // hand-authored: four fixtures in this repo have passed against broken code
  // because they were written to match it. Selection is mechanical — the six
  // flip-flop threads plus one row per confidence/date/provenance shape.
  const byName = (name: string) =>
    threadFixture.threads.filter((t) => t.athlete_name === name);

  it('the fixture carries real shapes, not invented ones', () => {
    expect(threadFixture._recorded_from).toContain('live production DB');
    expect(threadFixture.threads.length).toBeGreaterThan(5);
    // Both provenance shapes must be present or the md_manual arm is untested.
    expect(threadFixture.threads.some((t) => hasManualDate(t))).toBe(true);
    expect(threadFixture.threads.some((t) => !hasManualDate(t))).toBe(true);
  });

  it('settles every thread whose date the system was flip-flopping', () => {
    // These are the entities with repeated system otm_projection_reanchored
    // rows in audit_log. Each one would now be left alone.
    for (const name of ['Patrick Mahomes', 'Danny Pinter', 'Ashton Jeanty', 'Alvin Kamara', 'Jayden Higgins']) {
      const dated = byName(name).filter((t) => t.injury_date);
      expect(dated.length, name).toBeGreaterThan(0);
      for (const t of dated) expect(isSettledThreadDate(t).settled, `${name} ${t.id}`).toBe(true);
    }
  });

  it('leaves a real dateless thread resolvable', () => {
    const dateless = threadFixture.threads.filter((t) => !t.injury_date && !hasManualDate(t));
    expect(dateless.length).toBeGreaterThan(0);
    for (const t of dateless) expect(isSettledThreadDate(t).settled, t.id).toBe(false);
  });
});
