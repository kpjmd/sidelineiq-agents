/**
 * The five scored fields of a Prognosis Ledger entry, in the ONE order every
 * card, post and page prints them (spec: "Prediction taxonomy", "Card content
 * spec" item 3: "Forecast block, always this order").
 *
 * This module is the vocabulary the rest of `src/ledger/` shares. It has no
 * I/O and no imports so the frontend can carry a byte-identical copy.
 */

export const LEDGER_FIELDS = ['F1', 'F2', 'F3', 'F4', 'F5'] as const;
export type LedgerField = (typeof LEDGER_FIELDS)[number];

/** How a field is scored (spec "Prediction taxonomy", Score column). */
export type LedgerScoreKind = 'brier' | 'mae_coverage';

/** Which public record resolves the field (spec, Resolution source column). */
export type LedgerResolutionSource = 'transaction_wire' | 'gamebook' | 'injury_report_and_gamebook';

export interface LedgerFieldSpec {
  field: LedgerField;
  /** Short label used on cards: "IR", "Next game", "4 weeks", "Games missed", "Re-injury". */
  label: string;
  /** The question the forecast answers, as the spec words it. */
  question: string;
  resolution_source: LedgerResolutionSource;
  score: LedgerScoreKind;
}

export const LEDGER_FIELD_SPECS: Readonly<Record<LedgerField, LedgerFieldSpec>> = Object.freeze({
  F1: {
    field: 'F1',
    label: 'IR',
    question: 'P(placed on IR within 7 days of injury)',
    resolution_source: 'transaction_wire',
    score: 'brier',
  },
  F2: {
    field: 'F2',
    label: 'Next game',
    question: "P(plays ≥ 1 snap in team's next scheduled game)",
    resolution_source: 'gamebook',
    score: 'brier',
  },
  F3: {
    field: 'F3',
    label: '4 weeks',
    question: 'P(plays ≥ 1 snap in any game within 28 days)',
    resolution_source: 'gamebook',
    score: 'brier',
  },
  F4: {
    field: 'F4',
    label: 'Games missed',
    question:
      'Point estimate + 80% interval, regular-season games from injury through the game before first return',
    resolution_source: 'gamebook',
    score: 'mae_coverage',
  },
  F5: {
    field: 'F5',
    label: 'Re-injury',
    question: 'P(same-site injury on injury report AND ≥ 1 game missed within 6 games of return)',
    resolution_source: 'injury_report_and_gamebook',
    score: 'brier',
  },
});

/** The forecast columns, in field order. F4 is three columns. */
export const FORECAST_PROBABILITY_COLUMNS = ['f1_ir', 'f2_next', 'f3_4wk', 'f5_reinjury'] as const;
export const FORECAST_F4_COLUMNS = ['f4_point', 'f4_low', 'f4_high'] as const;

export function isLedgerField(value: unknown): value is LedgerField {
  return typeof value === 'string' && (LEDGER_FIELDS as readonly string[]).includes(value);
}

/** The probability column a Brier-scored field reads; null for F4. */
export function probabilityColumnOf(
  field: LedgerField,
): (typeof FORECAST_PROBABILITY_COLUMNS)[number] | null {
  switch (field) {
    case 'F1':
      return 'f1_ir';
    case 'F2':
      return 'f2_next';
    case 'F3':
      return 'f3_4wk';
    case 'F5':
      return 'f5_reinjury';
    case 'F4':
      return null;
  }
}
