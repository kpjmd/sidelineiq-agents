/**
 * Scoreboard arithmetic (spec "Scoring integrity"). The fixture's expectations
 * are hand-computed, so they state the rule; the implementation has to meet
 * them, not the other way round. The same fixture pins the frontend twin.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeLedger,
  scoreboardLine,
  bucketIndex,
  round,
  LEDGER_SCORING_VERSION,
  SCOREBOARD_LINE_MIN_N,
  type ScoringForecastRow,
  type ScoringResolutionRow,
  type CalibrationBucket,
} from '../src/ledger/scoring.js';
import fixture from './fixtures/ledger-scoring-cases.json' with { type: 'json' };

interface Case {
  name: string;
  source: string;
  forecasts: ScoringForecastRow[];
  resolutions: ScoringResolutionRow[];
  expect: {
    initial: unknown;
    latest: unknown;
    revision_delta: unknown;
    voids: unknown[];
    exclusions: unknown[];
    open_fields: number;
    entries_scored: number;
    latest_versions: Record<string, number>;
    calibration_initial_F2: CalibrationBucket[];
  };
}

const CASES = (fixture as unknown as { cases: Case[] }).cases;

describe('ledger scoring fixture', () => {
  it('was written against this scoring version', () => {
    expect((fixture as unknown as { scoring_version: number }).scoring_version).toBe(LEDGER_SCORING_VERSION);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const s = summarizeLedger(c.forecasts, c.resolutions);
      expect({ kind: 'initial', ...(c.expect.initial as object) }).toEqual(s.initial);
      expect({ kind: 'latest', ...(c.expect.latest as object) }).toEqual(s.latest);
      expect(s.revision_delta).toEqual(c.expect.revision_delta);
      expect(s.voids).toEqual(c.expect.voids);
      expect(s.exclusions).toEqual(c.expect.exclusions);
      expect(s.open_fields).toBe(c.expect.open_fields);
      expect(s.entries_scored).toBe(c.expect.entries_scored);
      for (const [key, version] of Object.entries(c.expect.latest_versions)) {
        const [entry_id, field] = key.split('/');
        const obs = s.observations.find((o) => o.entry_id === entry_id && o.field === field);
        expect(obs?.latest_version, key).toBe(version);
      }
      expect(s.calibration.initial.F2.filter((b) => b.n > 0)).toEqual(c.expect.calibration_initial_F2);
    });
  }
});

describe('scoring invariants', () => {
  it('both boards score the same n for every field (revisions never add to n)', () => {
    for (const c of CASES) {
      const s = summarizeLedger(c.forecasts, c.resolutions);
      for (const f of ['F1', 'F2', 'F3', 'F5'] as const) expect(s.latest.brier[f].n).toBe(s.initial.brier[f].n);
      expect(s.latest.f4.n).toBe(s.initial.f4.n);
    }
  });

  it('every resolution row is accounted for exactly once: open, void, excluded or scored', () => {
    for (const c of CASES) {
      const s = summarizeLedger(c.forecasts, c.resolutions);
      expect(s.open_fields + s.voids.length + s.exclusions.length + s.observations.length).toBe(c.resolutions.length);
    }
  });

  it('does not depend on input order', () => {
    for (const c of CASES) {
      const a = summarizeLedger(c.forecasts, c.resolutions);
      const b = summarizeLedger([...c.forecasts].reverse(), [...c.resolutions].reverse());
      expect(b.initial).toEqual(a.initial);
      expect(b.latest).toEqual(a.latest);
      expect(b.exclusions).toEqual(a.exclusions);
    }
  });

  it('calibration buckets are 0–10 … 90–100 with the top bucket closed', () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(0.099)).toBe(0);
    expect(bucketIndex(0.1)).toBe(1);
    expect(bucketIndex(0.95)).toBe(9);
    expect(bucketIndex(1)).toBe(9);
    const s = summarizeLedger(CASES[0].forecasts, CASES[0].resolutions);
    expect(s.calibration.initial.F1).toHaveLength(10);
    expect(s.calibration.initial.F1.reduce((n, b) => n + b.n, 0)).toBe(s.initial.brier.F1.n);
  });

  it('rounds half up at three decimals', () => {
    expect(round(0.1395, 3)).toBe(0.14);
    expect(round(0.0005, 3)).toBe(0.001);
    expect(round(0.835 / 6, 3)).toBe(0.139);
  });
});

describe('scoreboard line', () => {
  it('is withheld below n = 20 entries scored and formatted from the initial board above it', () => {
    const small = summarizeLedger(CASES[2].forecasts, CASES[2].resolutions);
    expect(small.entries_scored).toBeLessThan(SCOREBOARD_LINE_MIN_N);
    expect(scoreboardLine(small)).toBeNull();

    const forecasts: ScoringForecastRow[] = [];
    const resolutions: ScoringResolutionRow[] = [];
    for (let i = 1; i <= 25; i++) {
      const id = `PT-2026-${String(i).padStart(3, '0')}`;
      forecasts.push({ entry_id: id, version: 1, published_at: '2026-09-20T22:00:00.000Z', f1_ir: 0.1, f2_next: 0.3, f3_4wk: 0.5, f4_point: 2, f4_low: 1, f4_high: 3, f5_reinjury: 0.1 });
      resolutions.push({ entry_id: id, field: 'F2', status: 'resolved', outcome: i % 3 === 0 ? 1 : 0, freeze_at: '2026-09-27T17:00:00.000Z' });
      resolutions.push({ entry_id: id, field: 'F4', status: 'resolved', outcome: i % 4 === 0 ? 5 : 2, freeze_at: '2026-10-04T17:00:00.000Z' });
    }
    const s = summarizeLedger(forecasts, resolutions);
    expect(s.entries_scored).toBe(25);
    // 8 of 25 outcomes are 1: Brier = (8·0.49 + 17·0.09)/25 = (3.92 + 1.53)/25 = 0.218. Coverage: 6 of 25 miss → 0.76.
    expect(s.initial.brier.F2.brier).toBe(0.218);
    expect(s.initial.f4.coverage).toBe(0.76);
    expect(scoreboardLine(s)).toBe('Ledger: n=25 · F2 Brier 0.22 · 80% intervals hit 76%');
  });
});
