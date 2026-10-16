/**
 * Pins the raw-export twin (agents src/ledger/export-csv.ts ↔ frontend
 * lib/ledger-export-csv.ts) against a fixture RECORDED from the live ledger by
 * src/scripts/ledger-csv-fixture.ts. The frontend runs the same assertions on
 * the same file.
 *
 * Spec "Public site → raw export": the CSV recomputes to the published boards
 * with the pinned scoring helper. Decision S4-1: as_of is the ledger as it
 * stood at the end of that New York day, never adds a row, and is the identity
 * past every timestamp.
 */
import { describe, it, expect } from 'vitest';
import {
  LEDGER_CSV_VERSION, endOfEtDay, isAsOfDate, ledgerAsOf, ledgerCsv, ledgerFromCsv, parseLedgerCsv, type LedgerCsvPayload,
} from '../src/ledger/export-csv.js';
import { summarizeLedger, type ScoringForecastRow, type ScoringResolutionRow } from '../src/ledger/scoring.js';
import fixture from './fixtures/ledger-csv-cases.json' with { type: 'json' };

interface CsvCase { name: string; as_of: string | null; export: LedgerCsvPayload; csv: string; expect: { initial: unknown; latest: unknown; entries_scored: number; open_fields: number } }
const f = fixture as unknown as { csv_version: number; cases: CsvCase[] };
const view = (c: CsvCase) => (c.as_of ? ledgerAsOf(c.export, endOfEtDay(c.as_of)) : c.export);
const score = (p: { forecasts: unknown[]; resolutions: unknown[] }) => summarizeLedger(p.forecasts as ScoringForecastRow[], p.resolutions as ScoringResolutionRow[]);
const strip = <T extends { kind: string }>({ kind: _k, ...rest }: T) => rest;

describe('ledger-csv-cases.json (recorded live)', () => {
  it('matches LEDGER_CSV_VERSION', () => {
    expect(f.csv_version).toBe(LEDGER_CSV_VERSION);
    expect(f.cases.length).toBeGreaterThan(0);
  });

  for (const c of f.cases) {
    describe(c.name, () => {
      it('writes the recorded CSV byte for byte', () => {
        expect(ledgerCsv(view(c))).toBe(c.csv);
      });

      it('scores to the recorded boards', () => {
        const s = score(view(c));
        expect(strip(s.initial)).toEqual(c.expect.initial);
        expect(strip(s.latest)).toEqual(c.expect.latest);
        expect(s.entries_scored).toBe(c.expect.entries_scored);
        expect(s.open_fields).toBe(c.expect.open_fields);
      });

      it('recomputes to the same boards from the CSV alone', () => {
        const fromCsv = score(ledgerFromCsv(c.csv));
        const direct = score(view(c));
        expect(fromCsv.initial).toEqual(direct.initial);
        expect(fromCsv.latest).toEqual(direct.latest);
        expect(fromCsv.voids).toEqual(direct.voids);
        expect(fromCsv.exclusions).toEqual(direct.exclusions);
      });

      it('has one row per resolution in the view', () => {
        expect(parseLedgerCsv(c.csv)).toHaveLength(view(c).resolutions.length);
      });
    });
  }
});

describe('ledgerAsOf', () => {
  const live = f.cases.find((c) => c.as_of === null)!;

  it('is the identity after every timestamp', () => {
    expect(ledgerAsOf(live.export, '2100-01-01T00:00:00.000Z')).toEqual(live.export);
  });

  it('never adds a row, and only ever turns a decided field back to open', () => {
    for (const c of f.cases.filter((x) => x.as_of)) {
      const v = view(c);
      expect(v.forecasts.length).toBeLessThanOrEqual(c.export.forecasts.length);
      expect(v.resolutions.length).toBeLessThanOrEqual(c.export.resolutions.length);
      for (const r of v.resolutions) {
        const orig = c.export.resolutions.find((o) => o.entry_id === r.entry_id && o.field === r.field)!;
        if (r.status !== orig.status) expect(r.status).toBe('open');
      }
    }
  });

  it('a reopened field looks like a live open row: no outcome, freeze, evidence or confirmer', () => {
    const decided = live.export.resolutions.find((r) => r.status !== 'open');
    if (!decided) return;
    const before = ledgerAsOf(live.export, String(decided.confirmed_at));
    const r = before.resolutions.find((x) => x.entry_id === decided.entry_id && x.field === decided.field) as unknown as Record<string, unknown>;
    expect(r.status).toBe('open');
    for (const k of ['outcome', 'freeze_at', 'outcome_date', 'resolved_at', 'evidence_url', 'evidence', 'proposal_id', 'confirmed_by', 'confirmed_at']) expect(r[k]).toBeNull();
    const liveOpen = live.export.resolutions.find((x) => x.status === 'open') as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(Object.keys(liveOpen).sort());
  });

  it('drops an entry that did not exist yet, resolutions and corrections included', () => {
    const v = ledgerAsOf(live.export, '2000-01-01T00:00:00.000Z');
    expect(v.forecasts).toEqual([]);
    expect(v.resolutions).toEqual([]);
    expect(v.corrections).toEqual([]);
  });
});

describe('endOfEtDay', () => {
  it('is the next New York midnight, DST-correct', () => {
    expect(endOfEtDay('2026-10-13')).toBe('2026-10-14T04:00:00.000Z'); // EDT
    expect(endOfEtDay('2026-11-03')).toBe('2026-11-04T05:00:00.000Z'); // EST
    expect(endOfEtDay('2026-11-01')).toBe('2026-11-02T05:00:00.000Z'); // fall-back day
    expect(endOfEtDay('2027-03-13')).toBe('2027-03-14T05:00:00.000Z'); // eve of spring-forward
    expect(endOfEtDay('2027-03-14')).toBe('2027-03-15T04:00:00.000Z'); // spring-forward day
    expect(endOfEtDay('2026-12-31')).toBe('2027-01-01T05:00:00.000Z');
  });

  it('refuses anything but a real calendar date', () => {
    for (const bad of ['2026-02-30', '2026-1-1', '', 'today']) {
      expect(isAsOfDate(bad)).toBe(false);
      expect(() => endOfEtDay(bad)).toThrow();
    }
  });
});
