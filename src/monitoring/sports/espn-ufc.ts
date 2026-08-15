import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource, SourceFetchReport } from './multi-source.js';
import {
  type ESPNAthleteCategory,
  resolveTaggedAthlete,
  parseDate,
  getMaxEventAgeMs,
} from './text-extraction.js';

/**
 * UFC has no structured injury feed on ESPN. Instead we poll the news feed
 * and filter for injury-keyword headlines, then hand each candidate to the
 * classifier which makes the final call.
 *
 * This source emitted ZERO events from the day it was written until 2026-08-15.
 * It read `categories[].athlete.displayName`; ESPN news categories carry
 * `description`. With no text fallback (unlike the soccer source) every single
 * article failed the athlete check and was skipped — a replay of the live feed
 * on 2026-08-15 found 12 keyword hits and 0 emitted events. See
 * resolveTaggedAthlete in text-extraction.ts.
 *
 * There is no text fallback here on purpose. Soccer needs one because half its
 * injury articles are about a club rather than a named player; MMA is an
 * individual sport where ESPN tags every fighter it names, so a missing tag
 * means the article is about an event, a card, or a promotion — not a fighter.
 */
const UFC_NEWS_URL = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/news?limit=50';

/**
 * Stems carry an explicit \w* — see the note on INJURY_KEYWORD_RE in
 * text-extraction.ts for why a bare stem followed by \b never matches.
 *
 * Deliberately NOT the shared INJURY_KEYWORD_RE: MMA needs its own withdrawal
 * and infection vocabulary, and it must not inherit the shared regex's bare
 * `knee`/`shoulder`/`ankle`. In this sport those are strikes and targets — "a
 * flying knee", "shoulder strikes on the fence" — so they select fight
 * previews, not injuries. The same reasoning removed the original bare `hand`,
 * `foot`, `hurt`, `disc` and `out of`; a body part only earns a match here when
 * a clinical stem sits next to it.
 *
 * Known gap: ufc-injuries.md §5 calls commission medical suspensions the most
 * reliable objective signal in the sport, and this regex does not select them.
 * That is not an oversight — poller.ts's NON_INJURY_RE drops "suspension" text
 * unless an injury anchor is also present, so a suspension-only article would
 * be pre-filtered after being fetched. Wiring that signal means teaching the
 * pre-filter about commission language first.
 */
const INJURY_KEYWORDS =
  /\b(injur\w*|torn|tear\w*|ruptur\w*|fractur\w*|broken|sprain\w*|strain\w*|surger\w*|concuss\w*|sidelin\w*|ACL|MCL|hernia\w*|staph|MRSA|withdrew|withdraw\w*|(pull|pulls|pulled|drop|drops|dropped)\s+out|out\s+of\s+(the\s+)?(fight|bout|card|event))\b/i;

interface ESPNNewsFeed {
  articles?: ESPNNewsArticle[];
}

interface ESPNNewsArticle {
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
  categories?: ESPNAthleteCategory[];
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
    const maxAgeMs = getMaxEventAgeMs();
    const now = Date.now();

    for (const article of articles) {
      const headline = article.headline ?? '';
      const description = article.description ?? '';
      const text = `${headline} ${description}`;

      if (!INJURY_KEYWORDS.test(text)) continue;

      const athleteName = resolveTaggedAthlete(article.categories, headline);
      if (!athleteName) continue;

      // The recency window every other source applies. Without it this source
      // read `new Date(article.published)` with `new Date()` as the fallback,
      // so an undated or long-stale article entered the pipeline stamped today
      // — and BREAKING's own staleness check (fact-validator's
      // date_stale_breaking) could never see the real date to reject it.
      const reportedAt = parseDate(article.published);
      if (!reportedAt) continue;
      if (now - reportedAt.getTime() > maxAgeMs) continue;

      events.push({
        athlete_name: athleteName,
        sport: this.sport,
        team: 'UFC',
        injury_description: text.trim(),
        source_url: article.links?.web?.href ?? UFC_NEWS_URL,
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
