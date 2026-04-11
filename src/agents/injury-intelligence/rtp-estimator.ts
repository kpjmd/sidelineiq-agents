import type { ReturnToPlayEstimate, InjurySeverity } from '../../types.js';

export interface RTPValidationResult {
  valid: boolean;
  corrected?: ReturnToPlayEstimate;
  warnings: string[];
}

/**
 * Validates and corrects an RTP estimate produced by the agent.
 *
 * Rules enforced:
 * - min_weeks <= max_weeks
 * - all probabilities in [0, 1]
 * - probabilities monotonically non-decreasing (week_2 <= week_4 <= week_8)
 * - confidence in [0, 1]
 *
 * When a rule can be safely auto-corrected (e.g., swapping min/max, clamping
 * a probability into range), the corrected value is returned with a warning.
 * When a rule cannot be corrected, valid=false.
 */
export function validateRTPEstimate(
  estimate: ReturnToPlayEstimate,
  injury_type: string,
  severity: InjurySeverity
): RTPValidationResult {
  const warnings: string[] = [];
  const corrected: ReturnToPlayEstimate = { ...estimate };

  // 1. min_weeks <= max_weeks
  if (corrected.min_weeks > corrected.max_weeks) {
    warnings.push(
      `min_weeks (${corrected.min_weeks}) > max_weeks (${corrected.max_weeks}) — swapped`
    );
    [corrected.min_weeks, corrected.max_weeks] = [corrected.max_weeks, corrected.min_weeks];
  }

  // 2. week counts non-negative
  if (corrected.min_weeks < 0) {
    warnings.push(`min_weeks was negative (${corrected.min_weeks}) — clamped to 0`);
    corrected.min_weeks = 0;
  }
  if (corrected.max_weeks < 0) {
    warnings.push(`max_weeks was negative (${corrected.max_weeks}) — clamped to 0`);
    corrected.max_weeks = 0;
  }

  // 3. clamp probabilities to [0, 1]
  const probKeys: Array<keyof ReturnToPlayEstimate> = [
    'probability_week_2',
    'probability_week_4',
    'probability_week_8',
    'confidence',
  ];
  for (const key of probKeys) {
    const val = corrected[key];
    if (typeof val !== 'number' || Number.isNaN(val)) {
      warnings.push(`${key} is not a valid number (${val})`);
      return { valid: false, warnings };
    }
    if (val < 0) {
      warnings.push(`${key} was negative (${val}) — clamped to 0`);
      corrected[key] = 0;
    } else if (val > 1) {
      warnings.push(`${key} exceeded 1 (${val}) — clamped to 1`);
      corrected[key] = 1;
    }
  }

  // 4. Probabilities must be monotonically non-decreasing (week_2 <= week_4 <= week_8)
  if (corrected.probability_week_2 > corrected.probability_week_4) {
    warnings.push(
      `probability_week_2 (${corrected.probability_week_2}) > probability_week_4 (${corrected.probability_week_4}) — not monotonic`
    );
    corrected.probability_week_4 = corrected.probability_week_2;
  }
  if (corrected.probability_week_4 > corrected.probability_week_8) {
    warnings.push(
      `probability_week_4 (${corrected.probability_week_4}) > probability_week_8 (${corrected.probability_week_8}) — not monotonic`
    );
    corrected.probability_week_8 = corrected.probability_week_4;
  }

  // 5. Sanity warning for wildly out-of-range estimates
  if (corrected.max_weeks > 104) {
    warnings.push(
      `max_weeks (${corrected.max_weeks}) exceeds 104 — unusually long for ${injury_type} (${severity})`
    );
  }

  const wasCorrected = warnings.length > 0;
  return {
    valid: true,
    ...(wasCorrected && { corrected }),
    warnings,
  };
}
