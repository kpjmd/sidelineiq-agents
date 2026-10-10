/**
 * The model the Haiku-class classifiers run on: the injury classifier
 * (classifier.ts) and the mention-intent classifier (reply-agent.ts).
 *
 * One setting, because the two must not drift apart, and an environment
 * variable, because Haiku 4.5 is scheduled for retirement (not before
 * 2026-10-15) and the move to Haiku 5.5 changes WHICH events publish — a
 * classifier A/B (src/scripts/classifier-ab-dryrun.ts, NFL, 2026-10-09) showed
 * 5.5 more willing to call an ESPN "ruled out" row new, so the switch is made
 * and unmade in Railway rather than in a deploy. Rollback only works while 4.5
 * is still served.
 *
 * Unset or unrecognized falls back to the DEFAULT with a warning. Not to the
 * raw value: a typo here would fail every classifier call, and a classifier
 * error is indistinguishable from "nothing was newsworthy" in the poll summary
 * except for `classifier_errors=`.
 */
export const CLASSIFIER_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export const CLASSIFIER_MODELS: readonly string[] = [
  CLASSIFIER_DEFAULT_MODEL,
  'claude-haiku-5-5',
];

let warned = false;

export function classifierModel(): string {
  const raw = process.env.CLASSIFIER_MODEL?.trim();
  if (!raw) return CLASSIFIER_DEFAULT_MODEL;
  if (CLASSIFIER_MODELS.includes(raw)) return raw;
  if (!warned) {
    warned = true;
    console.warn(
      `[Config] CLASSIFIER_MODEL="${raw}" is not one of ${CLASSIFIER_MODELS.join(', ')} — using ${CLASSIFIER_DEFAULT_MODEL}`,
    );
  }
  return CLASSIFIER_DEFAULT_MODEL;
}
