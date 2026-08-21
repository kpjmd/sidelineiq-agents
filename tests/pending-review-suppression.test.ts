/**
 * Asking the MD the same question every cycle is not a review queue.
 *
 * PR #37 stopped an unapproved post from counting as evidence we COVERED a
 * story — isDuplicate and checkFollowUpCadence both filter to PUBLISHED. The
 * cost was that a PENDING_REVIEW post then had no memory anywhere. ESPN
 * re-serves the same status row every POLL_INTERVAL_MS, the classifier keeps
 * answering is_new, entity dedup passes it through as a legitimate follow-up,
 * and the pipeline filed another identical review item every six hours.
 *
 * Live queue on 2026-08-21, recorded into tests/fixtures/pending-review-rows-biadasz.json:
 * one published BREAKING for Tyler Biadasz's ACL tear, then three byte-identical
 * PENDING_REVIEW TRACKING rows on the same thread, one per cycle, carrying the
 * same md_review_reason. Alvin Kamara had the same shape.
 *
 * "Should this follow-up publish?" and "should this event re-route to review?"
 * are different questions. These tests pin the second one, and pin that asking
 * it did not change the answer to the first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { InjuryPostContent } from '../src/types.js';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { publishInjuryPost } from '../src/utils/publishing-pipeline.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

/**
 * Real rows, recorded from the live web DB — never hand-authored. Three
 * hand-written fixtures in publishing-pipeline.test.ts once omitted `status`
 * entirely and passed only because the code shared their blind spot.
 */
const LIVE_ROWS: Array<Record<string, unknown>> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/pending-review-rows-biadasz.json', import.meta.url)),
    'utf-8',
  ),
);

const THREAD_ID = 'eee9852d-e6c9-421c-9810-8feb2191828a';
const WEB_CREATE = {
  content: [
    { type: 'text', text: JSON.stringify({ post_id: 'post-new', status: 'PENDING_REVIEW' }) },
  ],
};
const OK = { content: [{ type: 'text', text: 'ok' }] };

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

/** The post the poller would file on the NEXT cycle for the same ESPN row. */
function biadaszFollowUp(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Tyler Biadasz',
    sport: 'NFL',
    team: 'Los Angeles Chargers',
    injury_type: 'ACL tear, left knee — procedure type unconfirmed',
    injury_severity: 'SEVERE',
    content_type: 'TRACKING',
    parent_post_id: THREAD_ID,
    headline: 'Tyler Biadasz ACL Tear Tracking Update',
    clinical_summary: 'Confirmed ACL tear with additional left knee involvement.',
    return_to_play: {
      min_weeks: 39,
      max_weeks: 52,
      probability_week_2: 0,
      probability_week_4: 0,
      probability_week_8: 0,
      confidence: 0.85,
    },
    confidence: 0.8,
    ...overrides,
  };
}

/**
 * A pending row shaped like the live ones, with the recency the fixture rows
 * have lost. `created_at` is restamped because the recorded rows are pinned to
 * 2026-08-20 and only the log line reads the age.
 */
function pendingRow(overrides: Record<string, unknown> = {}) {
  const live = LIVE_ROWS.find(
    (r) => r.status === 'PENDING_REVIEW' && r.team_timeline_weeks === null,
  )!;
  return { ...live, created_at: hoursAgo(6), ...overrides };
}

