// One-shot migration: walk every existing injury_posts row in chronological
// order and create / attach the post to an injury_entity. Idempotent —
// re-running skips posts already linked to an entity.
//
// Grouping signal precedence:
//   1. parent_post_id chain — if the parent already has an entity, reuse it.
//   2. find_matching_entity within a 60-day window (wider than runtime 21d
//      because legacy posts span many months and intra-injury gaps can be
//      large).
//   3. Otherwise create a fresh entity with canonical_post_id = this post.
//
// Posts where web_resolve_player misses (UFC fighters not in roster, name
// typos, retired players) are logged to ./backfill-skipped.csv. Posts with
// ambiguous player matches go to the same file with reason='ambiguous'.
//
// Usage:
//   npx tsx src/scripts/backfill-entities.ts            # default: live run
//   npx tsx src/scripts/backfill-entities.ts --dry-run  # no writes
//
// Run AFTER migrations 007/008/009 are applied and after rosters are synced.

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { extractInjuryMetadata } from '../agents/injury-intelligence/fact-validator.js';
import type { SportKey } from '../types.js';

interface InjuryPost {
  id: string;
  athlete_name: string;
  sport: string;
  team: string;
  injury_type: string;
  injury_severity: string;
  content_type: string;
  clinical_summary: string;
  team_timeline_weeks: number | null;
  return_to_play_min_weeks: number | null;
  source_url: string | null;
  parent_post_id: string | null;
  created_at: string;
}

