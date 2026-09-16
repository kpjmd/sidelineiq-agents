/**
 * --allow-dated waives the injury_date blocker and NOTHING else.
 *
 * resolveThreadAndDates writes a date BEFORE any post exists, so a thread
 * carrying a date and nothing else is the commonest shell shape — and refusing
 * it made the script unable to retract the shells it was written for. The flag
 * is the narrow opt-in. The risk it introduces is a careless sweep taking a
 * thread that actually covered something, so every other blocker is asserted
 * to survive it.
 */
import { describe, it, expect } from 'vitest';
import { blockers } from '../src/scripts/void-thread.js';

const shell = {
  id: 'e1',
  player_id: 'p1',
  body_part: 'head',
  laterality: 'UNSPECIFIED',
  injury_type: null,
  status: 'ACTIVE',
  canonical_post_id: null,
  injury_date: '2026-08-08',
  otm_projection: null,
  accuracy_record: null,
  first_reported_at: '2026-08-08T00:00:00Z',
  last_updated_at: '2026-08-08T00:00:00Z',
  void_reason: null,
};

describe('blockers', () => {
  it('blocks a dated shell by default and names the flag', () => {
    const out = blockers(shell, 0, 0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/injury_date/);
    expect(out[0]).toMatch(/--allow-dated/);
  });

  it('clears a dated shell with the flag', () => {
    expect(blockers(shell, 0, 0, true)).toEqual([]);
  });

  it('waives the date and nothing else', () => {
    // Each of these must still stop the script with the flag set.
    expect(blockers({ ...shell, canonical_post_id: 'post-1' }, 0, 0, true)).toHaveLength(1);
    expect(blockers(shell, 1, 0, true)).toHaveLength(1);
    expect(blockers(shell, 0, 1, true)).toHaveLength(1);
    expect(blockers({ ...shell, otm_projection: { min_weeks: 4 } }, 0, 0, true)).toHaveLength(1);
    expect(blockers({ ...shell, accuracy_record: { within_range: true } }, 0, 0, true)).toHaveLength(1);
    expect(blockers({ ...shell, status: 'RESOLVED' }, 0, 0, true)).toHaveLength(1);
  });

  it('reports every blocker at once, so one --allow-dated run cannot reveal them one at a time', () => {
    const busy = { ...shell, canonical_post_id: 'post-1', otm_projection: { min_weeks: 4 } };
    expect(blockers(busy, 3, 2, true).length).toBe(4);
  });
});
