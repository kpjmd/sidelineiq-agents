import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource } from './multi-source.js';

/**
 * Shared shape for ESPN's per-sport injury endpoints.
 * Non-exhaustive — only the fields we rely on.
 */
interface ESPNInjuryFeed {
  injuries?: ESPNTeamInjuries[];
}

interface ESPNTeamInjuries {
  team?: {
    displayName?: string;
    shortDisplayName?: string;
    name?: string;
    location?: string;
    abbreviation?: string;
  };
  injuries?: ESPNInjuryRecord[];
}

interface ESPNInjuryRecord {
  athlete?: { displayName?: string; fullName?: string };
  status?: string;
  date?: string;
  longComment?: string;
  shortComment?: string;
  details?: {
    type?: string;
    location?: string;
    detail?: string;
    side?: string;
    returnDate?: string;
  };
  type?: { description?: string };
}

/**
 * Strips ESPN sentinel team name values (e.g. "<UNKNOWN>", "<UNK>") and
 * returns undefined so the fallback chain continues to the next candidate.
 */
function sanitizeTeamName(name: string | undefined): string | undefined {
  if (!name || name.trim() === '') return undefined;
  // ESPN sometimes returns angle-bracket sentinel strings for unresolved teams
  if (/^<.*>$/.test(name.trim())) return undefined;
  return name;
}

/**
 * Statuses that indicate a chronic or season-ending condition.
 * These are stable long-term listings that don't represent new injury news.
 */
const SKIP_STATUS_RE =
  /^(injured\s+reserve|ir|physically\s+unable\s+to\s+perform|pup|non[-\s]?football\s+injury|nfi|out\s+for\s+(the\s+)?season|season[-\s]ending)/i;

/**
 * Maximum age (in ms) for an event to be considered "recent enough" to process.
 * Defaults to 7 days. Override with MAX_EVENT_AGE_DAYS env var.
 */
function getMaxEventAgeMs(): number {
  const days = parseInt(process.env.MAX_EVENT_AGE_DAYS ?? '', 10);
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  return d * 24 * 60 * 60 * 1000;
}

/**
 * Roster data exposed by ESPN team + roster endpoints.
 * Used by agents/src/monitoring/roster-sync.ts to seed/refresh
 * the players + teams tables that fact-validator depends on.
 */
export interface ESPNTeam {
  espn_team_id: string;
  name: string;
  abbreviation?: string;
  location?: string;
  display_name?: string;
  conference?: string;
}

export interface ESPNRosterAthlete {
  espn_athlete_id: string;
  full_name: string;
  position?: string;
  jersey?: string;
}

interface ESPNTeamsResponse {
  sports?: Array<{
    leagues?: Array<{
      teams?: Array<{ team?: ESPNRawTeam }>;
    }>;
  }>;
}

interface ESPNRawTeam {
  id?: string | number;
  abbreviation?: string;
  displayName?: string;
  name?: string;
  location?: string;
  shortDisplayName?: string;
}

interface ESPNRosterResponse {
  athletes?: Array<ESPNRosterGroup | ESPNRawAthlete>;
}

interface ESPNRosterGroup {
  position?: string;
  items?: ESPNRawAthlete[];
}

interface ESPNRawAthlete {
  id?: string | number;
  displayName?: string;
  fullName?: string;
  jersey?: string;
  position?: { abbreviation?: string };
}

/**
 * Base class for ESPN injury-feed sources (NFL, NBA, Premier League).
 * Subclasses only need to provide url, sport, leaguePath, and source name.
 * leaguePath drives roster fetching (e.g. "basketball/nba").
 */
