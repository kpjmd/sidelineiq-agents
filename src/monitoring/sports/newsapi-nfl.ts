import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource } from './multi-source.js';

// ── NewsAPI response shapes ────────────────────────────────────────

interface NewsAPIArticle {
  title?: string;
  description?: string;
  url?: string;
  publishedAt?: string;
  source?: { name?: string };
}

interface NewsAPIResponse {
  status?: string;
  code?: string;
  message?: string;
  articles?: NewsAPIArticle[];
}

// ── Constants ──────────────────────────────────────────────────────

const ENDPOINT = 'https://newsapi.org/v2/everything';
const QUERY = '("NFL" AND (injury OR injured OR "out for" OR torn OR sidelined)) AND NOT fantasy';
const DOMAINS = 'bleacherreport.com,nfl.com,profootballtalk.nbcsports.com,si.com,cbssports.com';

// NewsAPI free tier: 100 req/day. At 15-min polling cadence (96 polls/day),
// running every cycle would exhaust the budget with zero headroom for future
// sports or catch-up polls. Hard floor of 4 ensures max 24 req/day.
const MIN_NEWSAPI_POLL_EVERY_N_CYCLES = 4;
const DEFAULT_NEWSAPI_POLL_EVERY_N_CYCLES = 6; // ~16 req/day, ~84/day headroom

const INJURY_KEYWORD_RE =
  /\b(injur|hurt|torn|sprain|fractur|concuss|sidelin|out\s+for|ACL|MCL|hamstring|knee|ankle|shoulder|achilles|surgery|strain)\b/i;

// ── Athlete name extraction ────────────────────────────────────────
// Regex: two capitalized words ("FirstName LastName"). Requires first name
// to have 3+ chars starting with uppercase then lowercase.
//
// Known miss rate: this will NOT match all-caps stylized names ("DK Metcalf",
// "DJ Moore", "TJ Watt") or apostrophe-prefix names ("Za'Darius Smith").
// Those athletes still arrive via ESPN's structured athlete.displayName feed.
// Skip-on-failure is the correct behavior — precision over recall.
const NAME_RE = /\b([A-Z][a-z]{2,})\s+([A-Z][a-zA-Z'.-]+)\b/g;

const NFL_TEAMS = new Set([
  'Cardinals', 'Falcons', 'Ravens', 'Bills', 'Panthers', 'Bears', 'Bengals', 'Browns',
  'Cowboys', 'Broncos', 'Lions', 'Packers', 'Texans', 'Colts', 'Jaguars', 'Chiefs',
  'Raiders', 'Chargers', 'Rams', 'Dolphins', 'Vikings', 'Patriots', 'Saints', 'Giants',
  'Jets', 'Eagles', 'Steelers', '49ers', 'Seahawks', 'Buccaneers', 'Titans', 'Commanders',
]);

// Words that look like a first name but aren't — team names, day names,
// league labels, and common headline words.
const LEADING_BLOCKLIST = new Set([
  ...NFL_TEAMS,
  'NFL', 'National', 'Monday', 'Sunday', 'Thursday', 'Saturday', 'Tuesday', 'Wednesday', 'Friday',
  'Fantasy', 'Super', 'Injury', 'Report', 'Breaking', 'Update', 'Watch', 'Week',
  'Sources', 'League', 'Season', 'Coach', 'Pro', 'Wild', 'Hall',
]);

// Full team names for extractTeam() — short nicknames only, case-sensitive
const NFL_TEAM_NAMES = [
  'Cardinals', 'Falcons', 'Ravens', 'Bills', 'Panthers', 'Bears', 'Bengals', 'Browns',
  'Cowboys', 'Broncos', 'Lions', 'Packers', 'Texans', 'Colts', 'Jaguars', 'Chiefs',
  'Raiders', 'Chargers', 'Rams', 'Dolphins', 'Vikings', 'Patriots', 'Saints', 'Giants',
  'Jets', 'Eagles', 'Steelers', '49ers', 'Seahawks', 'Buccaneers', 'Titans', 'Commanders',
];

// ── Helpers ────────────────────────────────────────────────────────

function extractAthleteName(title: string, description: string): string | null {
  for (const text of [title, description]) {
    if (!text) continue;
    const matches = [...text.matchAll(NAME_RE)];
    for (const match of matches) {
      const first = match[1];
      if (LEADING_BLOCKLIST.has(first)) continue;
      return `${first} ${match[2]}`;
    }
  }
  return null;
}

function extractTeam(text: string): string {
  for (const team of NFL_TEAM_NAMES) {
    if (new RegExp(`\\b${team}\\b`).test(text)) return team;
  }
  return 'Unknown';
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getMaxEventAgeMs(): number {
  const days = parseInt(process.env.MAX_EVENT_AGE_DAYS ?? '', 10);
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  return d * 24 * 60 * 60 * 1000;
}

function getPollEveryN(): number {
  const raw = parseInt(process.env.NEWSAPI_POLL_EVERY_N_CYCLES ?? '', 10);
  const n = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NEWSAPI_POLL_EVERY_N_CYCLES;
  return Math.max(n, MIN_NEWSAPI_POLL_EVERY_N_CYCLES);
}

// ── Source implementation ──────────────────────────────────────────

export class NewsAPINFLSource implements SportDataSource {
  readonly name = 'newsapi-nfl';
  private readonly sport: SportKey = 'NFL';
  private cycleCount = 0;

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    const key = process.env.NEWSAPI_KEY;
    if (!key) {
      console.warn(`[${this.name}] NEWSAPI_KEY not set — skipping`);
      return [];
    }

    // N-cycle throttle: only fetch on every Nth call
    const n = getPollEveryN();
    const cycle = this.cycleCount++;
    if (cycle % n !== 0) {
      console.log(`[${this.name}] skipping cycle ${cycle} (runs every ${n})`);
      return [];
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', QUERY);
    url.searchParams.set('domains', DOMAINS);
    url.searchParams.set('language', 'en');
    url.searchParams.set('sortBy', 'publishedAt');
    url.searchParams.set('pageSize', '50');

    try {
      const res = await fetch(url.toString(), {
        headers: { 'X-Api-Key': key, Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} from NewsAPI`);
        return [];
      }
      const body = (await res.json()) as NewsAPIResponse;
      if (body.status && body.status !== 'ok') {
        console.warn(`[${this.name}] NewsAPI error: status=${body.status} code=${body.code ?? ''}`);
        return [];
      }
      return this.parse(body.articles ?? []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] fetch failed: ${message}`);
      return [];
    }
  }

  private parse(articles: NewsAPIArticle[]): RawInjuryEvent[] {
    const events: RawInjuryEvent[] = [];
    const maxAgeMs = getMaxEventAgeMs();
    const now = Date.now();

    for (const article of articles) {
      const title = article.title ?? '';
      const description = article.description ?? '';
      const haystack = `${title} ${description}`;

      if (!INJURY_KEYWORD_RE.test(haystack)) continue;

      const athlete = extractAthleteName(title, description);
      if (!athlete) continue;

      const reportedAt = parseDate(article.publishedAt);
      if (!reportedAt) continue;
      if (now - reportedAt.getTime() > maxAgeMs) continue;

      const team = extractTeam(haystack);

      events.push({
        athlete_name: athlete,
        sport: this.sport,
        team,
        injury_description: `${title}${description ? ` — ${description}` : ''}`.trim(),
        source_url: article.url ?? ENDPOINT,
        reported_at: reportedAt,
        source_name: this.name,
      });
    }

    console.log(`[${this.name}] ${events.length} events after filtering (${articles.length} raw)`);
    return events;
  }
}
