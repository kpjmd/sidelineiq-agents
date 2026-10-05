/**
 * Scoreboard arithmetic (spec "Scoring integrity → Computation", "Publication").
 *
 * The rule the whole module serves: ONE injury event contributes exactly ONE
 * observation per field to any scoreboard. Revisions never add to n and are
 * never averaged with the original. Two boards are computed over the SAME n:
 *
 *  - Initial board: for each resolved, non-void (entry, field), score v1.
 *  - Latest board: score the last revision published strictly BEFORE that
 *    field's freeze point. A revision after the freeze is stored but ignored.
 *
 * Brier per field = mean (p − outcome)², outcome ∈ {0, 1}, reported to three
 * decimals with n. F4 = mean absolute error of the point estimate in games, plus
 * the fraction of outcomes inside the 80% interval. Calibration buckets are
 * 0–10% … 90–100% (upper bucket closed), published once a bucket has n ≥ 5.
 * Revision delta = Latest − Initial per field; negative means updating helped.
 *
 * Arithmetic only — no policy beyond the spec and no I/O. A byte-identical copy
 * lives at `lib/ledger-scoring.ts` in sidelineiq-frontend; both are pinned by
 * `tests/fixtures/ledger-scoring-cases.json`. Change one, bump
 * LEDGER_SCORING_VERSION, update the fixture, copy both across.
 */

export const LEDGER_SCORING_VERSION = 1;

/** Spec "Computation": publish a calibration bucket once n ≥ 5. */
export const CALIBRATION_MIN_N = 5;
/** Spec "Card content spec": the scoreboard line appears once n ≥ 20. */
export const SCOREBOARD_LINE_MIN_N = 20;

export type BrierField = 'F1' | 'F2' | 'F3' | 'F5';
export const BRIER_FIELDS: readonly BrierField[] = ['F1', 'F2', 'F3', 'F5'];
export type AnyField = BrierField | 'F4';

/** A forecast row as `web_ledger_list_entries` returns it (NUMERIC may arrive as strings). */
export interface ScoringForecastRow {
  entry_id: string;
  version: number | string;
  published_at: string | Date;
  f1_ir: number | string | null;
  f2_next: number | string | null;
  f3_4wk: number | string | null;
  f5_reinjury: number | string | null;
  f4_point: number | string;
  f4_low: number | string;
  f4_high: number | string;
}

/** A resolution row. Only `resolved` rows with a freeze_at are scoreable. */
export interface ScoringResolutionRow {
  entry_id: string;
  field: AnyField;
  status: 'open' | 'resolved' | 'void';
  outcome: number | string | null;
  freeze_at: string | Date | null;
  void_reason?: string | null;
}

export interface BrierCell {
  n: number;
  /** Mean (p − outcome)², rounded to 3 decimals. null when n = 0. */
  brier: number | null;
}

export interface F4Cell {
  n: number;
  /** Mean |point − games missed|, rounded to 2 decimals. null when n = 0. */
  mae: number | null;
  /** Fraction of outcomes inside [low, high], rounded to 3 decimals. null when n = 0. */
  coverage: number | null;
}

export interface Board {
  kind: 'initial' | 'latest';
  brier: Record<BrierField, BrierCell>;
  f4: F4Cell;
}

export interface CalibrationBucket {
  /** Inclusive lower bound, e.g. 0.1 for the 10–20% bucket. */
  lo: number;
  /** Exclusive upper bound except the last bucket (1.0 inclusive). */
  hi: number;
  n: number;
  forecast_mean: number | null;
  observed_rate: number | null;
  /** n ≥ CALIBRATION_MIN_N. */
  published: boolean;
}

export interface RevisionDelta {
  /** Latest − Initial Brier per field; null when either side has n = 0. */
  brier: Record<BrierField, number | null>;
  /** Latest − Initial F4 MAE. */
  f4_mae: number | null;
}

export interface VoidListing {
  entry_id: string;
  field: AnyField;
  void_reason: string;
}

export type ExclusionReason =
  | 'no_v1'
  | 'no_freeze_at'
  | 'v1_after_freeze'
  | 'no_forecast_value'
  | 'outcome_not_binary'
  | 'outcome_not_integer';

export interface Exclusion {
  entry_id: string;
  field: AnyField;
  reason: ExclusionReason;
}

/** One scored (entry, field): what each board read and the outcome. Exposed so a page can list them. */
export interface ScoredObservation {
  entry_id: string;
  field: AnyField;
  outcome: number;
  freeze_at: string;
  initial_version: number;
  latest_version: number;
  /** For Brier fields: the probability each board scored. */
  initial_p?: number;
  latest_p?: number;
  /** For F4: the interval each board scored. */
  initial_f4?: { point: number; low: number; high: number };
  latest_f4?: { point: number; low: number; high: number };
}

