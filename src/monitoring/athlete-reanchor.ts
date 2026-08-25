// ── Athlete re-anchor ────────────────────────────────────────────────
//
// What this is for. The poller resolves the athlete tier — and so
// athlete_prominence, 35% of the significance score — from the SOURCE's athlete
// tag, before the classifier runs. When the classifier comes back naming a
// different athlete, the old behaviour was to route the post to MD review and
// keep every downstream identity (player row, fact validation, dedup key,
// entity) pointing at the source's tag. The post said one name; the thread said
// another.
//
// The live case this was built from, still recurring every cycle:
//
//   ESPN injuries feed row → athlete "Tyler Allgeier", status "Active",
//   details null, comment "Allgeier could open the regular season as the
//   Cardinals' primary running back, as Adam Schefter of ESPN reports that
//   Jeremiyah Love sustained a high-ankle sprain in Thursday's preseason win."
//
// ESPN's feed is one row per athlete, so the tag is normally reliable — but a
// HEALTHY athlete's row exists precisely to carry news about somebody else. The
// classifier reads the sentence and correctly answers "Jeremiah Love". The
// guard then punished it for being right, scored the event on Allgeier's tier,
// and minted an ankle-sprain entity against Allgeier's player row.
//
// So: when the drift is verifiable against the roster, follow the classifier
// instead of flagging it. When it is not, keep the old force-review.
//
// FAIL-CLOSED IS THE DEFAULT. Everything here can only take effect when a
// roster lookup confirms a different, unambiguous player AND the source's own
// data says the tagged athlete is not the injured one. Anything else — an
// ambiguous name, a name that appears nowhere in the source text, an injured
// tagged athlete — returns a review outcome and the caller behaves exactly as
// it did before.

import type {
  AthleteTier,
  AthleteTierSource,
  ClassificationResult,
  RawInjuryEvent,
  SportKey,
} from '../types.js';
import type { ResolvedPlayerInfo } from '../agents/injury-intelligence/fact-validator.js';
import {
  computeSignificance,
  isSameAthleteName,
  looseNameKey,
  lookupAthleteTier,
} from '../agents/injury-intelligence/significance.js';
import { NAME_RE } from './sports/text-extraction.js';

/**
 * off    — never re-anchor; today's behaviour exactly.
 * shadow — compute the decision and log it, but still force MD review.
 * on     — apply it.
 *
 * Defaults to `shadow`, following DATE_RESOLUTION_ENABLED's opt-in precedent
 * rather than SIGNIFICANCE_GATE_ENABLED's opt-out: this changes WHO a post is
 * about, so the first deploy should only be able to talk about what it would
 * have done.
 */
export type ReanchorMode = 'off' | 'shadow' | 'on';

export function getReanchorMode(): ReanchorMode {
  const raw = process.env.ATHLETE_REANCHOR_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'on' || raw === 'shadow') return raw;
  return 'shadow';
}

export type ReanchorReviewReason =
  | 'disabled'
  | 'ineligible'
  | 'unresolvable'
  | 'ambiguous'
  | 'not_text_anchored'
  | 'redundant_teammate_mention';

export type ReanchorOutcome =
  /** Both spellings resolve to the same player row — not drift at all. */
  | { kind: 'spelling_variant'; player: ResolvedPlayerInfo; from: string; to: string }
  | {
      kind: 'reanchored';
      from: string;
      to: string;
      player: ResolvedPlayerInfo;
      candidateFrom: 'text' | 'classifier';
      tier: { tier: AthleteTier; source: AthleteTierSource };
    }
  /** Another event in this same cycle already covers the re-anchored athlete. */
  | { kind: 'skip'; reason: 'redundant_teammate_mention'; to: string }
  | { kind: 'review'; reason: ReanchorReviewReason };

export interface ReanchorDeps {
  resolvePlayer: (name: string, sport: SportKey) => Promise<ResolvedPlayerInfo | null>;
  /** The other events in this cycle, for the redundancy check. */
  cycleEvents?: readonly RawInjuryEvent[];
  now?: Date;
}

// ESPN's status strings for an athlete who is NOT currently hurt. Anything else
// — Out, Questionable, Doubtful, Day-To-Day — means the tagged athlete is
// themselves injured, so the tag is about them and drift is a genuine
// disagreement to escalate, not a teammate mention.
const HEALTHY_FEED_STATUS_RE = /^(active|healthy)$/i;

export function isHealthyFeedStatus(status: string | undefined): boolean {
  return Boolean(status && HEALTHY_FEED_STATUS_RE.test(status.trim()));
}

/**
 * May this event's tag be overruled at all?
 *
 * - Article sources tag by regex over prose (the first capitalized bigram that
 *   survives the club/position filters wins, see extractAthleteName), so the
 *   tag is a guess to begin with.
 * - Feed sources tag authoritatively — EXCEPT on a row for a healthy athlete,
 *   which by construction is carrying somebody else's news.
 *
 * A feed event with no status at all is not eligible: absence of evidence that
 * the athlete is healthy is not evidence that they are.
 */
