/**
 * Content-type drift between the significance gate and the published post.
 *
 * The gate scores `classified.content_type` (Haiku's guess). The agent then
 * re-types the post afterwards — agent.ts downgrades a CONFLICT_FLAG with no
 * parseable team timeline to TRACKING, and forces TRACKING on anything with a
 * parent post. Every tier rule is attached to the content type, so before this
 * check a re-typed post was published under rules that had never been applied
 * to it.
 *
 * The shape that motivated this: Haiku labels a two-source disagreement about a
 * depth player CONFLICT_FLAG → the gate always-processes it with no score and
 * no tier check → Sonnet finds no week number → it publishes as a tier-4
 * TRACKING post, which is exactly what `require_tier_1_or_2` exists to stop and
 * what tests/significance-reachability.test.ts asserts is unreachable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { checkContentTypeDrift } from '../src/monitoring/poller.js';
import {
  loadSignificanceData,
  computeSignificance,
} from '../src/agents/injury-intelligence/significance.js';
import type { AthleteTier, ContentType, SportKey } from '../src/types.js';

// In-season NBA so the season delta is 0 and the numbers below are the plain
// configured thresholds.
const IN_SEASON = new Date('2026-01-15');
const SPORT: SportKey = 'NBA';

function sig(tier: AthleteTier, contentType: ContentType, spec: number, rec: number) {
  return computeSignificance(
    tier,
    'lookup',
    { information_specificity: spec, event_recency_novelty: rec },
    contentType,
    SPORT,
    IN_SEASON,
  );
}

beforeAll(async () => {
  await loadSignificanceData();
});

describe('checkContentTypeDrift — no drift', () => {
  it('proceeds when the type did not change', () => {
    const s = sig(1, 'BREAKING', 90, 90);
    expect(checkContentTypeDrift('BREAKING', 'BREAKING', s, SPORT, IN_SEASON)).toEqual({
      action: 'proceed',
    });
  });
});

describe('checkContentTypeDrift — the CONFLICT_FLAG escape hatch', () => {
  // CONFLICT_FLAG always_process means the gate never consulted the score OR
  // the tier. Whatever it becomes must therefore be checked from scratch.
  it('drops a CONFLICT_FLAG that became TRACKING on a tier-4 athlete', () => {
    const s = sig(4, 'CONFLICT_FLAG', 100, 100);
    const result = checkContentTypeDrift('CONFLICT_FLAG', 'TRACKING', s, SPORT, IN_SEASON);

    expect(result.action).toBe('drop');
    expect(result.reason).toContain('tier_blocked');
  });

  it('drops the same drift on a tier-3 athlete — the default for unlisted players', () => {
    const s = sig(3, 'CONFLICT_FLAG', 100, 100);
    expect(checkContentTypeDrift('CONFLICT_FLAG', 'TRACKING', s, SPORT, IN_SEASON).action).toBe(
      'drop',
    );
  });

  it('lets a genuinely significant tier-1 TRACKING post through', () => {
    // Tier 1 clears require_tier_1_or_2, and 95/95 clears the 65 bar.
    const s = sig(1, 'CONFLICT_FLAG', 95, 95);
    expect(checkContentTypeDrift('CONFLICT_FLAG', 'TRACKING', s, SPORT, IN_SEASON).action).toBe(
      'proceed',
    );
  });

  it('routes a tier-1 TRACKING post that misses the bar to MD review, not to social', () => {
    // Tier-1 TRACKING: prom 95*.35 + prior 30*.15 = 37.75, so low subscores
    // land under the 65 bar without being tier-blocked.
    const s = sig(1, 'CONFLICT_FLAG', 20, 20);
    const result = checkContentTypeDrift('CONFLICT_FLAG', 'TRACKING', s, SPORT, IN_SEASON);

    expect(result.action).toBe('md_review');
    expect(result.reason).toBe('content_type_drift:CONFLICT_FLAG->TRACKING');
  });
});

describe('checkContentTypeDrift — parent_post_id forces TRACKING', () => {
  // agent.ts:459 retypes ANY post with a parent to TRACKING. A tier-3 BREAKING
  // event clears its own bar of 60 but is tier-blocked as TRACKING.
  it('drops a tier-3 BREAKING post that became TRACKING', () => {
    const s = sig(3, 'BREAKING', 95, 95);
    expect(s.triage_decision).toBe('PROCESS'); // it legitimately passed the gate

    const result = checkContentTypeDrift('BREAKING', 'TRACKING', s, SPORT, IN_SEASON);
    expect(result.action).toBe('drop');
  });

  it('keeps a tier-2 BREAKING post that became TRACKING when it still clears the bar', () => {
    const s = sig(2, 'BREAKING', 95, 95);
    expect(checkContentTypeDrift('BREAKING', 'TRACKING', s, SPORT, IN_SEASON).action).toBe(
      'proceed',
    );
  });
});

describe('checkContentTypeDrift — upgrades stay permissive', () => {
  // Conflict detection upgrading to CONFLICT_FLAG is the one drift direction
  // that is always safe: CONFLICT_FLAG always processes by policy.
  it('proceeds on BREAKING -> CONFLICT_FLAG at every tier', () => {
    for (const tier of [1, 2, 3, 4] as AthleteTier[]) {
      const s = sig(tier, 'BREAKING', 10, 10);
      expect(
        checkContentTypeDrift('BREAKING', 'CONFLICT_FLAG', s, SPORT, IN_SEASON).action,
        `tier ${tier}`,
      ).toBe('proceed');
    }
  });
});

describe('checkContentTypeDrift — the re-score uses the final type, not the old one', () => {
  it('re-scores with the destination content-type prior', () => {
    // BREAKING prior 75 vs TRACKING prior 30 — a 6.75-point swing at 0.15
    // weight. Scoring the drifted post under its old prior would overstate it.
    const s = sig(1, 'BREAKING', 60, 60);
    const result = checkContentTypeDrift('BREAKING', 'TRACKING', s, SPORT, IN_SEASON);

    expect(result.rescored!.subscores.content_type_prior).toBe(30);
    expect(result.rescored!.composite_score).toBeLessThan(s.composite_score);
  });
});
