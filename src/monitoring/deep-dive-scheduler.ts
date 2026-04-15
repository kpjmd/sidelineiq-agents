import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { processDeepDive } from '../agents/injury-intelligence/agent.js';
import { publishInjuryPost } from '../utils/publishing-pipeline.js';
import type { SportKey } from '../types.js';

// Default: 3 days — keeps DEEP_DIVE premium (~8/month, ~100/year)
const DEFAULT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_COUNT = 3;
// Lookback window for finding trending injury types (matches interval)
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
// Cooldown: don't repeat a DEEP_DIVE for the same injury type within 7 days
const INJURY_TYPE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// Delay first run after boot so MCP clients are settled
const STARTUP_DELAY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function getIntervalMs(): number {
  const raw = process.env.DEEP_DIVE_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function getMinCount(): number {
  const raw = process.env.DEEP_DIVE_MIN_INJURY_COUNT;
  if (!raw) return DEFAULT_MIN_COUNT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MIN_COUNT;
}

interface RecentPost {
  injury_type?: string;
  sport?: string;
  athlete_name?: string;
  team?: string;
  created_at?: string;
  content_type?: string;
}

function parseListPostsResponse(raw: unknown): RecentPost[] {
  try {
    // Direct array response
    if (Array.isArray(raw)) return raw as RecentPost[];
    // MCP-wrapped response: { content: [{ text: '...' }] }
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return [];
    const text = wrapped?.content?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as RecentPost[];
    const withPosts = parsed as { posts?: unknown[] };
    if (Array.isArray(withPosts?.posts)) return withPosts.posts as RecentPost[];
    return [];
  } catch {
    return [];
  }
}

interface InjuryAggregate {
  injury_type: string;
  count: number;
  sport: SportKey;
  athletes: string[];
  teams: string[];
}

/**
 * Queries recent posts and finds the highest-frequency injury type
 * that meets the minimum count threshold and hasn't had a DEEP_DIVE
 * published for it within the cooldown window.
 *
 * Returns null if no qualifying injury type is found.
 */
async function findTopInjuryType(): Promise<InjuryAggregate | null> {
  if (!isServerAvailable('web')) {
    console.warn('[DeepDive] Web MCP unavailable — skipping cycle');
    return null;
  }

  let raw: unknown;
  try {
    raw = await callTool('web', 'web_list_posts', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[DeepDive] web_list_posts failed: ${message}`);
    return null;
  }

  const posts = parseListPostsResponse(raw);
  const now = Date.now();

  // Split into recent BREAKING/TRACKING/CONFLICT_FLAG posts (for frequency analysis)
  // and recent DEEP_DIVE posts (for cooldown check)
  const recentEvents = posts.filter((p) => {
    if (!p.created_at || !p.injury_type) return false;
    if (p.content_type === 'DEEP_DIVE') return false;
    return now - new Date(p.created_at).getTime() < LOOKBACK_MS;
  });

  const recentDeepDives = posts.filter((p) => {
    if (!p.created_at || !p.injury_type) return false;
    if (p.content_type !== 'DEEP_DIVE') return false;
    return now - new Date(p.created_at).getTime() < INJURY_TYPE_COOLDOWN_MS;
  });

  const recentDeepDiveTypes = new Set(
    recentDeepDives
      .map((p) => p.injury_type?.toLowerCase().trim())
      .filter(Boolean) as string[]
  );

  // Aggregate recent events by normalized injury_type
  const counts = new Map<string, { count: number; sports: string[]; athletes: string[]; teams: string[] }>();
  for (const post of recentEvents) {
    const key = post.injury_type!.toLowerCase().trim();
    const existing = counts.get(key) ?? { count: 0, sports: [], athletes: [], teams: [] };
    existing.count++;
    if (post.sport) existing.sports.push(post.sport);
    if (post.athlete_name) existing.athletes.push(post.athlete_name);
    if (post.team) existing.teams.push(post.team);
    counts.set(key, existing);
  }

  const minCount = getMinCount();

  // Sort by count descending, pick highest that isn't in cooldown
  const sorted = [...counts.entries()]
    .filter(([key, data]) => data.count >= minCount && !recentDeepDiveTypes.has(key))
    .sort(([, a], [, b]) => b.count - a.count);

  if (sorted.length === 0) return null;

  const [injuryTypeKey, data] = sorted[0];

  // Determine most common sport for this injury type
  const sportCounts = new Map<string, number>();
  data.sports.forEach((s) => sportCounts.set(s, (sportCounts.get(s) ?? 0) + 1));
  const topSport = [...sportCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NFL';

  return {
    injury_type: injuryTypeKey,
    count: data.count,
    sport: topSport as SportKey,
    athletes: [...new Set(data.athletes)],
    teams: [...new Set(data.teams)],
  };
}

async function runDeepDiveCycle(): Promise<void> {
  console.log('[DeepDive] Starting scheduled deep-dive check...');

  const aggregate = await findTopInjuryType();
  if (!aggregate) {
    console.log('[DeepDive] No injury type meets threshold or all qualifying types are in cooldown — skipping');
    return;
  }

  console.log(
    `[DeepDive] Top injury type: "${aggregate.injury_type}" (${aggregate.count} occurrences, sport: ${aggregate.sport}) — generating DEEP_DIVE`
  );

  const post = await processDeepDive(aggregate);
  if (!post) {
    console.error('[DeepDive] Agent returned null — check logs for details');
    return;
  }

  const result = await publishInjuryPost(post);
  console.log(`[DeepDive] Published: status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);
}

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await runDeepDiveCycle();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DeepDive] Cycle crashed: ${message}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

/**
 * Starts the autonomous DEEP_DIVE scheduler.
 *
 * Env vars:
 *   DEEP_DIVE_ENABLED         — set to 'false' to disable (default: enabled)
 *   DEEP_DIVE_INTERVAL_MS     — interval between cycles (default: 259200000 = 3 days)
 *   DEEP_DIVE_MIN_INJURY_COUNT — minimum occurrences to trigger (default: 3)
 *
 * First run is delayed by 5 minutes to let MCP clients settle on boot.
 */
export function startDeepDiveScheduler(): void {
  if (process.env.DEEP_DIVE_ENABLED === 'false') {
    console.log('[DeepDive] DEEP_DIVE_ENABLED=false — scheduler not started');
    return;
  }

  stopped = false;
  const intervalMs = getIntervalMs();
  console.log(`[DeepDive] Scheduler starting — interval=${intervalMs}ms (${Math.round(intervalMs / 3600000)}h), min_count=${getMinCount()}`);

  // Delay first run so MCP clients are fully initialized
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

/**
 * Stops the DEEP_DIVE scheduler. Safe to call multiple times.
 */
export function stopDeepDiveScheduler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[DeepDive] Scheduler stopped');
}
