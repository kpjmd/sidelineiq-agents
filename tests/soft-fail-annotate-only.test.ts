/**
 * MD_REVIEW_ANNOTATE_ONLY_CODES — a per-code lever over fact-validator soft
 * failures.
 *
 * Why it exists. A soft failure becomes forceMDReviewReason, and that
 * short-circuits needsMDReview outright: no confidence score and no threshold
 * change can un-gate a post once a soft code has fired. That is the correct
 * default — these codes describe facts we could not verify — but it meant a
 * single noisy code silently gated everything, and only a deploy could change
 * it. `source_tier_low` fired on 100% of X insider events for a month and
 * overrode X_INSIDER_FORCE_MD_REVIEW=false while doing it.
 *
 * The lever is opt-in per code, and a downgraded code is annotated, never
 * dropped: it is logged and written to the validation audit row, so a published
 * post still carries the record of what was unverified about it.
 */
import { describe, it, expect } from 'vitest';
import { partitionSoftFailures } from '../src/monitoring/poller.js';
import type { ValidationFailure } from '../src/agents/injury-intelligence/fact-validator.js';

const TIER_LOW: ValidationFailure = {
  code: 'source_tier_low',
  detail: 'Source https://randomblog.example is tier unknown',
};
const TEAM_UNVERIFIED: ValidationFailure = {
  code: 'team_unverified',
  detail: 'player not in roster store',
};

describe('partitionSoftFailures', () => {
  it('forces every code when the env var is unset — todays behaviour', () => {
    const { forcing, annotateOnly } = partitionSoftFailures([TIER_LOW, TEAM_UNVERIFIED], undefined);
    expect(forcing).toHaveLength(2);
    expect(annotateOnly).toHaveLength(0);
  });

  it('forces every code when the env var is empty or whitespace', () => {
    for (const env of ['', '   ', ',', ' , ']) {
      const { forcing, annotateOnly } = partitionSoftFailures([TIER_LOW], env);
      expect(forcing, `env=${JSON.stringify(env)}`).toHaveLength(1);
      expect(annotateOnly).toHaveLength(0);
    }
  });

  it('downgrades only the codes named, never its neighbours', () => {
    const { forcing, annotateOnly } = partitionSoftFailures(
      [TIER_LOW, TEAM_UNVERIFIED],
      'source_tier_low',
    );
    expect(annotateOnly.map((f) => f.code)).toEqual(['source_tier_low']);
    expect(forcing.map((f) => f.code)).toEqual(['team_unverified']);
  });

  it('tolerates spacing and casing in the env value', () => {
    const { annotateOnly } = partitionSoftFailures(
      [TIER_LOW, TEAM_UNVERIFIED],
      ' Source_Tier_Low , team_unverified ',
    );
    expect(annotateOnly).toHaveLength(2);
  });

  it('ignores names that are not real codes rather than matching loosely', () => {
    // A typo or a partial name must not silently downgrade something adjacent.
    const { forcing, annotateOnly } = partitionSoftFailures([TIER_LOW], 'tier_low');
    expect(forcing).toHaveLength(1);
    expect(annotateOnly).toHaveLength(0);
  });
});
