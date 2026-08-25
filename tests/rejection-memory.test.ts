/**
 * A rejection the MD already made is an answer, not a gap.
 *
 * The Reject button hard-DELETED the post row, so the queue's only memory —
 * findEquivalentPendingReview, which anchors on PENDING_REVIEW — was destroyed
 * by the one action that most needed remembering. The story re-filed on the
 * next 6h poll, and every poll after that, forever. mcp migration 021 keeps the
 * row as REJECTED and findRecentRejection reads it.
 *
 * Which of these fail pre-fix, stated per test rather than left to inference:
 * only the two that assert suppression. Every other test here is a fail-closed
 * boundary that passes in BOTH directions — they pin that the new check stays
 * narrow, not that it works.
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
 * Real rows from the live web DB. No REJECTED row exists yet — nothing has been
 * rejected since migration 021 — so these tests take a recorded PENDING_REVIEW
 * row and override EXACTLY TWO fields: `status` and `retired_at`. Every other
 * column keeps the shape the database actually returns, which is the whole
 * point: the RTP column names, the missing `status` field and the
 * web_get_social_state envelope all survived because hand-written fixtures
 * shared the code's blind spot. Replace this with a recorded REJECTED row after
 * the first production rejection.
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

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

/** A live PENDING_REVIEW row re-stamped as a rejection `days` ago. */
function rejectedRow(days: number, overrides: Record<string, unknown> = {}) {
  const live = LIVE_ROWS.find(
    (r) => r.status === 'PENDING_REVIEW' && r.team_timeline_weeks === null,
  )!;
  return {
    ...live,
    created_at: daysAgo(days + 1),
    status: 'REJECTED',
    retired_at: daysAgo(days),
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

describe('a recent rejection answers for the next cycle', () => {
  // FAILS PRE-FIX. There was no REJECTED branch: the row would have been
  // invisible to every check and the pipeline would have filed a fresh review
  // item, exactly as it did every 6h in production.
  it('does not re-file a question the MD rejected 3 days ago', async () => {
    withPriorPosts([rejectedRow(3)]);
    const r = await publishInjuryPost(biadaszFollowUp());
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('rejected_recently');
    expect(mockCallTool).not.toHaveBeenCalledWith(
      'web',
      'web_create_injury_post',
      expect.anything(),
    );
    expect(mockCallTool).not.toHaveBeenCalledWith(
      'web',
      'web_flag_for_md_review',
      expect.anything(),
    );
  });

  // FAILS PRE-FIX, same reason. Pins the boundary from the inside.
  it('still suppresses at 20 days, one day inside the entity window', async () => {
    withPriorPosts([rejectedRow(20)]);
    expect((await publishInjuryPost(biadaszFollowUp())).reason).toBe('rejected_recently');
  });
});

describe('what the rejection window deliberately does not suppress', () => {
  // PASSES IN BOTH DIRECTIONS — fail-closed. 21 days is where
  // web_find_matching_entity stops matching, so the next report opens a new
  // thread and is a genuinely new question rather than the same one re-asked.
  it('files again once the rejection is older than the 21-day entity window', async () => {
    withPriorPosts([rejectedRow(22)]);
    expect((await publishInjuryPost(biadaszFollowUp())).status).toBe('pending_review');
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. A malformed row must never
  // silence a review item; the same rule isSameReviewQuestion applies to a
  // missing severity.
  it.each([
    ['a missing retired_at', { retired_at: undefined }],
    ['an unparseable retired_at', { retired_at: 'not-a-date' }],
    ['a null retired_at', { retired_at: null }],
  ])('files again on %s', async (_label, override) => {
    withPriorPosts([rejectedRow(3, override)]);
    expect((await publishInjuryPost(biadaszFollowUp())).status).toBe('pending_review');
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. Escalation is exactly what a
  // reviewer needs to see, whatever they said about the milder version.
  it('files again on a severity escalation', async () => {
    withPriorPosts([rejectedRow(3, { injury_severity: 'MODERATE' })]);
    expect((await publishInjuryPost(biadaszFollowUp())).status).toBe('pending_review');
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed.
  it('files again on a different thread', async () => {
    withPriorPosts([rejectedRow(3, { parent_post_id: 'some-other-thread' })]);
    expect((await publishInjuryPost(biadaszFollowUp())).status).toBe('pending_review');
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. The same material-change override
  // the cadence throttle honours, read through disclosedWeeks.
  it('files again when a team actually discloses a timeline', async () => {
    withPriorPosts([rejectedRow(3, { team_timeline_weeks: null })]);
    expect(
      (await publishInjuryPost(biadaszFollowUp({ team_timeline_weeks: 8 }))).status,
    ).toBe('pending_review');
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed. A CONFLICT_FLAG belongs beside the
  // BREAKING it contradicts, and a rejection of one says nothing about the
  // other. (Danny Pinter filed both 25s apart for one patellar tendon tear.)
  it('files again on a different content_type', async () => {
    withPriorPosts([rejectedRow(3, { content_type: 'CONFLICT_FLAG' })]);
    expect((await publishInjuryPost(biadaszFollowUp())).status).toBe('pending_review');
  });

  // PASSES IN BOTH DIRECTIONS — fail-closed, and the important one. The
  // rejection check lives INSIDE the review.needed branch. A post that would
  // publish must never be skipped for having a rejected sibling: that is the
  // publish question, and isDuplicate / checkFollowUpCadence own it.
  it('never consults the rejection on the publish path', async () => {
    withPriorPosts([rejectedRow(3, { injury_severity: 'MINOR' })]);
    // MINOR + high confidence + no forced reason ⇒ no review needed.
    const r = await publishInjuryPost(
      biadaszFollowUp({ injury_severity: 'MINOR', confidence: 0.95 }),
    );
    expect(r.reason).not.toBe('rejected_recently');
  });
});
