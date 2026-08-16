import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource, SourceFetchReport } from './multi-source.js';
import {
  type ESPNAthleteCategory,
  INJURY_KEYWORD_RE,
  buildBlocklist,
  extractAthleteName,
  extractTeam,
  resolveTaggedAthlete,
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
 * Athlete extraction stays a hybrid, but not for the reason originally written
 * here. The old comment said soccer articles don't tag athletes — that they
 * carry a `categories[].athlete` entry whose `displayName` is null. The field
 * is `description`; `displayName` does not exist on a news category in any
 * sport, so it read null on every article and the tag branch never fired. See
 * resolveTaggedAthlete in text-extraction.ts. The genuine reason for the text
 * fallback is different and still holds: a real share of soccer injury stories
 * are framed around the club rather than a named player ("Man United being
 * 'careful' with Mason Mount after injury scare" tags only the team), so when
 * the tags name nobody the headline still has to be parsed.
 */
const PL_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/news?limit=50';

/**
 * Club names used for the text fallback when no team category is present.
 *
 * MUST BE REFRESHED EACH SEASON — promotion and relegation replace three clubs
 * every summer, and a stale list is wrong in both directions: a promoted club
 * is unrecognised as a team AND its tokens are missing from PL_BLOCKLIST, so
 * NAME_RE reads "Ipswich Town" as a person. This is the 2026-27 set, taken from
 * .../soccer/eng.1/teams on 2026-08-15 (out: Burnley, West Ham, Wolves; in:
 * Coventry City, Hull City, Ipswich Town). The live source of truth is that
 * endpoint, mirrored in the teams table — `web_list_teams {sport:
 * 'PREMIER_LEAGUE', coverage:'in'}`.
 */
export const PL_TEAM_NAMES = [
  'Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton', 'Chelsea',
  'Coventry', 'Crystal Palace', 'Everton', 'Fulham', 'Hull', 'Ipswich', 'Leeds',
  'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle',
  'Nottingham Forest', 'Sunderland', 'Tottenham',
];

/**
 * NAME_RE matches any two capitalized words, so club and competition names are
 * indistinguishable from people: "Man United" parses as first name "Man", last
 * name "United". Every token of every club name has to be blocked individually,
 * plus the European clubs that show up constantly in PL transfer coverage.
 *
 * Relegated clubs stay blocked on purpose. They keep appearing in coverage
 * long after they leave the division (transfers out, former players, results
 * elsewhere), and a token that is no longer a PL club is no more a person's
 * first name than it was before.
 */
const PL_BLOCKLIST = buildBlocklist([
  // Premier League clubs, tokenized — 2026-27 set plus recently relegated
  'Man', 'Manchester', 'United', 'City', 'West', 'Ham', 'Aston', 'Villa',
  'Crystal', 'Palace', 'Nottingham', 'Forest', 'Brighton', 'Hove', 'Albion',
  'Wolves', 'Wolverhampton', 'Newcastle', 'Tottenham', 'Hotspur', 'Spurs',
  'Arsenal', 'Chelsea', 'Liverpool', 'Everton', 'Fulham', 'Brentford',
  'Bournemouth', 'Burnley', 'Leeds', 'Sunderland',
  'Coventry', 'Hull', 'Ipswich', 'Town',
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
  categories?: Array<ESPNAthleteCategory & { team?: { description?: string } }>;
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

      const sourceUrl = article.links?.web?.href;
      events.push({
        athlete_name: athleteName,
        sport: this.sport,
        team: resolveTeam(article, text),
        injury_description: text,
        source_url: sourceUrl ?? PL_NEWS_URL,
        reported_at: reportedAt,
        source_name: this.name,
        // Only when the URL is a real story — the fallback is the shared feed
        // endpoint, which identifies nothing.
        source_kind: sourceUrl ? 'article' : 'feed',
      });
    }

    console.log(
      `[${this.name}] ${events.length} events from ${articles.length} articles (${maxAgeMs / 86400000}d window)`,
    );
    return events;
  }
}

/**
 * Prefer ESPN's own tag; fall back to text parsing when the tags name nobody or
 * name too many to choose between.
 *
 * The tag is strictly better than NAME_RE when it resolves: it is ESPN's own
 * identification, it carries accents and multi-word surnames the regex mangles,
 * and it cannot mistake a club for a person. The fallback exists for the
 * club-framed stories that tag only a team.
 */
function resolveAthlete(
  article: ESPNNewsArticle,
  headline: string,
  description: string,
): string | null {
  return (
    resolveTaggedAthlete(article.categories, headline) ??
    extractAthleteName(headline, description, PL_BLOCKLIST)
  );
}

/** Team categories are reliably populated on soccer articles, unlike athletes. */
function resolveTeam(article: ESPNNewsArticle, text: string): string {
  const tagged = article.categories?.find((c) => c.team?.description)?.team?.description;
  if (tagged) return tagged;
  return extractTeam(text, PL_TEAM_NAMES);
}
