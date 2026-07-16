// One-off correction script for a laterality (left/right side) misreport that
// propagated across an entire injury thread. Root cause (see agent.ts,
// fact-validator.ts, deduplicator.ts) was architectural: the extracted
// laterality was only ever used to build a DB entity-matching key — never
// checked against, or fed into, the actual published post text — so a wrong
// side, once introduced, silently propagated to every TRACKING/CONFLICT_FLAG
// follow-up with nothing to catch the drift. That gap is now closed (thread
// laterality is passed to Sonnet and cross-checked on every new report — see
// poller.ts/agent.ts). This script corrects the posts that were published
// before that fix landed.
//
// Default target: Jalen Brunson (NBA) wrist/forearm surgery, RIGHT → LEFT —
// confirmed against multiple sources per the reporting user. Overridable via
// flags so the same script can be reused for a similar future case.
//
// Behavior:
//   • Resolves the athlete, lists their posts, and finds every post whose
//     injury_type/headline/clinical_summary mentions the wrong side in the
//     same field as the target body part.
//   • For each matching field, proposes a whole-word side replacement and
//     applies it via web_apply_correction (same tool legacy-fact-sweep.ts
//     already uses for field:'team' — this is the first call in this repo
//     with a different field, so ALWAYS run --dry-run first and inspect the
//     report before a live run).
//   • Appends a CORRECTION injury_updates row and an audit_log entry per post.
//   • Flags each corrected post for MD review with preserve_status:true (does
//     not pull it out of "PUBLISHED only" views — same pattern as the legacy
//     sweep).
//   • Entity-level laterality correction (the injury_entities row itself) is
//     reported but NOT attempted unless --fix-entity is passed — there's no
//     precedent in this codebase for correcting an entity field via MCP, so
//     this is an explicit opt-in until verified against the live server.
//
// Usage:
//   npx tsx src/scripts/fix-injury-laterality.ts --dry-run
//   npx tsx src/scripts/fix-injury-laterality.ts                 # live: posts only
//   npx tsx src/scripts/fix-injury-laterality.ts --fix-entity    # also attempt entity correction
//
// Optional overrides:
//   --athlete="Jalen Brunson" --sport=NBA --body-part=wrist --from=RIGHT --to=LEFT

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import type { SportKey } from '../types.js';

interface InjuryPost {
  id: string;
  athlete_name: string;
  sport: string;
  team: string;
  injury_type: string;
  headline?: string;
  clinical_summary: string;
  content_type: string;
  source_url: string | null;
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
  player: { player_id: string; full_name: string } | null;
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

// The server-side athlete_name/sport filter is the fast path but has never
// been exercised by any script in this repo before (only unfiltered
// pagination, per legacy-fact-sweep.ts) — if it returns nothing, fall back to
// a full paginated scan (the proven-working pattern) and match client-side on
// the athlete's last name. This tells us definitively whether the filter is
// the problem or the data genuinely isn't there.
async function fetchPostsForAthlete(athleteName: string, sport: SportKey): Promise<InjuryPost[]> {
  const filtered = unwrap<ListPostsResp>(
    await callTool('web', 'web_list_posts', { athlete_name: athleteName, sport, limit: 200 }),
  );
  if (filtered?.posts && filtered.posts.length > 0) {
    return filtered.posts;
  }

  console.log('[fix-laterality] server-side athlete_name/sport filter returned 0 — falling back to a full scan');
  const lastName = athleteName.trim().split(/\s+/).slice(-1)[0]?.toLowerCase() ?? athleteName.toLowerCase();
  const matched: InjuryPost[] = [];
  let offset = 0;
  let scanned = 0;
  while (true) {
    const page = unwrap<ListPostsResp>(await callTool('web', 'web_list_posts', { limit: PAGE_SIZE, offset }));
    if (!page || page.posts.length === 0) break;
    scanned += page.posts.length;
    for (const p of page.posts) {
      if (p.athlete_name?.toLowerCase().includes(lastName)) {
        matched.push(p);
      }
    }
    if (!page.has_more || page.next_offset === null) break;
    offset = page.next_offset;
  }
  console.log(
    `[fix-laterality] full scan complete — scanned ${scanned} total post(s), matched ${matched.length} by last name "${lastName}"`,
  );
  if (matched.length > 0) {
    for (const p of matched) {
      console.log(`[fix-laterality]   match: id=${p.id} athlete_name="${p.athlete_name}" sport=${p.sport} content_type=${p.content_type} created_at=${p.created_at}`);
    }
  }
  return matched;
}

function parseArgs(argv: string[]) {
  const flag = (name: string, fallback: string) => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : fallback;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    fixEntity: argv.includes('--fix-entity'),
    athlete: flag('athlete', 'Jalen Brunson'),
    sport: flag('sport', 'NBA') as SportKey,
    bodyPart: flag('body-part', 'wrist').toLowerCase(),
    from: flag('from', 'RIGHT').toUpperCase() as 'LEFT' | 'RIGHT',
    to: flag('to', 'LEFT').toUpperCase() as 'LEFT' | 'RIGHT',
  };
}

