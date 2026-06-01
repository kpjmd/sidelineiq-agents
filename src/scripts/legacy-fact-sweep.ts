// One-shot legacy data cleanup: run the fact-validator over every existing
// injury_posts row to surface team-mislabel errors (the Luka-tagged-Lakers
// class) that landed in production before the validator was live.
//
// Behavior:
//   • Resolves the player via web_resolve_player.
//   • If the player matches unambiguously and event.team disagrees with the
//     player's current_team beyond the Jaro-Winkler threshold, applies an
//     auto-correction via web_apply_correction. The post's clinical_summary
//     gets a visible "Updated on <date>: team corrected from X to Y" suffix.
//     We also append an injury_updates row (kind=CORRECTION) and an audit
//     entry.
//   • If anything is ambiguous (unresolved player, ambiguous match, missing
//     current team in roster, validator-soft-fail), the post is flagged into
//     the existing md_review queue with reason 'legacy_sweep:<codes>'. No
//     auto-correction.
//
// "no deletions" — corrections are explicit, visible, and audited. Existing
// posts are never overwritten silently.
//
// Usage:
//   npx tsx src/scripts/legacy-fact-sweep.ts            # live run
//   npx tsx src/scripts/legacy-fact-sweep.ts --dry-run  # report only

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import {
  validateEvent,
  summarizeFailures,
  type ResolvedPlayerInfo,
} from '../agents/injury-intelligence/fact-validator.js';
import type { RawInjuryEvent, SportKey } from '../types.js';

interface InjuryPost {
  id: string;
  athlete_name: string;
  sport: string;
  team: string;
  injury_type: string;
  injury_severity: string;
  content_type: string;
  clinical_summary: string;
  source_url: string | null;
  created_at: string;
  corrected_at: string | null;
}

