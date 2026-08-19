import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESPNNFLSource } from '../src/monitoring/sports/espn-nfl.js';
import {
  detectCarryoverSignals,
  isGatingCarryover,
} from '../src/agents/injury-intelligence/carryover.js';
import type { RawInjuryEvent } from '../src/types.js';

const FIXTURE = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/espn-nfl-injuries.json'),
    'utf-8',
  ),
);

function parseAll(): RawInjuryEvent[] {
  process.env.MAX_EVENT_AGE_DAYS = '100000';
  return (new ESPNNFLSource() as unknown as { parse: (f: unknown) => RawInjuryEvent[] }).parse(
    FIXTURE,
  );
}
function byName(name: string): RawInjuryEvent {
  const e = parseAll().find((x) => x.athlete_name === name);
  if (!e) throw new Error(`fixture row missing: ${name}`);
  return e;
}

describe('detectCarryoverSignals', () => {
  const prevAge = process.env.MAX_EVENT_AGE_DAYS;
  beforeEach(() => {
    process.env.MAX_EVENT_AGE_DAYS = '100000';
  });
  afterEach(() => {
    if (prevAge === undefined) delete process.env.MAX_EVENT_AGE_DAYS;
    else process.env.MAX_EVENT_AGE_DAYS = prevAge;
  });

  it('reads a PUP-P designation as a structured carryover', () => {
    const e = byName('Mykel Williams');
    const c = detectCarryoverSignals(e);
    expect(c.strength).toBe('structured');
    expect(c.codes).toContain('roster_designation:PUP-P');
    expect(isGatingCarryover(c, e)).toBe(true);
  });

  it('recovers the prose-only cases PUP/NFI misses', () => {
    // All four are plain QUESTIONABLE with a carryover stated only in
    // longComment. This is the recall the roster designation cannot give:
    // of the six in-window surgical rows on the live feed, all six were
    // carryovers and the designation matched exactly one.
    for (const name of ['Nick Bosa', 'Malik Nabers', 'Michael Penix Jr.', 'Tank Dell']) {
      const e = byName(name);
      const c = detectCarryoverSignals(e);
      expect(c.strength, name).toBe('prose');
      expect(c.codes.length, name).toBeGreaterThan(0);
      expect(isGatingCarryover(c, e), name).toBe(true);
    }
  });

  it('reads an abbreviated month and a spelled-out elapsed span', () => {
    // Kittle's row says "suffered on Jan. 11"; Buchanan's says "eight months
    // after tearing his ACL". A \b-anchored month pattern and a \d+ elapsed
    // pattern would both miss these.
    expect(detectCarryoverSignals(byName('George Kittle')).codes).toContain('prose:dated_month');
    expect(detectCarryoverSignals(byName('Teddye Buchanan')).codes).toContain(
      'prose:elapsed_span',
    );
  });

  it('quotes the matched sentence as evidence for the resolver prompt', () => {
    const c = detectCarryoverSignals(byName('Malik Nabers'));
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(c.evidence.every((e) => e.length <= 180)).toBe(true);
    expect(c.evidence.join(' ')).toMatch(/last season|ACL/i);
  });

  it('does not gate a fresh injury that merely reads like a rehab story', () => {
    // "Bryant (knee) had surgery Friday" — the report date IS the anchor here.
    // ESPN's longComment closes with career boilerplate ("Chicago's prized
    // offseason signing") that trips the prose patterns, so the fresh-event
    // veto has to override them.
    const e = byName('Coby Bryant');
    expect(isGatingCarryover(detectCarryoverSignals(e), e)).toBe(false);
  });

  it('does not gate on a month that is not about the injury', () => {
    // Mariota sprained his MCL three days before this row. The longComment
    // mentions a future month; matching a bare month flagged it as a carryover.
    const e = byName('Marcus Mariota');
    expect(isGatingCarryover(detectCarryoverSignals(e), e)).toBe(false);
  });

  it('never reads ESPN returnDate — a past estimate is not a carryover signal', () => {
    // Synthesized from a recorded row: strip the narrative, keep everything
    // else. ESPN's returnDate for this row (2026-08-13) precedes its own date,
    // which is true of 64 of 111 live rows and means nothing.
    const base = byName('Mykel Williams');
    const stripped: RawInjuryEvent = {
      ...base,
      injury_description: 'Right Leg Knee - ACL Surgery — out — Status: Out',
      injury_description_long: undefined,
      roster_designation: undefined,
    };
    const c = detectCarryoverSignals(stripped);
    expect(c.strength).toBe('none');
    expect(isGatingCarryover(c, stripped)).toBe(false);
  });

  it('returns none when there is neither a designation nor carryover prose', () => {
    const plain: RawInjuryEvent = {
      athlete_name: 'Test Player',
      sport: 'NFL',
      team: 'Test Team',
      injury_description: 'Left Arm Shoulder Sprain — questionable — Status: Questionable',
      source_url: 'https://example.com/injuries',
      reported_at: new Date('2026-08-19T00:00:00Z'),
    };
    expect(detectCarryoverSignals(plain).strength).toBe('none');
    expect(isGatingCarryover(detectCarryoverSignals(plain), plain)).toBe(false);
  });

  it('does not gate prose without a major-injury marker', () => {
    // The narrowing that keeps the gate off routine soft-tissue chatter.
    const minor: RawInjuryEvent = {
      athlete_name: 'Test Player',
      sport: 'NFL',
      team: 'Test Team',
      injury_description: 'Calf tightness — questionable',
      injury_description_long: 'He has been working his way back to the field since last season.',
      injury_details: { type: 'Calf', detail: 'Not Specified' },
      source_url: 'https://example.com/injuries',
      reported_at: new Date('2026-08-19T00:00:00Z'),
    };
    const c = detectCarryoverSignals(minor);
    expect(c.strength).toBe('prose');
    expect(isGatingCarryover(c, minor)).toBe(false);
  });
});
