/**
 * The ledger's raw export (spec "Public site → raw export", "Publication") and
 * the `as_of` view that keeps every monthly scoreboard recomputable after later
 * resolutions land (decision S4-1).
 *
 * BYTE-IDENTICAL TWIN: agents `src/ledger/export-csv.ts` and frontend
 * `lib/ledger-export-csv.ts`, pinned in both repos by
 * `tests/fixtures/ledger-csv-cases.json` (recorded live by
 * `src/scripts/ledger-csv-fixture.ts`, never hand-written). Change one, bump
 * LEDGER_CSV_VERSION, re-record, copy across. No imports, so the two files can
 * stay identical.
 *
 * `ledgerAsOf` is exact rather than approximate because nothing it reads moves:
 * a published forecast row is immutable, a resolved or void resolution is
 * locked, and both carry the instant they became public (`published_at`,
 * `confirmed_at`). A resolution confirmed after the cutoff reads as it did
 * then — open.
 */

export const LEDGER_CSV_VERSION = 1;

export interface CsvForecastRow {
  entry_id: string;
  version: number | string;
  published_at: string | Date;
  status?: string;
  f1_ir: number | string | null;
  f2_next: number | string | null;
  f3_4wk: number | string | null;
  f5_reinjury: number | string | null;
  f4_point: number | string;
  f4_low: number | string;
  f4_high: number | string;
}

export interface CsvResolutionRow {
  entry_id: string;
  field: string;
  status: 'open' | 'resolved' | 'void';
  outcome: number | string | null;
  freeze_at: string | Date | null;
  outcome_date?: string | Date | null;
  void_reason?: string | null;
  evidence_url?: string | null;
  confirmed_at?: string | Date | null;
}

export interface LedgerCsvPayload {
  forecasts: CsvForecastRow[];
  resolutions: CsvResolutionRow[];
  corrections?: unknown[];
  exported_at?: string;
}

const PROBABILITY_COLUMN: Record<string, 'f1_ir' | 'f2_next' | 'f3_4wk' | 'f5_reinjury' | undefined> = {
  F1: 'f1_ir',
  F2: 'f2_next',
  F3: 'f3_4wk',
  F5: 'f5_reinjury',
};

const published = <F extends CsvForecastRow>(forecasts: F[]): F[] => forecasts.filter((f) => f.status === undefined || f.status === 'published');

export const LEDGER_CSV_COLUMNS = [
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
const ms = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return Number.NaN;
  return v instanceof Date ? v.getTime() : Date.parse(String(v));
};

/**
 * One row per (entry, field) resolution, with the v1 forecast and the last
 * version published strictly before the freeze point — exactly the two values
 * the boards score, so the published numbers recompute from this file alone.
 */
export function ledgerCsv(payload: LedgerCsvPayload): string {
  const forecasts = published(payload.forecasts);
  const byEntry = new Map<string, CsvForecastRow[]>();
  for (const f of forecasts) byEntry.set(f.entry_id, [...(byEntry.get(f.entry_id) ?? []), f]);
  const rows: string[] = [LEDGER_CSV_COLUMNS.join(',')];
  const sorted = [...payload.resolutions].sort((a, b) => a.entry_id.localeCompare(b.entry_id) || a.field.localeCompare(b.field));
  for (const r of sorted) {
    const versions = (byEntry.get(r.entry_id) ?? []).slice().sort((a, b) => Number(a.version) - Number(b.version));
    const v1 = versions.find((v) => Number(v.version) === 1) ?? null;
    const freeze = iso(r.freeze_at);
    const latest = freeze ? [...versions].filter((v) => (iso(v.published_at) ?? '') < freeze).pop() ?? v1 : v1;
    const col = PROBABILITY_COLUMN[r.field] ?? null;
    const value = (v: CsvForecastRow | null) => (v ? (col ? v[col] : v.f4_point) : null);
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

// ── Recompute from the CSV alone ───────────────────────────────────────

/** RFC 4180 reader for the file `ledgerCsv` writes. */
export function parseLedgerCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      records.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); records.push(row); }
  const [header, ...body] = records;
  if (!header) return [];
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/**
 * Rebuild the scoring inputs from the export alone: the v1 and the
 * latest-before-freeze version of each (entry, field), and every resolution.
 * Feeding the result to `summarizeLedger` reproduces the published boards —
 * the check anyone can run.
 */
