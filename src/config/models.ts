/**
 * The model the Haiku-class classifiers run on: the injury classifier
 * (classifier.ts) and the mention-intent classifier (reply-agent.ts).
 *
 * One setting, because the two must not drift apart, and an environment
 * variable, so the model can be changed in Railway rather than in a deploy.
 *
 * The default is Haiku 5.5 (production has run it since 2026-10-10). The move
 * from 4.5 changed WHICH events publish — a classifier A/B
 * (src/scripts/classifier-ab-dryrun.ts, NFL, 2026-10-09) showed 5.5 more willing
 * to call an ESPN "ruled out" row new — so do not change the default casually;
 * re-run that dry run first. Haiku 4.5 stays in the allowed list only so a
 * rollback by env var works while it is still served (retirement was "not
 * before 2026-10-15"); once it is retired, remove it.
 *
 * Unset or unrecognized falls back to the DEFAULT with a warning. Not to the
 * raw value: a typo here would fail every classifier call, and a classifier
 * error is indistinguishable from "nothing was newsworthy" in the poll summary
 * except for `classifier_errors=`.
 */
export const CLASSIFIER_DEFAULT_MODEL = 'claude-haiku-5-5';

export const CLASSIFIER_MODELS: readonly string[] = [
  CLASSIFIER_DEFAULT_MODEL,
  'claude-haiku-4-5-20251001',
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

/**
 * Whether the injury classifier asks for its two rationale fields. `on` is the
 * default; `off` saves about a quarter of the route's output tokens. A Railway
 * switch for the same reason as the model: a different request can move which
 * events publish, even though nothing reads the fields. Anything but `off` means `on`.
 */
export type ClassifierRationales = 'on' | 'off';

export function classifierRationales(): ClassifierRationales {
  return process.env.CLASSIFIER_RATIONALES?.trim() === 'off' ? 'off' : 'on';
}
