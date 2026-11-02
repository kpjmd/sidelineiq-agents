import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { checkFollowUpCadence, type ExistingPost } from '../utils/publishing-pipeline.js';
import { parseListPostsResponse } from '../utils/web-posts.js';
import { parseTeamTimeline } from '../agents/injury-intelligence/agent.js';
import type { ClassificationResult } from '../types.js';

/**
 * "Is this Sonnet call already known to be pointless?" — a different question
 * from checkFollowUpCadence's "should this follow-up publish?", and it ANSWERS
 * it by asking that function about the post the model would have to emit.
 *
 * The poller used to pay for a full post and then let the cadence throttle
 * discard it: 22 of 23 entity pass-throughs across 69h of Oct 2026 logs. The
 * throttle reads exactly five things — athlete, sport, thread, content type and
 * team_timeline_weeks — and only the last two come from the model. Severity,
 * confidence and prose are not consulted before it, so they cannot rescue a post.
 *
 * With a thread parent, the final type is TRACKING unless team_timeline_weeks is
 * set, because a CONFLICT_FLAG with no timeline is downgraded in the agent. So
 * the whole prediction rests on one claim: THE MODEL WILL EMIT NO TIMELINE. That
 * claim is why each gate below exists. Any doubt means the model runs.
 *
 * - **source_timeline.** agent.ts falls back to parseTeamTimeline when the model
 *   emits nothing, so a parseable team_timeline is a number with no model involved.
 *   It comes from longComment too, which injury_description drops.
 * - **source_text.** Reading a source's duration language is the model's job and
 *   the outcome is not stable. Sam Darnold's "about a four-week return" passed four
 *   times with no post, then published with 4 on the fifth. Identical text is
 *   therefore NOT a safe signal, and is deliberately not a gate.
 * - **thread_timeline.** The thread context prints prior team numbers into the
 *   prompt, and Caleb Williams (2026-10-01) looks like an echo from silent text. A
 *   stored 0 counts, which is why this is not disclosedWeeks: 0 against null is
 *   still a material change to the throttle.
 *
 * The bypass is why a prior post carrying a number also runs the model: omitting
 * it would read as a change. checkFollowUpCadence decides that, not this file.
 */

export type CadencePrecheckMode = 'off' | 'shadow' | 'on';

/** `CADENCE_PRECHECK_MODE=off|shadow|on`, default `shadow`: decides and logs, skips nothing. */
export function cadencePrecheckMode(
  env: string | undefined = process.env.CADENCE_PRECHECK_MODE,
): CadencePrecheckMode {
  const v = env?.trim().toLowerCase();
  return v === 'off' || v === 'on' ? v : 'shadow';
}

/**
 * Anything the model could turn into a week count, read wide on purpose. A false
 * match costs one Sonnet call; a miss can silence a real update. `games?` covers
 * "miss the first four games" (Parsons → 4), month names cover "Week 12 … Nov. 25",
 * and a bare `may` matching the verb is the cheap direction.
 */
const SOURCE_TIMELINE_LANGUAGE =
  /\b(?:days?|weeks?|months?|years?|seasons?|games?|timeline|return\w*|recover\w*|sideline\w*|miss\w*|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\b/i;

export function mentionsTimeline(text: string | undefined | null): boolean {
  return Boolean(text) && SOURCE_TIMELINE_LANGUAGE.test(text!);
}

/**
 * A throttle window closing during the model call would have let the post
 * through, so the cooldown must still hold this far ahead. One missed post at the
 * edge would otherwise wait a whole poll cycle.
 */
export const PRECHECK_COOLDOWN_MARGIN_MS = 5 * 60 * 1000;

export type PrecheckRunReason =
  | 'no_parent'
  | 'no_thread'
  | 'source_timeline'
  | 'source_text'
  | 'thread_timeline'
  | 'read_failed'
  | 'not_throttled';

export interface PrecheckDecision {
  skip: boolean;
  /** Why the model must run, or the throttle's own reason when it need not. */
  reason: string;
}

export interface PrecheckInput {
  athlete_name: string;
  sport: ClassificationResult['sport'];
  /** Everything the prompt shows as source text: raw and classifier-rewritten. */
  source_texts: Array<string | undefined>;
  team_timeline?: string;
  parent_post_id?: string;
  /** Oldest→newest team numbers, from InjuryThreadContext.prior_timelines. */
  thread_reported_weeks?: Array<number | null>;
}

/** The gates that need no read. Null means only the post history can answer. */
export function precheckSourceGate(input: PrecheckInput): PrecheckRunReason | null {
  if (!input.parent_post_id) return 'no_parent';
  if (!input.thread_reported_weeks) return 'no_thread';
  if (
    input.team_timeline &&
    (parseTeamTimeline(input.team_timeline) !== null || mentionsTimeline(input.team_timeline))
  ) {
    return 'source_timeline';
  }
  if (input.source_texts.some(mentionsTimeline)) return 'source_text';
  if (input.thread_reported_weeks.some((w) => w !== null && w !== undefined)) {
    return 'thread_timeline';
  }
  return null;
}

/** Pure, so the dry run replays the same decision the poller makes. */
export function decidePrecheck(
  input: PrecheckInput,
  existingPosts: ExistingPost[],
  now: number = Date.now(),
): PrecheckDecision {
  const gate = precheckSourceGate(input);
  if (gate) return { skip: false, reason: gate };

  const cadence = checkFollowUpCadence(
    {
      athlete_name: input.athlete_name,
      sport: input.sport,
      content_type: 'TRACKING',
      parent_post_id: input.parent_post_id,
    },
    existingPosts,
    now + PRECHECK_COOLDOWN_MARGIN_MS,
  );
  return cadence.throttled
    ? { skip: true, reason: cadence.reason ?? 'follow_up_cooldown' }
    : { skip: false, reason: 'not_throttled' };
}

/** Fails open: an unreadable history runs the model, and the pipeline asks again. */
export async function runCadencePrecheck(
  classified: ClassificationResult,
  parentPostId: string | undefined,
  threadReportedWeeks: Array<number | null> | undefined,
): Promise<PrecheckDecision> {
  const input: PrecheckInput = {
    athlete_name: classified.athlete_name,
    sport: classified.sport,
    source_texts: [classified.injury_description, classified.raw_event.injury_description],
    team_timeline: classified.raw_event.team_timeline,
    parent_post_id: parentPostId,
    thread_reported_weeks: threadReportedWeeks,
  };
  const gate = precheckSourceGate(input);
  if (gate) return { skip: false, reason: gate };
  if (!isServerAvailable('web')) return { skip: false, reason: 'read_failed' };

  try {
    // Same query as publishInjuryPost, so both see the same rows.
    const raw = await callTool('web', 'web_list_posts', {
      athlete_name: classified.athlete_name,
      sport: classified.sport,
      limit: 50,
    });
    return decidePrecheck(input, parseListPostsResponse<ExistingPost>(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[CadencePrecheck] post read failed for ${classified.athlete_name} (${classified.sport}) at ` +
        `${new Date().toISOString()}, running the model: ${message}`,
    );
    return { skip: false, reason: 'read_failed' };
  }
}
