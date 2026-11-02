/**
 * cadence pre-check dry run — old (always call Sonnet) vs new (skip a call the
 * cadence throttle would discard). Read-only: no model call, no write.
 *
 *   export WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp
 *   railway logs --service sidelineiq-agents --lines 5000 --json > /tmp/agents.jsonl
 *   npx tsx src/scripts/cadence-precheck-dryrun.ts --log /tmp/agents.jsonl [--since <ISO>]
 *
 * A: every follow-up row in injury_posts since --since (default 30 days). Each
 *    row is a post the model produced that the throttle let through, so it is
 *    exactly the population the pre-check could wrongly silence. Replayed against
 *    the posts and thread rows that existed when it was created.
 * B: every `follow-up on entity` line in the log, with what really happened to it.
 * C: the live ESPN feed: how often team_timeline, not the text, is what stops a skip.
 *
 * The numbers that must be zero:
 *   1  follow-up rows the pre-check would have skipped (A)
 *   2  log events that reached publish or review and would have been skipped (B)
 *
 * One limit, and it is why the poller ships in shadow: raw.team_timeline is not
 * persisted, so A and B replay with it unknown. A skip in A may be a row the live
 * gate would have refused. `precheck_miss=` in the poll summary is the live proof.
 * Burns (2026-09-22, "Team Holds 6-Week Timeline" from silent text) is that case:
 * pass --since 2026-08-01 to see him. He is either a longComment number or an
 * invention; his row cannot say which.
 *
 * Exits 1 if a must-be-zero number is not zero, or a read fails.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { initializeMCPClients, disconnectAll, isServerAvailable, callTool } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { isMCPError, extractMCPErrorMessage, type ExistingPost } from '../utils/publishing-pipeline.js';
import { decidePrecheck, mentionsTimeline, type PrecheckInput } from '../monitoring/cadence-precheck.js';
import { parseTeamTimeline } from '../agents/injury-intelligence/agent.js';
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';

/** Estimate from the prompt-caching review, input plus output. Not a measurement. */
const SONNET_CALL_USD = 0.065;
const SAME_RUN_MS = 10 * 60 * 1000;

interface PostRow extends ExistingPost {
  id: string;
  athlete_name: string;
  sport: string;
  created_at: string;
  source_url?: string;
}
interface UpdateRow {
  created_at: string;
  description: string | null;
  post_id: string | null;
  source_url: string | null;
  team_timeline_weeks: number | null;
}
interface ThreadPayload {
  entity: { id: string; canonical_post_id: string | null };
  updates: UpdateRow[];
}

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

function parseTool<T>(res: unknown): T {
  if (isMCPError(res)) throw new Error(extractMCPErrorMessage(res));
  const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error('empty MCP response');
  return JSON.parse(text) as T;
}

const failures: string[] = [];
function mustBeZero(label: string, examples: string[]): void {
  console.log(`  ${examples.length === 0 ? 'OK  ' : 'FAIL'}  ${label}: ${examples.length}`);
  for (const e of examples.slice(0, 12)) console.log(`          ${e}`);
  if (examples.length > 0) failures.push(`${label} = ${examples.length}`);
}

const threads = new Map<string, ThreadPayload>();
async function loadThread(entityId: string): Promise<ThreadPayload> {
  let t = threads.get(entityId);
  if (!t) {
    t = parseTool<ThreadPayload>(await callTool('web', 'web_thread_get', { entity_id: entityId }));
    threads.set(entityId, t);
  }
  return t;
}

/** The input as it stood at `at`, from what the thread stored. team_timeline is unknown. */
function replayInput(
  name: string,
  sport: string,
  parent: string,
  text: string,
  thread: ThreadPayload,
  at: number,
): PrecheckInput {
  return {
    athlete_name: name,
    sport: sport as PrecheckInput['sport'],
    source_texts: [text],
    parent_post_id: parent,
    thread_reported_weeks: thread.updates
      .filter((u) => Date.parse(u.created_at) < at - SAME_RUN_MS)
      .map((u) => u.team_timeline_weeks),
  };
}

