/**
 * Follow-up cadence throttle.
 *
 * This never executed in production until 2026-08-08. It requires
 * `parent_post_id`, which comes from an entity match, which required the
 * `post_id` that publishInjuryPost never set — so the whole function was
 * unreachable from the day it shipped. Entities now exist, which means these
 * paths are running for the first time against real data.
 *
 * Each test below pins one of the defects that were latent while it was dead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InjuryPostContent } from '../src/types.js';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { publishInjuryPost } from '../src/utils/publishing-pipeline.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

const WEB_CREATE = {
  content: [{ type: 'text', text: JSON.stringify({ post_id: 'post-new', status: 'PUBLISHED' }) }],
};
const OK = { content: [{ type: 'text', text: 'ok' }] };

const THREAD_ID = 'post-root';
const DAYS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAYS).toISOString();
}

function followUp(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Jalen Brunson',
    sport: 'NBA',
    team: 'New York Knicks',
    injury_type: 'Ankle sprain',
    injury_severity: 'MODERATE',
    content_type: 'TRACKING',
    parent_post_id: THREAD_ID,
    headline: 'Brunson progressing in ankle rehab',
    clinical_summary: 'Still limited in practice.',
    return_to_play: {
      min_weeks: 2,
      max_weeks: 4,
      probability_week_2: 0.3,
      probability_week_4: 0.7,
      probability_week_8: 0.95,
      confidence: 0.85,
    },
    confidence: 0.92,
    ...overrides,
  };
}

/**
 * A prior post as web_list_posts would return it — every status included.
 *
 * `created_at` is deliberately 2 days old, not 1. publishInjuryPost runs a
 * blanket 24h `isDuplicate` check on (athlete, sport) BEFORE the cadence check
 * and with no status filter, so any fixture inside 24h short-circuits to
 * `skipped`/`duplicate` and never reaches the code these tests exist to pin.
 * A 1-day fixture sits exactly on that boundary and passes only by the
 * milliseconds between building the fixture and the comparison. Every test
 * that expects a throttle therefore also asserts the REASON, so a duplicate
 * skip can never masquerade as a cadence skip.
 */
function priorPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-prior',
    athlete_name: 'Jalen Brunson',
    sport: 'NBA',
    content_type: 'TRACKING',
    status: 'PUBLISHED',
    parent_post_id: THREAD_ID,
    created_at: daysAgo(2),
    team_timeline_weeks: 3,
    ...overrides,
  };
}

