import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { canonicalInjuryKey } from '../src/monitoring/injury-taxonomy.js';
import {
  selectDeepDiveCandidate,
  deepDiveCooldownKey,
  type CandidatePost,
} from '../src/monitoring/deep-dive-candidates.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function post(overrides: Partial<CandidatePost> & { daysAgo?: number } = {}): CandidatePost {
  const { daysAgo = 1, ...rest } = overrides;
  return {
    status: 'PUBLISHED',
    content_type: 'BREAKING',
    sport: 'NFL',
    athlete_name: 'Athlete',
    team: 'Team',
    created_at: new Date(NOW - daysAgo * DAY).toISOString(),
    ...rest,
  };
}

const select = (posts: CandidatePost[], minCount = 3) =>
  selectDeepDiveCandidate(posts, { now: NOW, minCount });

describe('canonicalInjuryKey', () => {
  it.each([
    // Labels copied verbatim from the live corpus (2026-09-12).
    ['acl tear, right knee — surgical (procedure type unconfirmed)', 'acl'],
    ['high ankle sprain (syndesmosis), grade 2 — inferred', 'ankle'],
    ['ankle sprain (grade unconfirmed)', 'ankle'],
    ['grade unconfirmed hamstring strain (myo/le)', 'hamstring'],
    ['mcl sprain, left knee — grade inferred from reported language', 'knee'],
    ['grade 2 oblique strain (left torso)', 'oblique'],
    ['pectoral muscle tear — surgical repair (grade 3, confirmed)', 'pectoral'],
    ['fibula fracture with surgical fixation (grade 3 bon/le)', 'fibula'],
    ['plantar fasciitis (suspected)', 'foot'],
    ['stinger (brachial plexus traction/compression injury) — grade 1 inferred', 'neck'],
  ])('%s → %s', (label, key) => {
    expect(canonicalInjuryKey(label)).toBe(key);
  });

  it('lets a specific structure win even when a general region comes first in the text', () => {
    // Text order alone would call this a knee story; it is a meniscus explainer.
    expect(canonicalInjuryKey('left knee meniscus tear')).toBe('meniscus');
    expect(canonicalInjuryKey('right knee patellar tendon rupture')).toBe('patellar');
  });

  it('breaks a tie between two specifics by declared order', () => {
    expect(canonicalInjuryKey('ACL and meniscus tear, left knee')).toBe('acl');
  });

  it('resolves general regions by text position, not declaration order', () => {
    // The declaration-order bug that put 'back' ahead of 'pectoral' (Greenard).
    expect(canonicalInjuryKey('hip flexor strain with lower back tightness')).toBe('hip');
  });

  it.each([
    ['illness (systemic)'],
    ['appendectomy (surgical)'],
    ['undisclosed'],
    ['abdominal/torso surgery — specific procedure not publicly disclosed'],
    ['lower leg surgery — specific procedure undisclosed'],
    ['eye surgery (ocular/orbital — post-surgical)'],
    ['head injury'],
  ])('leaves %s unbucketed', (label) => {
    expect(canonicalInjuryKey(label)).toBeNull();
  });

  it('refuses false friends in prose but trusts them in a clinical label', () => {
    expect(canonicalInjuryKey("Greenard won't be back at practice", { allowFalseFriends: false })).toBeNull();
    expect(canonicalInjuryKey('on the other hand, the team expects him', { allowFalseFriends: false })).toBeNull();
    expect(canonicalInjuryKey('lower back strain')).toBe('back');
    expect(canonicalInjuryKey('neck injury — surgical (procedure type undisclosed)')).toBe('neck');
  });

  it('does not match anatomy inside unrelated words', () => {
    expect(canonicalInjuryKey('squad rotation')).toBeNull();
    expect(canonicalInjuryKey('football operations update')).toBeNull();
    expect(canonicalInjuryKey('')).toBeNull();
    expect(canonicalInjuryKey(undefined)).toBeNull();
  });
});

