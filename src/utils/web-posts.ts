import { callTool } from './mcp-client-manager.js';

/**
 * Paged reads of injury_posts through the web MCP server.
 *
 * `web_list_posts` defaults to limit=20 (max 50) and orders created_at DESC.
 * Every caller that passed `{}` was therefore answering questions about a
 * 7-day or 30-day window from the newest 20 rows — /admin/social-health
 * returned byte-identical results for window_hours=336 and window_hours=720,
 * because neither could see past row 20. A health check that cannot see its
 * own window is how a five-day social publish outage stayed invisible.
 *
 * Known limitation: OFFSET paging over created_at DESC can skip a row if an
 * insert lands mid-scan. These are backward-looking recovery scans, so a row
 * missed on one cycle is picked up on the next; keyset paging would need a
 * server-side change.
 */

/** Server-side filters accepted by web_list_posts. */

/**
 * The post statuses that mean "this row never reached an audience and is not a
 * live queue item": an MD rejected it, or a later post published in its place.
 * Added by mcp migration 021.
 *
 * Grouped because every reader treats them identically — exclude them. The
 * readers that answer "did we cover this?" (isDuplicate, checkFollowUpCadence,
 * getSocialReachReport) or "is this awaiting review?"
 * (findEquivalentPendingReview) are equality allowlists and already ignore
 * anything they do not name. The readers with NO status predicate at all —
 * listAthletePosts in deduplicator.ts, the deep-dive frequency scan, several
 * scripts — must exclude this set explicitly, or a rejected post starts
 * suppressing coverage it was never evidence of.
 *
 * REJECTED additionally implies the post never published, so it never carries a
 * farcaster_hash or twitter_id: rejectPost only ever transitions
 * PENDING_REVIEW → REJECTED. republish-social-orphans relies on that.
 */
export const RETIRED_POST_STATUSES: ReadonlySet<string> = new Set(['REJECTED', 'SUPERSEDED']);

/** True for a REJECTED or SUPERSEDED row. A status-less row is NOT retired. */
export function isRetiredPostStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && RETIRED_POST_STATUSES.has(status);
}

export interface ListPostsFilters {
  sport?: string;
  athlete_name?: string;
  content_type?: string;
  status?: string;
}

export interface ListAllPostsOptions {
  /**
   * Stop once a row older than this epoch-ms timestamp is seen. Rows come back
   * newest-first, so this bounds a windowed scan to the window instead of
   * walking the whole table.
   */
  stopWhenOlderThan?: number;
  /** Hard page cap. Reaching it sets `truncated` — never silently. */
  maxPages?: number;
  pageSize?: number;
}

export interface ListAllPostsResult<T> {
  posts: T[];
  pages: number;
  /** True when maxPages stopped the scan before the server ran out of rows. */
  truncated: boolean;
}

interface MCPTextResponse {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface ListPostsPage<T> {
  posts: T[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number | null;
}

/** Server max — asking for more is rejected by the tool's zod schema. */
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;

/**
 * Unwraps a web_list_posts result to just the rows.
 *
 * Tolerates all three shapes the tool has returned: the MCP text envelope
 * wrapping `{posts: [...]}`, the same envelope wrapping a bare array, and an
 * already-unwrapped array. Returns [] rather than throwing — callers that need
 * to distinguish "empty" from "failed" should use listAllPosts, which throws.
 */
export function parseListPostsResponse<T>(raw: unknown): T[] {
  return parseListPostsPage<T>(raw)?.posts ?? [];
}

/**
 * Unwraps a web_list_posts result keeping the pagination envelope.
 *
 * Returns null when the response is an error or cannot be parsed, so a failed
 * page is distinguishable from an empty one — the distinction parseListPostsResponse
 * cannot make, and the reason the paging loop below can fail loudly.
 */
export function parseListPostsPage<T>(raw: unknown): ListPostsPage<T> | null {
  if (!raw) return null;

  // Already unwrapped (some callers hand us the parsed payload directly).
  if (Array.isArray(raw)) {
    return { posts: raw as T[], total: null, hasMore: false, nextOffset: null };
  }

  const wrapped = raw as MCPTextResponse;
  if (wrapped.isError) return null;
  const text = wrapped.content?.[0]?.text;
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    return { posts: parsed as T[], total: null, hasMore: false, nextOffset: null };
  }

  const envelope = parsed as {
    posts?: unknown;
    total?: unknown;
    has_more?: unknown;
    next_offset?: unknown;
  };
  if (!Array.isArray(envelope?.posts)) return null;

  return {
    posts: envelope.posts as T[],
    total: typeof envelope.total === 'number' ? envelope.total : null,
    hasMore: envelope.has_more === true,
    nextOffset: typeof envelope.next_offset === 'number' ? envelope.next_offset : null,
  };
}

function createdAtMs(row: unknown): number | null {
  const value = (row as { created_at?: string } | null)?.created_at;
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Reads every post matching `filters`, paging until the server runs out.
 *
 * Throws when a page fails or cannot be parsed. That is deliberate: a scan
 * that silently returns [] on a transport failure reports "nothing is wrong"
 * for the same reason the truncation did. Callers that would rather skip a
 * cycle than crash catch it themselves.
 */
export async function listAllPosts<T>(
  filters: ListPostsFilters = {},
  options: ListAllPostsOptions = {},
): Promise<ListAllPostsResult<T>> {
  const pageSize = Math.min(options.pageSize ?? PAGE_SIZE, PAGE_SIZE);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const cutoff = options.stopWhenOlderThan;

  const posts: T[] = [];
  let offset = 0;
  let pages = 0;

  while (pages < maxPages) {
    const raw = await callTool('web', 'web_list_posts', {
      ...filters,
      limit: pageSize,
      offset,
    });
    const page = parseListPostsPage<T>(raw);
    if (!page) {
      throw new Error(`web_list_posts failed or returned an unreadable page at offset ${offset}`);
    }
    pages++;

    if (cutoff === undefined) {
      posts.push(...page.posts);
    } else {
      // Newest-first, so the first row past the cutoff ends the scan. Keep the
      // rows before it — a partial page is still a complete answer for the window.
      let reachedCutoff = false;
      for (const row of page.posts) {
        const created = createdAtMs(row);
        if (created !== null && created < cutoff) {
          reachedCutoff = true;
          break;
        }
        posts.push(row);
      }
      if (reachedCutoff) return { posts, pages, truncated: false };
    }

    if (!page.hasMore || page.nextOffset === null) {
      return { posts, pages, truncated: false };
    }
    // A server that stops advancing the offset would spin this loop forever
    // inside a five-minute cron. Stop instead, and say the scan was cut short.
    if (page.nextOffset <= offset) {
      return { posts, pages, truncated: true };
    }
    offset = page.nextOffset;
  }

  return { posts, pages, truncated: true };
}