/**
 * Status is today's, not the status at the time. A post pending then and approved
 * since reads as already PUBLISHED, which only makes the replay skip MORE, so a
 * zero here is still a zero.
 */
const postsAsOf = (posts: PostRow[], at: number): PostRow[] =>
  posts.filter((p) => Date.parse(p.created_at) < at);

async function sectionA(posts: PostRow[], since: number): Promise<void> {
  console.log(`\nA. Follow-up rows since ${new Date(since).toISOString().slice(0, 10)}`);
  const entityByCanonical = new Map<string, string>();
  for (let offset = 0; ; ) {
    const page = parseTool<{
      threads: Array<{ id: string; canonical_post_id: string | null }>;
      has_more: boolean;
      next_offset: number | null;
    }>(await callTool('web', 'web_list_threads', { limit: 200, offset }));
    for (const t of page.threads) if (t.canonical_post_id) entityByCanonical.set(t.canonical_post_id, t.id);
    if (!page.has_more || page.next_offset === null) break;
    offset = page.next_offset;
  }

  const rows = posts.filter((p) => p.parent_post_id && Date.parse(p.created_at) >= since);
  const reasons: Record<string, number> = {};
  const skipped: string[] = [];
  const noText: string[] = [];
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    const parent = row.parent_post_id!;
    const entityId = entityByCanonical.get(parent);
    const peers = postsAsOf(
      posts.filter((p) => p.athlete_name === row.athlete_name && p.sport === row.sport),
      at,
    );
    // No thread row means no text to read, so only the post history can speak,
    // and a would-skip here fails: the replay cannot clear it.
    const thread = entityId ? await loadThread(entityId) : null;
    // Rejecting a post nulls its update's post_id, so fall back to the source and time.
    const update =
      thread?.updates.find((u) => u.post_id === row.id) ??
      thread?.updates.find(
        (u) => u.source_url === row.source_url && Math.abs(Date.parse(u.created_at) - at) < SAME_RUN_MS,
      );
    if (!thread || !update?.description) {
      const d = decidePrecheck(
        {
          athlete_name: row.athlete_name,
          sport: row.sport as PrecheckInput['sport'],
          source_texts: [],
          parent_post_id: parent,
          thread_reported_weeks: [],
        },
        peers,
        at,
      );
      if (d.skip) noText.push(`${row.created_at.slice(0, 16)} ${row.athlete_name} (${row.status})`);
      reasons[d.skip ? 'no_text_inside_cooldown' : d.reason] =
        (reasons[d.skip ? 'no_text_inside_cooldown' : d.reason] ?? 0) + 1;
      continue;
    }
    const d = decidePrecheck(
      replayInput(row.athlete_name, row.sport, parent, update.description, thread, at),
      peers,
      at,
    );
    const key = d.skip ? 'skip' : d.reason;
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (d.skip) {
      skipped.push(
        `${row.created_at.slice(0, 16)} ${row.athlete_name} ${row.content_type} ${row.status} ` +
          `weeks=${row.team_timeline_weeks ?? 'none'}: ${update.description.slice(0, 110)}`,
      );
    }
  }
  console.log(`  ---   rows: ${rows.length}  decisions: ${JSON.stringify(reasons)}`);
  mustBeZero('follow-up rows the pre-check would have skipped', [...skipped, ...noText]);
}

interface LogLine {
  message: string;
  timestamp: string;
}

