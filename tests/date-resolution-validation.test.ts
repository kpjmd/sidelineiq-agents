import { describe, it, expect } from 'vitest';
import {
  validateResolvedDates,
  type ResolvedDates,
} from '../src/agents/injury-intelligence/date-validation.js';

/**
 * The resolver did no validation at all — `toResult` only trimmed — so whatever
 * the model typed reached the MCP write verbatim. The cases below are the LIVE
 * emits that exposed it, read out of the production `[ThreadManager]` log
 * lines, not invented.
 */

const TODAY = '2026-09-09';

function run(over: Partial<ResolvedDates> = {}) {
  return validateResolvedDates({
    injury_date: null,
    injury_date_confidence: 'unknown',
    surgery_date: null,
    surgery_confirmed: false,
    today: TODAY,
    ...over,
  });
}

describe('validateResolvedDates', () => {
  it('drops a YYYY-MM injury date (live: Jonathan Greenard, "injury_date=2026-07")', () => {
    const r = run({ injury_date: '2026-07', injury_date_confidence: 'possible' });
    expect(r.injury_date).toBeNull();
    expect(r.violations).toContain('injury_date_malformed');
    // Not salvaged to 2026-07-01 — inventing a day is the confidently-wrong
    // date the anchoring rules forbid, and every RTP week measures from it.
    expect(r.injury_date).not.toBe('2026-07-01');
  });

  it('drops a YYYY-MM surgery date but KEEPS surgery_confirmed and the injury date (live: Mykel Williams)', () => {
    const r = run({
      injury_date: '2025-11-02',
      injury_date_confidence: 'confirmed',
      surgery_date: '2025-11',
      surgery_confirmed: true,
    });
    expect(r.surgery_date).toBeNull();
    expect(r.surgery_confirmed).toBe(true); // confirmation is not the date
    expect(r.injury_date).toBe('2025-11-02');
    expect(r.injury_date_confidence).toBe('confirmed');
    expect(r.violations).toEqual(['surgery_date_malformed']);
  });

  it('caps confidence at possible when injury and surgery sit a year apart on the same day (live: Patrick Mahomes)', () => {
    const r = run({
      injury_date: '2024-12-15',
      injury_date_confidence: 'confirmed',
      surgery_date: '2025-12-15',
      surgery_confirmed: true,
    });
    // Both kept — the value may still be right, and the MD needs the evidence.
    expect(r.injury_date).toBe('2024-12-15');
    expect(r.surgery_date).toBe('2025-12-15');
    expect(r.injury_date_confidence).toBe('possible');
    expect(r.violations).toContain('surgery_injury_year_apart');
  });

  it('a genuine delayed surgery a year later is NOT flagged when the calendar day differs', () => {
    const r = run({
      injury_date: '2025-09-21',
      injury_date_confidence: 'confirmed',
      surgery_date: '2026-08-14',
      surgery_confirmed: true,
    });
    expect(r.injury_date_confidence).toBe('confirmed');
    expect(r.violations).toEqual([]);
  });

  it('drops a surgery date that precedes the injury and downgrades one tier', () => {
    const r = run({
      injury_date: '2026-03-01',
      injury_date_confidence: 'confirmed',
      surgery_date: '2026-02-01',
      surgery_confirmed: true,
    });
    expect(r.surgery_date).toBeNull();
    expect(r.surgery_confirmed).toBe(true);
    expect(r.injury_date_confidence).toBe('probable');
    expect(r.violations).toContain('surgery_before_injury');
  });

  it('keeps today+1 but drops today+2 — the tolerance is the UTC/local edge, not slack', () => {
    const kept = run({ injury_date: '2026-09-10', injury_date_confidence: 'probable' });
    expect(kept.injury_date).toBe('2026-09-10');
    expect(kept.violations).toEqual([]);

    const dropped = run({ injury_date: '2026-09-11', injury_date_confidence: 'probable' });
    expect(dropped.injury_date).toBeNull();
    expect(dropped.injury_date_confidence).toBe('unknown');
    expect(dropped.violations).toContain('injury_date_future');
  });

  it('drops a date older than the plausibility window', () => {
    const r = run({ injury_date: '2015-03-04', injury_date_confidence: 'confirmed' });
    expect(r.injury_date).toBeNull();
    expect(r.violations).toContain('injury_date_absurdly_old');
  });

  it('drops a well-shaped but non-existent calendar date', () => {
    const r = run({ injury_date: '2026-02-30', injury_date_confidence: 'confirmed' });
    expect(r.injury_date).toBeNull();
    expect(r.violations).toContain('injury_date_malformed');
  });

  it('forces unknown when any confidence tier is claimed with no date', () => {
    // The tier measures the DATE; the emit schema only requires the tier, so
    // this combination is expressible and used to flow straight through the
    // Pass-1 fast path. 'possible' counts too — the poller sets
    // needs_date_review on 'unknown' alone, so anything else leaves a
    // dateless thread unflagged.
    for (const claimed of ['possible', 'probable', 'confirmed'] as const) {
      const r = run({ injury_date: null, injury_date_confidence: claimed });
      expect(r.injury_date_confidence).toBe('unknown');
      expect(r.violations).toContain('confidence_without_date');
    }
  });

  it('drops the date AND the tier together when the date is unusable', () => {
    const r = run({ injury_date: '2026-07', injury_date_confidence: 'possible' });
    expect(r.injury_date).toBeNull();
    expect(r.injury_date_confidence).toBe('unknown');
    expect(r.violations).toEqual(['injury_date_malformed', 'confidence_without_date']);
  });

  // Fail-closed the other way: this one PASSES against pre-fix code and must
  // keep passing. It is what catches a validator that has become over-eager.
  it('is inert on a clean resolution', () => {
    const clean: ResolvedDates = {
      injury_date: '2025-11-02',
      injury_date_confidence: 'confirmed',
      surgery_date: '2025-11-14',
      surgery_confirmed: true,
    };
    const r = validateResolvedDates({ ...clean, today: TODAY });
    expect(r).toEqual({ ...clean, violations: [] });
  });
});
