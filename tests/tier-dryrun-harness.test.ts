import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runTierDelta } from '../src/scripts/tier-dryrun-common.js';
import {
  _setConfigForTesting,
  _setTiersForTesting,
  _setDraftSnapshotForTesting,
  _setSalarySnapshotForTesting,
} from '../src/agents/injury-intelligence/significance.js';

// The harness is a SHIP GATE for every tier provider, and it had no test of its
// own while it lived inside salary-tier-dryrun. These pin the two invariants it
// exists to enforce.
const CONFIG = {
  thresholds: {
    default: { process: 60, defer: 35, max_tier: 3 },
    BREAKING_T1: { process: 45, defer: 30 },
    TRACKING: { process: 65, defer: 40, require_tier_1_or_2: true },
  },
  draft_tiers: { bands: { NFL: { tier_2_max_overall: 32, max_seasons_since_draft: 3 } } },
} as never;

function tierFile(entries: Array<{ name: string; tier: number }>) {
  _setTiersForTesting({
    athletes: entries.map((e) => ({ name: e.name, sport: 'NFL', tier: e.tier })),
  } as never);
}

describe('runTierDelta ship gate', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => void logs.push(String(m)));
    _setConfigForTesting(CONFIG);
    _setSalarySnapshotForTesting(null);
    _setDraftSnapshotForTesting([
      { full_name: 'Rookie One', sport: 'NFL', draft: { year: 2026, round: 1, overall: 4 } },
    ] as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _setConfigForTesting(null);
    _setTiersForTesting(null);
    _setDraftSnapshotForTesting(null);
  });

  const posts = (names: string[]) =>
    names.map((n) => ({ athlete_name: n, sport: 'NFL', content_type: 'BREAKING' }));

  it('accepts a 3->2 promotion and reports it clean', () => {
    tierFile([]);
    const r = runTierDelta(posts(['Rookie One']), {
      before: { allowDraft: false },
      after: { allowDraft: true },
      label: 'draft',
    });
    expect(r.violations).toBe(0);
    expect(r.promoted).toBe(1);
    expect(logs.join('\n')).toContain('promote-only holds');
  });

  it('accepts the diagonal — an unaffected athlete is not a violation', () => {
    tierFile([{ name: 'Star', tier: 1 }]);
    const r = runTierDelta(posts(['Star']), {
      before: { allowDraft: false },
      after: { allowDraft: true },
      label: 'draft',
    });
    expect(r.violations).toBe(0);
    expect(r.promoted).toBe(0);
  });

  it('flags a DEMOTION as a violation', () => {
    // Simulate a provider that demotes by running the toggle backwards: the
    // "after" state resolves lower-prominence than the "before" state.
    tierFile([]);
    const r = runTierDelta(posts(['Rookie One']), {
      before: { allowDraft: true },
      after: { allowDraft: false },
      label: 'inverted',
    });
    expect(r.violations).toBeGreaterThan(0);
    expect(logs.join('\n')).toContain('promote-only');
    expect(logs.join('\n')).toContain('FAIL');
  });

  it('flags movement in a control sport', () => {
    tierFile([]);
    const r = runTierDelta(
      [{ athlete_name: 'Rookie One', sport: 'NFL', content_type: 'BREAKING' }],
      {
        before: { allowDraft: false },
        after: { allowDraft: true },
        label: 'draft',
        controlSports: ['NFL'],
      },
    );
    expect(r.violations).toBeGreaterThan(0);
    expect(logs.join('\n')).toContain('control sports moved');
  });

  it('counts DROP->PROCESS as an improvement, never as forbidden', () => {
    tierFile([]);
    const r = runTierDelta(posts(['Rookie One']), {
      before: { allowDraft: false },
      after: { allowDraft: true },
      label: 'draft',
      // TRACKING at tier 3 is tier_blocked; at tier 2 it competes. That is
      // exactly the DROP->PROCESS this feature is for.
    });
    expect(r.forbidden).toBe(0);
  });

  it('counts a strictly-worse flip as forbidden', () => {
    tierFile([]);
    const r = runTierDelta(
      [{ athlete_name: 'Rookie One', sport: 'NFL', content_type: 'TRACKING' }],
      { before: { allowDraft: true }, after: { allowDraft: false }, label: 'inverted' },
    );
    // Losing the promotion takes TRACKING from competing to tier_blocked.
    expect(r.forbidden).toBeGreaterThan(0);
    expect(logs.join('\n')).toContain('STRICTLY WORSE');
  });
});
