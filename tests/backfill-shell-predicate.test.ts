import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyShell,
  daysStale,
  listRowsAreWide,
  defaultShellPolicy,
  type ShellCandidate,
  type ShellPolicy,
  type ShellReason,
} from '../src/utils/backfill-shells.js';

// The predicate that authorises a bulk VOID against 166 threads nobody watches.
//
// Every case here is driven by tests/fixtures/backfill-shell-threads.json,
// RECORDED from the live production DB by
//   npx tsx src/scripts/close-backfill-shells.ts --emit-fixture --out=<path>
// Four fixtures in this repo have shared the code's blind spot because they were
// hand-written to match it; these are not.
//
// FAIL-CLOSED IN BOTH DIRECTIONS. The recorded shells prove the predicate is not
// vacuously false; the recorded negative controls and the ten mechanical field
// flips prove it is not vacuously true. Delete any single conjunct from
// backfill-shells.ts and exactly one flip case fails.

interface Fixture {
  _policy: ShellPolicy;
  rows: ShellCandidate[];
  audit_counts: Record<string, number>;
}

const fx = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/backfill-shell-threads.json'), 'utf-8'),
) as Fixture;

const POLICY = fx._policy;
const audit = (r: ShellCandidate): number => fx.audit_counts[r.id] ?? 0;
const verdict = (r: ShellCandidate, n = audit(r)) => classifyShell(r, POLICY, n);

const shells = fx.rows.filter((r) => verdict(r).shell);
const controls = fx.rows.filter((r) => !verdict(r).shell);

describe('classifyShell over recorded live rows', () => {
  it('the recording carries both shells and negative controls', () => {
    // Guards the fixture itself: a recording of only shells could not fail.
    expect(shells.length).toBeGreaterThan(0);
    expect(controls.length).toBeGreaterThan(0);
  });

  it('recorded backfill shells classify as shells', () => {
    for (const r of shells) {
      expect(verdict(r)).toEqual({ shell: true, reason: 'ok' });
      expect(r.injury_date).toBeNull();
      expect(r.first_reported_at.startsWith('2026-05-31')).toBe(true);
    }
  });

  it('a shell whose canonical post was deleted is still a shell', () => {
    // 27 of the 166 have canonical_post_id NULL — the ON DELETE SET NULL
    // signature of the pre-migration-021 Reject button. Both sub-shapes must
    // pass, or a future canonical_post_id conjunct would silently exclude them.
    const withCanon = shells.filter((r) => r.canonical_post_id != null);
    const withoutCanon = shells.filter((r) => r.canonical_post_id == null);
    expect(withCanon.length).toBeGreaterThan(0);
    expect(withoutCanon.length).toBeGreaterThan(0);
    for (const r of withoutCanon) expect(verdict(r).shell).toBe(true);
  });

  it('recorded negative controls are rejected with their real reason', () => {
    for (const r of controls) {
      const v = verdict(r);
      expect(v.shell).toBe(false);
      const expected: ShellReason = r.injury_date ? 'has_injury_date' : 'outside_created_window';
      expect(v.reason, `${r.id} ${r.athlete_name}`).toBe(expected);
    }
  });

  it('the 2026-08-10 orphan is excluded by the window, not by its missing post', () => {
    // It has no canonical post and no updates, but so do 27 genuine shells. The
    // window is the honest discriminator; canonical_post_id is not.
    const orphan = fx.rows.find((r) => r.first_reported_at.startsWith('2026-08-10'));
    expect(orphan, 'the recording must contain the orphan').toBeDefined();
    expect(verdict(orphan!)).toEqual({ shell: false, reason: 'outside_created_window' });
  });
});

describe('every conjunct is load-bearing', () => {
  const base = (): ShellCandidate => ({ ...shells[0] });
  const DAY = 86_400_000;

  const flips: Array<[ShellReason, (r: ShellCandidate) => void, number?]> = [
    ['not_active', (r) => { r.status = 'RESOLVED'; }],
    ['has_injury_date', (r) => { r.injury_date = '2026-05-20'; }],
    ['has_otm_projection', (r) => { r.otm_projection = { min_weeks: 4, max_weeks: 6 }; }],
    ['has_resolution_sources', (r) => { r.date_resolution_sources = [{ stage: 'api' }]; }],
    ['needs_date_review', (r) => { r.needs_date_review = true; }],
    ['has_accuracy_record', (r) => { r.accuracy_record = { error_days: 3 }; }],
    ['outside_created_window', (r) => { r.first_reported_at = '2026-07-01T00:00:00.000Z'; }],
    ['recently_updated', (r) => {
      r.last_updated_at = new Date(POLICY.now - 1 * DAY).toISOString();
    }],
    ['has_audit_history', () => {}, 1],
  ];

  for (const [reason, mutate, auditN] of flips) {
    it(`flipping one field yields ${reason}`, () => {
      const r = base();
      mutate(r);
      expect(classifyShell(r, POLICY, auditN ?? 0)).toEqual({ shell: false, reason });
    });
  }

  it('the unmutated base is still a shell (the flips are what changed it)', () => {
    expect(classifyShell(base(), POLICY, 0)).toEqual({ shell: true, reason: 'ok' });
  });

  it('an empty date_resolution_sources array is not provenance', () => {
    // COALESCE writes can leave [] behind; that is "nothing resolved it", not
    // "something did".
    const r = base();
    r.date_resolution_sources = [];
    expect(classifyShell(r, POLICY, 0).shell).toBe(true);
  });
});

describe('the match window boundary', () => {
  const DAY = 86_400_000;
  it('is exclusive at exactly matchWindowDays — inside the window is not inert', () => {
    const r = { ...shells[0] };
    r.last_updated_at = new Date(POLICY.now - POLICY.matchWindowDays * DAY).toISOString();
    expect(classifyShell(r, POLICY, 0)).toEqual({ shell: false, reason: 'recently_updated' });
  });
  it('one millisecond older is inert', () => {
    const r = { ...shells[0] };
    r.last_updated_at = new Date(POLICY.now - POLICY.matchWindowDays * DAY - 1).toISOString();
    expect(classifyShell(r, POLICY, 0).shell).toBe(true);
  });
  it('daysStale is measured from the injected now, never the wall clock', () => {
    const r = { ...shells[0], last_updated_at: '2026-05-31T23:19:00.000Z' };
    const frozen = defaultShellPolicy(Date.parse('2026-06-10T23:19:00.000Z'));
    expect(daysStale(r, frozen.now)).toBe(10);
  });
});

describe('listRowsAreWide tests key presence, not value', () => {
  it('present-and-null is WIDE', () => {
    // The whole point: the column is JSONB and is null on 166 live rows. A
    // `!= null` implementation reports narrow here and reinstates a 268-read
    // fan-out — and cannot tell "never resolved" from "old server".
    expect(listRowsAreWide([{ id: 'x', date_resolution_sources: null }])).toBe(true);
  });
  it('a populated array is wide', () => {
    expect(listRowsAreWide([{ id: 'x', date_resolution_sources: [{ stage: 'md_manual' }] }]))
      .toBe(true);
  });
  it('key absent is narrow', () => {
    expect(listRowsAreWide([{ id: 'x', injury_date: null }])).toBe(false);
  });
  it('an empty page is narrow (nothing to conclude from)', () => {
    expect(listRowsAreWide([])).toBe(false);
  });
});
