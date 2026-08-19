import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESPNNFLSource } from '../src/monitoring/sports/espn-nfl.js';
import { resolveUpdateSignal } from '../src/monitoring/poller.js';
import type { RawInjuryEvent } from '../src/types.js';

// Recorded verbatim from ESPN's NFL injuries endpoint on 2026-08-19.
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/espn-nfl-injuries.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

/** Re-parse the fixture with the recency window disabled. */
function parseAll(): RawInjuryEvent[] {
  process.env.MAX_EVENT_AGE_DAYS = '100000';
  return (new ESPNNFLSource() as unknown as { parse: (f: unknown) => RawInjuryEvent[] }).parse(
    FIXTURE,
  );
}

/** Re-parse with one row's status overridden, everything else verbatim. */
function parseWithStatus(athlete: string, status: string | undefined): RawInjuryEvent | undefined {
  const clone = JSON.parse(JSON.stringify(FIXTURE));
  for (const group of clone.injuries) {
    for (const record of group.injuries) {
      if (record.athlete?.displayName !== athlete) continue;
      if (status === undefined) delete record.status;
      else record.status = status;
    }
  }
  process.env.MAX_EVENT_AGE_DAYS = '100000';
  const events = (
    new ESPNNFLSource() as unknown as { parse: (f: unknown) => RawInjuryEvent[] }
  ).parse(clone);
  return events.find((e) => e.athlete_name === athlete);
}

function byName(name: string): RawInjuryEvent {
  const e = parseAll().find((x) => x.athlete_name === name);
  if (!e) throw new Error(`fixture row missing: ${name}`);
  return e;
}

