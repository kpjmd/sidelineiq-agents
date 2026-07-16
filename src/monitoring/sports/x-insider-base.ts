import { callTool, isServerAvailable } from '../../utils/mcp-client-manager.js';
import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource } from './multi-source.js';
import type { XInsider } from '../../config/x-insiders.js';
import {
  INJURY_KEYWORD_RE,
  extractAthleteName,
  extractTeam,
  getMaxEventAgeMs,
} from './text-extraction.js';

// Verified against the live X MCP server's tools/list (2026-07-16):
// get_users_posts — a user's own authored posts, not get_users_timeline
// (which is that user's home/following feed — wrong semantics for us).
// Overridable without a redeploy if X renames it.
const TIMELINE_TOOL = process.env.X_API_TIMELINE_TOOL_NAME || 'get_users_posts';

// X API v2 only returns created_at/author_id when explicitly requested —
// both fields are required by parseTweets() below (age filtering, spoofing
// defense-in-depth), so this must be sent on every call.
const POST_FIELDS = 'created_at,author_id';

const MAX_FETCH_RETRIES = 3;

interface XApiTweet {
  id?: string;
  text?: string;
  created_at?: string;
  author_id?: string;
  referenced_tweets?: Array<{ id?: string; type?: string }>;
}

/**
 * Unwraps the standard MCP tool-result content envelope, then the X API v2
 * timeline shape (`{ data: [...tweets] }`). Falls back to treating the
 * parsed payload as the tweet array directly, in case the live server
 * returns an unwrapped array. Verified against the live server 2026-07-16.
 */
function parseTimelineResponse(raw: unknown): XApiTweet[] {
  try {
    const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
    if (wrapped?.isError === true) return [];
    const text = wrapped?.content?.[0]?.text;
    if (!text) return [];
    const parsed = JSON.parse(text) as { data?: XApiTweet[] } | XApiTweet[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.data ?? [];
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Base class for curated-insider X sources. Reads ONLY the allowlisted
 * accounts' own timelines by numeric user ID — never general/full-archive
 * search — to avoid ingesting impersonator accounts or unverified noise.
 */
export abstract class XInsiderSource implements SportDataSource {
  abstract readonly name: string;
  protected abstract readonly sport: SportKey;
  protected abstract readonly insiders: XInsider[];
  protected abstract readonly teamNames: string[];
  protected abstract readonly blocklist: Set<string>;
  private cycleCount = 0;

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    if (process.env.X_INSIDER_SOURCE_ENABLED === 'false') return [];
    if (!isServerAvailable('x_api')) {
      console.warn(`[${this.name}] x_api MCP unavailable — skipping`);
      return [];
    }

    const n = Math.max(1, parseInt(process.env.X_INSIDER_POLL_EVERY_N_CYCLES ?? '1', 10) || 1);
    const cycle = this.cycleCount++;
    if (cycle % n !== 0) {
      console.log(`[${this.name}] skipping cycle ${cycle} (runs every ${n})`);
      return [];
    }

    const activeInsiders = this.insiders.filter((i) => {
      if (!i.userId || i.userId === 'REPLACE_ME') {
        console.warn(`[${this.name}] ${i.handle} has no resolved userId — skipping until configured`);
        return false;
      }
      return true;
    });

    const results = await Promise.allSettled(
      activeInsiders.map((insider) => this.fetchForInsider(insider))
    );

    const events: RawInjuryEvent[] = [];
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        events.push(...result.value);
      } else {
        console.warn(`[${this.name}] ${activeInsiders[idx].handle} failed: ${result.reason}`);
      }
    });

    console.log(`[${this.name}] ${events.length} events after filtering (${activeInsiders.length} insiders polled)`);
    return events;
  }

  private async fetchForInsider(insider: XInsider, attempt = 1): Promise<RawInjuryEvent[]> {
    try {
      const raw = await callTool('x_api', TIMELINE_TOOL, {
        id: insider.userId, // numeric ID only — never pass insider.handle here
        max_results: Number(process.env.X_INSIDER_MAX_RESULTS_PER_USER ?? '5'),
        'post.fields': POST_FIELDS,
      });
      return this.parseTweets(parseTimelineResponse(raw), insider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/429|rate.?limit/i.test(message) && attempt < MAX_FETCH_RETRIES) {
        const delay = 1000 * 2 ** attempt;
        console.warn(`[${this.name}] ${insider.handle} rate-limited — retrying in ${delay}ms (attempt ${attempt}/${MAX_FETCH_RETRIES})`);
        await sleep(delay);
        return this.fetchForInsider(insider, attempt + 1);
      }
      console.warn(`[${this.name}] ${insider.handle} fetch failed: ${message}`);
      return []; // never throw — SportDataSource contract
    }
  }

  private parseTweets(tweets: XApiTweet[], insider: XInsider): RawInjuryEvent[] {
    const events: RawInjuryEvent[] = [];
    const maxAgeMs = getMaxEventAgeMs();
    const now = Date.now();

    for (const tweet of tweets) {
      // Pure retweets carry the retweeter's author_id even though the words
      // are someone else's — an insider retweeting another account's report
      // is not the same signal as reporting it themselves, and the author_id
      // check below would not catch this (X sets it to the retweeter, not
      // the original author). Quote-tweets are fine to keep: their top-level
      // text is the insider's own added commentary.
      if (tweet.referenced_tweets?.some((rt) => rt.type === 'retweeted')) continue;

      const text = tweet.text ?? '';
      if (!INJURY_KEYWORD_RE.test(text)) continue;

      // Defense in depth: we requested by numeric ID, but if the API ever
      // echoes a mismatched author_id, drop the tweet rather than trust it.
      if (tweet.author_id && tweet.author_id !== insider.userId) continue;

      const athlete = extractAthleteName(text, '', this.blocklist);
      if (!athlete) continue;

      const reportedAt = tweet.created_at ? new Date(tweet.created_at) : null;
      if (!reportedAt || Number.isNaN(reportedAt.getTime())) continue;
      if (now - reportedAt.getTime() > maxAgeMs) continue;

      events.push({
        athlete_name: athlete,
        sport: this.sport,
        team: extractTeam(text, this.teamNames),
        injury_description: text.trim(),
        source_url: tweet.id
          ? `https://x.com/${insider.handle}/status/${tweet.id}`
          : `https://x.com/${insider.handle}`,
        reported_at: reportedAt,
        source_name: `X:${insider.handle}`,
      });
    }

    return events;
  }
}
