import { describe, it, expect, vi, afterEach } from 'vitest';
import { deduplicateEvents } from '../src/monitoring/sports/multi-source.js';
import type { RawInjuryEvent } from '../src/types.js';

const DAY = new Date('2026-09-01T12:00:00Z');

function ev(
  source_name: string,
  injury_description: string,
  source_url = 'https://example.test/a',
): RawInjuryEvent {
  return {
    athlete_name: 'Jeremiyah Love',
    sport: 'NFL',
    team: 'Falcons',
    injury_description,
    source_url,
    reported_at: DAY,
    source_name,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('deduplicateEvents keeps the merged-away publisher', () => {
  // MultiSource collapses two sources reporting one athlete on one day. That
  // is right for everything downstream, and it is also the ONLY place the
  // pipeline ever sees two publishers on one story — which is precisely what
  // the defer queue needs. It used to log the fact and throw it away.

  it('carries the loser when the CANDIDATE is richer', () => {
    const espn = ev('espn-nfl', 'ankle');
    const tweet = ev('X:AdamSchefter', 'high ankle sprain, out multiple weeks');

    const [survivor] = deduplicateEvents([espn, tweet]);

    expect(survivor.source_name).toBe('X:AdamSchefter');
    expect(survivor.corroborating_families).toEqual(['espn']);
  });

  it('carries the loser when the INCUMBENT is richer', () => {
    // This direction was entirely silent before — no provenance, and not even
    // a log line — so half of all cross-source merges were invisible.
    const espn = ev('espn-nfl', 'high ankle sprain, questionable for Sunday');
    const tweet = ev('X:AdamSchefter', 'ankle');

    const [survivor] = deduplicateEvents([espn, tweet]);

    expect(survivor.source_name).toBe('espn-nfl');
    expect(survivor.corroborating_families).toEqual(['x:adamschefter']);
  });

  it('logs the merge in both directions', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    deduplicateEvents([ev('espn-nfl', 'ankle'), ev('X:AdamSchefter', 'high ankle sprain')]);
    deduplicateEvents([ev('espn-nfl', 'high ankle sprain'), ev('X:AdamSchefter', 'ankle')]);

    const merges = log.mock.calls.filter(([m]) => String(m).includes('cross-source merge'));
    expect(merges).toHaveLength(2);
  });

  it('does not let a survivor corroborate itself', () => {
    // Same publisher twice is one publisher.
    const a = ev('espn-nfl', 'ankle');
    const b = ev('espn-nfl', 'high ankle sprain');

    const [survivor] = deduplicateEvents([a, b]);

    expect(survivor.corroborating_families).toBeUndefined();
  });

  it('leaves the surviving event otherwise byte-identical', () => {
    // The merge must not touch what the classifier and the fingerprint read.
    const espn = ev('espn-nfl', 'ankle');
    const tweet = ev('X:AdamSchefter', 'high ankle sprain, out multiple weeks');

    const [survivor] = deduplicateEvents([espn, tweet]);

    expect(survivor.injury_description).toBe('high ankle sprain, out multiple weeks');
    expect(survivor.source_url).toBe(tweet.source_url);
    expect(survivor.reported_at).toBe(DAY);
  });

  it('accumulates three publishers across two merges', () => {
    const events = [
      ev('espn-nfl', 'ankle'),
      ev('newsapi-nfl', 'ankle sprain', 'https://www.si.com/nfl/x'),
      ev('X:AdamSchefter', 'high ankle sprain, out multiple weeks'),
    ];

    const [survivor] = deduplicateEvents(events);

    expect(survivor.source_name).toBe('X:AdamSchefter');
    expect(new Set(survivor.corroborating_families)).toEqual(new Set(['espn', 'news:si.com']));
  });

  it('keeps different athletes and different days apart', () => {
    const other = ev('espn-nfl', 'knee');
    other.athlete_name = 'Someone Else';
    const later = ev('espn-nfl', 'ankle');
    later.reported_at = new Date('2026-09-02T12:00:00Z');

    expect(deduplicateEvents([ev('espn-nfl', 'ankle'), other, later])).toHaveLength(3);
  });
});
