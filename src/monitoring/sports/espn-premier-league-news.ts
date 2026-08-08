import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource, SourceFetchReport } from './multi-source.js';
import {
  INJURY_KEYWORD_RE,
  buildBlocklist,
  extractAthleteName,
  extractTeam,
  parseDate,
  getMaxEventAgeMs,
} from './text-extraction.js';

/**
 * ESPN publishes no Premier League injury data. The structured endpoint that
 * backs ESPNPremierLeagueSource — .../soccer/eng.1/injuries — answers HTTP 200
 * with `{"injuries":[]}`, and does the same for every other soccer league,
 * while NFL and NBA return full feeds from the identical URL shape. It appears
 * to be populated for US leagues only.
 *
 * So Premier League follows the UFC pattern instead: poll the news feed and
 * keyword-filter, letting the classifier make the final call. The structured
 * source stays registered — it costs one request per cycle, now reports
 * `empty` explicitly, and starts producing on its own if ESPN ever fills it in.
 * It is also the roster provider for soccer/eng.1 (see roster-sync.ts), so it
 * must not be removed.
 *
 * One difference from UFC: soccer articles do not tag athletes. Roughly half
 * carry a `categories[].athlete` entry, but on the injury-relevant ones
 * `displayName` is null — today's "Man United being 'careful' with Mason Mount
 * after injury scare" has only a team category. So athlete extraction is a
 * hybrid: use the tag when it is really there, otherwise fall back to parsing
 * the text.
 */
const PL_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/news?limit=50';

/** Club names used for the text fallback when no team category is present. */
export const PL_TEAM_NAMES = [
  'Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton', 'Burnley',
  'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Leeds', 'Liverpool',
  'Manchester City', 'Manchester United', 'Newcastle', 'Nottingham Forest',
  'Sunderland', 'Tottenham', 'West Ham', 'Wolves',
];

/**
 * NAME_RE matches any two capitalized words, so club and competition names are
 * indistinguishable from people: "Man United" parses as first name "Man", last
 * name "United". Every token of every club name has to be blocked individually,
 * plus the European clubs that show up constantly in PL transfer coverage.
 */
const PL_BLOCKLIST = buildBlocklist([
  // Premier League clubs, tokenized
  'Man', 'Manchester', 'United', 'City', 'West', 'Ham', 'Aston', 'Villa',
  'Crystal', 'Palace', 'Nottingham', 'Forest', 'Brighton', 'Hove', 'Albion',
  'Wolves', 'Wolverhampton', 'Newcastle', 'Tottenham', 'Hotspur', 'Spurs',
  'Arsenal', 'Chelsea', 'Liverpool', 'Everton', 'Fulham', 'Brentford',
  'Bournemouth', 'Burnley', 'Leeds', 'Sunderland',
  // European clubs common in PL transfer/preseason coverage
  'Real', 'Madrid', 'Atletico', 'Barcelona', 'Inter', 'Internazionale', 'Milan',
  'Bayern', 'Munich', 'Borussia', 'Dortmund', 'Paris', 'Getafe', 'Juventus',
  'Napoli', 'Roma', 'Sevilla', 'Valencia', 'Porto', 'Benfica', 'Ajax',
  // Competition and coverage vocabulary
  'Premier', 'Champions', 'Europa', 'Transfer', 'Preseason', 'Deadline',
  'World', 'Cup', 'Community', 'Shield', 'Boxing', 'Matchday',
]);

interface ESPNNewsFeed {
  articles?: ESPNNewsArticle[];
}

interface ESPNNewsArticle {
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
  categories?: Array<{
    type?: string;
    athlete?: { displayName?: string };
    team?: { description?: string };
  }>;
}

export class ESPNPremierLeagueNewsSource implements SportDataSource {
  readonly name = 'espn-premier-league-news';
  private readonly sport: SportKey = 'PREMIER_LEAGUE';

  private report: SourceFetchReport = { status: 'empty' };

  lastFetchReport(): SourceFetchReport {
    return this.report;
  }

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    try {
      const res = await fetch(PL_NEWS_URL, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} from ${PL_NEWS_URL}`);
        this.report = { status: 'error', detail: `HTTP ${res.status}` };
        return [];
      }
      const feed = (await res.json()) as ESPNNewsFeed;
      const articles = feed.articles ?? [];
      const events = this.parse(articles);
      this.report =
        events.length > 0
          ? { status: 'ok' }
          : { status: 'empty', detail: `${articles.length} articles, no injury hits` };
      return events;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] fetch failed: ${message}`);
      this.report = { status: 'error', detail: message.slice(0, 80) };
      return [];
    }
  }

  private parse(articles: ESPNNewsArticle[]): RawInjuryEvent[] {
    const events: RawInjuryEvent[] = [];
    const maxAgeMs = getMaxEventAgeMs();
    const now = Date.now();

    for (const article of articles) {
      const headline = article.headline ?? '';
      const description = article.description ?? '';
      const text = `${headline} ${description}`.trim();

      if (!INJURY_KEYWORD_RE.test(text)) continue;

      const athleteName = resolveAthlete(article, headline, description);
      if (!athleteName) continue;

      const reportedAt = parseDate(article.published);
      if (!reportedAt) continue;
      if (now - reportedAt.getTime() > maxAgeMs) continue;

      events.push({
        athlete_name: athleteName,
        sport: this.sport,
        team: resolveTeam(article, text),
        injury_description: text,
        source_url: article.links?.web?.href ?? PL_NEWS_URL,
        reported_at: reportedAt,
        source_name: this.name,
      });
    }

    console.log(
      `[${this.name}] ${events.length} events from ${articles.length} articles (${maxAgeMs / 86400000}d window)`,
    );
    return events;
  }
}

/** Prefer ESPN's own tag; fall back to text parsing when it is absent or null. */
function resolveAthlete(
  article: ESPNNewsArticle,
  headline: string,
  description: string,
): string | null {
  const tagged = article.categories?.find((c) => c.athlete?.displayName)?.athlete?.displayName;
  if (tagged) return tagged;
  return extractAthleteName(headline, description, PL_BLOCKLIST);
}

/** Team categories are reliably populated on soccer articles, unlike athletes. */
function resolveTeam(article: ESPNNewsArticle, text: string): string {
  const tagged = article.categories?.find((c) => c.team?.description)?.team?.description;
  if (tagged) return tagged;
  return extractTeam(text, PL_TEAM_NAMES);
}
