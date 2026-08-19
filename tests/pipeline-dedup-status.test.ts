/**
 * The fallback duplicate check must not outrank the entity-aware one.
 *
 * `isDuplicate` is a flat 24h (athlete, sport) match. It exists as a FALLBACK
 * for when there is no thread context — but it runs unconditionally and BEFORE
 * checkFollowUpCadence, and it had no status filter. Two consequences, both
 * observed in production on 2026-08-19:
 *
 *  - a post sitting unapproved in the MD queue silenced every later report
 *    about that athlete for 24h. With almost everything routing to review, the
 *    queue was suppressing its own follow-ups.
 *  - Jayden Higgins cleared the entity-aware dedup as a legitimate follow-up
 *    (`entity_match_pass_through`), reached the thread manager and resolved his
 *    dates — then died at `[Pipeline] Duplicate detected`.
 *
 * checkFollowUpCadence already filters to PUBLISHED, with a comment explaining
 * why. isDuplicate was simply never given the same filter.
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

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

function post(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Jayden Higgins',
    sport: 'NFL',
    team: 'Houston Texans',
    injury_type: 'Hamstring strain',
    injury_severity: 'MODERATE',
    content_type: 'BREAKING',
    headline: 'Higgins leaves practice',
    clinical_summary: 'Pulled up during team drills.',
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

function priorPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-prior',
    athlete_name: 'Jayden Higgins',
    sport: 'NFL',
    content_type: 'BREAKING',
    status: 'PUBLISHED',
    created_at: hoursAgo(3),
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

describe('the fallback dedup only counts posts that reached an audience', () => {
  it('ignores a PENDING_REVIEW post', async () => {
    // The self-blocking queue. An unapproved post reached nobody, so treating
    // it as "we just covered this" silences an athlete no one heard about.
    withPriorPosts([priorPost({ status: 'PENDING_REVIEW' })]);
    const r = await publishInjuryPost(post());
    expect(r.reason).not.toBe('duplicate');
    expect(r.status).toBe('published');
  });

  it('ignores a DRAFT post', async () => {
    withPriorPosts([priorPost({ status: 'DRAFT' })]);
    const r = await publishInjuryPost(post());
    expect(r.reason).not.toBe('duplicate');
  });

  it('ignores a post with no status at all', async () => {
    // Fail-closed the other way would silence on a malformed row.
    withPriorPosts([priorPost({ status: undefined })]);
    const r = await publishInjuryPost(post());
    expect(r.reason).not.toBe('duplicate');
  });

  it('still blocks a genuine PUBLISHED repeat inside 24h', async () => {
    // Passes in BOTH directions — the check must keep doing its actual job.
    withPriorPosts([priorPost({ status: 'PUBLISHED' })]);
    const r = await publishInjuryPost(post());
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('duplicate');
  });

  it('still ignores a PUBLISHED post older than 24h', async () => {
    // Both directions.
    withPriorPosts([priorPost({ status: 'PUBLISHED', created_at: hoursAgo(30) })]);
    const r = await publishInjuryPost(post());
    expect(r.status).toBe('published');
  });

  it('still ignores a different athlete and a different sport', async () => {
    // Both directions.
    withPriorPosts([
      priorPost({ athlete_name: 'Someone Else' }),
      priorPost({ sport: 'NBA' }),
    ]);
    const r = await publishInjuryPost(post());
    expect(r.status).toBe('published');
  });
});

describe('a known follow-up is governed by the cadence throttle, not the fallback', () => {
  it('does not blanket-block a TRACKING follow-up on a known thread', async () => {
    // The poller's entity-aware dedup already decided this is a legitimate
    // follow-up (entity_match_pass_through) and set parent_post_id. The crude
    // fallback must not override that decision — checkFollowUpCadence is what
    // governs it, and it has the domain rules (5-day window, bypassed by a new
    // team-disclosed timeline).
    withPriorPosts([
      priorPost({ status: 'PUBLISHED', created_at: hoursAgo(3), team_timeline_weeks: 3 }),
    ]);
    const r = await publishInjuryPost(
      post({ content_type: 'TRACKING', parent_post_id: THREAD_ID, team_timeline_weeks: 8 }),
    );
    // A materially new team timeline bypasses the cooldown, so this publishes.
    expect(r.reason).not.toBe('duplicate');
    expect(r.status).toBe('published');
  });

  it('lets the cadence throttle do the blocking, with its own reason', async () => {
    // Same thread, nothing materially new — still skipped, but for the right
    // reason, so the logs say which rule fired.
    withPriorPosts([
      priorPost({
        status: 'PUBLISHED',
        content_type: 'TRACKING',
        parent_post_id: THREAD_ID,
        created_at: hoursAgo(3),
        team_timeline_weeks: 3,
      }),
    ]);
    const r = await publishInjuryPost(
      post({ content_type: 'TRACKING', parent_post_id: THREAD_ID, team_timeline_weeks: 3 }),
    );
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('follow_up_cooldown');
    expect(r.reason).not.toBe('duplicate');
  });

  it('still blanket-blocks a BREAKING post even when it carries a parent', async () => {
    // Nothing may become ungoverned. checkFollowUpCadence only handles
    // TRACKING and CONFLICT_FLAG, so a BREAKING post keeps the fallback.
    withPriorPosts([priorPost({ status: 'PUBLISHED', created_at: hoursAgo(3) })]);
    const r = await publishInjuryPost(post({ content_type: 'BREAKING', parent_post_id: THREAD_ID }));
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('duplicate');
  });
});