export abstract class ESPNInjurySource implements SportDataSource {
  abstract readonly name: string;
  protected abstract readonly sport: SportKey;
  protected abstract readonly url: string;
  // ESPN league path, e.g. "football/nfl", "basketball/nba", "soccer/eng.1".
  // Used to build roster endpoint URLs. Override per sport.
  protected readonly leaguePath: string | null = null;

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    try {
      const res = await fetch(this.url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} from ${this.url}`);
        return [];
      }
      const feed = (await res.json()) as ESPNInjuryFeed;
      return this.parse(feed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] fetch failed: ${message}`);
      return [];
    }
  }

  protected parse(feed: ESPNInjuryFeed): RawInjuryEvent[] {
    const events: RawInjuryEvent[] = [];
    const teamGroups = feed.injuries ?? [];
    const maxAgeMs = getMaxEventAgeMs();
    const now = Date.now();

    for (const group of teamGroups) {
      const t = group.team;
      const teamName =
        sanitizeTeamName(t?.displayName) ??
        sanitizeTeamName(t?.shortDisplayName) ??
        (t?.location && t?.name ? `${t.location} ${t.name}` : undefined) ??
        sanitizeTeamName(t?.name) ??
        sanitizeTeamName(t?.abbreviation) ??
        'Unknown';
      const records = group.injuries ?? [];

      for (const record of records) {
        const athleteName = record.athlete?.displayName ?? record.athlete?.fullName;
        if (!athleteName) continue;

        // Skip chronic / season-ending statuses (IR, PUP, NFI, etc.)
        if (record.status && SKIP_STATUS_RE.test(record.status)) continue;

        // Skip events with no date — can't verify recency
        const reportedAt = parseDate(record.date);
        if (!reportedAt) continue;

        // Skip events older than the recency window
        if (now - reportedAt.getTime() > maxAgeMs) continue;

        const description = buildDescription(record);
        if (!description) continue;

        const teamTimeline = extractTeamTimeline(record);
        const isUpdate = inferIsUpdate(record.status);

        events.push({
          athlete_name: athleteName,
          sport: this.sport,
          team: teamName,
          injury_description: description,
          source_url: this.url,
          reported_at: reportedAt,
          source_name: this.name,
          ...(teamTimeline && { team_timeline: teamTimeline }),
          ...(isUpdate && { is_update: true }),
        });
      }
    }

    console.log(`[${this.name}] ${events.length} events after recency+status filter (${maxAgeMs / 86400000}d window)`);
    return events;
  }

  // ── Roster sync helpers ──────────────────────────────────────────────
  // Returns the list of teams in the league. Empty if leaguePath unset.
  async fetchTeams(): Promise<ESPNTeam[]> {
    if (!this.leaguePath) return [];
    const url = `https://site.api.espn.com/apis/site/v2/sports/${this.leaguePath}/teams`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`[${this.name}] roster: HTTP ${res.status} from ${url}`);
        return [];
      }
      const body = (await res.json()) as ESPNTeamsResponse;
      const raw = body.sports?.[0]?.leagues?.[0]?.teams ?? [];
      const teams: ESPNTeam[] = [];
      for (const wrapper of raw) {
        const t = wrapper.team;
        if (!t?.id) continue;
        teams.push({
          espn_team_id: String(t.id),
          name: t.name ?? t.displayName ?? 'Unknown',
          abbreviation: t.abbreviation,
          location: t.location,
          display_name: t.displayName ?? t.shortDisplayName,
        });
      }
      return teams;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] roster teams fetch failed: ${message}`);
      return [];
    }
  }

  // Returns the roster for one team. Tolerates both flat and grouped shapes.
  async fetchRoster(espnTeamId: string): Promise<ESPNRosterAthlete[]> {
    if (!this.leaguePath) return [];
    const url = `https://site.api.espn.com/apis/site/v2/sports/${this.leaguePath}/teams/${espnTeamId}/roster`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`[${this.name}] roster ${espnTeamId}: HTTP ${res.status}`);
        return [];
      }
      const body = (await res.json()) as ESPNRosterResponse;
      const athletes: ESPNRosterAthlete[] = [];
      for (const entry of body.athletes ?? []) {
        const group = entry as ESPNRosterGroup;
        if (Array.isArray(group.items)) {
          for (const raw of group.items) {
            const a = normalizeRosterAthlete(raw, group.position);
            if (a) athletes.push(a);
          }
        } else {
          const a = normalizeRosterAthlete(entry as ESPNRawAthlete);
          if (a) athletes.push(a);
        }
      }
      return athletes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] roster ${espnTeamId} fetch failed: ${message}`);
      return [];
    }
  }
}

function normalizeRosterAthlete(
  raw: ESPNRawAthlete,
  groupPosition?: string,
): ESPNRosterAthlete | null {
  if (!raw?.id) return null;
  const fullName = raw.fullName ?? raw.displayName;
  if (!fullName) return null;
  return {
    espn_athlete_id: String(raw.id),
    full_name: fullName,
    position: raw.position?.abbreviation ?? groupPosition,
    jersey: raw.jersey,
  };
}

function buildDescription(record: ESPNInjuryRecord): string {
  const parts: string[] = [];
  const detail = record.details;
  if (detail) {
    const fragments = [detail.side, detail.location, detail.type, detail.detail].filter(
      (x): x is string => Boolean(x && x.trim())
    );
    if (fragments.length > 0) parts.push(fragments.join(' '));
  }
  if (record.type?.description) parts.push(record.type.description);
  if (record.status) parts.push(`Status: ${record.status}`);
  if (record.shortComment) parts.push(record.shortComment);
  else if (record.longComment) parts.push(record.longComment);
  return parts.join(' — ').trim();
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractTeamTimeline(record: ESPNInjuryRecord): string | undefined {
  const text = `${record.shortComment ?? ''} ${record.longComment ?? ''} ${record.details?.returnDate ?? ''}`;
  const m = text.match(/(\d+\s*(?:-|to)\s*\d+\s*weeks?|\d+\s*weeks?|\d+\s*months?|day[- ]to[- ]day|week[- ]to[- ]week|out\s+for\s+(?:the\s+)?season)/i);
  if (m) return m[0];
  // Fall back to raw status when it carries a timeline hint
  if (record.status && /out|questionable|doubtful|day/i.test(record.status)) {
    return record.status;
  }
  return undefined;
}

function inferIsUpdate(status: string | undefined): boolean {
  if (!status) return false;
  // ESPN "Day-To-Day", "Questionable", "Probable" tend to be recurring status rows
  return /day-to-day|questionable|probable|doubtful/i.test(status);
}
