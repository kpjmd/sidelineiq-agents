import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource, SourceFetchReport } from './multi-source.js';

/**
 * UFC has no structured injury feed on ESPN. Instead we poll the news feed
 * and filter for injury-keyword headlines, then hand each candidate to the
 * classifier which makes the final call.
 */
const UFC_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/news';

// Stems carry an explicit \w* — see the note on INJURY_KEYWORD_RE in
// text-extraction.ts for why a bare stem followed by \b never matches.
const INJURY_KEYWORDS =
  /\b(injur\w*|out of|withdrew|withdraw\w*|pull(ed)? out|hurt|surger\w*|torn|tear\w*|broken|fractur\w*|sprain\w*|strain\w*|knee|acl|mcl|hand|foot|ankle|shoulder|concuss\w*|disc|hernia|staph)\b/i;

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

  private report: SourceFetchReport = { status: 'empty' };

  lastFetchReport(): SourceFetchReport {
    return this.report;
  }

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    try {
      const res = await fetch(UFC_NEWS_URL, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} from ${UFC_NEWS_URL}`);
        this.report = { status: 'error', detail: `HTTP ${res.status}` };
        return [];
      }
      const feed = (await res.json()) as ESPNNewsFeed;
      const events = this.parse(feed);
      this.report =
        events.length > 0
          ? { status: 'ok' }
          : { status: 'empty', detail: `${feed.articles?.length ?? 0} articles, no injury hits` };
      return events;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] fetch failed: ${message}`);
      this.report = { status: 'error', detail: message.slice(0, 80) };
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
        source_name: 'espn-ufc',
      });
    }

    return events;
  }
}
