/**
 * Concussion tier gate.
 *
 * Concussion is the one category where OTM cannot produce its core output — an
 * RTP estimate — because SKILL.md forbids it. What's left is league-protocol
 * explanation that reads the same for every athlete, so the post's value comes
 * almost entirely from who was hurt.
 *
 * The prompting side of this already works: the Xavier Weaver post that
 * prompted the rule correctly refused to give a week number. The failure was
 * editorial — a tier-3 preseason depth player reached social at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isConcussionOnlyEvent,
  isConcussionTierBlocked,
  lookupAthleteTier,
  loadSignificanceData,
  _setConfigForTesting,
  _setSalarySnapshotForTesting,
  getLoadedConfig,
} from '../src/agents/injury-intelligence/significance.js';

beforeEach(async () => {
  await loadSignificanceData();
  // Stated, not assumed. Without this line the "unlisted athlete" assertions
  // below would still pass — but only because no salary snapshot happens to be
  // installed in this process, which is an accident of module state rather
  // than a property of the gate. The positive counterpart at the bottom of
  // this file is what actually exercises the salary path.
  _setSalarySnapshotForTesting(null);
});

describe('isConcussionOnlyEvent', () => {
  it.each([
    'Xavier Weaver entered concussion protocol after a hit in the preseason opener',
    'Placed in the NFL concussion protocol',
    'Concussed on the play, did not return',
    'Ruled out with a head injury',
    'Evaluated for a traumatic brain injury',
  ])('recognises %j as a head-injury story', (text) => {
    expect(isConcussionOnlyEvent(text)).toBe(true);
  });

  // The rule must not swallow a musculoskeletal story that happens to mention a
  // past concussion — that is a hamstring/ACL story and belongs in the pipeline.
  it.each([
    'Back from concussion protocol, now dealing with a hamstring strain',
    'Cleared from his concussion but suffered a torn ACL in practice',
    'Missed time with a concussion earlier this year; underwent knee surgery Tuesday',
  ])('does not claim %j', (text) => {
    expect(isConcussionOnlyEvent(text)).toBe(false);
  });

  it('ignores events with no head-injury language at all', () => {
    expect(isConcussionOnlyEvent('Grade 2 high ankle sprain, out 4-6 weeks')).toBe(false);
  });
});

describe('isConcussionTierBlocked', () => {
  const WEAVER = 'Xavier Weaver entered concussion protocol after a hit in the preseason opener';

  it('blocks a concussion story on a tier-3 athlete', () => {
    expect(isConcussionTierBlocked(WEAVER, 3)).toBe(true);
  });

  it('blocks a concussion story on a tier-4 athlete', () => {
    expect(isConcussionTierBlocked(WEAVER, 4)).toBe(true);
  });

  // A star's concussion is genuinely newsworthy even without an RTP.
  it('lets a concussion story through for tier 1 and 2', () => {
    expect(isConcussionTierBlocked(WEAVER, 1)).toBe(false);
    expect(isConcussionTierBlocked(WEAVER, 2)).toBe(false);
  });

  it('never blocks a non-concussion injury, at any tier', () => {
    const acl = 'Torn ACL confirmed by MRI, surgery scheduled';
    for (const tier of [1, 2, 3, 4] as const) {
      expect(isConcussionTierBlocked(acl, tier)).toBe(false);
    }
  });

  it('is config-driven — the policy can be relaxed without a deploy', () => {
    const cfg = getLoadedConfig()!;
    _setConfigForTesting({
      ...cfg,
      concussion: { require_tier_1_or_2: false },
    } as Parameters<typeof _setConfigForTesting>[0]);

    expect(isConcussionTierBlocked(WEAVER, 3)).toBe(false);
  });

  it('defaults to blocking when the config key is absent', () => {
    const cfg = getLoadedConfig()!;
    const { concussion: _omitted, ...withoutKey } = cfg;
    _setConfigForTesting(withoutKey as Parameters<typeof _setConfigForTesting>[0]);

    expect(isConcussionTierBlocked(WEAVER, 3)).toBe(true);
  });
});

describe('shipped config', () => {
  it('has the concussion tier rule enabled', () => {
    expect(getLoadedConfig()!.concussion).toEqual({ require_tier_1_or_2: true });
  });
});

// The gate drops before any model call, using a tier resolved from the SOURCE's
// spelling of the athlete's name. That tier is only trustworthy when it came
// from athlete-tiers.json: a miss returns tier 3 `default`, which is a guess,
// and hard-dropping on a guess buries a star's concussion outright. The poller
// therefore only drops pre-classification on a `lookup` tier — a `default` one
// is re-checked against the classifier's spelling first. These pin the lookup
// behaviour the poller's two-stage gate depends on.
describe('tier resolution the concussion gate depends on', () => {
  it('a punctuation variant of a listed star no longer defaults to tier 3', () => {
    // Ja'Marr Chase is tier 1 in the shipped file; a source writing "JaMarr
    // Chase" used to resolve to tier 3 default and get his concussion dropped.
    const result = lookupAthleteTier('JaMarr Chase', 'NFL');
    expect(result.source).toBe('lookup');
    expect(result.tier).toBeLessThanOrEqual(2);
    expect(isConcussionTierBlocked('Entered the concussion protocol', result.tier)).toBe(false);
  });

  it('an unlisted athlete still resolves to a tier-3 GUESS, not a confirmed tier', () => {
    // The distinction the poller keys on: source==='default' means "we don't
    // know", so the drop is deferred until the classifier's name is available.
    const result = lookupAthleteTier('Xavier Weaver', 'NFL');
    expect(result.source).toBe('default');
    expect(isConcussionTierBlocked('Entered the concussion protocol', result.tier)).toBe(true);
  });

  // The salary layer's effect on this gate, asserted rather than assumed.
  // Salary is promote-only, so it can only ever RESCUE a concussion here — it
  // has no way to create a new drop.
  it('still blocks an unlisted athlete whose salary clears no band', () => {
    // Weaver is really paid $1.07M, which bands to nothing. The negative
    // assertion above now proves the bands rather than the absence of data.
    _setSalarySnapshotForTesting([
      { full_name: 'Xavier Weaver', sport: 'NFL', salary: 1_070_000 },
    ]);
    const result = lookupAthleteTier('Xavier Weaver', 'NFL');
    expect(result.source).toBe('default');
    expect(result.tier).toBe(3);
    expect(isConcussionTierBlocked('Entered the concussion protocol', result.tier)).toBe(true);
  });

  it('rescues an unlisted star once salary resolves him', () => {
    // A.J. Brown at $29.0M: not in the shipped override file, so before the
    // salary layer his concussion was gated exactly like a practice-squad
    // player's. This is the editorial gap the feature closes.
    _setSalarySnapshotForTesting([{ full_name: 'A.J. Brown', sport: 'NFL', salary: 29_000_000 }]);
    const result = lookupAthleteTier('A.J. Brown', 'NFL');
    expect(result.source).toBe('salary');
    expect(result.tier).toBe(1);
    expect(isConcussionTierBlocked('Entered the concussion protocol', result.tier)).toBe(false);
  });

  it('leaves a salary-derived tier 3 for the post-classification re-check', () => {
    // poller.ts hard-drops pre-classification ONLY on source==='lookup'.
    // 'salary' is deliberately excluded: including it would newly drop every
    // salary-tier-3 athlete before any model call, which is the one way this
    // feature could remove coverage that publishes today.
    _setSalarySnapshotForTesting([{ full_name: 'Depth Guy', sport: 'NFL', salary: 1_100_000 }]);
    const result = lookupAthleteTier('Depth Guy', 'NFL');
    expect(result.source).not.toBe('lookup');
  });
});
