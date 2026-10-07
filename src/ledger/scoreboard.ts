/**
 * Scoreboard assembly over a `web_export_ledger` payload (spec "Scoring
 * integrity → Computation", "Publication", "Public site → raw export"). The
 * arithmetic is `scoring.ts` (the byte-identical twin); this module adds the
 * CSV and the card text and nothing that changes a number.
 */
import { type ScoringForecastRow, type ScoringResolutionRow, scoreboardLine, summarizeLedger, type ScoreboardSummary } from './scoring.js';
import { buildResolutionCardText, buildScoreboardCardText, type CardResolutionRow } from './card-text.js';
import { probabilityColumnOf, type LedgerField } from './fields.js';

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

const CSV_COLUMNS = [
  'entry_id', 'field', 'status', 'outcome', 'outcome_date', 'freeze_at', 'void_reason', 'evidence_url',
  'v1_published_at', 'v1_forecast', 'v1_f4_low', 'v1_f4_high',
  'latest_version', 'latest_published_at', 'latest_forecast', 'latest_f4_low', 'latest_f4_high',
] as const;

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isNaN(ms) ? String(v) : new Date(ms).toISOString();
};

/**
 * One row per (entry, field) resolution, with the v1 forecast and the last
 * version published strictly before the freeze point — exactly the two values
 * the boards score, so the published numbers recompute from this file alone.
 */
export function ledgerCsv(payload: LedgerExportPayload): string {
  const forecasts = published(payload);
  const byEntry = new Map<string, ScoringForecastRow[]>();
  for (const f of forecasts) byEntry.set(f.entry_id, [...(byEntry.get(f.entry_id) ?? []), f]);
  const rows: string[] = [CSV_COLUMNS.join(',')];
  const sorted = [...payload.resolutions].sort((a, b) => a.entry_id.localeCompare(b.entry_id) || a.field.localeCompare(b.field));
  for (const r of sorted) {
    const versions = (byEntry.get(r.entry_id) ?? []).slice().sort((a, b) => Number(a.version) - Number(b.version));
    const v1 = versions.find((v) => Number(v.version) === 1) ?? null;
    const freeze = iso(r.freeze_at);
    const latest = freeze ? [...versions].filter((v) => (iso(v.published_at) ?? '') < freeze).pop() ?? v1 : v1;
    const col = probabilityColumnOf(r.field as LedgerField);
    const value = (v: ScoringForecastRow | null) => (v ? (col ? v[col] : v.f4_point) : null);
    rows.push(
      [
        r.entry_id, r.field, r.status, r.outcome, iso(r.outcome_date)?.slice(0, 10) ?? '', freeze, r.void_reason, r.evidence_url,
        v1 ? iso(v1.published_at) : null, value(v1), col ? null : v1?.f4_low, col ? null : v1?.f4_high,
        latest?.version, latest ? iso(latest.published_at) : null, value(latest), col ? null : latest?.f4_low, col ? null : latest?.f4_high,
      ].map(cell).join(','),
    );
  }
  return rows.join('\n') + '\n';
}