export interface ScoreboardSummary {
  scoring_version: number;
  initial: Board;
  latest: Board;
  /** Calibration tables on each board, per Brier field. */
  calibration: { initial: Record<BrierField, CalibrationBucket[]>; latest: Record<BrierField, CalibrationBucket[]> };
  revision_delta: RevisionDelta;
  voids: VoidListing[];
  exclusions: Exclusion[];
  observations: ScoredObservation[];
  /** Resolution rows still open. */
  open_fields: number;
  /** Distinct entries with at least one scored field — the n on the card line. */
  entries_scored: number;
}

// ── Normalisation ──────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function instantMs(v: string | Date | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function probabilityOf(row: ScoringForecastRow, field: BrierField): number | null {
  switch (field) {
    case 'F1':
      return num(row.f1_ir);
    case 'F2':
      return num(row.f2_next);
    case 'F3':
      return num(row.f3_4wk);
    case 'F5':
      return num(row.f5_reinjury);
  }
}

// ── Version selection ──────────────────────────────────────────────────

interface Versioned {
  version: number;
  published_ms: number;
  row: ScoringForecastRow;
}

function versionsOf(rows: ScoringForecastRow[]): Versioned[] {
  return rows
    .map((row) => ({ version: num(row.version) ?? NaN, published_ms: instantMs(row.published_at) ?? NaN, row }))
    .filter((v) => Number.isInteger(v.version) && !Number.isNaN(v.published_ms))
    .sort((a, b) => a.version - b.version);
}

/** The last version published strictly before the freeze point. */
export function latestBeforeFreeze(versions: Versioned[], freezeMs: number): Versioned | null {
  let pick: Versioned | null = null;
  for (const v of versions) if (v.published_ms < freezeMs) pick = v;
  return pick;
}

// ── Calibration ────────────────────────────────────────────────────────

export function bucketIndex(p: number): number {
  return Math.min(Math.floor(p * 10), 9);
}

function calibrationTable(pairs: { p: number; outcome: number }[]): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const inBucket = pairs.filter((x) => bucketIndex(x.p) === i);
    const n = inBucket.length;
    buckets.push({
      lo: i / 10,
      hi: (i + 1) / 10,
      n,
      forecast_mean: n ? round(inBucket.reduce((s, x) => s + x.p, 0) / n, 3) : null,
      observed_rate: n ? round(inBucket.reduce((s, x) => s + x.outcome, 0) / n, 3) : null,
      published: n >= CALIBRATION_MIN_N,
    });
  }
  return buckets;
}

// ── The summary ────────────────────────────────────────────────────────