// Whole-word, case-preserving replacement of the wrong side with the correct
// one, but ONLY for occurrences of `from` that sit near the target body part
// — checked per-occurrence, not once for the whole field. A field-level check
// (any "right" near "wrist" anywhere → replace every "right" in the field) is
// wrong: it also rewrites unrelated occurrences like "make the right call"
// (an idiom, not a laterality claim) into "make the left call" — a real bug
// caught reviewing a --dry-run report against a DEEP_DIVE post, which used
// "right" once for the injury side and once idiomatically. Body-part-adjacent
// occurrences (e.g. "his right wrist") are still corrected; distant ones are not.
function correctSideOccurrences(
  text: string,
  bodyPart: string,
  from: string,
  to: string,
): { changed: boolean; text: string } {
  const WINDOW = 4;
  // Tokenize on runs of letters, NOT whitespace — a whitespace-only split
  // treats "wrist/forearm" as one token that cleans to "wristforearm",
  // which never equals the body part "wrist", so a slash-joined compound
  // like "right wrist/forearm surgery" silently fails to match. Splitting
  // on letter-runs correctly yields separate "wrist" and "forearm" tokens.
  const tokenRe = /[A-Za-z]+/g;
  const tokens: Array<{ raw: string; start: number; end: number; clean: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text))) {
    tokens.push({
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      clean: m[0].toLowerCase(),
    });
  }

  const fromLower = from.toLowerCase();
  const replaceIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].clean !== fromLower) continue;
    const start = Math.max(0, i - WINDOW);
    const end = Math.min(tokens.length, i + WINDOW + 1);
    if (tokens.slice(start, end).some((t) => t.clean === bodyPart)) {
      replaceIndices.push(i);
    }
  }

  if (replaceIndices.length === 0) return { changed: false, text };

  const wordRe = new RegExp(`\\b${from}\\b`, 'i');
  let result = '';
  let cursor = 0;
  for (const idx of replaceIndices) {
    const tok = tokens[idx];
    result += text.slice(cursor, tok.start);
    result += tok.raw.replace(wordRe, (match) => {
      if (match === match.toUpperCase()) return to.toUpperCase();
      if (match[0] === match[0].toUpperCase()) return to[0].toUpperCase() + to.slice(1).toLowerCase();
      return to.toLowerCase();
    });
    cursor = tok.end;
  }
  result += text.slice(cursor);
  return { changed: true, text: result };
}

interface ReportRow {
  post_id: string;
  field: string;
  before: string;
  after: string;
  action: 'corrected' | 'would_correct' | 'skipped_no_match' | 'error';
  note: string;
}

