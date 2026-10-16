/**
 * Scoreboard assembly over a `web_export_ledger` payload (spec "Scoring
 * integrity → Computation", "Publication", "Public site → raw export"). The
 * arithmetic is `scoring.ts` (the byte-identical twin); this module adds the
 * CSV and the card text and nothing that changes a number.
 */
import { type ScoringForecastRow, type ScoringResolutionRow, scoreboardLine, summarizeLedger, type ScoreboardSummary } from './scoring.js';
import { buildResolutionCardText, buildScoreboardCardText, type CardResolutionRow } from './card-text.js';

export interface LedgerExportPayload {
  forecasts: Array<ScoringForecastRow & { status?: string }>;
  resolutions: Array<CardResolutionRow & { outcome_date?: string | Date | null; evidence_url?: string | null }>;
  corrections?: unknown[];
  exported_at?: string;
}

export interface ScoreboardReport {
  as_of: string;
  summary: ScoreboardSummary;
  scoreboard_line: string | null;
  resolution_card_text: string;
  scoreboard_card_text: string;
}

const published = (p: LedgerExportPayload) => p.forecasts.filter((f) => f.status === undefined || f.status === 'published');

export function buildScoreboardReport(payload: LedgerExportPayload, asOf: string, resolutionsSince: string): ScoreboardReport {
  const forecasts = published(payload);
  const summary = summarizeLedger(forecasts, payload.resolutions as ScoringResolutionRow[]);
  return {
    as_of: asOf,
    summary,
    scoreboard_line: scoreboardLine(summary),
    resolution_card_text: buildResolutionCardText(forecasts, payload.resolutions, resolutionsSince),
    scoreboard_card_text: buildScoreboardCardText(summary, asOf),
  };
}

/**
 * The raw export lives in the import-free twin `export-csv.ts` (frontend
 * `lib/ledger-export-csv.ts`), re-exported here so existing callers are unchanged.
 */
export { ledgerCsv } from './export-csv.js';