async function sectionB(posts: PostRow[], logPath: string): Promise<void> {
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as LogLine)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const hours = (Date.parse(lines.at(-1)!.timestamp) - Date.parse(lines[0].timestamp)) / 3_600_000;
  console.log(`\nB. Log replay over ${hours.toFixed(1)}h`);

  let cooldown = 0;
  let caught = 0;
  const reasons: Record<string, number> = {};
  const lost: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].message.match(/follow-up on entity ([0-9a-f-]+): (.*?) \((\w+)\//);
    if (!m) continue;
    const [, entityId, name, sport] = m;
    const at = Date.parse(lines[i].timestamp);

    let outcome: 'cooldown' | 'output' | 'other' = 'other';
    for (const later of lines.slice(i + 1, i + 60)) {
      if (!later.message.includes(name)) continue;
      if (later.message.includes('follow_up_cooldown')) outcome = 'cooldown';
      else if (later.message.includes('Routing to MD review') || later.message.includes('[Pipeline] Published')) outcome = 'output';
      else continue;
      break;
    }
    if (outcome === 'cooldown') cooldown++;

    const thread = await loadThread(entityId);
    const update = thread.updates.find((u) => Math.abs(Date.parse(u.created_at) - at) < 30_000);
    const parent = thread.entity.canonical_post_id;
    if (!parent || !update?.description) {
      reasons.unreadable = (reasons.unreadable ?? 0) + 1;
      continue;
    }
    const d = decidePrecheck(
      replayInput(name, sport, parent, update.description, thread, at),
      postsAsOf(posts.filter((p) => p.athlete_name === name && p.sport === sport), at),
      at,
    );
    const key = d.skip ? 'skip' : d.reason;
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (d.skip && outcome === 'cooldown') caught++;
    if (d.skip && outcome === 'output') lost.push(`${lines[i].timestamp.slice(0, 16)} ${name}`);
  }

  const perMonth = (n: number) => (n / hours) * 24 * 30;
  console.log(`  ---   decisions: ${JSON.stringify(reasons)}`);
  console.log(`  ---   Sonnet calls discarded by the cadence: ${cooldown} (~${perMonth(cooldown).toFixed(0)}/month, ~$${(perMonth(cooldown) * SONNET_CALL_USD).toFixed(2)}/month)`);
  console.log(`  ---   of those, the pre-check skips: ${caught} (~${perMonth(caught).toFixed(0)}/month, ~$${(perMonth(caught) * SONNET_CALL_USD).toFixed(2)}/month)`);
  mustBeZero('log events that reached publish or review and would have been skipped', lost);
}

async function sectionC(): Promise<void> {
  console.log('\nC. Live ESPN feed (NFL, NBA): what the source gates see');
  for (const source of [new ESPNNFLSource(), new ESPNNBASource()]) {
    const events = await source.fetchLatestEvents();
    const silent = events.filter((e) => !mentionsTimeline(e.injury_description));
    const numeric = silent.filter((e) => e.team_timeline && parseTeamTimeline(e.team_timeline) !== null);
    console.log(
      `  ---   ${source.name}: rows ${events.length}, silent text ${silent.length}, ` +
        `of which team_timeline still carries a number ${numeric.length}`,
    );
    for (const e of numeric.slice(0, 3)) console.log(`          ${e.athlete_name}: "${e.team_timeline}"`);
  }
}

async function main(): Promise<void> {
  await initializeMCPClients();
  if (!isServerAvailable('web')) throw new Error('the web MCP server is unavailable');

  const since = Date.parse(flag('--since') ?? new Date(Date.now() - 30 * 86_400_000).toISOString());
  const { posts, truncated } = await listAllPosts<PostRow>({}, { maxPages: 60 });
  // A partial history replays as "no prior post" and hides skips.
  if (truncated) throw new Error('web_list_posts scan was truncated');

  await sectionA(posts, since);
  const log = flag('--log');
  if (log) await sectionB(posts, log);
  else console.log('\nB. skipped: pass --log <railway jsonl>');
  await sectionC();

  await disconnectAll();
  console.log(failures.length === 0 ? '\nPASS' : `\nFAIL: ${failures.join('; ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[cadence-precheck-dryrun] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
