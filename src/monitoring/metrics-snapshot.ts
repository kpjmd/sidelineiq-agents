import { callTool } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import type { MCPServerName } from '../types.js';

/**
 * Daily baseline snapshot of the accounts' own follower counts
 * (monetization plan, Phase 0.3; mcp migration 024).
 *
 * Gate G2 is "≥2%/week follower growth on at least one platform after 90
 * days" — a weekly RATE, so it needs a series that starts now rather than one
 * number copied down by hand. This loop reads each platform's own profile and
 * upserts one `metric_snapshots` row per metric per UTC day.
 *
 * The rule this module exists to keep: **an unreadable count writes NO row.**
 * A thrown call, an `isError` result, an unparseable payload and a
 * non-numeric count all mean "we don't know", and a 0 written in their place
 * reads as "lost every follower" to the growth gate. It is the defer queue's
 * `available` lesson again — an empty list and an unreadable store must never
 * be the same value. A day with no row is honest; a day with a false 0 is not.
 *
 * Each platform is independent: one failing never skips the other.
 *
 * Deliberately NOT inside pollSport: that loop runs every POLL_INTERVAL_MS
 * (6h in production) and carries publish budget state that has nothing to do
 * with this.
 */

type MetricName = 'x_followers' | 'farcaster_followers';
type MetricSource = 'x_api' | 'neynar';

interface PlatformRead {
  platform: 'x' | 'farcaster';
  server: MCPServerName;
  tool: string;
  metric: MetricName;
  source: MetricSource;
  /** Pull the follower count and the context stored beside it out of the tool payload. */
  extract: (payload: Record<string, unknown>) => { count: unknown; detail: Record<string, unknown> };
}

export const PLATFORM_READS: readonly PlatformRead[] = [
  {
    platform: 'x',
    server: 'twitter',
    tool: 'twitter_get_profile_stats',
    metric: 'x_followers',
    source: 'x_api',
    extract: (p) => ({
      count: p.followers_count,
      detail: { username: p.username, following_count: p.following_count, tweet_count: p.tweet_count },
    }),
  },
  {
    platform: 'farcaster',
    server: 'farcaster',
    tool: 'farcaster_get_profile_stats',
    metric: 'farcaster_followers',
    source: 'neynar',
    extract: (p) => ({
      count: p.follower_count,
      detail: { fid: p.fid, username: p.username, following_count: p.following_count },
    }),
  },
];

export interface MetricsSnapshotFailure {
  platform: PlatformRead['platform'];
  stage: 'read' | 'write';
  error: string;
}

export interface MetricsSnapshotSummary {
  readings: Partial<Record<MetricName, number>>;
  written: number;
  failed: number;
  failures: MetricsSnapshotFailure[];
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily — the series is per UTC day
const STARTUP_DELAY_MS = 3 * 60 * 1000;          // after MCP connects and roster sync starts

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function getIntervalMs(): number {
  const raw = process.env.METRICS_SNAPSHOT_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parsePayload(result: unknown): Record<string, unknown> | null {
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read one platform's count. Returns the reading, or a failure — never a
 * defaulted number.
 */
async function readPlatform(
  read: PlatformRead,
): Promise<{ count: number; detail: Record<string, unknown> } | { error: string }> {
  let result: unknown;
  try {
    result = await callTool(read.server, read.tool, {});
  } catch (err) {
    return { error: errorMessage(err) };
  }
  if (isMCPError(result)) return { error: extractMCPErrorMessage(result) };

  const payload = parsePayload(result);
  if (!payload) return { error: `${read.tool} returned no parseable payload` };

  const { count, detail } = read.extract(payload);
  if (!isCount(count)) return { error: `${read.tool} returned a non-numeric count: ${JSON.stringify(count)}` };
  return { count, detail };
}

export async function takeMetricsSnapshot(): Promise<MetricsSnapshotSummary> {
  const summary: MetricsSnapshotSummary = { readings: {}, written: 0, failed: 0, failures: [] };

  const outcomes = await Promise.all(PLATFORM_READS.map(async (read) => ({ read, outcome: await readPlatform(read) })));

  for (const { read, outcome } of outcomes) {
    if ('error' in outcome) {
      summary.failed++;
      summary.failures.push({ platform: read.platform, stage: 'read', error: outcome.error });
      console.error(`[Metrics] SNAPSHOT FAILED platform=${read.platform} metric=${read.metric} error=${outcome.error}`);
      continue;
    }

    summary.readings[read.metric] = outcome.count;
    let writeError: string | null = null;
    try {
      const res = await callTool('web', 'web_record_metric_snapshot', {
        metric: read.metric,
        value: outcome.count,
        source: read.source,
        detail: outcome.detail,
      });
      if (isMCPError(res)) writeError = extractMCPErrorMessage(res);
    } catch (err) {
      writeError = errorMessage(err);
    }

    if (writeError) {
      summary.failed++;
      summary.failures.push({ platform: read.platform, stage: 'write', error: writeError });
      console.error(
        `[Metrics] SNAPSHOT WRITE REJECTED platform=${read.platform} metric=${read.metric} value=${outcome.count} error=${writeError}`,
      );
      continue;
    }
    summary.written++;
  }

  const readings = PLATFORM_READS.map((r) => `${r.metric}=${summary.readings[r.metric] ?? 'unread'}`).join(' ');
  console.log(`[Metrics] ${readings} written=${summary.written} failed=${summary.failed}`);
  return summary;
}

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await takeMetricsSnapshot();
  } catch (err) {
    console.error(`[Metrics] cycle crashed: ${errorMessage(err)}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

export function startMetricsSnapshot(): void {
  if (process.env.METRICS_SNAPSHOT_ENABLED === 'false') {
    console.log('[Metrics] METRICS_SNAPSHOT_ENABLED=false — skipping startup');
    return;
  }

  stopped = false;
  const intervalMs = getIntervalMs();
  console.log(`[Metrics] Starting — interval=${intervalMs}ms (first run in ${STARTUP_DELAY_MS}ms)`);
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

export function stopMetricsSnapshot(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[Metrics] Stopped');
}
