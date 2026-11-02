import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cadencePrecheckMode,
  decidePrecheck,
  mentionsTimeline,
  PRECHECK_COOLDOWN_MARGIN_MS,
  precheckSourceGate,
  type PrecheckInput,
} from '../src/monitoring/cadence-precheck.js';
import { checkFollowUpCadence, type ExistingPost } from '../src/utils/publishing-pipeline.js';

const fx = JSON.parse(readFileSync('tests/fixtures/cadence-precheck-cases.json', 'utf8'));
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso).getTime();

function input(c: { parent_post_id: string; text: string; thread_reported_weeks: Array<number | null>; posts: ExistingPost[] }): PrecheckInput {
  return {
    athlete_name: c.posts[0].athlete_name!,
    sport: c.posts[0].sport as PrecheckInput['sport'],
    source_texts: [c.text, c.text],
    parent_post_id: c.parent_post_id,
    thread_reported_weeks: c.thread_reported_weeks,
  };
}

describe('decidePrecheck on recorded threads', () => {
  it('skips a silent re-serve inside the cooldown (Christian Watson)', () => {
    const d = decidePrecheck(input(fx.watson), fx.watson.posts, at(fx.watson.as_of));
    expect(d.skip).toBe(true);
    expect(d.reason).toMatch(/^follow_up_cooldown/);
  });

  it('agrees with the throttle on the post the model would have to emit', () => {
    const now = at(fx.watson.as_of);
    const throttle = checkFollowUpCadence(
      {
        athlete_name: 'Christian Watson',
        sport: 'NFL',
        content_type: 'TRACKING',
        parent_post_id: fx.watson.parent_post_id,
      },
      fx.watson.posts,
      now,
    );
    expect(throttle.throttled).toBe(true);
  });

  it('runs the model once the cooldown has passed', () => {
    const last = at(fx.watson.posts.at(-1).created_at);
    const d = decidePrecheck(input(fx.watson), fx.watson.posts, last + 6 * DAY);
    expect(d).toEqual({ skip: false, reason: 'not_throttled' });
  });

  it('runs the model when the window closes during the call', () => {
    const last = at(fx.watson.posts.at(-1).created_at);
    const justBefore = last + 5 * DAY - PRECHECK_COOLDOWN_MARGIN_MS + 1000;
    expect(decidePrecheck(input(fx.watson), fx.watson.posts, justBefore).reason).toBe('not_throttled');
    // The pipeline itself would still have throttled at that instant.
    expect(
      checkFollowUpCadence(
        { athlete_name: 'Christian Watson', sport: 'NFL', content_type: 'TRACKING', parent_post_id: fx.watson.parent_post_id },
        fx.watson.posts,
        justBefore,
      ).throttled,
    ).toBe(true);
  });

  it('never skips a thread that has carried a team number, even a 0 (Lamar Jackson)', () => {
    expect(fx.lamar.thread_reported_weeks).toContain(0);
    // His re-served text also says "game", so test this gate on silent text.
    const silent = { ...input(fx.lamar), source_texts: [fx.st_brown_text] };
    expect(decidePrecheck(silent, fx.lamar.posts, at(fx.lamar.as_of)).reason).toBe('thread_timeline');
    expect(decidePrecheck(input(fx.lamar), fx.lamar.posts, at(fx.lamar.as_of)).reason).toBe('source_text');
  });

  it('never skips duration language, however often it was re-served (Brandon Ingram)', () => {
    expect(decidePrecheck(input(fx.ingram), fx.ingram.posts, at(fx.ingram.as_of)).reason).toBe('source_text');
  });

  it('runs the model when the last post carried a number, since omitting it reads as a change', () => {
    const posts = fx.watson.posts.map((p: ExistingPost) => ({ ...p, team_timeline_weeks: 4 }));
    expect(decidePrecheck(input(fx.watson), posts, at(fx.watson.as_of)).reason).toBe('not_throttled');
  });

  it('fails open on an empty history', () => {
    expect(decidePrecheck(input(fx.watson), [], at(fx.watson.as_of)).reason).toBe('not_throttled');
  });
});

describe('precheckSourceGate', () => {
  const base = input(fx.watson);

  it('needs a parent and a thread', () => {
    expect(precheckSourceGate({ ...base, parent_post_id: undefined })).toBe('no_parent');
    expect(precheckSourceGate({ ...base, thread_reported_weeks: undefined })).toBe('no_thread');
  });

  it.each(['6 weeks', '2-4 weeks', '2 months', 'Day-To-Day', 'week-to-week', 'out for the season'])(
    'refuses team_timeline %s',
    (team_timeline) => {
      expect(precheckSourceGate({ ...base, team_timeline })).toBe('source_timeline');
    },
  );

  it.each(['Out', 'Questionable', 'Doubtful'])('accepts bare status %s, which is no timeline', (team_timeline) => {
    expect(precheckSourceGate({ ...base, team_timeline })).toBeNull();
  });

  it('reads the classifier rewrite as well as the raw text', () => {
    const source_texts = [fx.watson.text, 'Expected to miss about four weeks.'];
    expect(precheckSourceGate({ ...base, source_texts })).toBe('source_text');
  });
});

describe('mentionsTimeline', () => {
  it.each([
    fx.darnold_text,
    fx.parsons_four_games_text,
    fx.ingram.text,
    'targeting a return for Week 12',
    'could be back by Nov. 25',
    'sidelined for a while',
  ])('flags %s', (text) => {
    expect(mentionsTimeline(text)).toBe(true);
  });

  it.each([fx.watson.text, fx.st_brown_text])('passes %s', (text) => {
    expect(mentionsTimeline(text)).toBe(false);
  });
});

describe('wiring', () => {
  const poller = readFileSync('src/monitoring/poller.ts', 'utf8');

  it('defaults to shadow', () => {
    expect(cadencePrecheckMode(undefined)).toBe('shadow');
    expect(cadencePrecheckMode('garbage')).toBe('shadow');
    expect(cadencePrecheckMode('ON')).toBe('on');
    expect(cadencePrecheckMode('off')).toBe('off');
  });

  it('runs after the thread manager and before the agent call', () => {
    const thread = poller.indexOf('await resolveThreadAndDates(event, validation, dedup)');
    const check = poller.indexOf('await runCadencePrecheck(');
    const agent = poller.indexOf('await processInjuryEvent(classified, dedup.existingPostId, thread)');
    expect(thread).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(thread);
    expect(agent).toBeGreaterThan(check);
  });
});