interface ListPostsResp {
  posts: InjuryPost[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
}

interface ResolveResp {
  resolved: boolean;
  player: {
    player_id: string;
    full_name: string;
    confidence: 'exact' | 'normalized' | 'ambiguous' | 'miss';
    match_count: number;
  } | null;
}

interface MatchResp {
  matched: boolean;
  entity_id: string | null;
  canonical_post_id: string | null;
}

interface GetEntityResp {
  entity: { id: string; canonical_post_id: string | null } | null;
}

interface CreateEntityResp {
  entity: { id: string };
}

interface MCPResult {
  content?: Array<{ text?: string }>;
}

function unwrap<T>(res: unknown): T | null {
  try {
    const text = (res as MCPResult)?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const PAGE_SIZE = 50; // web_list_posts max

async function fetchPage(offset: number): Promise<ListPostsResp | null> {
  const res = await callTool('web', 'web_list_posts', { limit: PAGE_SIZE, offset });
  return unwrap<ListPostsResp>(res);
}

interface SkipRow {
  post_id: string;
  athlete_name: string;
  sport: string;
  reason: string;
}

async function backfill(dryRun: boolean): Promise<void> {
  let offset = 0;
  let totalSeen = 0;

  // entity_id keyed by parent post id, for fast lookup as we walk the chain.
  const entityByPostId = new Map<string, string>();
  const skipped: SkipRow[] = [];

  let parentChainReused = 0;
  let matchedExisting = 0;
  let createdNew = 0;
  let alreadyLinked = 0;
  let errors = 0;

  while (true) {
    const page = await fetchPage(offset);
    if (!page) {
      console.error(`[backfill] failed to fetch page at offset=${offset}, stopping`);
      break;
    }
    const posts = page.posts;
    if (posts.length === 0) break;

    // Newest-first comes back from web_list_posts ORDER BY created_at DESC.
    // We want oldest-first so parent posts get processed before their TRACKING
    // children. Reverse each page locally; not perfect across page boundaries
    // (a parent on page N+1 still beats a child on page N), but parent_post_id
    // chains are typically within hours/days so this is rare.
    posts.reverse();

    for (const post of posts) {
      totalSeen++;
      const context = `${post.athlete_name} (${post.sport})`;

      try {
        // Skip if this post is already linked to an entity (idempotency).
        const existing = unwrap<GetEntityResp>(
          await callTool('web', 'web_get_entity_for_post', { post_id: post.id }),
        );
        if (existing?.entity) {
          entityByPostId.set(post.id, existing.entity.id);
          alreadyLinked++;
          continue;
        }

        // Path 1: walk parent chain.
        let entityId: string | undefined;
        if (post.parent_post_id) {
          entityId = entityByPostId.get(post.parent_post_id);
          if (!entityId) {
            const parentEntity = unwrap<GetEntityResp>(
              await callTool('web', 'web_get_entity_for_post', {
                post_id: post.parent_post_id,
              }),
            );
            if (parentEntity?.entity) entityId = parentEntity.entity.id;
          }
          if (entityId) {
            parentChainReused++;
          }
        }

        // Path 2: find matching entity via player + metadata (wider 60d window).
        if (!entityId) {
          const resolved = unwrap<ResolveResp>(
            await callTool('web', 'web_resolve_player', {
              name: post.athlete_name,
              sport: post.sport as SportKey,
            }),
          );
          if (!resolved?.resolved || !resolved.player) {
            skipped.push({
              post_id: post.id,
              athlete_name: post.athlete_name,
              sport: post.sport,
              reason: 'no_player_resolved',
            });
            continue;
          }
          if (resolved.player.confidence === 'ambiguous') {
            skipped.push({
              post_id: post.id,
              athlete_name: post.athlete_name,
              sport: post.sport,
              reason: `ambiguous(${resolved.player.match_count})`,
            });
            continue;
          }

          const metadata = extractInjuryMetadata(
            `${post.injury_type} ${post.clinical_summary}`,
          );

          const match = unwrap<MatchResp>(
            await callTool('web', 'web_find_matching_entity', {
              player_id: resolved.player.player_id,
              body_part: metadata.primary_body_part ?? undefined,
              laterality: metadata.laterality,
              injury_type: metadata.injury_type_hint ?? undefined,
              recency_days: 60,
            }),
          );

          if (match?.matched && match.entity_id) {
            entityId = match.entity_id;
            matchedExisting++;
          } else if (!dryRun) {
            const created = unwrap<CreateEntityResp>(
              await callTool('web', 'web_create_injury_entity', {
                player_id: resolved.player.player_id,
                body_part: metadata.primary_body_part ?? undefined,
                laterality: metadata.laterality,
                injury_type: metadata.injury_type_hint ?? undefined,
                canonical_post_id: post.id,
              }),
            );
            entityId = created?.entity?.id;
            if (entityId) createdNew++;
          } else {
            createdNew++; // would-create count in dry-run mode
          }
        }

        if (!entityId) continue; // dry-run path can leave this unset

        entityByPostId.set(post.id, entityId);

        if (!dryRun) {
          const updateKind = post.parent_post_id
            ? 'TRACKING'
            : post.content_type === 'DEEP_DIVE'
              ? 'DEEP_DIVE'
              : 'INITIAL';
          await callTool('web', 'web_append_injury_update', {
            entity_id: entityId,
            post_id: post.id,
            update_kind: updateKind,
            severity_at_time: post.injury_severity,
            team_timeline_weeks: post.team_timeline_weeks ?? undefined,
            otm_min_weeks: post.return_to_play_min_weeks ?? undefined,
            source_url: post.source_url ?? undefined,
            description: post.clinical_summary.slice(0, 500),
          });
        }
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] ${context} (${post.id}): ${message}`);
      }
    }

    console.log(
      `[backfill] processed ${totalSeen}/${page.total} (page offset=${offset})`,
    );

    if (!page.has_more || page.next_offset === null) break;
    offset = page.next_offset;
  }

  if (skipped.length > 0) {
    const csv = [
      'post_id,athlete_name,sport,reason',
      ...skipped.map((r) =>
        [r.post_id, JSON.stringify(r.athlete_name), r.sport, r.reason].join(','),
      ),
    ].join('\n');
    await writeFile('./backfill-skipped.csv', csv, 'utf-8');
  }

  console.log(
    `[backfill] done (dry_run=${dryRun}) — total=${totalSeen} already_linked=${alreadyLinked} parent_reused=${parentChainReused} matched=${matchedExisting} created=${createdNew} skipped=${skipped.length} errors=${errors}`,
  );
  if (skipped.length > 0) {
    console.log(`[backfill] skipped rows written to ./backfill-skipped.csv`);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[backfill] DRY RUN — no writes will happen');
  await initializeMCPClients();
  try {
    await backfill(dryRun);
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