export function isReanchorEligible(event: RawInjuryEvent): boolean {
  if (event.source_kind === 'article') return true;
  return isHealthyFeedStatus(event.athlete_status);
}

/**
 * Last name, normalized the same way athlete identity is normalized elsewhere.
 *
 * Generational suffixes are dropped BEFORE the last token is taken, not after:
 * looseNameKey erases them, so "Marvin Harrison Jr." would otherwise key on an
 * empty string — and every suffixed name would collide with every other.
 */
const SUFFIX_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

export function surnameKey(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z]/g, ''))
    .filter((p) => p.length > 0 && !SUFFIX_TOKENS.has(p.toLowerCase()));
  return looseNameKey(parts[parts.length - 1] ?? '');
}

/**
 * Is the classifier's answer just the SOURCE athlete's surname?
 *
 * Sources refer to the athlete by surname alone as a matter of house style —
 * ESPN's comments read "Kittle (Achilles) said Sunday…", "Nabers (knee) logged
 * reps…", "Monangai (knee) is considered week-to-week". A classifier told to
 * follow the description's wording answers "Kittle" for a row tagged "George
 * Kittle", and a plain string comparison calls that a different athlete.
 *
 * It is not drift and it must not be treated as a re-anchor either: nobody's
 * identity is in question, the source simply used the short form. The caller
 * restores the source's full name — which matters beyond the review queue,
 * because post.athlete_name comes from the classifier and keys the dedup
 * lookup, the player row and the entity.
 *
 * Requires a single token, so "Travis Kelce" against "George Kittle" is still
 * drift, and a bare first name ("George") is not a surname reference.
 */
export function isSurnameReference(sourceName: string, classifierName: string): boolean {
  const classifierTokens = classifierName
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z]/g, ''))
    .filter((t) => t.length > 0 && !SUFFIX_TOKENS.has(t.toLowerCase()));
  if (classifierTokens.length !== 1) return false;

  const sourceSurname = surnameKey(sourceName);
  if (!sourceSurname) return false;
  return looseNameKey(classifierTokens[0]) === sourceSurname;
}

function firstNameOf(name: string): string {
  return looseNameKey(name.trim().split(/\s+/)[0] ?? '');
}

// Small edit distance, for the spelling the classifier gets close but not
// exact: "Jeremiah" vs the roster's "Jeremiyah". Bounded at 2 — enough for a
// dropped or swapped letter, not enough to reach a different first name.
const MAX_FIRST_NAME_EDITS = 2;

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function isSamePerson(candidate: string, classifierName: string): boolean {
  if (surnameKey(candidate) !== surnameKey(classifierName)) return false;
  const a = firstNameOf(candidate);
  const b = firstNameOf(classifierName);
  if (a === b) return true;
  if (a[0] !== b[0]) return false; // a different initial is a different person
  return editDistance(a, b) <= MAX_FIRST_NAME_EDITS;
}

export interface ReanchorCandidate {
  name: string;
  from: 'text' | 'classifier';
}

/**
 * Names from the source text that plausibly denote the classifier's athlete,
 * most trustworthy first.
 *
 * Text-derived candidates lead because they carry the SOURCE's spelling, which
 * is what the roster is keyed on — web_resolve_player matches an exact
 * normalized name, so the classifier's "Jeremiah Love" resolves to nothing
 * while the article's "Jeremiyah Love" resolves cleanly. The classifier's own
 * spelling is kept as a last resort for the names NAME_RE cannot see at all
 * ("DK Metcalf", "Za'Darius Smith").
 */
export function buildReanchorCandidates(
  sourceText: string,
  classifierName: string,
): ReanchorCandidate[] {
  const candidates: ReanchorCandidate[] = [];
  const seen = new Set<string>();

  // matchAll, not exec: NAME_RE is /g and a shared module-level regex, so its
  // lastIndex would leak between calls.
  for (const match of sourceText.matchAll(NAME_RE)) {
    const name = `${match[1]} ${match[2].replace(/'s$/, '')}`;
    const key = looseNameKey(name);
    if (seen.has(key)) continue;
    if (!isSamePerson(name, classifierName)) continue;
    seen.add(key);
    candidates.push({ name, from: 'text' });
  }

  if (!seen.has(looseNameKey(classifierName))) {
    candidates.push({ name: classifierName, from: 'classifier' });
  }
  return candidates;
}

/**
 * Decide whether this drift is a correctable mis-tag. Pure apart from the
 * injected roster lookup; applies nothing.
 */