function publishedBreaking(overrides: Record<string, unknown> = {}) {
  const live = LIVE_ROWS.find((r) => r.status === 'PUBLISHED')!;
  return { ...live, created_at: hoursAgo(30), ...overrides };
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

describe('an unresolved review item answers for the next cycle', () => {
  it('does not re-file when an identical item is already pending on the thread', async () => {
    // The bug, verbatim: Biadasz cycle 2 on top of cycle 1.
    withPriorPosts([pendingRow(), publishedBreaking()]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('already_pending_review');
    // And it must not have written a row.
    expect(mockCallTool).not.toHaveBeenCalledWith('web', 'web_create_injury_post', expect.anything());
    expect(mockCallTool).not.toHaveBeenCalledWith('web', 'web_flag_for_md_review', expect.anything());
  });

  it('does not re-file across the live null/0/null team_timeline_weeks flap', async () => {
    // The whole live pending set at once. The model emitted 0 on the middle
    // row for an ACL tear nobody put a number on; read strictly that is two
    // material changes and all three rows file again. See disclosedWeeks.
    withPriorPosts(LIVE_ROWS.map((r) => ({ ...r, created_at: hoursAgo(6) })));
    const r = await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: undefined }));
    expect(r.reason).toBe('already_pending_review');

    // Symmetric: the 0-week post lands against the null-week pending rows.
    const zero = await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: 0 }));
    expect(zero.reason).toBe('already_pending_review');
  });

  it('files again when a team actually discloses a timeline', async () => {
    // The material-change override, the same one the cadence throttle honours.
    withPriorPosts([pendingRow({ team_timeline_weeks: null })]);
    const r = await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: 8 }));
    expect(r.status).toBe('pending_review');
  });

  it('files again when the disclosed timeline changes', async () => {
    withPriorPosts([pendingRow({ team_timeline_weeks: 3 })]);
    const r = await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: 8 }));
    expect(r.status).toBe('pending_review');
  });

  it('files again when the timeline arrives as a string from MCP', async () => {
    // Untyped MCP columns: '8' !== 8 would make every comparison a mismatch and
    // the check a no-op. Both directions — '8' vs 8 must MATCH and suppress.
    withPriorPosts([pendingRow({ team_timeline_weeks: '8' })]);
    const same = await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: 8 }));
    expect(same.reason).toBe('already_pending_review');

    withPriorPosts([pendingRow({ team_timeline_weeks: '3' })]);
    const changed = await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: 8 }));
    expect(changed.status).toBe('pending_review');
  });

  it('files again when severity escalates', async () => {
    // MODERATE → SEVERE is exactly what a reviewer needs to see.
    withPriorPosts([pendingRow({ injury_severity: 'MODERATE' })]);
    const r = await publishInjuryPost(biadaszFollowUp({ injury_severity: 'SEVERE' }));
    expect(r.status).toBe('pending_review');
  });

  it('files again when the pending row carries no severity at all', async () => {
    // A malformed row must not silence a review item, the same reason
    // isDuplicate refuses to let a status-less row count as coverage.
    withPriorPosts([pendingRow({ injury_severity: undefined })]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('pending_review');
  });

  it('files again for a different content type — the Danny Pinter pair', async () => {
    // A BREAKING and a CONFLICT_FLAG for one patellar tendon tear, filed 25s
    // apart on 2026-08-21. A CONFLICT_FLAG says the sources disagree; the
    // reviewer should see that beside the BREAKING, not behind it.
    withPriorPosts([pendingRow({ content_type: 'BREAKING' })]);
    const r = await publishInjuryPost(
      biadaszFollowUp({ content_type: 'CONFLICT_FLAG', conflict_reason: 'Sources disagree' }),
    );
    expect(r.status).toBe('pending_review');
  });

  it('files again when the pending item belongs to a different thread', async () => {
    // A hamstring thread must not answer for an ACL thread.
    withPriorPosts([
      pendingRow({ id: 'other-post', parent_post_id: 'other-thread' }),
    ]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('pending_review');
  });

  it('suppresses against the thread ROOT, not just its follow-ups', async () => {
    // The pending item may be the post the thread is named after.
    withPriorPosts([pendingRow({ id: THREAD_ID, parent_post_id: null })]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.reason).toBe('already_pending_review');
  });

  it('files again for a different athlete or a different sport', async () => {
    withPriorPosts([
      pendingRow({ athlete_name: 'Someone Else' }),
      pendingRow({ sport: 'NBA' }),
    ]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('pending_review');
  });

  it('files a BREAKING with no thread against a pending BREAKING for the athlete', async () => {
    // No parent_post_id means athlete-level is all the identity there is.
    withPriorPosts([pendingRow({ content_type: 'BREAKING', parent_post_id: null })]);
    const r = await publishInjuryPost(
      biadaszFollowUp({ content_type: 'BREAKING', parent_post_id: undefined }),
    );
    expect(r.reason).toBe('already_pending_review');
  });
});

describe('the publish question is unchanged', () => {
  it('does not suppress a post that would publish, however many items are pending', async () => {
    // The check lives inside the review branch. A publishable post must never
    // be skipped for having a pending sibling — that is the publish question,
    // and isDuplicate/checkFollowUpCadence already answered it.
    withPriorPosts([pendingRow({ injury_severity: 'MODERATE' })]);
    const r = await publishInjuryPost(
      // Nothing forces review: not SEVERE, confidence above any threshold.
      biadaszFollowUp({
        injury_severity: 'MODERATE',
        confidence: 0.95,
        team_timeline_weeks: undefined,
      }),
    );
    expect(r.status).toBe('published');
  });

  it('still routes to review when only PUBLISHED rows exist', async () => {
    // Both directions: suppression is pending-only.
    withPriorPosts([publishedBreaking()]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('pending_review');
  });

  it('still routes to review when there is no history at all', async () => {
    withPriorPosts([]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('pending_review');
  });

  it('fails open and files when the post lookup fails', async () => {
    // Losing a review item is worse than filing a second one, so a failed
    // lookup must not suppress.
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') throw new Error('web MCP down');
      if (tool === 'web_create_injury_post') return WEB_CREATE;
      return OK;
    });
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('pending_review');
  });

  it('still lets the cadence throttle block a publishable follow-up', async () => {
    // Both directions on the rule this change must not touch.
    withPriorPosts([
      {
        ...publishedBreaking(),
        id: 'prior-tracking',
        content_type: 'TRACKING',
        parent_post_id: THREAD_ID,
        created_at: hoursAgo(3),
        team_timeline_weeks: null,
      },
    ]);
    const r = await publishInjuryPost(
      biadaszFollowUp({ injury_severity: 'MODERATE', confidence: 0.95 }),
    );
    expect(r.status).toBe('skipped');
    expect(r.reason).toContain('follow_up_cooldown');
  });
});