export function ledgerFromCsv(text: string): { forecasts: CsvForecastRow[]; resolutions: CsvResolutionRow[] } {
  const rows = parseLedgerCsv(text);
  const forecasts = new Map<string, CsvForecastRow & Record<string, unknown>>();
  const resolutions: CsvResolutionRow[] = [];
  const orNull = (s: string | undefined) => (s === undefined || s === '' ? null : s);
  for (const r of rows) {
    resolutions.push({
      entry_id: r.entry_id,
      field: r.field,
      status: r.status as CsvResolutionRow['status'],
      outcome: orNull(r.outcome),
      freeze_at: orNull(r.freeze_at),
      outcome_date: orNull(r.outcome_date),
      void_reason: orNull(r.void_reason),
      evidence_url: orNull(r.evidence_url),
    });
    for (const which of ['v1', 'latest'] as const) {
      const version = which === 'v1' ? '1' : r.latest_version;
      const publishedAt = r[`${which}_published_at`];
      if (!version || !publishedAt) continue;
      const key = `${r.entry_id}|${version}`;
      const row =
        forecasts.get(key) ??
        { entry_id: r.entry_id, version: Number(version), published_at: publishedAt, f1_ir: null, f2_next: null, f3_4wk: null, f5_reinjury: null, f4_point: '', f4_low: '', f4_high: '' };
      const col = PROBABILITY_COLUMN[r.field];
      if (col) row[col] = orNull(r[`${which}_forecast`]);
      else {
        row.f4_point = r[`${which}_forecast`];
        row.f4_low = r[`${which}_f4_low`];
        row.f4_high = r[`${which}_f4_high`];
      }
      forecasts.set(key, row);
    }
  }
  return { forecasts: [...forecasts.values()], resolutions };
}

// ── as_of (decision S4-1) ──────────────────────────────────────────────

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isAsOfDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return probe.toISOString().slice(0, 10) === value;
}

/** America/New_York's offset from UTC at an instant, in ms (negative). */
function etOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant the given New York calendar day ENDS, i.e. the next day's ET
 * midnight, as an ISO string. "As of 2026-11-03" includes everything strictly
 * before it. DST changes at 02:00, never at midnight, so the offset sampled at
 * the next midnight's UTC guess is the right one.
 */
export function endOfEtDay(date: string): string {
  if (!isAsOfDate(date)) throw new Error(`as_of is not a YYYY-MM-DD date: ${JSON.stringify(date)}`);
  const m = ISO_DATE_RE.exec(date)!;
  const nextMidnightUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return new Date(nextMidnightUtc - etOffsetMs(nextMidnightUtc + 5 * 3_600_000)).toISOString();
}

/**
 * The ledger as it stood just before `cutoffIso`:
 *  - a forecast version counts only if it was published before the cutoff;
 *  - an entry with no version by then did not exist, so its resolutions go too;
 *  - a resolution confirmed at or after the cutoff (or never) reads as open,
 *    exactly as the open row looked — no outcome, no freeze point, no evidence;
 *  - a correction counts only if filed before the cutoff.
 * Never adds a row. With a cutoff after every timestamp it is the identity.
 */
export function ledgerAsOf<P extends LedgerCsvPayload>(payload: P, cutoffIso: string): P {
  const cutoff = ms(cutoffIso);
  if (Number.isNaN(cutoff)) throw new Error(`cutoff is not an instant: ${JSON.stringify(cutoffIso)}`);
  const forecasts = payload.forecasts.filter((f) => ms(f.published_at) < cutoff);
  const entries = new Set(forecasts.map((f) => f.entry_id));
  const resolutions = payload.resolutions
    .filter((r) => entries.has(r.entry_id))
    .map((r) => {
      if (r.status === 'open' || ms(r.confirmed_at) < cutoff) return r;
      const reopened: Record<string, unknown> = { ...r, status: 'open', outcome: null, freeze_at: null };
      for (const k of ['outcome_date', 'resolved_at', 'void_reason', 'evidence_url', 'evidence', 'proposal_id', 'confirmed_by', 'confirmed_at']) {
        if (k in reopened) reopened[k] = null;
      }
      return reopened as unknown as CsvResolutionRow;
    });
  const corrections = payload.corrections?.filter((c) => {
    const at = (c as { corrected_at?: unknown } | null)?.corrected_at;
    return ms(at) < cutoff;
  });
  return { ...payload, forecasts, resolutions, ...(corrections ? { corrections } : {}) } as P;
}
