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
  loadSignificanceData,
  _setConfigForTesting,
  getLoadedConfig,
} from '../src/agents/injury-intelligence/significance.js';

beforeEach(async () => {
  await loadSignificanceData();
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
