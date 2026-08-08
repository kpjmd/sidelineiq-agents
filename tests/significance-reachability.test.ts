/**
 * Reachability guardrail for the significance gate.
 *
 * In July 2026 publishing stopped completely for three weeks. The cause was not
 * a bug in any single function: the config applied a x0.7 "offseason multiplier"
 * to the composite score while the PROCESS thresholds stayed fixed, which put
 * the bar *above the maximum score those events could ever reach*. No TRACKING
 * event at any tier, and no tier-3/4 BREAKING event, could publish — and tier 3
 * is the default for every athlete missing from athlete-tiers.json.
 *
 * Nothing caught it because the existing fixture tests inline their own config
 * and only exercise the NBA-playoffs window. So this file:
 *   1. loads the REAL data/significance-config.json, and
 *   2. proves every (sport x season window x content_type x tier) cell is either
 *      reachable or blocked by an explicit, named policy.
 *
 * If you change a threshold or a season delta and this fails, the config you
 * wrote makes some class of injury permanently unpublishable. That is the bug,
 * not the test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  loadSignificanceData,
  getLoadedConfig,
  baseProcessThreshold,
  maxAchievableScore,
  computeSignificance,
  REACHABILITY_MARGIN,
} from '../src/agents/injury-intelligence/significance.js';
import type { AthleteTier, ContentType, SportKey } from '../src/types.js';

const CONTENT_TYPES: ContentType[] = ['BREAKING', 'TRACKING', 'DEEP_DIVE', 'CONFLICT_FLAG'];
const TIERS: AthleteTier[] = [1, 2, 3, 4];

/**
 * Cells that cannot PROCESS by deliberate editorial policy, not arithmetic.
 * TRACKING requires a tier 1-2 athlete (`require_tier_1_or_2`), so a routine
 * status update on a depth player is intentionally never published.
 */
const POLICY_BLOCKED = new Set(['TRACKING|3', 'TRACKING|4']);

interface Probe {
  sport: SportKey;
  window: string;
  date: Date;
  delta: number;
}

/**
 * One probe date per configured window, derived from the config itself so a new
 * sport or window is covered the moment it is added. Uses the window's `from`
 * boundary plus a day, which is inside the window for both normal and
 * year-wrapping ranges.
 */
function buildProbes(): Probe[] {
  const cfg = getLoadedConfig();
  if (!cfg) throw new Error('significance config failed to load');

  const probes: Probe[] = [];
  for (const [sport, windows] of Object.entries(cfg.sport_seasons ?? {})) {
    for (const w of windows ?? []) {
      const [mm, dd] = w.from.split('-').map(Number);
      const date = new Date(Date.UTC(2026, mm - 1, dd + 1, 12));
      probes.push({
        sport: sport as SportKey,
        window: w.window,
        date,
        delta: w.threshold_delta,
      });
    }
  }

  // Sports with no configured windows fall back to default_threshold_delta.
  // PREMIER_LEAGUE and UFC are in this bucket today and must still be reachable.
  for (const sport of ['PREMIER_LEAGUE', 'UFC'] as SportKey[]) {
    if (!cfg.sport_seasons?.[sport]) {
      probes.push({
        sport,
        window: 'none',
        date: new Date(Date.UTC(2026, 7, 8, 12)),
        delta: cfg.default_threshold_delta ?? 0,
      });
    }
  }

  return probes;
}

/**
 * Cheapest (specificity, recency) pair that reaches PROCESS, or null if no pair
 * does. Deliberately stops at 95 rather than 100 — a bar only clearable with
 * perfect subscores is not a bar Haiku can clear in practice.
 */
function minimumSubscoresForProcess(
  probe: Probe,
  contentType: ContentType,
  tier: AthleteTier,
): { spec: number; rec: number } | null {
  for (let total = 0; total <= 190; total += 5) {
    for (let spec = 0; spec <= Math.min(95, total); spec += 5) {
      const rec = total - spec;
      if (rec > 95) continue;
      const result = computeSignificance(
        tier,
        'lookup',
        { information_specificity: spec, event_recency_novelty: rec },
        contentType,
        probe.sport,
        probe.date,
      );
      if (result.triage_decision === 'PROCESS') return { spec, rec };
    }
  }
  return null;
}

let probes: Probe[];

beforeAll(async () => {
  // The real data file — NOT an inlined copy. That distinction is the whole point.
  await loadSignificanceData();
  probes = buildProbes();
});

describe('significance config — season windows', () => {
  it('loads the real config in the migrated shape', () => {
    const cfg = getLoadedConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.sport_seasons).toBeDefined();
    // The legacy score-multiplier shape must be gone, not merely ignored.
    expect(cfg as object).not.toHaveProperty('sport_multipliers');
    expect(cfg as object).not.toHaveProperty('default_sport_multiplier');
  });

  it('covers every configured window plus the unconfigured-sport fallback', () => {
    expect(probes.length).toBeGreaterThanOrEqual(5);
    const labels = probes.map((p) => `${p.sport}/${p.window}`);
    expect(labels).toContain('NFL/offseason');
    expect(labels).toContain('NBA/offseason');
    expect(labels).toContain('PREMIER_LEAGUE/none');
  });
});

