import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESPNNFLSource } from '../src/monitoring/sports/espn-nfl.js';
import type { RawInjuryEvent } from '../src/types.js';

// Recorded verbatim from https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries
// on 2026-08-19. Values are untouched; only never-read fields (athlete.links,
// team logos/ids) were pruned to keep the file reviewable. Never hand-author
// this — the RTP-column suite passed for months because its fixtures repeated
// the same wrong names the code used.
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/espn-nfl-injuries.json'),
    'utf-8',
  ),
);

function parseAll(): RawInjuryEvent[] {
  // The fixture is a fixed snapshot, so the recency window must not filter it.
  process.env.MAX_EVENT_AGE_DAYS = '100000';
  return (new ESPNNFLSource() as unknown as { parse: (f: unknown) => RawInjuryEvent[] }).parse(
    FIXTURE,
  );
}

function byName(events: RawInjuryEvent[], name: string): RawInjuryEvent {
  const e = events.find((x) => x.athlete_name === name);
  if (!e) throw new Error(`fixture row missing: ${name}`);
  return e;
}

/** buildDescription() exactly as it stood before this change. */
function legacyDescription(record: {
  details?: { side?: string; location?: string; type?: string; detail?: string };
  type?: { description?: string };
  status?: string;
  shortComment?: string;
  longComment?: string;
}): string {
  const parts: string[] = [];
  const d = record.details;
  if (d) {
    const frags = [d.side, d.location, d.type, d.detail].filter(
      (x): x is string => Boolean(x && x.trim()),
    );
    if (frags.length > 0) parts.push(frags.join(' '));
  }
  if (record.type?.description) parts.push(record.type.description);
  if (record.status) parts.push(`Status: ${record.status}`);
  if (record.shortComment) parts.push(record.shortComment);
  else if (record.longComment) parts.push(record.longComment);
  return parts.join(' — ').trim();
}

describe('ESPN carryover fields', () => {
  const prevAge = process.env.MAX_EVENT_AGE_DAYS;
  beforeEach(() => {
    process.env.MAX_EVENT_AGE_DAYS = '100000';
  });
  afterEach(() => {
    if (prevAge === undefined) delete process.env.MAX_EVENT_AGE_DAYS;
    else process.env.MAX_EVENT_AGE_DAYS = prevAge;
  });

  it('carries longComment as injury_description_long without touching the description', () => {
    const williams = byName(parseAll(), 'Mykel Williams');
    // The historical anchor lives only here — buildDescription took shortComment.
    expect(williams.injury_description_long).toContain('Bosa');
    expect(williams.injury_description_long).toContain('ACL tear suffered last year');
    // ...and must NOT have leaked into the description, which keys body-part
    // extraction, the classifier, dedup and entity matching.
    expect(williams.injury_description).not.toContain('Bosa');
  });

  it('leaves injury_description byte-identical for every recorded row', () => {
    const events = parseAll();
    const expected = new Map<string, string>();
    for (const group of FIXTURE.injuries) {
      for (const record of group.injuries) {
        expected.set(record.athlete.displayName, legacyDescription(record));
      }
    }
    // Fail-closed in BOTH directions: this must hold before and after the change.
    for (const ev of events) {
      expect(ev.injury_description).toBe(expected.get(ev.athlete_name));
    }
    expect(events.length).toBeGreaterThanOrEqual(11);
  });

  it('carries fantasyStatus as roster_designation, distinct from athlete_status', () => {
    const williams = byName(parseAll(), 'Mykel Williams');
    // The two answer different questions and disagree exactly where it matters:
    // ESPN says he is "Out" while the roster list he occupies is preseason PUP.
    expect(williams.roster_designation).toBe('PUP-P');
    expect(williams.athlete_status).toBe('Out');
  });

  it('keeps injury_details at exactly its four documented keys', () => {
    const williams = byName(parseAll(), 'Mykel Williams');
    expect(Object.keys(williams.injury_details ?? {}).sort()).toEqual([
      'detail',
      'location',
      'side',
      'type',
    ]);
    // ...while the designation still arrives, as a sibling.
    expect(williams.roster_designation).toBe('PUP-P');
  });

  it('never carries ESPN returnDate onto the event, in any field', () => {
    const williams = byName(parseAll(), 'Mykel Williams');
    // ESPN reports returnDate 2026-08-13 on this row. It is a lapsed ESTIMATE
    // (64 of 111 live rows carry one dated before the row itself, median lag
    // -2 days), so it is deliberately unreachable from carryover detection.
    const serialized = JSON.stringify(williams);
    expect(serialized).not.toContain('2026-08-13');
    expect(serialized).not.toContain('returnDate');
    expect(williams.injury_description_long).toBeTruthy();
  });

  it('still emits PUP-P rows — the skip filter must not swallow them', () => {
    // Widening SKIP_STATUS_RE to catch fantasyStatus would drop Williams
    // entirely, and a PUP-P athlete returning for Week 1 is exactly the story
    // this platform exists to cover. The designation is evidence, not a filter.
    const events = parseAll();
    expect(events.some((e) => e.athlete_name === 'Mykel Williams')).toBe(true);
    expect(byName(events, 'Mykel Williams').roster_designation).toBe('PUP-P');
  });
});
