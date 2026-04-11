import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource } from './multi-source.js';

/**
 * UFC has no structured injury feed on ESPN. Instead we poll the news feed
 * and filter for injury-keyword headlines, then hand each candidate to the
 * classifier which makes the final call.
 */
const UFC_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/news';

const INJURY_KEYWORDS =
  /\b(injur|out of|withdrew|withdraw|pull(ed)? out|hurt|surgery|torn|tear|broken|fracture|sprain|strain|knee|acl|mcl|hand|foot|ankle|shoulder|concuss|disc|hernia|staph)\b/i;

interface ESPNNewsFeed {
  articles?: ESPNNewsArticle[];
}

interface ESPNNewsArticle {
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
  categories?: Array<{ athlete?: { displayName?: string } }>;
}

export class ESPNUFCSource implements SportDataSource {
  readonly name = 'espn-ufc';
  private readonly sport: SportKey = 'UFC';

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    try {
      const res = await fetch(UFC_NEWS_URL, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} from ${UFC_NEWS_URL}`);
        return [];
      }
      const feed = (await res.json()) as ESPNNewsFeed;
      return this.parse(feed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] fetch failed: ${message}`);
      return [];
    }
  }

  private parse(feed: ESPNNewsFeed): RawInjuryEvent[] {
    const articles = feed.articles ?? [];
    const events: RawInjuryEvent[] = [];

    for (const article of articles) {
      const headline = article.headline ?? '';
      const description = article.description ?? '';
      const text = `${headline} ${description}`;

      if (!INJURY_KEYWORDS.test(text)) continue;

      const athleteName = article.categories?.find((c) => c.athlete?.displayName)?.athlete
        ?.displayName;
      if (!athleteName) continue;

      const reportedAt = article.published ? new Date(article.published) : new Date();
      if (Number.isNaN(reportedAt.getTime())) continue;

      events.push({
        athlete_name: athleteName,
        sport: this.sport,
        team: 'UFC',
        injury_description: text.trim(),
        source_url: article.links?.web?.href ?? UFC_NEWS_URL,
        reported_at: reportedAt,
      });
    }

    return events;
  }
}
