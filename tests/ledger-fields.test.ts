import { describe, it, expect } from 'vitest';
import {
  LEDGER_FIELDS,
  LEDGER_FIELD_SPECS,
  FORECAST_PROBABILITY_COLUMNS,
  FORECAST_F4_COLUMNS,
  isLedgerField,
  probabilityColumnOf,
} from '../src/ledger/fields.js';

describe('ledger fields', () => {
  it('are the five spec fields in card order', () => {
    expect(LEDGER_FIELDS).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    expect(LEDGER_FIELDS.map((f) => LEDGER_FIELD_SPECS[f].label)).toEqual([
      'IR',
      'Next game',
      '4 weeks',
      'Games missed',
      'Re-injury',
    ]);
  });

  it('scores F4 on MAE + coverage and every other field on Brier', () => {
    for (const f of LEDGER_FIELDS) {
      expect(LEDGER_FIELD_SPECS[f].score).toBe(f === 'F4' ? 'mae_coverage' : 'brier');
    }
  });

  it('names the resolution source the spec table names', () => {
    expect(LEDGER_FIELD_SPECS.F1.resolution_source).toBe('transaction_wire');
    expect(LEDGER_FIELD_SPECS.F2.resolution_source).toBe('gamebook');
    expect(LEDGER_FIELD_SPECS.F3.resolution_source).toBe('gamebook');
    expect(LEDGER_FIELD_SPECS.F4.resolution_source).toBe('gamebook');
    expect(LEDGER_FIELD_SPECS.F5.resolution_source).toBe('injury_report_and_gamebook');
  });

  it('maps each Brier field to its probability column and F4 to none', () => {
    expect(probabilityColumnOf('F1')).toBe('f1_ir');
    expect(probabilityColumnOf('F2')).toBe('f2_next');
    expect(probabilityColumnOf('F3')).toBe('f3_4wk');
    expect(probabilityColumnOf('F4')).toBeNull();
    expect(probabilityColumnOf('F5')).toBe('f5_reinjury');
    expect(FORECAST_PROBABILITY_COLUMNS).toHaveLength(4);
    expect(FORECAST_F4_COLUMNS).toEqual(['f4_point', 'f4_low', 'f4_high']);
  });

  it('isLedgerField rejects anything outside the five', () => {
    expect(isLedgerField('F3')).toBe(true);
    expect(isLedgerField('F6')).toBe(false);
    expect(isLedgerField('f1')).toBe(false);
    expect(isLedgerField(1)).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LEDGER_FIELD_SPECS)).toBe(true);
  });
});
