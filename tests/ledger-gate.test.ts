import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activeSpanMinutes,
  buildGateReport,
  compareImpressions,
  gateWeekBounds,
  gateWeekOf,
  gateWeekStart,
  thirdPartyReplies,
  tuesdayPass,
  type CardReading,
} from '../src/ledger/gate.js';
import { assembleGate, type GateRawResponses } from '../src/ledger/gate-assemble.js';

// Recorded from prod by `ledger-gate-report.ts --record-fixtures` (user ids redacted).
const RECORDED = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/ledger-gate/2026-11-06/responses.json'), 'utf8'),
) as GateRawResponses & { recorded_at: string };
const AS_OF = RECORDED.recorded_at;

describe('gate weeks', () => {
  it('week 1 is Sun 2026-10-04 and week 8 ends before the Tue 12-01 review', () => {
    expect(gateWeekStart(1)).toBe('2026-10-04');
    expect(gateWeekStart(8)).toBe('2026-11-22');
    expect(gateWeekBounds(8).end).toBe('2026-11-29T05:00:00.000Z');
  });

  it('buckets on the New York calendar across the Nov 1 DST change', () => {
    // PT-2026-020 published 2026-11-01T03:38Z = Sat Oct 31 23:38 EDT → week 4.
    expect(gateWeekOf('2026-11-01T03:38:22.206Z')).toBe(4);
    expect(gateWeekOf('2026-11-01T03:59:59Z')).toBe(4);
    expect(gateWeekOf('2026-11-01T04:00:00Z')).toBe(5);
    expect(gateWeekBounds(5)).toEqual({ start: '2026-11-01T04:00:00.000Z', end: '2026-11-08T05:00:00.000Z' });
    // PT-2026-001 published Tue Oct 6 20:15 EDT.
    expect(gateWeekOf('2026-10-07T00:15:20.352Z')).toBe(1);
    expect(gateWeekOf('2026-10-04T03:59:59Z')).toBe(0);
  });
});

describe('activeSpanMinutes', () => {
  it('sums only gaps at or under the cap', () => {
    expect(activeSpanMinutes(['2026-10-01T10:00:00Z', '2026-10-01T10:20:00Z', '2026-10-01T10:41:00Z'])).toBe(20);
    expect(activeSpanMinutes(['2026-10-01T10:41:00Z', '2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z'])).toBe(5);
    expect(activeSpanMinutes(['2026-10-01T10:00:00Z'])).toBe(0);
  });
});

describe('compareImpressions', () => {
  const card = (posted_at: string, impressions: number, frozen = true): CardReading =>
    ({ entry_id: 'X', x_post_id: posted_at, posted_at, impressions, reply_count: 0, age_days: 7, frozen });

  it('rising only when the weeks 5–8 median is strictly above weeks 1–4', () => {
    expect(compareImpressions([card('2026-10-10T12:00:00Z', 100), card('2026-11-10T12:00:00Z', 100)]).verdict).toBe('not_rising');
    expect(compareImpressions([card('2026-10-10T12:00:00Z', 100), card('2026-11-10T12:00:00Z', 101)]).verdict).toBe('rising');
  });

  it('never lets a live (<7d) reading into a median', () => {
    const c = compareImpressions([card('2026-10-10T12:00:00Z', 100), card('2026-11-10T12:00:00Z', 9999, false)]);
    expect(c.verdict).toBe('not_measurable');
    expect(c.late_n).toBe(0);
  });
});

describe('against the 2026-11-06 recording', () => {
  const assembled = assembleGate(RECORDED, AS_OF);
  const report = buildGateReport(assembled.input);

  it('prints weeks 1..5 with the ledger counts', () => {
    expect(report.current_week).toBe(5);
    expect(report.weeks.map((w) => w.week)).toEqual([1, 2, 3, 4, 5]);
    expect(report.gate.entries).toEqual({ value: 23 });
    expect(report.gate.resolved).toEqual({ value: 52 });
    expect(report.weeks[4].void).toBe(1);
  });

  it('week 1 is nothing due, weeks 2–5 are done', () => {
    expect(report.weeks.map((w) => w.tuesday.status)).toEqual(['nothing_due', 'done', 'done', 'done', 'done']);
    expect(report.gate.tuesday_passes).toEqual({ value: { done: 4, counted: 4, nothing_due: 1 } });
  });

  it('counts the Oct 27 00:41 ET decisions inside week 4\'s window', () => {
    const tp = tuesdayPass(4, assembled.input.proposals, assembled.input.resolutions, AS_OF);
    expect(tp.status).toBe('done');
    expect(tp.due).toBe(8);
    expect(tp.decisions_in_window).toBe(8);
  });

  it('a pass whose window has not closed is not_yet, not a miss', () => {
    expect(tuesdayPass(5, assembled.input.proposals, assembled.input.resolutions, '2026-11-04T08:00:00Z').status).toBe('not_yet');
  });

  it('reads every Tier 1 card from X and none is frozen yet', () => {
    expect(assembled.card_rows).toHaveLength(18);
    expect(assembled.unmeasured_cards).toEqual([]);
    expect(assembled.card_rows.every((c) => !c.frozen)).toBe(true);
    expect(report.gate.impressions).toEqual({ not_measurable: 'no frozen readings for weeks 1–4' });
  });

  it('subtracts our own self-reply from every card\'s reply_count', () => {
    const own = assembled.input.baseline.own;
    for (const c of assembled.card_rows) {
      const post = own.find((p) => p.id === c.x_post_id);
      expect(post, c.entry_id).toBeDefined();
      expect(post!.reply_count).toBe(1);
      expect(thirdPartyReplies(post!, own)).toBe(0);
    }
  });

  it('reply rate is not measurable with an empty list, and says what the baseline is', () => {
    const cell = report.gate.reply_rate;
    expect('not_measurable' in cell && cell.not_measurable).toMatch(/^no open-question posts listed.*baseline so far/);
  });

  it('loop time stops at the X post and drops long gaps', () => {
    const pt14 = assembled.loop_rows.find((l) => l.entry_id === 'PT-2026-014')!;
    // Draft opened 10-19 22:44Z, card posted the next day: wall ~22.6h, active ~6 min.
    expect(pt14.wall_min).toBeGreaterThan(1300);
    expect(pt14.active_min).toBeLessThan(10);
    expect(assembled.loop_rows).toHaveLength(18);
    expect(report.gate.loop_time).toMatchObject({ value: { n: 18 } });
  });

  it('an as-of view hides what happened later', () => {
    const early = buildGateReport(assembleGate(RECORDED, '2026-10-21T12:00:00.000Z').input);
    expect(early.current_week).toBe(3);
    expect(early.gate.entries).toEqual({ value: 14 }); // PT-015 published 10-24
    expect(early.weeks[2].tuesday.status).toBe('done');
  });
});