export function summarizeLedger(forecasts: ScoringForecastRow[], resolutions: ScoringResolutionRow[]): ScoreboardSummary {
  const byEntry = new Map<string, Versioned[]>();
  for (const row of forecasts) {
    const list = byEntry.get(row.entry_id) ?? [];
    list.push(...versionsOf([row]));
    byEntry.set(row.entry_id, list);
  }
  for (const list of byEntry.values()) list.sort((a, b) => a.version - b.version);

  const voids: VoidListing[] = [];
  const exclusions: Exclusion[] = [];
  const observations: ScoredObservation[] = [];
  let open = 0;

  const brierPairs: Record<'initial' | 'latest', Record<BrierField, { p: number; outcome: number }[]>> = {
    initial: { F1: [], F2: [], F3: [], F5: [] },
    latest: { F1: [], F2: [], F3: [], F5: [] },
  };
  const f4Pairs: Record<'initial' | 'latest', { point: number; low: number; high: number; outcome: number }[]> = {
    initial: [],
    latest: [],
  };

  const sorted = [...resolutions].sort((a, b) => a.entry_id.localeCompare(b.entry_id) || a.field.localeCompare(b.field));
  for (const res of sorted) {
    if (res.status === 'open') {
      open++;
      continue;
    }
    if (res.status === 'void') {
      voids.push({ entry_id: res.entry_id, field: res.field, void_reason: res.void_reason ?? 'unspecified' });
      continue;
    }
    const versions = byEntry.get(res.entry_id) ?? [];
    const v1 = versions.find((v) => v.version === 1);
    if (!v1) {
      exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'no_v1' });
      continue;
    }
    const freezeMs = instantMs(res.freeze_at);
    if (freezeMs === null) {
      exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'no_freeze_at' });
      continue;
    }
    if (v1.published_ms >= freezeMs) {
      exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'v1_after_freeze' });
      continue;
    }
    const latest = latestBeforeFreeze(versions, freezeMs) ?? v1;
    const outcome = num(res.outcome);

    if (res.field === 'F4') {
      if (outcome === null || !Number.isInteger(outcome) || outcome < 0) {
        exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'outcome_not_integer' });
        continue;
      }
      const iv = (v: Versioned) => ({ point: num(v.row.f4_point), low: num(v.row.f4_low), high: num(v.row.f4_high) });
      const a = iv(v1);
      const b = iv(latest);
      if (a.point === null || a.low === null || a.high === null || b.point === null || b.low === null || b.high === null) {
        exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'no_forecast_value' });
        continue;
      }
      const ai = { point: a.point, low: a.low, high: a.high };
      const bi = { point: b.point, low: b.low, high: b.high };
      f4Pairs.initial.push({ ...ai, outcome });
      f4Pairs.latest.push({ ...bi, outcome });
      observations.push({
        entry_id: res.entry_id,
        field: 'F4',
        outcome,
        freeze_at: isoOf(freezeMs),
        initial_version: v1.version,
        latest_version: latest.version,
        initial_f4: ai,
        latest_f4: bi,
      });
      continue;
    }

    if (outcome !== 0 && outcome !== 1) {
      exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'outcome_not_binary' });
      continue;
    }
    const p1 = probabilityOf(v1.row, res.field);
    const pL = probabilityOf(latest.row, res.field);
    if (p1 === null || pL === null) {
      exclusions.push({ entry_id: res.entry_id, field: res.field, reason: 'no_forecast_value' });
      continue;
    }
    brierPairs.initial[res.field].push({ p: p1, outcome });
    brierPairs.latest[res.field].push({ p: pL, outcome });
    observations.push({
      entry_id: res.entry_id,
      field: res.field,
      outcome,
      freeze_at: isoOf(freezeMs),
      initial_version: v1.version,
      latest_version: latest.version,
      initial_p: p1,
      latest_p: pL,
    });
  }

  const board = (kind: 'initial' | 'latest'): Board => {
    const brier = {} as Record<BrierField, BrierCell>;
    for (const f of BRIER_FIELDS) {
      const pairs = brierPairs[kind][f];
      brier[f] = {
        n: pairs.length,
        brier: pairs.length ? round(pairs.reduce((s, x) => s + (x.p - x.outcome) ** 2, 0) / pairs.length, 3) : null,
      };
    }
    const f4 = f4Pairs[kind];
    return {
      kind,
      brier,
      f4: {
        n: f4.length,
        mae: f4.length ? round(f4.reduce((s, x) => s + Math.abs(x.point - x.outcome), 0) / f4.length, 2) : null,
        coverage: f4.length ? round(f4.filter((x) => x.low <= x.outcome && x.outcome <= x.high).length / f4.length, 3) : null,
      },
    };
  };

  const initial = board('initial');
  const latest = board('latest');

  const delta = {} as Record<BrierField, number | null>;
  for (const f of BRIER_FIELDS) {
    const a = initial.brier[f].brier;
    const b = latest.brier[f].brier;
    delta[f] = a === null || b === null ? null : round(b - a, 3);
  }

  const calib = (kind: 'initial' | 'latest') => {
    const out = {} as Record<BrierField, CalibrationBucket[]>;
    for (const f of BRIER_FIELDS) out[f] = calibrationTable(brierPairs[kind][f]);
    return out;
  };

  return {
    scoring_version: LEDGER_SCORING_VERSION,
    initial,
    latest,
    calibration: { initial: calib('initial'), latest: calib('latest') },
    revision_delta: {
      brier: delta,
      f4_mae: initial.f4.mae === null || latest.f4.mae === null ? null : round(latest.f4.mae - initial.f4.mae, 2),
    },
    voids,
    exclusions,
    observations,
    open_fields: open,
    entries_scored: new Set(observations.map((o) => o.entry_id)).size,
  };
}

/**
 * The static scoreboard line for cards (spec "Card content spec"), e.g.
 * "Ledger: n=34 · F2 Brier 0.14 · 80% intervals hit 76%". null below n ≥ 20
 * entries scored, or when F2 / F4 have no observations. Reads the INITIAL
 * board — the headline board.
 */
export function scoreboardLine(summary: ScoreboardSummary): string | null {
  if (summary.entries_scored < SCOREBOARD_LINE_MIN_N) return null;
  const f2 = summary.initial.brier.F2.brier;
  const cov = summary.initial.f4.coverage;
  if (f2 === null || cov === null) return null;
  return `Ledger: n=${summary.entries_scored} · F2 Brier ${f2.toFixed(2)} · 80% intervals hit ${Math.round(cov * 100)}%`;
}
