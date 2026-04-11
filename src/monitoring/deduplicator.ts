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
 *   - If a post for the same athlete+sport was created within the last 24h
 *     AND the event is flagged as an update → returns the existing post_id
 *     so the pipeline can produce a TRACKING post.
 *   - If a post exists within 24h AND the event is not an update → returns
 *     isDuplicate: true so the poller skips it entirely.
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

    const existingPostId = recent.post_id ?? recent.id;
    if (event.is_update && existingPostId) {
      return { isDuplicate: false, existingPostId };
    }
    return { isDuplicate: true, ...(existingPostId && { existingPostId }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Dedup] Lookup failed for ${event.athlete_name} (${event.sport}), proceeding: ${message}`
    );
    return { isDuplicate: false };
  }
}