export async function attemptAthleteReanchor(
  event: RawInjuryEvent,
  classified: ClassificationResult,
  deps: ReanchorDeps,
): Promise<ReanchorOutcome> {
  if (getReanchorMode() === 'off') return { kind: 'review', reason: 'disabled' };

  const sourceName = event.athlete_name;
  const classifierName = classified.athlete_name;

  // Before anything else: are these actually two people? The roster is the
  // authority on that, and isSameAthleteName only compares spellings. If the
  // source's tag and the classifier's name resolve to the SAME player row, the
  // classifier just spelled it differently and there is nothing to review.
  const sourcePlayer = await deps.resolvePlayer(sourceName, event.sport);

  // The classifier's surname has to appear in the text we were given. Without
  // this an article naming five players lets the model pick any of them and
  // have it silently adopted; with it, the model can only re-anchor onto
  // someone the source actually named.
  const textAnchored = mentionsSurname(event.injury_description, classifierName);

  // Never empty: the classifier's own spelling is always appended, and it is
  // only usable when text-anchored, so "the text names nobody matching" comes
  // back as not_text_anchored rather than as an empty candidate list.
  const candidates = buildReanchorCandidates(event.injury_description, classifierName);

  for (const candidate of candidates) {
    if (candidate.from === 'classifier' && !textAnchored) continue;

    const player = await deps.resolvePlayer(candidate.name, event.sport);
    if (!player) continue;
    if (player.confidence === 'ambiguous') return { kind: 'review', reason: 'ambiguous' };

    if (sourcePlayer && player.player_id === sourcePlayer.player_id) {
      return { kind: 'spelling_variant', player, from: sourceName, to: player.full_name };
    }

    // Eligibility is checked only once a real, different player is in hand, so
    // the reason reported for an ineligible event is the interesting one.
    if (!isReanchorEligible(event)) return { kind: 'review', reason: 'ineligible' };

    // The injured athlete's own row is usually in the same cycle, carrying the
    // real status and details. Publishing from the teammate's row too would
    // double-post — or worse, win the race and anchor the thread to the
    // second-hand account.
    if (coveredElsewhereInCycle(deps.cycleEvents, event, player.full_name)) {
      return { kind: 'skip', reason: 'redundant_teammate_mention', to: player.full_name };
    }

    return {
      kind: 'reanchored',
      from: sourceName,
      to: player.full_name,
      player,
      candidateFrom: candidate.from,
      tier: lookupAthleteTier(player.full_name, event.sport),
    };
  }

  if (!textAnchored) return { kind: 'review', reason: 'not_text_anchored' };
  return { kind: 'review', reason: 'unresolvable' };
}

function mentionsSurname(text: string, name: string): boolean {
  const surname = surnameKey(name);
  if (surname.length < 3) return false;
  return text
    .toLowerCase()
    .split(/[^a-z']+/)
    .some((word) => looseNameKey(word) === surname);
}

function coveredElsewhereInCycle(
  cycleEvents: readonly RawInjuryEvent[] | undefined,
  self: RawInjuryEvent,
  athleteName: string,
): boolean {
  if (!cycleEvents) return false;
  return cycleEvents.some((e) => e !== self && isSameAthleteName(e.athlete_name, athleteName));
}

/**
 * Rewrite the event and classification onto the re-anchored athlete.
 *
 * Mutates both objects in place — `classified.raw_event` is the same reference
 * as `event`, and every downstream stage (fact validation, dedup, entity
 * maintenance) reads one or the other, so they have to agree.
 */
export function applyAthleteReanchor(
  event: RawInjuryEvent,
  classified: ClassificationResult,
  outcome: Extract<ReanchorOutcome, { kind: 'reanchored' }>,
  now: Date = new Date(),
): void {
  const { player, tier } = outcome;

  // The roster's spelling, not the classifier's — this is the name the post is
  // published under and the name the player row is keyed on.
  event.athlete_name = player.full_name;
  classified.athlete_name = player.full_name;

  // The ESPN id belongs to the athlete we just stopped talking about, and
  // resolvePlayer tries the id BEFORE the name. Left in place it would quietly
  // resolve the re-anchored event straight back to the original athlete — and
  // for a register-on-sight sport, mint the new name under the old id.
  delete event.espn_athlete_id;

  // A feed row's team is the tagged athlete's. Carrying it forward would
  // contradict the roster and raise team_mismatch_unconfirmed on a fact we
  // already know better. An article's team came from the text alongside the
  // name, and validateEvent already tier-gates that claim, so leave it.
  if (event.source_kind !== 'article' && player.current_team_name) {
    event.team = player.current_team_name;
    classified.team = player.current_team_name;
  }

  // Re-score. The comment at the drift site says a rescue must not rewrite one
  // athlete's score with a second lookup — that guards the case where the
  // SUBJECT is unchanged and only the spelling improved. Here the subject
  // itself changed, so the old score belongs to a player this post is not
  // about. Only prominence moves: the two Haiku subscores describe the report,
  // not the athlete, and are carried over unchanged.
  const sig = classified.significance;
  if (sig) {
    classified.significance = computeSignificance(
      tier.tier,
      tier.source,
      {
        information_specificity: sig.subscores.information_specificity,
        event_recency_novelty: sig.subscores.event_recency_novelty,
      },
      classified.content_type,
      classified.sport,
      now,
    );
  }
}