describe('significance config — TRACKING thresholds under observation', () => {
  // TRACKING.process 70→65 and TRACKING.defer 35→40 shipped 2026-08-08 alongside
  // the multiplier removal and are being monitored in prod before being treated
  // as settled. Pinning them here means any later edit is a deliberate, visible
  // decision rather than something that quietly invalidates the observation.
  it('TRACKING is at the values under observation (65 process / 40 defer)', () => {
    const t = getLoadedConfig()!.thresholds.TRACKING;
    expect(t).toMatchObject({ process: 65, defer: 40, require_tier_1_or_2: true });
  });

  it('the other content types are unchanged', () => {
    const th = getLoadedConfig()!.thresholds;
    expect(th.default).toEqual({ process: 55, defer: 35 });
    expect(th.BREAKING_T1).toMatchObject({ process: 45, defer: 30 });
    expect(th.DEEP_DIVE).toMatchObject({ process: 40, defer: 25 });
    expect(th.CONFLICT_FLAG).toMatchObject({ always_process: true });
  });
});

describe('significance config — no unreachable PROCESS threshold', () => {
  // The assertion that would have failed on the July 2026 config. It checks the
  // arithmetic directly rather than relying on the runtime clamp, because the
  // clamp would otherwise quietly repair a bad config and hide the regression.
  it('every effective threshold leaves real headroom below the max score', () => {
    const violations: string[] = [];

    for (const probe of probes) {
      for (const contentType of CONTENT_TYPES) {
        for (const tier of TIERS) {
          // Policy-blocked cells never consult the score, so an unreachable bar
          // there is meaningless — the tier rule already decided. The companion
          // test below proves they are blocked by policy and not by arithmetic.
          if (POLICY_BLOCKED.has(`${contentType}|${tier}`)) continue;

          const base = baseProcessThreshold(contentType, tier);
          if (base === null) continue; // CONFLICT_FLAG always processes

          const ceiling = maxAchievableScore(contentType, tier) - REACHABILITY_MARGIN;
          const effective = base + probe.delta;
          if (effective > ceiling) {
            violations.push(
              `${probe.sport}/${probe.window} ${contentType} tier=${tier}: ` +
                `bar ${base}${probe.delta >= 0 ? '+' : ''}${probe.delta}=${effective} > max ${ceiling}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('significance config — every cell is reachable or policy-blocked', () => {
  it('finds a passing subscore combination for every publishable cell', () => {
    const unreachable: string[] = [];
    const table: string[] = [];

    for (const probe of probes) {
      for (const contentType of CONTENT_TYPES) {
        for (const tier of TIERS) {
          const label = `${probe.sport}/${probe.window} ${contentType} T${tier}`;
          const found = minimumSubscoresForProcess(probe, contentType, tier);
          const policyBlocked = POLICY_BLOCKED.has(`${contentType}|${tier}`);

          if (policyBlocked) {
            // Blocked cells must be blocked by the tier rule, never by arithmetic.
            expect(found, `${label} should be policy-blocked, not reachable`).toBeNull();
            table.push(`${label.padEnd(44)} policy-blocked (require_tier_1_or_2)`);
            continue;
          }

          if (!found) {
            unreachable.push(label);
            continue;
          }
          table.push(`${label.padEnd(44)} spec>=${found.spec} rec>=${found.rec}`);
        }
      }
    }

    // Printed so a threshold change shows up as a readable diff in review.
    console.log(`\nMinimum subscores to PROCESS:\n${table.join('\n')}\n`);
    expect(unreachable).toEqual([]);
  });
});

describe('significance config — regression: the July 2026 outage shape', () => {
  it('a tier-3 BREAKING event can publish during the NFL offseason', () => {
    // Tier 3 is the default for any athlete missing from athlete-tiers.json, so
    // this is the modal case, not an edge case. Under the old x0.7 config its
    // maximum score was 53 against a bar of 55 — permanently unpublishable.
    const result = computeSignificance(
      3,
      'default',
      { information_specificity: 90, event_recency_novelty: 90 },
      'BREAKING',
      'NFL',
      new Date('2026-08-08'),
    );
    expect(result.season_window).toBe('offseason');
    expect(result.triage_decision).toBe('PROCESS');
  });

  it('a tier-1 TRACKING event can publish during the NBA offseason', () => {
    // Under the old config the theoretical maximum was 62 against a bar of 70.
    const result = computeSignificance(
      1,
      'lookup',
      { information_specificity: 90, event_recency_novelty: 90 },
      'TRACKING',
      'NBA',
      new Date('2026-08-08'),
    );
    expect(result.season_window).toBe('offseason');
    expect(result.triage_decision).toBe('PROCESS');
  });

  it('the score is the event, the season only moves the bar', () => {
    const args = [
      2 as AthleteTier,
      'lookup' as const,
      { information_specificity: 70, event_recency_novelty: 70 },
      'BREAKING' as ContentType,
    ] as const;
    const offseason = computeSignificance(...args, 'NFL', new Date('2026-08-08'));
    const inSeason = computeSignificance(...args, 'NFL', new Date('2026-10-15'));

    expect(offseason.composite_score).toBe(inSeason.composite_score);
    expect(offseason.composite_score).toBe(offseason.raw_score);
    expect(offseason.season_threshold_delta).toBe(5);
    expect(inSeason.season_threshold_delta).toBe(0);
  });
});