describe('selectDeepDiveCandidate', () => {
  it('collapses fragmented labels that the exact-string key could never count together', () => {
    // Three spellings of one story. Under the old predicate each is count 1.
    const posts = [
      post({ injury_type: 'ankle sprain (grade unconfirmed)', athlete_name: 'A' }),
      post({ injury_type: 'high ankle sprain (syndesmosis), grade 2 — inferred', athlete_name: 'B' }),
      post({ injury_type: 'Lateral ankle sprain, grade unconfirmed', athlete_name: 'C' }),
    ];
    const c = select(posts);
    expect(c?.canonical_key).toBe('ankle');
    expect(c?.count).toBe(3);
  });

  it('returns null below minCount', () => {
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A' }),
      post({ injury_type: 'high ankle sprain', athlete_name: 'B' }),
    ];
    expect(select(posts, 3)).toBeNull();
  });

  it('hands the agent a real clinical label as the topic, never the bare key', () => {
    const posts = [
      post({ injury_type: 'High ankle sprain (syndesmosis)', athlete_name: 'A', daysAgo: 3 }),
      post({ injury_type: 'high ankle sprain (syndesmosis)', athlete_name: 'B', daysAgo: 2 }),
      post({ injury_type: 'ankle sprain (grade unconfirmed)', athlete_name: 'C', daysAgo: 1 }),
    ];
    const c = select(posts);
    expect(c?.injury_type).toBe('high ankle sprain (syndesmosis)');
    expect(c?.injury_type).not.toBe(c?.canonical_key);
  });

  it('breaks a topic-label tie by recency', () => {
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A', daysAgo: 4 }),
      post({ injury_type: 'high ankle sprain', athlete_name: 'B', daysAgo: 1 }),
      post({ injury_type: 'syndesmosis injury', athlete_name: 'C', daysAgo: 2 }),
    ];
    expect(select(posts)?.injury_type).toBe('high ankle sprain');
  });

  it('keeps athletes and teams index-aligned when a report names no team', () => {
    // The old predicate de-duplicated these arrays independently, so 'B' lost
    // its slot and 'C' was printed beside team T1's neighbour.
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A', team: 'T1', daysAgo: 3 }),
      post({ injury_type: 'ankle sprain', athlete_name: 'B', team: undefined, daysAgo: 2 }),
      post({ injury_type: 'ankle sprain', athlete_name: 'C', team: 'T3', daysAgo: 1 }),
    ];
    const c = select(posts)!;
    expect(c.athletes).toHaveLength(c.teams.length);
    const pairs = Object.fromEntries(c.athletes.map((a, i) => [a, c.teams[i]]));
    expect(pairs).toEqual({ A: 'T1', B: '', C: 'T3' });
  });

  it('keeps one entry per athlete, on their most recent team', () => {
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A', team: 'Old', daysAgo: 4 }),
      post({ injury_type: 'high ankle sprain', athlete_name: 'a', team: 'New', daysAgo: 1 }),
      post({ injury_type: 'ankle sprain', athlete_name: 'B', team: 'T2', daysAgo: 2 }),
    ];
    const c = select(posts, 2)!;
    expect(c.athletes).toHaveLength(2);
    expect(c.teams[c.athletes.findIndex((x) => x.toLowerCase() === 'a')]).toBe('New');
  });

  describe('counts athletes, not posts — the agent prints the count as "N cases"', () => {
    it('does not let one athlete\'s follow-ups reach the bar', () => {
      // Three TRACKING updates on one stinger, labels evolving as they do live.
      const posts = [
        post({ injury_type: 'cervical spine / neck injury — unspecified', athlete_name: 'A', daysAgo: 3 }),
        post({ injury_type: 'stinger (brachial plexus traction injury)', athlete_name: 'A', daysAgo: 2 }),
        post({ injury_type: 'cervical spine surgery', athlete_name: 'A', daysAgo: 1 }),
      ];
      expect(select(posts, 3)).toBeNull();
      expect(select(posts, 1)?.count).toBe(1);
    });

    it('reports distinct athletes as the count', () => {
      const posts = [
        post({ injury_type: 'ankle sprain', athlete_name: 'A', daysAgo: 3 }),
        post({ injury_type: 'high ankle sprain', athlete_name: 'A', daysAgo: 2 }),
        post({ injury_type: 'ankle sprain', athlete_name: 'B', daysAgo: 2 }),
        post({ injury_type: 'ankle sprain', athlete_name: 'C', daysAgo: 1 }),
      ];
      expect(select(posts, 3)?.count).toBe(3);
    });

    it('does not let one athlete\'s repeated label out-vote other athletes on the topic', () => {
      const posts = [
        post({ injury_type: 'bone bruise with hyperextension, left knee', athlete_name: 'A', daysAgo: 1 }),
        post({ injury_type: 'bone bruise with hyperextension, left knee', athlete_name: 'A', daysAgo: 2 }),
        post({ injury_type: 'bone bruise with hyperextension, left knee', athlete_name: 'A', daysAgo: 3 }),
        post({ injury_type: 'knee sprain, grade unconfirmed', athlete_name: 'B', daysAgo: 2 }),
        post({ injury_type: 'knee sprain, grade unconfirmed', athlete_name: 'C', daysAgo: 3 }),
      ];
      expect(select(posts, 3)?.injury_type).toBe('knee sprain, grade unconfirmed');
    });

    it('votes each athlete by their most recent label', () => {
      const posts = [
        post({ injury_type: 'knee sprain', athlete_name: 'A', daysAgo: 4 }),
        post({ injury_type: 'mcl sprain, left knee', athlete_name: 'A', daysAgo: 1 }),
        post({ injury_type: 'mcl sprain, left knee', athlete_name: 'B', daysAgo: 2 }),
        post({ injury_type: 'knee sprain', athlete_name: 'C', daysAgo: 3 }),
      ];
      expect(select(posts, 3)?.injury_type).toBe('mcl sprain, left knee');
    });
  });

  it('never counts a retired report', () => {
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A' }),
      post({ injury_type: 'ankle sprain', athlete_name: 'B' }),
      post({ injury_type: 'ankle sprain', athlete_name: 'C', status: 'REJECTED' }),
      post({ injury_type: 'ankle sprain', athlete_name: 'D', status: 'SUPERSEDED' }),
    ];
    expect(select(posts)).toBeNull();
  });

  it('ignores reports outside the lookback and rows from the future', () => {
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A', daysAgo: 1 }),
      post({ injury_type: 'ankle sprain', athlete_name: 'B', daysAgo: 2 }),
      post({ injury_type: 'ankle sprain', athlete_name: 'C', daysAgo: 6 }),
      post({ injury_type: 'ankle sprain', athlete_name: 'D', daysAgo: -1 }),
    ];
    expect(select(posts)).toBeNull();
  });

  describe('cooldown', () => {
    const hamstrings = [
      post({ injury_type: 'grade 2 hamstring strain (inferred), left', athlete_name: 'A' }),
      post({ injury_type: 'hamstring strain, grade unconfirmed', athlete_name: 'B' }),
      post({ injury_type: 'grade unconfirmed hamstring strain (myo/le)', athlete_name: 'C' }),
    ];

    it('lets a DEEP_DIVE cool reports that are spelled differently from its own label', () => {
      // Comparing a canonical candidate key to a raw DEEP_DIVE string would never
      // match, and this explainer would be written again next cycle.
      const deepDive = post({
        content_type: 'DEEP_DIVE',
        injury_type: 'Hamstring strain, grade unconfirmed',
        daysAgo: 2,
      });
      expect(select([...hamstrings, deepDive])).toBeNull();
    });

    it('still holds past the old seven days — a key is a structure now, not a phrasing', () => {
      const deepDive = post({ content_type: 'DEEP_DIVE', injury_type: 'Hamstring strain', daysAgo: 8 });
      expect(select([...hamstrings, deepDive])).toBeNull();
      const late = post({ content_type: 'DEEP_DIVE', injury_type: 'Hamstring strain', daysAgo: 29 });
      expect(select([...hamstrings, late])).toBeNull();
    });

    it('releases after thirty days', () => {
      const deepDive = post({ content_type: 'DEEP_DIVE', injury_type: 'Hamstring strain', daysAgo: 31 });
      expect(select([...hamstrings, deepDive])?.canonical_key).toBe('hamstring');
    });

    it('is not held by a rejected DEEP_DIVE', () => {
      const deepDive = post({
        content_type: 'DEEP_DIVE',
        injury_type: 'Hamstring strain',
        status: 'REJECTED',
        daysAgo: 1,
      });
      expect(select([...hamstrings, deepDive])?.canonical_key).toBe('hamstring');
    });

    it('falls back to the headline when the label names no bucket', () => {
      const deepDive = post({
        content_type: 'DEEP_DIVE',
        injury_type: 'Soft tissue injury, multiple cases',
        headline: 'Hamstring Strains Are Clustering in the NBA',
        daysAgo: 1,
      });
      expect(deepDiveCooldownKey(deepDive)).toBe('hamstring');
      expect(select([...hamstrings, deepDive])).toBeNull();
    });

    it('does not take a false friend from a headline', () => {
      expect(
        deepDiveCooldownKey(post({ content_type: 'DEEP_DIVE', injury_type: 'undisclosed', headline: "He won't be back soon" })),
      ).toBeNull();
    });

    it('honours the in-memory cooldown on the canonical key', () => {
      const c = selectDeepDiveCandidate(hamstrings, {
        now: NOW,
        minCount: 3,
        isInMemoryCooldown: (key) => key === 'hamstring',
      });
      expect(c).toBeNull();
    });

    it('moves on to the next-best bucket when the top one is cooling', () => {
      const ankles = [
        post({ injury_type: 'ankle sprain', athlete_name: 'X' }),
        post({ injury_type: 'high ankle sprain', athlete_name: 'Y' }),
        post({ injury_type: 'ankle sprain (grade unconfirmed)', athlete_name: 'Z' }),
      ];
      const extraHamstring = post({ injury_type: 'hamstring strain', athlete_name: 'D' });
      const deepDive = post({ content_type: 'DEEP_DIVE', injury_type: 'Hamstring strain', daysAgo: 1 });
      expect(select([...hamstrings, extraHamstring, ...ankles, deepDive])?.canonical_key).toBe('ankle');
    });
  });

  it('prefers the bucket with the most reports', () => {
    const posts = [
      post({ injury_type: 'ankle sprain', athlete_name: 'A' }),
      post({ injury_type: 'ankle sprain', athlete_name: 'B' }),
      post({ injury_type: 'ankle sprain', athlete_name: 'C' }),
      post({ injury_type: 'acl tear', athlete_name: 'D' }),
      post({ injury_type: 'acl tear', athlete_name: 'E' }),
      post({ injury_type: 'acl reconstruction', athlete_name: 'F' }),
      post({ injury_type: 'torn acl', athlete_name: 'G' }),
    ];
    expect(select(posts)?.canonical_key).toBe('acl');
  });
});
