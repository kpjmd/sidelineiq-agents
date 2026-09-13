import { isServerAvailable } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { processDeepDive } from '../agents/injury-intelligence/agent.js';
import { publishInjuryPost } from '../utils/publishing-pipeline.js';
import {
  DEEP_DIVE_COOLDOWN_MS,
  DEEP_DIVE_LOOKBACK_MS,
  selectDeepDiveCandidate,
  type CandidatePost,
  type DeepDiveCandidate,
} from './deep-dive-candidates.js';

// Default: 3 days — keeps DEEP_DIVE premium (~8/month, ~100/year)
const DEFAULT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_COUNT = 2;
// Delay first run after boot so MCP clients are settled
const STARTUP_DELAY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

// In-memory cooldown: canonical injury key → timestamp of last DEEP_DIVE generation.
// Belt-and-suspenders guard for cases where web_list_posts doesn't return
// PENDING_REVIEW posts (so the DB-side cooldown check can't see them).
// Persists for the life of the server process.
const generatedAt = new Map<string, number>();

function isInMemoryCooldown(canonicalKey: string): boolean {
  const last = generatedAt.get(canonicalKey);
  if (last === undefined) return false;
  return Date.now() - last < DEEP_DIVE_COOLDOWN_MS;
}

function recordGenerated(canonicalKey: string): void {
  generatedAt.set(canonicalKey, Date.now());
  console.log(`[DeepDive] In-memory cooldown set for "${canonicalKey}" (${DEEP_DIVE_COOLDOWN_MS / 86400000}d)`);
}

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

/**
 * Finds this cycle's DEEP_DIVE candidate. The selection rules live in
 * deep-dive-candidates.ts (pure, tested, and replayed by
 * src/scripts/deep-dive-starvation-dryrun.ts); this only fetches the window.
 *
 * Returns null if no qualifying injury type is found.
 */
async function findTopInjuryType(): Promise<DeepDiveCandidate | null> {
  if (!isServerAvailable('web')) {
    console.warn('[DeepDive] Web MCP unavailable — skipping cycle');
    return null;
  }

  const now = Date.now();

  // Scan to the wider of the two windows the selection reads. Unpaged, this saw
  // only the newest 20 rows, so a busy week of BREAKING posts could push every
  // DEEP_DIVE out of view and defeat the cooldown check entirely. No status
  // filter server-side: frequency analysis counts pending posts too — an
  // unapproved post is still a report that came in. Retired rows are dropped in
  // selectDeepDiveCandidate.
  let posts: CandidatePost[];
  try {
    ({ posts } = await listAllPosts<CandidatePost>(
      {},
      { stopWhenOlderThan: now - Math.max(DEEP_DIVE_LOOKBACK_MS, DEEP_DIVE_COOLDOWN_MS) },
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[DeepDive] web_list_posts failed: ${message}`);
    return null;
  }

  return selectDeepDiveCandidate(posts, {
    now,
    minCount: getMinCount(),
    isInMemoryCooldown,
  });
}

async function runDeepDiveCycle(): Promise<void> {
  console.log('[DeepDive] Starting scheduled deep-dive check...');

  const aggregate = await findTopInjuryType();
  if (!aggregate) {
    console.log('[DeepDive] No injury type meets threshold or all qualifying types are in cooldown — skipping');
    return;
  }

  console.log(
    `[DeepDive] Top injury type: "${aggregate.injury_type}" [key=${aggregate.canonical_key}] (${aggregate.count} athletes, sport: ${aggregate.sport}) — generating DEEP_DIVE`
  );

  const post = await processDeepDive(aggregate);
  if (!post) {
    console.error('[DeepDive] Agent returned null — check logs for details');
    return;
  }

  const result = await publishInjuryPost(post);
  console.log(`[DeepDive] Published: status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);

  // Record in-memory cooldown regardless of publish status (pending_review counts)
  if (result.status === 'published' || result.status === 'pending_review') {
    recordGenerated(aggregate.canonical_key);
  }
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
 *   DEEP_DIVE_MIN_INJURY_COUNT — minimum DISTINCT ATHLETES sharing a canonical
 *                                injury key (default: 2; production sets 3).
 *                                Not a post count: the agent prints it as
 *                                "N cases", so one athlete's follow-ups are one.
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
