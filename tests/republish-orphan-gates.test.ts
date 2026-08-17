import { describe, it, expect } from 'vitest';
import {
  classifyOrphans,
  groupKey,
  type OrphanRow,
} from '../src/scripts/republish-social-orphans.js';

/**
 * Gates for the Aug 2026 outage backfill. These decide whether days-old injury
 * news goes out under the brand accounts, so they are unit-tested for the same
 * reason selectPostsToRepublish is: getting them wrong publishes something a
 * human never read.
 *
 * The first dry run against production found a real defect these now pin down —
 * see the Coby Bryant case below.
 */

const NOW = Date.parse('2026-08-17T19:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const POLICY = {
  now: NOW,
  maxBreakingAgeMs: 48 * HOUR,
  maxAgeMs: 14 * DAY,
};

function row(overrides: Partial<OrphanRow> = {}): OrphanRow {
  return {
    post_id: 'p1',
    athlete_name: 'Jaren Kanak',
    sport: 'NFL',
    content_type: 'BREAKING',
    created_at: new Date(NOW - 1 * DAY).toISOString(),
    ...overrides,
  };
}

function decisions(rows: OrphanRow[], newerLive: Map<string, string> = new Map()) {
  return Object.fromEntries(
    classifyOrphans(rows, POLICY, newerLive).map((v) => [v.post_id, v.decision]),
  );
}

describe('groupKey', () => {
  it('keys on athlete and sport, case- and whitespace-insensitive', () => {
    expect(groupKey(row({ athlete_name: ' Coby Bryant ', sport: 'nfl' }))).toBe('coby bryant|NFL');
  });

  it('separates the same name in different sports', () => {
    expect(groupKey(row({ sport: 'NFL' }))).not.toBe(groupKey(row({ sport: 'NBA' })));
  });
});

describe('classifyOrphans — superseded by a live post', () => {
  it('skips a post whose athlete already has a newer live one', () => {
    const rows = [row({ post_id: 'orphan' })];
    const verdicts = classifyOrphans(rows, POLICY, new Map([['orphan', 'live-post']]));

    expect(verdicts[0].decision).toBe('skip_superseded');
    expect(verdicts[0].newer_live_post_id).toBe('live-post');
  });

  it('does not let a superseded post suppress a genuine candidate for the same athlete', () => {
    // The superseded one is newer, so a naive newest-wins pass would pick it and
    // silently drop the post that actually needs casting.
    const rows = [
      row({ post_id: 'newer-but-covered', created_at: new Date(NOW - 2 * HOUR).toISOString() }),
      row({ post_id: 'genuine', created_at: new Date(NOW - 6 * HOUR).toISOString() }),
    ];

    expect(decisions(rows, new Map([['newer-but-covered', 'live-post']]))).toEqual({
      'newer-but-covered': 'skip_superseded',
      genuine: 'publish',
    });
  });
});

/**
 * The regression this file exists for.
 *
 * Coby Bryant had three hashless CONFLICT_FLAGs on one knee — Aug 11, 13, 15 —
 * and only the last two shared a parent_post_id. Grouping by
 * `parent_post_id ?? id` let the Aug 11 post through as its own thread, so two
 * posts about the same injury would have gone out, the older one claiming a
 * team timeline of 26 weeks that the newer had already revised to 24.
 */
describe('classifyOrphans — one post per athlete', () => {
  const cobyBryant = [
    row({
      post_id: 'aug-11',
      athlete_name: 'Coby Bryant',
      content_type: 'CONFLICT_FLAG',
      created_at: '2026-08-11T21:37:40.614Z',
      // No parent_post_id — this is what made it its own thread.
    }),
    row({
      post_id: 'aug-13',
      athlete_name: 'Coby Bryant',
      content_type: 'CONFLICT_FLAG',
      created_at: '2026-08-13T20:38:03.600Z',
    }),
    row({
      post_id: 'aug-15',
      athlete_name: 'Coby Bryant',
      content_type: 'CONFLICT_FLAG',
      created_at: '2026-08-15T19:09:37.308Z',
      parent_post_id: 'aug-13',
    }),
  ];

  it('collapses all three to the newest, not one per thread', () => {
    expect(decisions(cobyBryant)).toEqual({
      'aug-11': 'skip_sibling',
      'aug-13': 'skip_sibling',
      'aug-15': 'publish',
    });
  });

  it('groups by athlete even when injury_type is spelled differently each time', () => {
    // The three real rows described the same fracture three ways, so an
    // injury_type-based key would not have collapsed them either.
    const varied = cobyBryant.map((r, i) => ({
      ...r,
      injury_type: [
        'Knee fracture, surgical repair (procedure type unspecified)',
        'Left knee fracture, post-surgical',
        'Left knee fracture, surgically repaired',
      ][i],
    }));

    const published = classifyOrphans(varied, POLICY, new Map()).filter(
      (v) => v.decision === 'publish',
    );
    expect(published).toHaveLength(1);
    expect(published[0].post_id).toBe('aug-15');
  });

  it('leaves different athletes alone', () => {
    const rows = [
      row({ post_id: 'kanak', athlete_name: 'Jaren Kanak', created_at: new Date(NOW - 1 * DAY).toISOString() }),
      row({ post_id: 'harrell', athlete_name: 'Jaylen Harrell', created_at: new Date(NOW - 1 * DAY).toISOString() }),
    ];

    expect(decisions(rows)).toEqual({ kanak: 'publish', harrell: 'publish' });
  });
});

