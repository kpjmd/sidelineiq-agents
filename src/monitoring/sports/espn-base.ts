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
  team?: { displayName?: string; name?: string; abbreviation?: string };
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

    for (const group of teamGroups) {
      const teamName = group.team?.displayName ?? group.team?.name ?? 'Unknown';
      const records = group.injuries ?? [];

      for (const record of records) {
        const athleteName = record.athlete?.displayName ?? record.athlete?.fullName;
        if (!athleteName) continue;

        const description = buildDescription(record);
        if (!description) continue;

        const reportedAt = parseDate(record.date) ?? new Date();
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
