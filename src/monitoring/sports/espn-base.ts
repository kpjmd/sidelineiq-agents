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
 * Base class for ESPN injury-feed sources (NFL, NBA, Premier League).
 * Subclasses only need to provide url, sport, and source name.
 */
export abstract class ESPNInjurySource implements SportDataSource {
  abstract readonly name: string;
  protected abstract readonly sport: SportKey;
  protected abstract readonly url: string;

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
        t?.displayName ??
        t?.shortDisplayName ??
        (t?.location && t?.name ? `${t.location} ${t.name}` : undefined) ??
        t?.name ??
        t?.abbreviation ??
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
          ...(teamTimeline && { team_timeline: teamTimeline }),
          ...(isUpdate && { is_update: true }),
        });
      }
    }

    console.log(`[${this.name}] ${events.length} events after recency+status filter (${maxAgeMs / 86400000}d window)`);
    return events;
  }
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
