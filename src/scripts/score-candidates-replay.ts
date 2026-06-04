// One-shot Phase 1 verification harness for the promotion_score model.
//
// Replays recent CONFLICT_FLAG posts through computePromotionScore and prints a
// ranked table so the MD can gut-check the ordering before we wire the score
// into any UI or the poller. This is the Phase 1 verify gate: "top-5
// promotion_score matches the MD's gut pick."
//
// We FAVOR recent posts where the conflict threshold was genuinely met — i.e.
// the team timeline and the OTM estimate actually diverge (gap >=
// CONFLICT_GAP_MIN_WEEKS). Many legacy conflict-flag posts predate the
// significance gate and suffered from the OTM agent not knowing the exact
// injury/surgery date, so their "conflict" is noise; those are de-prioritized
// (still listed, but below the replay set and clearly marked).
//
// Inputs to the score, per post:
//   • composite      — PROXY: athlete prominence (TIER_TO_PROMINENCE). The
//                      original Haiku subscores (specificity / recency) were
//                      never persisted on injury_posts, so we reconstruct the
//                      deterministic part of the composite. Documented, not
//                      hidden — all four component contributions are printed.
//   • conflict_flag  — conflict_reason present on the row.
//   • corroboration  — resolveSourceTier(source_url) (same logic as the validator).
//   • staleness_days — days since the entity's last_updated_at (falls back to
//                      the post's created_at when no entity is linked).
//
// This script READS only (web_list_posts / web_get_entity_for_post / source
// tiers). It does not write desk_candidates and does not require migration 011.
//
// Usage:
//   npx tsx src/scripts/score-candidates-replay.ts             # default: 15 recent threshold-met
//   npx tsx src/scripts/score-candidates-replay.ts --limit 10
//   npx tsx src/scripts/score-candidates-replay.ts --all       # ignore the threshold filter

import 'dotenv/config';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
  prominenceForTier,
  computePromotionScore,
  PROMOTION_PROPOSE_THRESHOLD,
} from '../agents/injury-intelligence/significance.js';
import { resolveSourceTier } from '../agents/injury-intelligence/fact-validator.js';
import type { SportKey, CorroborationTier, PromotionScore } from '../types.js';

// A conflict is "real" when the team timeline exceeds the OTM ceiling by at
// least this many weeks. Mirrors the delta-rule spirit used in dedup.
const CONFLICT_GAP_MIN_WEEKS = 2;
const DEFAULT_LIMIT = 15;
const PAGE_SIZE = 50;

interface InjuryPost {
  id: string;
  athlete_name: string;
  sport: string;
  team: string;
  injury_type: string;
  injury_severity: string;
  content_type: string;
  headline: string;
  slug: string | null;
  conflict_reason: string | null;
  team_timeline_weeks: number | null;
  return_to_play_min_weeks: number | null;
  return_to_play_max_weeks: number | null;
  source_url: string | null;
  created_at: string;
}