describe('ESPN update signal is a tri-state, not a boolean', () => {
  const prevAge = process.env.MAX_EVENT_AGE_DAYS;
  beforeEach(() => {
    process.env.MAX_EVENT_AGE_DAYS = '100000';
  });
  afterEach(() => {
    if (prevAge === undefined) delete process.env.MAX_EVENT_AGE_DAYS;
    else process.env.MAX_EVENT_AGE_DAYS = prevAge;
  });

  it('leaves is_update ABSENT for an "Out" row', () => {
    // The core of the bug. A transition TO "Out" is the most newsworthy
    // transition in the sport, and it used to assert "not an update", which
    // resolveUpdateSignal treats as final.
    const williams = byName('Mykel Williams');
    expect(williams.athlete_status).toBe('Out');
    expect('is_update' in williams).toBe(false);
  });

  it('leaves is_update ABSENT for an "Active" row that is plainly about an injury', () => {
    // Mariota is status "Active" with no details block and a shortComment
    // reading "expected to miss the rest of the preseason due to a sprained
    // MCL". "Active" says nothing about whether the report is new.
    const mariota = byName('Marcus Mariota');
    expect(mariota.athlete_status).toBe('Active');
    expect(mariota.injury_description).toMatch(/sprained MCL/i);
    expect('is_update' in mariota).toBe(false);
  });

  it('still asserts true for the day-to-day family', () => {
    // Passes in BOTH directions — nothing that publishes today may stop.
    for (const name of ['Malik Nabers', 'Michael Penix Jr.', 'Nick Bosa']) {
      const e = byName(name);
      expect(e.athlete_status, name).toBe('Questionable');
      expect(e.is_update, name).toBe(true);
    }
  });

  it('asserts true for Doubtful, Day-To-Day and Probable', () => {
    for (const status of ['Doubtful', 'Day-To-Day', 'Probable']) {
      expect(parseWithStatus('Mykel Williams', status)?.is_update, status).toBe(true);
    }
  });

  it('leaves an unrecognised status ABSENT rather than asserting false', () => {
    const e = parseWithStatus('Mykel Williams', 'Game Time Decision');
    expect(e).toBeDefined();
    expect('is_update' in e!).toBe(false);
  });

  it('emits is_update: false for NO row in the recorded feed', () => {
    // The strongest statement available: `false` is unreachable from this
    // source, because no ESPN injuries status supports the claim "this report
    // is not a change".
    const withFalse = parseAll().filter((e) => e.is_update === false);
    expect(withFalse.map((e) => e.athlete_name)).toEqual([]);
  });

  it('never reaches inferIsUpdate for an Injured Reserve row', () => {
    // SKIP_STATUS_RE drops these at parse, BEFORE the inferIsUpdate call.
    // Passes in both directions; it exists so nobody "fixes" IR's is_update.
    const e = parseWithStatus('Mykel Williams', 'Injured Reserve');
    expect(e).toBeUndefined();
  });

  it('is MONOTONE — a flip can only ever add a pass-through, never remove one', () => {
    // The property that makes this change safe. For every recorded status and
    // every classifier answer, the new signal is >= the old one
    // (false < true), so nothing that publishes today can stop publishing.
    const legacy = (status: string | undefined): boolean =>
      status ? /day-to-day|questionable|probable|doubtful/i.test(status) : false;

    for (const ev of parseAll()) {
      for (const isNew of [true, false, undefined]) {
        const before = resolveUpdateSignal(
          { ...ev, is_update: legacy(ev.athlete_status) },
          isNew,
        ).isUpdate;
        const after = resolveUpdateSignal(ev, isNew).isUpdate;
        expect(
          Number(after) >= Number(before),
          `${ev.athlete_name} status=${ev.athlete_status} is_new=${isNew}: ${before} -> ${after}`,
        ).toBe(true);
      }
    }
  });

  it('hands an "Out" row to the classifier, which is what unblocks it', () => {
    // The exact combination that produced `entity_match_skip
    // update_signal=source` for Mykel Williams on two consecutive cycles.
    const williams = byName('Mykel Williams');
    expect(resolveUpdateSignal(williams, false)).toEqual({
      isUpdate: true,
      updateSignal: 'classifier',
    });
    // ...and fails closed when the classifier cannot answer either.
    expect(resolveUpdateSignal(williams, undefined)).toEqual({
      isUpdate: false,
      updateSignal: 'none',
    });
  });

  it('leaves injury_description byte-identical for every recorded row', () => {
    // This change must touch exactly one field. injury_description keys
    // body-part extraction, the classifier, significance, dedup and entity
    // matching. Passes in both directions.
    const legacyDescription = (r: Record<string, any>): string => {
      const parts: string[] = [];
      const d = r.details;
      if (d) {
        const frags = [d.side, d.location, d.type, d.detail].filter(
          (x: unknown): x is string => Boolean(x && String(x).trim()),
        );
        if (frags.length > 0) parts.push(frags.join(' '));
      }
      if (r.type?.description) parts.push(r.type.description);
      if (r.status) parts.push(`Status: ${r.status}`);
      if (r.shortComment) parts.push(r.shortComment);
      else if (r.longComment) parts.push(r.longComment);
      return parts.join(' — ').trim();
    };
    const expected = new Map<string, string>();
    for (const g of FIXTURE.injuries) {
      for (const r of g.injuries) expected.set(r.athlete.displayName, legacyDescription(r));
    }
    for (const ev of parseAll()) {
      expect(ev.injury_description, ev.athlete_name).toBe(expected.get(ev.athlete_name));
    }
  });
});

describe('ESPN_UPDATE_SIGNAL_MODE=legacy', () => {
  const prevMode = process.env.ESPN_UPDATE_SIGNAL_MODE;
  const prevAge = process.env.MAX_EVENT_AGE_DAYS;
  beforeEach(() => {
    process.env.MAX_EVENT_AGE_DAYS = '100000';
    process.env.ESPN_UPDATE_SIGNAL_MODE = 'legacy';
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.ESPN_UPDATE_SIGNAL_MODE;
    else process.env.ESPN_UPDATE_SIGNAL_MODE = prevMode;
    if (prevAge === undefined) delete process.env.MAX_EVENT_AGE_DAYS;
    else process.env.MAX_EVENT_AGE_DAYS = prevAge;
  });

  it('reproduces the pre-fix output exactly, row for row', () => {
    // The rollback test. Passes in both directions by construction.
    const legacy = (status: string | undefined): boolean =>
      status ? /day-to-day|questionable|probable|doubtful/i.test(status) : false;
    const events = (
      new ESPNNFLSource() as unknown as { parse: (f: unknown) => RawInjuryEvent[] }
    ).parse(FIXTURE);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.is_update, ev.athlete_name).toBe(legacy(ev.athlete_status));
    }
    // ...and `false` is reachable again, which is the point of the lever.
    expect(events.some((e) => e.is_update === false)).toBe(true);
  });
});
