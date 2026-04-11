import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import type { RawInjuryEvent } from '../types.js';

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

interface MCPTextResponse {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ExistingPost {
  post_id?: string;
  id?: string;
  athlete_name?: string;
  sport?: string;
  created_at?: string;
  headline?: string;
}

export interface DedupResult {
  isDuplicate: boolean;
  existingPostId?: string;
}

/**
 * Parses the MCP tool response, which is wrapped as
 * `{ content: [{ type: 'text', text: '<json>' }], isError?: boolean }`,
 * into a typed list of existing posts. Falls back to [] on any parse
 * error so dedup never crashes the poller.
 */
function parseListPostsResponse(raw: unknown): ExistingPost[] {
  if (!raw) return [];

  // Some tests or alternate MCP paths may return an array directly
  if (Array.isArray(raw)) return raw as ExistingPost[];

  const wrapped = raw as MCPTextResponse;
  if (wrapped.isError) return [];

  const text = wrapped.content?.[0]?.text;
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as ExistingPost[];
    if (parsed && Array.isArray((parsed as { posts?: unknown }).posts)) {
      return (parsed as { posts: ExistingPost[] }).posts;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Checks whether a raw event is already covered by an existing post.
 *
 * Semantics:
 *   - If a post for the same athlete+sport was created within the last 24h,
 *     always returns isDuplicate:true regardless of is_update flag. The 24h
 *     window is the dedup boundary — once it expires the next cycle will
 *     produce a fresh post naturally.
 *   - If no recent post exists → returns isDuplicate: false.
 *
 * On any MCP failure the function returns isDuplicate:false so the pipeline
 * continues (publishing-pipeline.ts has its own dedup fallback).
 */
export async function checkForExisting(event: RawInjuryEvent): Promise<DedupResult> {
  if (!isServerAvailable('web')) {
    return { isDuplicate: false };
  }

  try {
    const raw = await callTool('web', 'web_list_posts', {
      athlete_name: event.athlete_name,
      sport: event.sport,
    });
    const posts = parseListPostsResponse(raw);

    const now = Date.now();
    const recent = posts.find((post) => {
      if (!post.created_at) return false;
      if (post.athlete_name && post.athlete_name !== event.athlete_name) return false;
      if (post.sport && post.sport !== event.sport) return false;
      const age = now - new Date(post.created_at).getTime();
      return age >= 0 && age < DEDUP_WINDOW_MS;
    });

    if (!recent) return { isDuplicate: false };

    // Any post within the 24h window = always skip.
    // Re-publishing Q/DTD players every 15 minutes is flooding, not tracking.
    return { isDuplicate: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Dedup] Lookup failed for ${event.athlete_name} (${event.sport}), proceeding: ${message}`
    );
    return { isDuplicate: false };
  }
}
