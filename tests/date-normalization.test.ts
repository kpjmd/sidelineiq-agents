import { describe, it, expect } from 'vitest';
import { addWeeksIso } from '../src/monitoring/poller.js';

// Regression: the DB DATE column comes back through MCP JSON as a full ISO
// timestamp ('2026-01-19T00:00:00.000Z'), not 'YYYY-MM-DD'. addWeeksIso must
// handle both without producing an invalid date.
describe('addWeeksIso', () => {
  it('handles plain YYYY-MM-DD', () => {
    expect(addWeeksIso('2026-01-19', 4)).toBe('2026-02-16');
  });

  it('handles a full ISO timestamp (the DB-returned form)', () => {
    expect(addWeeksIso('2026-01-19T00:00:00.000Z', 4)).toBe('2026-02-16');
  });

  it('supports fractional weeks (RTP midpoints)', () => {
    // 6.5 weeks = 45.5 days → floors to the 45-day mark at UTC midnight
    expect(addWeeksIso('2026-01-19', 6.5)).toBe('2026-03-05');
  });

  it('returns null on an unparseable date instead of throwing', () => {
    expect(addWeeksIso('not-a-date', 4)).toBeNull();
  });
});