function withPriorPosts(posts: unknown[]) {
  mockCallTool.mockImplementation(async (_server, tool) => {
    if (tool === 'web_list_posts') return posts;
    if (tool === 'web_create_injury_post') return WEB_CREATE;
    return OK;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsServerAvailable.mockReturnValue(true);
});

describe('follow-up cadence — baseline', () => {
  it('throttles a same-thread TRACKING follow-up inside the 5-day window', async () => {
    withPriorPosts([priorPost()]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
  });

  it('publishes once the cooldown has elapsed', async () => {
    withPriorPosts([priorPost({ created_at: daysAgo(9) })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('published');
  });

  it('never throttles the first post in a thread', async () => {
    withPriorPosts([priorPost()]);
    const result = await publishInjuryPost(followUp({ parent_post_id: undefined }));

    expect(result.status).toBe('published');
  });
});

describe('follow-up cadence — defect 1: unpublished posts must not anchor a cooldown', () => {
  // web_list_posts returns every status. A post sitting in the review queue —
  // or one an MD rejected outright — never reached anyone, so treating it as
  // "we just covered this" silences an athlete nobody heard about.
  it('ignores a PENDING_REVIEW post', async () => {
    withPriorPosts([priorPost({ status: 'PENDING_REVIEW' })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('published');
  });

  it('ignores a DRAFT post', async () => {
    withPriorPosts([priorPost({ status: 'DRAFT' })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('published');
  });

  it('still throttles when a PUBLISHED post exists alongside an unpublished one', async () => {
    // The PENDING_REVIEW post is the NEWER of the two, so a filter that merely
    // sorted without excluding it would still anchor on the wrong row.
    withPriorPosts([
      priorPost({ id: 'p1', status: 'PENDING_REVIEW', created_at: daysAgo(1.5) }),
      priorPost({ id: 'p2', status: 'PUBLISHED', created_at: daysAgo(2) }),
    ]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
  });

  // The status filter only governs the CADENCE throttle. publishInjuryPost's
  // separate 24h duplicate check has no status filter, so inside 24h a
  // PENDING_REVIEW post still suppresses coverage — as a duplicate, not as a
  // cooldown. Pinned here so the distinction is deliberate rather than a
  // surprise the next reader has to rediscover.
  it('is still suppressed as a DUPLICATE (not a cooldown) inside 24h', async () => {
    withPriorPosts([priorPost({ status: 'PENDING_REVIEW', created_at: daysAgo(0.5) })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('duplicate');
  });
});

describe('follow-up cadence — defect 2: cooldowns are per-injury, not per-athlete', () => {
  // Scoping by athlete meant a hamstring follow-up in March could silence the
  // first update on an ACL tear in October.
  it('ignores a recent follow-up belonging to a different thread', async () => {
    withPriorPosts([priorPost({ id: 'other', parent_post_id: 'post-other-injury' })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('published');
  });

  it('counts the thread root itself as an anchor', async () => {
    // The root has no parent_post_id — it is identified by its own id.
    withPriorPosts([priorPost({ id: THREAD_ID, parent_post_id: null })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
  });
});

describe('follow-up cadence — defect 3: content types must not anchor each other', () => {
  // Pooling both types and taking the newest let the 14-day CONFLICT_FLAG
  // window silently govern routine 5-day TRACKING updates, and vice versa.
  it('a CONFLICT_FLAG does not anchor a TRACKING cooldown', async () => {
    withPriorPosts([priorPost({ content_type: 'CONFLICT_FLAG' })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('published');
  });

  it('a TRACKING post does not anchor a CONFLICT_FLAG cooldown', async () => {
    withPriorPosts([priorPost({ content_type: 'TRACKING', created_at: daysAgo(7) })]);
    const result = await publishInjuryPost(
      followUp({ content_type: 'CONFLICT_FLAG', team_timeline_weeks: 3 }),
    );

    expect(result.status).toBe('published');
  });

  it('CONFLICT_FLAG uses its own 14-day window', async () => {
    withPriorPosts([priorPost({ content_type: 'CONFLICT_FLAG', created_at: daysAgo(7) })]);
    const result = await publishInjuryPost(
      followUp({ content_type: 'CONFLICT_FLAG', team_timeline_weeks: 3 }),
    );

    // 7 days < 14-day cooldown, same type, same thread → throttled
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
  });
});

describe('follow-up cadence — defect 4: material-change comparison is numeric', () => {
  // team_timeline_weeks arrives as untyped MCP data. If a numeric column came
  // back as a string, `'3' !== 3` would be true every time and the throttle
  // would never fire at all.
  it('treats "3" and 3 as the same disclosure', async () => {
    withPriorPosts([priorPost({ team_timeline_weeks: '3' })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 3 }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
  });

  it('publishes when the team timeline actually changes', async () => {
    withPriorPosts([priorPost({ team_timeline_weeks: 3 })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 6 }));

    expect(result.status).toBe('published');
  });

  it('publishes on a first-time disclosure', async () => {
    withPriorPosts([priorPost({ team_timeline_weeks: null })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: 4 }));

    expect(result.status).toBe('published');
  });

  it('treats null and absent as the same non-disclosure', async () => {
    withPriorPosts([priorPost({ team_timeline_weeks: null })]);
    const result = await publishInjuryPost(followUp({ team_timeline_weeks: undefined }));

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
  });
});