interface ListPostsResp {
  posts: InjuryPost[];
  total: number;
  has_more: boolean;
  next_offset: number | null;
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

async function fetchAllConflictFlags(): Promise<InjuryPost[]> {
  const all: InjuryPost[] = [];
  let offset = 0;
  while (true) {
    const res = await callTool('web', 'web_list_posts', {
      content_type: 'CONFLICT_FLAG',
      limit: PAGE_SIZE,
      offset,
    });
    const page = unwrap<ListPostsResp>(res);
    if (!page) {
      console.error(`[replay] failed to fetch page at offset=${offset}, stopping`);
      break;
    }
    all.push(...page.posts);
    if (!page.has_more || page.posts.length === 0) break;
    offset = page.next_offset ?? offset + PAGE_SIZE;
  }
  return all;
}

function daysBetween(fromIso: string, now: Date): number {
  const then = new Date(fromIso).getTime();
  return Math.max(0, Math.round((now.getTime() - then) / 86_400_000));
}

// Conflict magnitude = how much LONGER the orthopedic (OTM) estimate runs than
// the team's stated timeline. A CONFLICT_FLAG is raised when the team downplays
// ("day-to-day", short return) versus what the injury biology implies, so the
// signal is positive when OTM exceeds team. (NOTE: promotion_score itself only
// uses conflict_flag *presence*, not this magnitude — we compute it here purely
// to pick the replay set and to show the MD what varies. See the report.)
function conflictGapWeeks(post: InjuryPost): number | null {
  if (post.team_timeline_weeks == null || post.return_to_play_max_weeks == null) return null;
  return post.return_to_play_max_weeks - post.team_timeline_weeks;
}

interface ScoredPost {
  post: InjuryPost;
  thresholdMet: boolean;
  gapWeeks: number | null;
  tier: number;
  corroboration: CorroborationTier;
  stalenessDays: number;
  result: PromotionScore;
}

async function scorePost(post: InjuryPost, now: Date): Promise<ScoredPost> {
  const { tier } = lookupAthleteTier(post.athlete_name, post.sport as SportKey);
  const composite = prominenceForTier(tier);          // proxy — see header note
  const corroboration = await resolveSourceTier(post.source_url);

  // Staleness from the POST's created_at, NOT the entity's last_updated_at:
  // the Phase 0 entity backfill (2026-05-31) bulk-reset every entity timestamp,
  // so entity staleness is uniformly ~0 for legacy rows. created_at reflects
  // the real recency of the coverage. (Live auto-scoring will use the entity.)
  const stalenessDays = daysBetween(post.created_at, now);

  const gapWeeks = conflictGapWeeks(post);

  const result = computePromotionScore({
    composite,
    conflict_flag_present: post.conflict_reason != null,
    conflict_gap_weeks: gapWeeks,
    entity_staleness_days: stalenessDays,
    corroboration_tier: corroboration,
  });

  const thresholdMet = gapWeeks != null && gapWeeks >= CONFLICT_GAP_MIN_WEEKS;

  return { post, thresholdMet, gapWeeks, tier, corroboration, stalenessDays, result };
}

function fmtGap(s: ScoredPost): string {
  if (s.gapWeeks == null) return 'gap=?';
  const t = s.post.team_timeline_weeks;
  const o = s.post.return_to_play_max_weeks;
  return `team ${t}w vs otm ${o}w (Δ${s.gapWeeks >= 0 ? '+' : ''}${s.gapWeeks})`;
}

function printTable(title: string, rows: ScoredPost[]): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  rows.forEach((s, i) => {
    const flag = s.result.proposed ? '✓PROPOSE' : ' below  ';
    const name = s.post.athlete_name.padEnd(22).slice(0, 22);
    const sport = s.post.sport.padEnd(4).slice(0, 4);
    console.log(
      `${String(i + 1).padStart(2)}. score=${String(s.result.score).padStart(3)} [${flag}]  ${name} ${sport}  ` +
        `tier${s.tier}  ${s.corroboration.padEnd(7)}  ${fmtGap(s).padEnd(28)}  stale=${s.stalenessDays}d`,
    );
    console.log(`      reasons: ${s.result.reasons.join('  ·  ')}`);
    console.log(`      "${s.post.headline}"  (${s.post.created_at.slice(0, 10)})`);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const includeAll = args.includes('--all');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) || DEFAULT_LIMIT : DEFAULT_LIMIT;
  const now = new Date();

  await initializeMCPClients();
  await loadSignificanceData();

  const posts = await fetchAllConflictFlags();
  console.log(`[replay] fetched ${posts.length} CONFLICT_FLAG posts`);
  if (posts.length === 0) {
    console.log('Nothing to replay.');
    return;
  }

  // Most recent first.
  posts.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const scored: ScoredPost[] = [];
  for (const post of posts) {
    scored.push(await scorePost(post, now));
  }

  // Replay set: recent + conflict-threshold-met (unless --all). Backfill with
  // recent non-threshold conflict posts if too few genuine ones exist, so the
  // gut-check table is never empty — clearly separated below.
  const thresholdMet = scored.filter((s) => s.thresholdMet);
  const replaySource = includeAll ? scored : thresholdMet;
  const replaySet = replaySource.slice(0, limit);

  // Within the replay set, rank by promotion_score (this is the gut-check).
  const ranked = [...replaySet].sort((a, b) => b.result.score - a.result.score);
  printTable(
    `REPLAY SET — ranked by promotion_score  (threshold = ${PROMOTION_PROPOSE_THRESHOLD}, gap >= ${CONFLICT_GAP_MIN_WEEKS}w${includeAll ? ', --all' : ''})`,
    ranked,
  );

  if (!includeAll) {
    const rest = scored.filter((s) => !s.thresholdMet).slice(0, 10);
    printTable(
      'CONTEXT — recent conflict-flag posts that did NOT meet the gap threshold (likely pre-gate / missing-date noise)',
      [...rest].sort((a, b) => b.result.score - a.result.score),
    );
  }

  const proposeCount = ranked.filter((s) => s.result.proposed).length;
  console.log(
    `\n[replay] replay set: ${ranked.length} posts · ${proposeCount} would propose (score >= ${PROMOTION_PROPOSE_THRESHOLD}) · ` +
      `${thresholdMet.length}/${scored.length} total met the conflict gap`,
  );
  console.log('[replay] Gut-check the top-5 ordering above against your pick. No writes were made.');
}

main()
  .catch((err) => {
    console.error('[replay] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll();
  });
