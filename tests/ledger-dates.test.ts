import { describe, it, expect } from 'vitest';
import {
  isIsoDate,
  addDays,
  daysBetween,
  compareDates,
  etCalendarDate,
  etToUtcIso,
  endOfEtDayIso,
  compareInstants,
} from '../src/ledger/dates.js';

describe('ledger dates', () => {
  it('validates YYYY-MM-DD strictly', () => {
    expect(isIsoDate('2026-09-13')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-13')).toBe(false);
    expect(isIsoDate('2026-09-13T00:00:00Z')).toBe(false);
    expect(isIsoDate(20260913)).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
    expect(addDays('2026-12-30', 28)).toBe('2027-01-27');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('measures and orders days', () => {
    expect(daysBetween('2026-09-13', '2026-10-11')).toBe(28);
    expect(daysBetween('2026-10-11', '2026-09-13')).toBe(-28);
    expect(compareDates('2026-09-13', '2026-09-14')).toBe(-1);
    expect(compareDates('2026-09-14', '2026-09-14')).toBe(0);
  });

  it('reads the New York calendar date of an instant (the Bosa Thursday-night trap)', () => {
    // 2026-09-11T00:35Z is a Thursday 8:35pm kickoff on 2026-09-10 in New York.
    expect(etCalendarDate(new Date('2026-09-11T00:35:00Z'))).toBe('2026-09-10');
    expect(etCalendarDate(new Date('2026-09-11T04:00:00Z'))).toBe('2026-09-11');
  });

  it('converts an Eastern wall clock to UTC in both daylight and standard time', () => {
    // September: EDT = UTC−4.
    expect(etToUtcIso('2026-09-13', '13:00')).toBe('2026-09-13T17:00:00.000Z');
    // Sunday Night Football kickoff 20:20 ET lands on the next UTC day.
    expect(etToUtcIso('2026-09-13', '20:20')).toBe('2026-09-14T00:20:00.000Z');
    // December: EST = UTC−5.
    expect(etToUtcIso('2026-12-13', '13:00')).toBe('2026-12-13T18:00:00.000Z');
  });

  it('ends a New York day at the next local midnight', () => {
    expect(endOfEtDayIso('2026-09-20')).toBe('2026-09-21T04:00:00.000Z');
    expect(endOfEtDayIso('2026-12-20')).toBe('2026-12-21T05:00:00.000Z');
  });

  it('orders instants', () => {
    expect(compareInstants('2026-09-13T17:00:00.000Z', '2026-09-13T17:00:00.001Z')).toBe(-1);
    expect(() => compareInstants('nope', '2026-09-13T17:00:00.000Z')).toThrow();
  });
});