describe('classifyOrphans — staleness', () => {
  it('skips BREAKING past the breaking budget and keeps a fresh one', () => {
    const rows = [
      row({ post_id: 'walker', athlete_name: 'Jalon Walker', created_at: new Date(NOW - 8 * DAY).toISOString() }),
      row({ post_id: 'kanak', athlete_name: 'Jaren Kanak', created_at: new Date(NOW - 1 * DAY).toISOString() }),
    ];

    expect(decisions(rows)).toEqual({ walker: 'skip_stale', kanak: 'publish' });
  });

  it('gives CONFLICT_FLAG the longer budget — a disagreement persists for weeks', () => {
    const rows = [
      row({
        post_id: 'flag',
        athlete_name: 'Coby Bryant',
        content_type: 'CONFLICT_FLAG',
        created_at: new Date(NOW - 6 * DAY).toISOString(),
      }),
    ];

    expect(decisions(rows)).toEqual({ flag: 'publish' });
  });

  it('skips anything past the general age budget', () => {
    const rows = [
      row({
        post_id: 'ancient',
        content_type: 'DEEP_DIVE',
        created_at: new Date(NOW - 20 * DAY).toISOString(),
      }),
    ];

    expect(decisions(rows)).toEqual({ ancient: 'skip_stale' });
  });

  it('applies staleness after the duplicate gate, so a stale sibling reads as a sibling', () => {
    // Reporting the more specific reason keeps the CSV honest about why a post
    // was not cast — the operator reads these to decide what to approve.
    const rows = [
      row({
        post_id: 'old',
        athlete_name: 'Coby Bryant',
        content_type: 'BREAKING',
        created_at: new Date(NOW - 8 * DAY).toISOString(),
      }),
      row({
        post_id: 'new',
        athlete_name: 'Coby Bryant',
        content_type: 'BREAKING',
        created_at: new Date(NOW - 1 * DAY).toISOString(),
      }),
    ];

    expect(decisions(rows)).toEqual({ old: 'skip_sibling', new: 'publish' });
  });
});

describe('classifyOrphans — the real Aug 2026 backlog', () => {
  /** The nine orphans as /admin/social-health reports them. */
  const backlog: OrphanRow[] = [
    row({ post_id: 'walker', athlete_name: 'Jalon Walker', content_type: 'BREAKING', created_at: '2026-08-09T19:34:34.465Z' }),
    row({ post_id: 'coby-1', athlete_name: 'Coby Bryant', content_type: 'CONFLICT_FLAG', created_at: '2026-08-11T21:37:40.614Z' }),
    row({ post_id: 'coby-2', athlete_name: 'Coby Bryant', content_type: 'CONFLICT_FLAG', created_at: '2026-08-13T20:38:03.600Z' }),
    row({ post_id: 'hill', athlete_name: 'Dax Hill', content_type: 'BREAKING', created_at: '2026-08-14T05:11:56.627Z' }),
    row({ post_id: 'mertz', athlete_name: 'Graham Mertz', content_type: 'BREAKING', created_at: '2026-08-14T17:56:12.391Z' }),
    row({ post_id: 'bisontis', athlete_name: 'Chase Bisontis', content_type: 'BREAKING', created_at: '2026-08-15T06:27:49.646Z' }),
    row({ post_id: 'coby-3', athlete_name: 'Coby Bryant', content_type: 'CONFLICT_FLAG', created_at: '2026-08-15T19:09:37.308Z', parent_post_id: 'coby-2' }),
    row({ post_id: 'harrell', athlete_name: 'Jaylen Harrell', content_type: 'BREAKING', created_at: '2026-08-16T00:34:03.510Z' }),
    row({ post_id: 'kanak', athlete_name: 'Jaren Kanak', content_type: 'BREAKING', created_at: '2026-08-16T15:14:17.775Z' }),
  ];

  it('proposes three casts, not nine', () => {
    const verdicts = classifyOrphans(backlog, POLICY, new Map());
    const published = verdicts.filter((v) => v.decision === 'publish').map((v) => v.post_id);

    expect(published.sort()).toEqual(['coby-3', 'harrell', 'kanak']);
    expect(verdicts.filter((v) => v.decision === 'skip_stale')).toHaveLength(4);
    expect(verdicts.filter((v) => v.decision === 'skip_sibling')).toHaveLength(2);
  });

  it('never proposes two posts for the same athlete', () => {
    const published = classifyOrphans(backlog, POLICY, new Map()).filter(
      (v) => v.decision === 'publish',
    );
    expect(new Set(published.map((v) => v.group_key)).size).toBe(published.length);
  });
});