const FIELDS: Array<keyof Pick<InjuryPost, 'injury_type' | 'headline' | 'clinical_summary'>> = [
  'injury_type',
  'headline',
  'clinical_summary',
];

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `[fix-laterality] athlete="${opts.athlete}" sport=${opts.sport} body_part=${opts.bodyPart} ${opts.from}→${opts.to} dry_run=${opts.dryRun} fix_entity=${opts.fixEntity}`,
  );

  const resolveRes = unwrap<ResolveResp>(
    await callTool('web', 'web_resolve_player', { name: opts.athlete, sport: opts.sport }),
  );
  if (!resolveRes?.resolved || !resolveRes.player) {
    console.error(`[fix-laterality] could not resolve player "${opts.athlete}" (${opts.sport}) — aborting`);
    return;
  }
  console.log(`[fix-laterality] resolved player_id=${resolveRes.player.player_id}`);

  const posts = await fetchPostsForAthlete(opts.athlete, opts.sport);
  console.log(`[fix-laterality] found ${posts.length} post(s) for ${opts.athlete}`);

  const report: ReportRow[] = [];
  let correctedPosts = 0;

  for (const post of posts) {
    let postTouched = false;
    for (const field of FIELDS) {
      const value = post[field];
      if (!value) continue;
      const { changed, text: newValue } = correctSideOccurrences(value, opts.bodyPart, opts.from, opts.to);
      if (!changed || newValue === value) continue;

      if (opts.dryRun) {
        report.push({
          post_id: post.id,
          field,
          before: value,
          after: newValue,
          action: 'would_correct',
          note: 'dry run — no changes applied',
        });
        console.log(`[fix-laterality] WOULD CORRECT post=${post.id} field=${field}`);
        continue;
      }

      try {
        await callTool('web', 'web_apply_correction', {
          post_id: post.id,
          field,
          new_value: newValue,
          note: `${opts.bodyPart} side corrected from ${opts.from} to ${opts.to} (fix-injury-laterality script, player_id=${resolveRes.player.player_id})`,
        });
        report.push({ post_id: post.id, field, before: value, after: newValue, action: 'corrected', note: '' });
        console.log(`[fix-laterality] CORRECTED post=${post.id} field=${field}`);
        postTouched = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.push({ post_id: post.id, field, before: value, after: newValue, action: 'error', note: message });
        console.error(`[fix-laterality] FAILED post=${post.id} field=${field}: ${message}`);
      }
    }

    if (postTouched) {
      correctedPosts++;
      try {
        const entityRes = unwrap<{ entity: { id: string } | null }>(
          await callTool('web', 'web_get_entity_for_post', { post_id: post.id }),
        );
        if (entityRes?.entity) {
          await callTool('web', 'web_append_injury_update', {
            entity_id: entityRes.entity.id,
            post_id: post.id,
            update_kind: 'CORRECTION',
            description: `${opts.bodyPart} side: ${opts.from} → ${opts.to} (laterality correction)`,
          });
        }
        await callTool('web', 'web_audit_append', {
          actor: 'automation',
          actor_id: 'fix-injury-laterality',
          entity_type: 'injury_post',
          entity_id: post.id,
          action: 'apply_correction',
          before: { [opts.bodyPart + '_side']: opts.from },
          after: { [opts.bodyPart + '_side']: opts.to },
          payload: { reason: 'laterality_correction', player_id: resolveRes.player.player_id },
        });
        await callTool('web', 'web_flag_for_md_review', {
          post_id: post.id,
          reason: `laterality_correction:${opts.from}_to_${opts.to}`,
          confidence_score: 0.5,
          flagged_by: 'fix-injury-laterality',
          preserve_status: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[fix-laterality] post-correction bookkeeping failed for post=${post.id}: ${message}`);
      }
    }
  }

  // Entity-level laterality is separate from the post text and needs its own
  // correction so future entity matching / thread-context anchoring (see
  // agent.ts InjuryThreadContext) carries the right value forward. There's no
  // established call shape for this in the codebase (web_apply_correction has
  // only ever been called with a post_id target) — report it either way, and
  // only attempt a live call behind the explicit --fix-entity flag.
  //
  // DEEP_DIVE posts are topic-level (educational content about an injury
  // type across multiple athletes) and are not linked to a per-athlete
  // injury_entities thread the way BREAKING/TRACKING/CONFLICT_FLAG posts are
  // — web_get_entity_for_post correctly returns nothing for them. Try every
  // corrected post, not just the first in list order, until one resolves.
  const correctedPostIds = new Set(
    report.filter((r) => r.action !== 'skipped_no_match').map((r) => r.post_id),
  );
  let entityRes: { entity: { id: string; laterality?: string } | null } | null = null;
  for (const post of posts) {
    if (!correctedPostIds.has(post.id)) continue;
    const res = unwrap<{ entity: { id: string; laterality?: string } | null }>(
      await callTool('web', 'web_get_entity_for_post', { post_id: post.id }),
    );
    if (res?.entity) {
      entityRes = res;
      break;
    }
  }
  if (entityRes?.entity) {
    console.log(
      `[fix-laterality] entity_id=${entityRes.entity.id} stored laterality=${entityRes.entity.laterality ?? 'unknown'} — ` +
        (opts.fixEntity && !opts.dryRun
          ? 'attempting live correction'
          : 'NOT corrected automatically (pass --fix-entity on a live run, or correct manually)'),
    );
    if (opts.fixEntity && !opts.dryRun) {
      try {
        await callTool('web', 'web_apply_correction', {
          entity_id: entityRes.entity.id,
          field: 'laterality',
          new_value: opts.to,
          note: `entity laterality corrected from ${opts.from} to ${opts.to} (fix-injury-laterality script)`,
        });
        console.log(`[fix-laterality] entity ${entityRes.entity.id} laterality correction call sent — verify result manually`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[fix-laterality] entity correction call failed for entity=${entityRes.entity.id}: ${message} — correct manually`,
        );
      }
    }
  } else if (correctedPostIds.size > 0) {
    console.warn(
      '[fix-laterality] could not resolve entity via web_get_entity_for_post for any corrected post — checking whether an entity exists for this player at all',
    );
    const matchRes = unwrap<{
      matched: boolean;
      entity_id: string | null;
      laterality: string | null;
    }>(
      await callTool('web', 'web_find_matching_entity', {
        player_id: resolveRes.player.player_id,
        body_part: opts.bodyPart,
        recency_days: 3650,
      }),
    );
    if (matchRes?.matched && matchRes.entity_id) {
      console.warn(
        `[fix-laterality] an entity DOES exist (entity_id=${matchRes.entity_id}, laterality=${matchRes.laterality ?? 'unknown'}) but is not linked to any of the corrected posts — this looks like a post↔entity linkage gap, not a missing entity. Correct entity_id=${matchRes.entity_id} manually, or investigate why web_get_entity_for_post isn't resolving it for these post_ids.`,
      );
    } else {
      console.warn(
        '[fix-laterality] no entity found for this player at all — entity creation likely never ran for this thread (see maintainEntity() in poller.ts, which fails silently on error). ' +
          'Try `npx tsx src/scripts/backfill-entities.ts --dry-run` first, which is built exactly for this case (creates/links a missing entity for legacy posts), then re-run this script with --fix-entity.',
      );
    }
  }

  const csv = [
    'post_id,field,before,after,action,note',
    ...report.map((r) =>
      [r.post_id, r.field, JSON.stringify(r.before), JSON.stringify(r.after), r.action, JSON.stringify(r.note)].join(','),
    ),
  ].join('\n');
  await writeFile('./laterality-fix-report.csv', csv, 'utf-8');

  console.log(
    `[fix-laterality] done (dry_run=${opts.dryRun}) — posts_seen=${posts.length} posts_corrected=${correctedPosts} field_changes=${report.length}`,
  );
  console.log('[fix-laterality] full report written to ./laterality-fix-report.csv');
}

async function main(): Promise<void> {
  await initializeMCPClients();
  try {
    await run();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[fix-laterality] fatal:', err);
  process.exit(1);
});
