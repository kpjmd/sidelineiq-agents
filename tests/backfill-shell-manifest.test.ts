import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertBlastRadius, type ShellCandidate, type ShellPolicy }
  from '../src/utils/backfill-shells.js';
import { buildManifest, renderTable, type SweepRow }
  from '../src/scripts/close-backfill-shells.js';

// The manifest is the only artefact a human reads before authorising 166 VOIDs,
// and the blast-radius cap is the only thing standing between a wrong predicate
// and a bulk write.
//
// FAIL-CLOSED IN BOTH DIRECTIONS: assertBlastRadius must throw at one over and
// must NOT throw at exactly the cap — a "fix" that truncates instead of aborting
// fails the first, and one that is off by one fails the second.

interface Fixture {
  _policy: ShellPolicy;
  rows: ShellCandidate[];
  audit_counts: Record<string, number>;
}
const fx = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/backfill-shell-threads.json'), 'utf-8'),
) as Fixture;

const rows: SweepRow[] = fx.rows.map((r) => ({ ...r, sport: 'NFL' }));
const counts = new Map(Object.entries(fx.audit_counts));

describe('buildManifest', () => {
  const entries = buildManifest(rows, counts, fx._policy);

  it('decides every recorded row and gives each one a reason', () => {
    expect(entries).toHaveLength(rows.length);
    for (const e of entries) {
      expect(['void', 'skip']).toContain(e.decision);
      expect(e.reason).toBeTruthy();
      if (e.decision === 'void') expect(e.reason).toBe('ok');
      else expect(e.reason).not.toBe('ok');
    }
  });

  it('never marks a non-ACTIVE row for voiding', () => {
    const nonActive = buildManifest(
      rows.map((r) => ({ ...r, status: 'RESOLVED' })),
      counts,
      fx._policy,
    );
    expect(nonActive.every((e) => e.decision === 'skip')).toBe(true);
    expect(nonActive.every((e) => e.reason === 'not_active')).toBe(true);
  });

  it('computes days_stale from the injected policy.now, never the wall clock', () => {
    const shifted = { ...fx._policy, now: fx._policy.now + 100 * 86_400_000 };
    const later = buildManifest(rows, counts, shifted);
    for (let i = 0; i < entries.length; i += 1) {
      expect(later[i].days_stale).toBe(entries[i].days_stale + 100);
    }
  });

  it('carries the audit count through so the manifest shows the evidence', () => {
    const withHistory = buildManifest(rows, new Map(rows.map((r) => [r.id, 3])), fx._policy);
    for (const e of withHistory) {
      expect(e.audit_entries).toBe(3);
      expect(e.decision).toBe('skip');
    }
  });

  it('renders a table naming every row and its decision', () => {
    const table = renderTable(entries);
    for (const e of entries) {
      expect(table).toContain(e.entity_id.slice(0, 6));
      expect(table).toContain(e.reason);
    }
  });
});

describe('assertBlastRadius aborts rather than truncating', () => {
  it('throws at one over the cap, naming both numbers', () => {
    expect(() => assertBlastRadius(167, 166)).toThrowError(/167.*166/s);
    expect(() => assertBlastRadius(167, 166)).toThrowError(/truncated/i);
  });
  it('does not throw at exactly the cap', () => {
    expect(() => assertBlastRadius(166, 166)).not.toThrow();
  });
  it('does not throw under the cap', () => {
    expect(() => assertBlastRadius(0, 170)).not.toThrow();
  });
});
