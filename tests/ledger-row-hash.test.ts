/**
 * The row hash is printed on every card and committed with every row, and
 * three repos compute it. This test pins THIS copy to the recorded fixture; the
 * mcp and frontend copies run the same fixture, so a one-sided edit fails in
 * whichever repo made it.
 */
import { describe, it, expect } from 'vitest';
import {
  LEDGER_HASH_VERSION,
  LEDGER_HASH_FIELDS,
  ledgerHashInput,
  ledgerRowHash,
  canonicalize,
  shortHash,
  type HashableForecastRow,
} from '../src/ledger/row-hash.js';
import fixture from './fixtures/ledger-hash-cases.json' with { type: 'json' };

interface Case {
  name: string;
  rule: string;
  input: Record<string, unknown>;
  equivalent?: Record<string, unknown>;
  normalized: Record<string, unknown>;
  row_hash: string;
}

/** Undo the fixture's wire markers: {"$date": iso} → Date, {"$undefined": true} → omitted. */
function revive(input: Record<string, unknown>): HashableForecastRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v && typeof v === 'object' && '$date' in (v as object)) out[k] = new Date((v as { $date: string }).$date);
    else if (v && typeof v === 'object' && '$undefined' in (v as object)) continue;
    else out[k] = v;
  }
  return out as unknown as HashableForecastRow;
}

const CASES = (fixture as unknown as { cases: Case[] }).cases;

describe('ledger row hash fixture', () => {
  it('was recorded against this hash version', () => {
    expect((fixture as unknown as { hash_version: number }).hash_version).toBe(LEDGER_HASH_VERSION);
  });

  for (const c of CASES) {
    it(`${c.name} — ${c.rule}`, () => {
      const row = revive(c.input);
      expect(ledgerHashInput(row)).toEqual(c.normalized);
      expect(ledgerRowHash(row)).toBe(c.row_hash);
      if (c.equivalent) expect(ledgerRowHash(revive(c.equivalent))).toBe(c.row_hash);
    });
  }

  it('distinct normalized inputs give distinct hashes, identical ones the same hash', () => {
    const byInput = new Map<string, string>();
    for (const c of CASES) {
      const key = canonicalize(c.normalized);
      if (byInput.has(key)) expect(byInput.get(key)).toBe(c.row_hash);
      byInput.set(key, c.row_hash);
    }
    expect(new Set(byInput.values()).size).toBe(byInput.size);
    expect(byInput.size).toBe(4);
  });
});

describe('ledger row hash rules', () => {
  const base = revive(CASES[0].input);

  it('covers exactly the spec fields plus published_at, and hash_version', () => {
    const keys = Object.keys(ledgerHashInput(base)).sort();
    expect(keys).toEqual([...LEDGER_HASH_FIELDS, 'hash_version'].sort());
  });

  it('leaves provenance OUT of the hash: a social id or commit sha changes nothing', () => {
    const withProvenance = { ...base, commit_sha: 'abc', x_post_id: '1', farcaster_hash: '0x', confirmed_by: 'u' };
    expect(ledgerRowHash(withProvenance as HashableForecastRow)).toBe(ledgerRowHash(base));
  });

  it('refuses a revision without a trigger', () => {
    expect(() => ledgerRowHash({ ...base, version: 2, trigger: null })).toThrow(/trigger/);
  });

  it('refuses an incoherent F4 interval and an out-of-range probability', () => {
    expect(() => ledgerRowHash({ ...base, f4_low: 4, f4_point: 3, f4_high: 5 })).toThrow(/low ≤ point ≤ high/);
    expect(() => ledgerRowHash({ ...base, f1_ir: 1.2 })).toThrow(/\[0, 1\]/);
    expect(() => ledgerRowHash({ ...base, f1_ir: '18%' })).toThrow(/\[0, 1\]/);
  });

  it('refuses a malformed timestamp rather than hashing an Invalid Date', () => {
    expect(() => ledgerRowHash({ ...base, published_at: 'yesterday' })).toThrow(/timestamp/);
  });

  it('canonical JSON sorts keys and nests', () => {
    expect(canonicalize({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  });

  it('shortHash is the first 8 hex characters of a real hash only', () => {
    const h = ledgerRowHash(base);
    expect(shortHash(h)).toBe(h.slice(0, 8));
    expect(() => shortHash('deadbeef')).toThrow();
  });
});
