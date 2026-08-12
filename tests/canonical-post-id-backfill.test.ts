/**
 * canonical_post_id backfill.
 *
 * injury_entities.canonical_post_id was declared-but-never-populated on the
 * entity-reuse path: resolveThreadAndDates() creates the entity before any post
 * exists (so it can't set the column), and maintainEntity() only ever set it on
 * the branch where IT created the entity. Reused entities kept it NULL forever.
 *
 * The cost of that NULL is the whole point of these tests:
 *   canonical_post_id NULL
 *     -> web_find_matching_entity returns canonical_post_id: null
 *     -> DedupResult.existingPostId undefined
 *     -> parent_post_id never set on the post
 *     -> checkFollowUpCadence() returns early at `if (!content.parent_post_id)`
 *     -> the thread is permanently exempt from the TRACKING cooldown.
 *
 * Latent until DATE_RESOLUTION_ENABLED flips on — which is precisely the flag
 * that routes maintainEntity down the reuse branch. Same declared-but-never-
 * populated shape as the PublishResult.post_id bug that killed entity
 * maintenance for 10 weeks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawInjuryEvent, InjuryPostContent } from '../src/types.js';
import type {
  ResolvedPlayerInfo,
  ExtractedInjuryMetadata,
} from '../src/agents/injury-intelligence/fact-validator.js';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

// Return Watch is orthogonal bookkeeping with its own try/catch; stub it so the
// assertions below see only the entity-maintenance calls.
vi.mock('../src/monitoring/return-watch.js', () => ({
  maybeProposeReturnWatch: vi.fn(),
}));

import { callTool, isServerAvailable } from '../src/utils/mcp-client-manager.js';
import { maintainEntity } from '../src/monitoring/poller.js';
import { checkForExisting, type DedupResult } from '../src/monitoring/deduplicator.js';
import { publishInjuryPost } from '../src/utils/publishing-pipeline.js';

const mockCallTool = vi.mocked(callTool);
const mockIsServerAvailable = vi.mocked(isServerAvailable);

const POST_ID = 'post-first';
const ENTITY_ID = 'entity-1';
const CREATED_ENTITY_ID = 'entity-created';

function mcpText(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const event: RawInjuryEvent = {
  athlete_name: 'Jalen Brunson',
  sport: 'NBA',
  team: 'New York Knicks',
  injury_description: 'Rolled right ankle in the third quarter.',
  source_url: 'https://espn.com/story/1',
  reported_at: new Date('2026-08-10T00:00:00Z'),
};

const player: ResolvedPlayerInfo = {
  player_id: 'player-1',
  full_name: 'Jalen Brunson',
  current_team_id: 'team-1',
  current_team_name: 'New York Knicks',
  current_team_abbreviation: 'NYK',
  prominence_tier: 2,
  confidence: 'exact',
  match_count: 1,
};

const metadata: ExtractedInjuryMetadata = {
  body_parts: ['ankle'],
  primary_body_part: 'ankle',
  laterality: 'RIGHT',
  injury_type_hint: 'Ankle sprain',
};

const otmProjection = { min_weeks: 2, max_weeks: 4 };

// Returns the params of the first web_thread_update_dates call, or undefined.
function threadUpdateCall(): Record<string, unknown> | undefined {
  const call = mockCallTool.mock.calls.find(
    (c) => c[1] === 'web_thread_update_dates',
  );
  return call?.[2] as Record<string, unknown> | undefined;
}

function callsTo(tool: string): number {
  return mockCallTool.mock.calls.filter((c) => c[1] === tool).length;
}

function run(dedup: DedupResult, opts?: Parameters<typeof maintainEntity>[8]) {
  return maintainEntity(
    event,
    player,
    metadata,
    dedup,
    POST_ID,
    3,
    2,
    'MODERATE',
    opts,
  );
}

describe('maintainEntity — canonical_post_id backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsServerAvailable.mockReturnValue(true);
    mockCallTool.mockResolvedValue(mcpText({ entity: { id: CREATED_ENTITY_ID } }));
  });

  it('backfills the canonical post when reusing the thread manager entity', async () => {
    // The DATE_RESOLUTION_ENABLED path: entity was created pre-publish.
    await run({ isDuplicate: false }, { entityId: ENTITY_ID, otmProjection });

    expect(callsTo('web_create_injury_entity')).toBe(0);
    expect(threadUpdateCall()).toMatchObject({
      entity_id: ENTITY_ID,
      canonical_post_id: POST_ID,
    });
  });

  it('backfills when reusing a dedup-matched entity', async () => {
    // This path previously issued no web_thread_update_dates call at all.
    await run({
      isDuplicate: false,
      entityId: ENTITY_ID,
      decision: 'entity_match_pass_through',
    });

    expect(callsTo('web_create_injury_entity')).toBe(0);
    expect(threadUpdateCall()).toMatchObject({
      entity_id: ENTITY_ID,
      canonical_post_id: POST_ID,
    });
  });

  it('sends the canonical and the projection in a single call', async () => {
    await run({ isDuplicate: false }, { entityId: ENTITY_ID, otmProjection });

    expect(callsTo('web_thread_update_dates')).toBe(1);
    expect(threadUpdateCall()).toMatchObject({
      entity_id: ENTITY_ID,
      canonical_post_id: POST_ID,
      otm_projection: otmProjection,
    });
  });

  it('does not re-send the canonical when it created the entity itself', async () => {
    // The INSERT already carries canonical_post_id — a backfill call would be a
    // wasted round trip.
    await run({ isDuplicate: false });

    expect(mockCallTool).toHaveBeenCalledWith(
      'web',
      'web_create_injury_entity',
      expect.objectContaining({ canonical_post_id: POST_ID }),
    );
    expect(callsTo('web_thread_update_dates')).toBe(0);
  });

  it('never breaks the publish path when the backfill call fails', async () => {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_thread_update_dates') throw new Error('boom');
      return mcpText({ entity: { id: CREATED_ENTITY_ID } });
    });

    await expect(
      run({ isDuplicate: false }, { entityId: ENTITY_ID, otmProjection }),
    ).resolves.toBeUndefined();
  });
});

describe('canonical_post_id -> existingPostId -> parent_post_id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsServerAvailable.mockReturnValue(true);
  });

  function withMatch(canonicalPostId: string | null) {
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_find_matching_entity') {
        return mcpText({
          matched: true,
          entity_id: ENTITY_ID,
          canonical_post_id: canonicalPostId,
          body_part: 'ankle',
          laterality: 'RIGHT',
        });
      }
      return mcpText({ ok: true });
    });
  }

  it('populates existingPostId once the canonical is backfilled', async () => {
    withMatch(POST_ID);

    const dedup = await checkForExisting(
      { ...event, is_update: true },
      { resolvedPlayer: player, metadata },
    );

    expect(dedup.existingPostId).toBe(POST_ID);
    expect(dedup.decision).toBe('entity_match_pass_through');
  });

  it('leaves existingPostId undefined while the canonical is still NULL', async () => {
    // This is exactly what the bug produced — and what silently disabled the
    // follow-up cadence throttle for the whole thread.
    withMatch(null);

    const dedup = await checkForExisting(
      { ...event, is_update: true },
      { resolvedPlayer: player, metadata },
    );

    expect(dedup.existingPostId).toBeUndefined();
  });
});

describe('checkFollowUpCadence engages once parent_post_id is set', () => {
  const DAYS = 86_400_000;
  const WEB_CREATE = mcpText({ post_id: 'post-new', status: 'PUBLISHED' });

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
      parent_post_id: POST_ID,
      // Matches the prior post's disclosed timeline — otherwise the
      // material-change override bypasses the cooldown and this proves nothing.
      team_timeline_weeks: 3,
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

  const recentFollowUp = [
    {
      id: 'post-recent',
      athlete_name: 'Jalen Brunson',
      sport: 'NBA',
      status: 'PUBLISHED',
      content_type: 'TRACKING',
      parent_post_id: POST_ID,
      created_at: daysAgo(1),
      team_timeline_weeks: 3,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsServerAvailable.mockReturnValue(true);
    mockCallTool.mockImplementation(async (_server, tool) => {
      if (tool === 'web_list_posts') return recentFollowUp;
      if (tool === 'web_create_injury_post') return WEB_CREATE;
      return mcpText({ ok: true });
    });
  });

  it('throttles a follow-up that carries a parent_post_id', async () => {
    const result = await publishInjuryPost(followUp());

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('follow_up_cooldown');
    expect(callsTo('web_create_injury_post')).toBe(0);
  });

  it('does not throttle when parent_post_id is missing (the bug state)', async () => {
    // Same post, same recent history — the only difference is the NULL canonical
    // upstream. The guard short-circuits and the cooldown never runs.
    const result = await publishInjuryPost(followUp({ parent_post_id: undefined }));

    expect(result.status).toBe('published');
  });
});