interface ListPostsResp {
  posts: InjuryPost[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
}

interface ResolveResp {
  resolved: boolean;
  player: ResolvedPlayerInfo | null;
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

const PAGE_SIZE = 50;

async function fetchPage(offset: number): Promise<ListPostsResp | null> {
  const res = await callTool('web', 'web_list_posts', { limit: PAGE_SIZE, offset });
  return unwrap<ListPostsResp>(res);
}

async function resolvePlayer(name: string, sport: SportKey): Promise<ResolvedPlayerInfo | null> {
  const res = await callTool('web', 'web_resolve_player', { name, sport });
  const parsed = unwrap<ResolveResp>(res);
  return parsed?.resolved ? parsed.player : null;
}

interface ReportRow {
  post_id: string;
  athlete_name: string;
  sport: string;
  team_reported: string;
  team_resolved: string | null;
  action: 'corrected' | 'flagged' | 'pass' | 'error';
  codes: string;
}

async function sweep(dryRun: boolean): Promise<void> {
  let offset = 0;
  let totalSeen = 0;
  let corrected = 0;
  let flagged = 0;
  let passed = 0;
  let alreadyCorrected = 0;
  let errors = 0;

  const report: ReportRow[] = [];

  while (true) {
    const page = await fetchPage(offset);
    if (!page) {
      console.error(`[sweep] failed to fetch page at offset=${offset}, stopping`);
      break;
    }
    const posts = page.posts;
    if (posts.length === 0) break;

    for (const post of posts) {
      totalSeen++;
      const context = `${post.athlete_name} (${post.sport})`;

      // Skip posts that already have a recent correction — idempotent rerun.
      if (post.corrected_at) {
        alreadyCorrected++;
        continue;
      }

      try {
        const resolved = await resolvePlayer(post.athlete_name, post.sport as SportKey);

        const event: RawInjuryEvent = {
          athlete_name: post.athlete_name,
          sport: post.sport as SportKey,
          team: post.team,
          injury_description: `${post.injury_type}. ${post.clinical_summary}`,
          source_url: post.source_url ?? '',
          reported_at: new Date(post.created_at),
          source_name: 'legacy-sweep',
        };

        const result = await validateEvent(event, resolved, {
          // For legacy posts use the post's own content_type. Date check is
          // irrelevant for already-published archive content.
          contentTypeHint: post.content_type as 'BREAKING' | 'TRACKING' | 'DEEP_DIVE' | 'CONFLICT_FLAG',
          now: new Date(post.created_at),
        });

        const hardCodes = summarizeFailures(result.hardFailures);
        const softCodes = summarizeFailures(result.softFailures);

        // Auto-correction path: unambiguous team correction proposal.
        const teamCorrection = result.corrections.find((c) => c.field === 'team');
        if (teamCorrection && resolved && resolved.confidence !== 'ambiguous') {
          if (!dryRun) {
            await callTool('web', 'web_apply_correction', {
              post_id: post.id,
              field: 'team',
              new_value: teamCorrection.to,
              note: `team corrected from "${teamCorrection.from}" to "${teamCorrection.to}" (legacy fact sweep, roster lookup player_id=${resolved.player_id})`,
            });

            // Mirror the correction onto the entity timeline + audit log.
            const entityRes = unwrap<{ entity: { id: string } | null }>(
              await callTool('web', 'web_get_entity_for_post', { post_id: post.id }),
            );
            if (entityRes?.entity) {
              await callTool('web', 'web_append_injury_update', {
                entity_id: entityRes.entity.id,
                post_id: post.id,
                update_kind: 'CORRECTION',
                description: `team: "${teamCorrection.from}" → "${teamCorrection.to}"`,
              });
            }
            await callTool('web', 'web_audit_append', {
              actor: 'automation',
              actor_id: 'legacy-fact-sweep',
              entity_type: 'injury_post',
              entity_id: post.id,
              action: 'apply_correction',
              before: { team: teamCorrection.from },
              after: { team: teamCorrection.to },
              payload: { reason: 'legacy_sweep_team_mismatch', player_id: resolved.player_id },
            });
          }
          corrected++;
          report.push({
            post_id: post.id,
            athlete_name: post.athlete_name,
            sport: post.sport,
            team_reported: teamCorrection.from,
            team_resolved: teamCorrection.to,
            action: 'corrected',
            codes: hardCodes,
          });
          continue;
        }

        // Anything else: if there are any failures (hard or soft) or the
        // identity was ambiguous/unresolved, flag for MD review. Skip if
        // already flagged (the underlying tool is idempotent on the post but
        // we don't want a flood of duplicate md_reviews rows from rerunning).
        const codes = [hardCodes, softCodes].filter(Boolean).join(',');
        if (codes) {
          if (!dryRun) {
            await callTool('web', 'web_flag_for_md_review', {
              post_id: post.id,
              reason: `legacy_sweep:${codes}`,
              confidence_score: 0.5,
              flagged_by: 'legacy-fact-sweep',
              // Retrospective flag on an already-published post — don't flip
              // status to PENDING_REVIEW, which would pull the post out of
              // any "PUBLISHED only" filter and is what required the
              // post-run SQL cleanup the first time around.
              preserve_status: true,
            });
          }
          flagged++;
          report.push({
            post_id: post.id,
            athlete_name: post.athlete_name,
            sport: post.sport,
            team_reported: post.team,
            team_resolved: resolved?.current_team_name ?? null,
            action: 'flagged',
            codes,
          });
          continue;
        }

        passed++;
        report.push({
          post_id: post.id,
          athlete_name: post.athlete_name,
          sport: post.sport,
          team_reported: post.team,
          team_resolved: resolved?.current_team_name ?? null,
          action: 'pass',
          codes: '',
        });
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sweep] ${context} (${post.id}): ${message}`);
        report.push({
          post_id: post.id,
          athlete_name: post.athlete_name,
          sport: post.sport,
          team_reported: post.team,
          team_resolved: null,
          action: 'error',
          codes: message.slice(0, 100),
        });
      }
    }

    console.log(`[sweep] processed ${totalSeen}/${page.total} (page offset=${offset})`);
    if (!page.has_more || page.next_offset === null) break;
    offset = page.next_offset;
  }

  const csv = [
    'post_id,athlete_name,sport,team_reported,team_resolved,action,codes',
    ...report.map((r) =>
      [
        r.post_id,
        JSON.stringify(r.athlete_name),
        r.sport,
        JSON.stringify(r.team_reported),
        JSON.stringify(r.team_resolved ?? ''),
        r.action,
        JSON.stringify(r.codes),
      ].join(','),
    ),
  ].join('\n');
  await writeFile('./legacy-sweep-report.csv', csv, 'utf-8');

  console.log(
    `[sweep] done (dry_run=${dryRun}) — total=${totalSeen} corrected=${corrected} flagged=${flagged} pass=${passed} already_corrected=${alreadyCorrected} errors=${errors}`,
  );
  console.log('[sweep] full report written to ./legacy-sweep-report.csv');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('[sweep] DRY RUN — no corrections or md_review flags will be written');
  await initializeMCPClients();
  try {
    await sweep(dryRun);
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[sweep] fatal:', err);
  process.exit(1);
});
