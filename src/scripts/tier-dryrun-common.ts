// Shared ship-gate for any tier provider.
//
// A tier provider may only ever PROMOTE. That is enforced three ways — the
// `1 | 2 | null` return type of each mapping function, the validators that drop
// a config naming tier 3 or 4, and this, which checks the claim against real
// posts before the feature is ever switched on.
//
// Extracted from salary-tier-dryrun so the draft provider asserts the SAME two
// invariants rather than a hand-rolled approximation of them. The only thing
// that differs between providers is which lookup option to toggle.
import {
  lookupAthleteTier,
  computeSignificance,
} from '../agents/injury-intelligence/significance.js';
import type { AthleteTier, ContentType, SportKey } from '../types.js';

export interface DryRunPost {
  athlete_name: string;
  sport: string;
  content_type?: string;
  created_at?: string;
}

export type LookupOpts = { allowSalary?: boolean; allowDerived?: boolean; allowDraft?: boolean };

/** Mid-range subscores, so the gate delta reflects the TIER change alone. */
export const PROXY_SUBSCORES = {
  information_specificity: 65,
  event_recency_novelty: 85,
};

export interface TierDeltaResult {
  promoted: number;
  violations: number;
  forbidden: number;
  newProcess: number;
}

/**
 * Print the before/after tier matrix, the gate-decision delta and the volume
 * estimate. Returns the counters so the caller can decide the exit code.
 *
 * The two invariants, and why each is a ship gate:
 *  - the matrix — only 3→1 and 3→2 may be non-zero. Any other move is a
 *    DEMOTION, which removes coverage that publishes today.
 *  - the flips — PROCESS→DEFER, PROCESS→DROP and DEFER→DROP are forbidden for
 *    the same reason, one layer down.
 */
export function runTierDelta(
  posts: DryRunPost[],
  opts: {
    before: LookupOpts;
    after: LookupOpts;
    label: string;
    /** Sports that must come out entirely diagonal — a control group. */
    controlSports?: SportKey[];
    now?: Date;
  },
): TierDeltaResult {
  const now = opts.now ?? new Date();
  const matrix = new Map<string, number>();
  const gateFlips = new Map<string, number>();
  const controlHits = new Map<string, number>();
  let promoted = 0;

  for (const p of posts) {
    const sport = p.sport as SportKey;
    const before = lookupAthleteTier(p.athlete_name, sport, opts.before);
    const after = lookupAthleteTier(p.athlete_name, sport, opts.after);
    const key = `${before.tier}->${after.tier}`;
    matrix.set(key, (matrix.get(key) ?? 0) + 1);
    if (after.tier < before.tier) promoted++;
    if (opts.controlSports?.includes(sport) && before.tier !== after.tier) {
      controlHits.set(sport, (controlHits.get(sport) ?? 0) + 1);
    }

    const ct = (p.content_type as ContentType) ?? 'BREAKING';
    const sigBefore = computeSignificance(before.tier, before.source, PROXY_SUBSCORES, ct, sport, now);
    const sigAfter = computeSignificance(after.tier, after.source, PROXY_SUBSCORES, ct, sport, now);
    if (sigBefore.triage_decision !== sigAfter.triage_decision) {
      const k = `${sigBefore.triage_decision}->${sigAfter.triage_decision}`;
      gateFlips.set(k, (gateFlips.get(k) ?? 0) + 1);
    }
  }

  console.log(`\n══ B. BEFORE/AFTER TIER DISTRIBUTION (${opts.label}) ═══════════════`);
  console.log(`  ${posts.length} athletes examined, ${promoted} promoted\n`);
  console.log('        after:    t1    t2    t3    t4');
  const tiers: AthleteTier[] = [1, 2, 3, 4];
  let violations = 0;
  for (const b of tiers) {
    const cells = tiers.map((a) => {
      const n = matrix.get(`${b}->${a}`) ?? 0;
      if (n > 0 && a > b) violations += n;
      if (n > 0 && a < b && b !== 3) violations += n;
      return String(n).padStart(5);
    });
    console.log(`  before t${b}: ${cells.join(' ')}`);
  }
  console.log(
    violations > 0
      ? `\n  ✗ FAIL — ${violations} athlete(s) moved somewhere other than 3->1 or 3->2. ` +
          `${opts.label} is meant to be promote-only; a demotion removes coverage that publishes today.`
      : '\n  ✓ promote-only holds: every move is 3->1 or 3->2.',
  );

  if (opts.controlSports?.length) {
    const bad = [...controlHits.entries()];
    console.log(
      bad.length === 0
        ? `  ✓ control sports (${opts.controlSports.join(', ')}) are entirely diagonal.`
        : `  ✗ FAIL — control sports moved: ${bad.map(([s, n]) => `${s}=${n}`).join(', ')}`,
    );
    violations += bad.reduce((a, [, n]) => a + n, 0);
  }

  console.log('\n══ C. GATE DECISION DELTA ═════════════════════════════════════════');
  const FORBIDDEN = ['PROCESS->DEFER', 'PROCESS->DROP', 'DEFER->DROP'];
  let forbidden = 0;
  if (gateFlips.size === 0) console.log('  no gate decision changed.');
  for (const [k, n] of [...gateFlips.entries()].sort()) {
    const bad = FORBIDDEN.includes(k);
    if (bad) forbidden += n;
    console.log(`  ${bad ? '✗' : '·'} ${k.padEnd(18)} ${n}`);
  }
  console.log(
    forbidden > 0
      ? `\n  ✗ FAIL — ${forbidden} decision(s) got STRICTLY WORSE. Nothing that publishes ` +
          `today may stop publishing.`
      : '\n  ✓ no decision got worse.',
  );

  const newProcess =
    (gateFlips.get('DROP->PROCESS') ?? 0) + (gateFlips.get('DEFER->PROCESS') ?? 0);
  return { promoted, violations, forbidden, newProcess };
}
