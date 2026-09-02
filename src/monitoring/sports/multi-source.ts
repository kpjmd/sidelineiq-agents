import type { RawInjuryEvent } from '../../types.js';
import { sourceFamilies, sourceFamily } from '../source-family.js';

/**
 * Why a fetch produced the events it did.
 *
 * `fetchLatestEvents()` returns [] for wildly different reasons — the feed was
 * genuinely empty, the source was off-cycle, or the upstream was down — and for
 * three weeks in July 2026 an empty Premier League feed was indistinguishable
 * from a dead one in the logs. The status makes that difference visible without
 * changing the never-throw contract that sources rely on.
 */
export type SourceFetchStatus =
  | 'ok' // fetched and produced events
  | 'empty' // fetched fine, upstream had nothing
  | 'skipped' // deliberately did not fetch (off-cycle, disabled, no API key)
  | 'degraded' // partial success (some sub-fetches failed)
  | 'error'; // the fetch itself failed

export interface SourceFetchReport {
  status: SourceFetchStatus;
  detail?: string;
}

/**
 * Common interface for any sport injury data source.
 * Implementations must never throw — return [] on failure.
 *
 * `lastFetchReport()` is optional; a source that does not implement it is
 * treated as 'ok'/'empty' based purely on the event count.
 */
export interface SportDataSource {
  readonly name: string;
  fetchLatestEvents(): Promise<RawInjuryEvent[]>;
  lastFetchReport?(): SourceFetchReport;
}

export interface NamedSourceReport extends SourceFetchReport {
  name: string;
  events: number;
}

export interface MultiSourceResult {
  events: RawInjuryEvent[];
  reports: NamedSourceReport[];
  errorCount: number;
}

/** Renders reports as one compact log line: `espn-nfl=ok(24) newsapi-nfl=skipped`. */
export function formatSourceReports(reports: NamedSourceReport[]): string {
  return reports
    .map((r) => {
      const count = r.status === 'ok' || r.status === 'degraded' ? `(${r.events})` : '';
      const detail = r.detail ? `[${r.detail}]` : '';
      return `${r.name}=${r.status}${count}${detail}`;
    })
    .join(' ');
}

/**
 * Composable wrapper that fetches from multiple sources in parallel,
 * deduplicates overlapping events, and keeps the richer record when
 * two sources report the same injury.
 *
 * Dedup key: lowercase(athlete_name) + sport + same calendar day.
 * Richness heuristic: prefer the record with a team_timeline; otherwise
 * the one with the longer injury_description.
 */
export class MultiSource implements SportDataSource {
  readonly name: string;
  constructor(private readonly sources: SportDataSource[]) {
    this.name = sources.map((s) => s.name).join('+') || 'multi-source(empty)';
  }

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    return (await this.fetchLatestEventsWithReport()).events;
  }

  async fetchLatestEventsWithReport(): Promise<MultiSourceResult> {
    if (this.sources.length === 0) return { events: [], reports: [], errorCount: 0 };

    const results = await Promise.allSettled(
      this.sources.map((s) => s.fetchLatestEvents())
    );

    const merged: RawInjuryEvent[] = [];
    const reports: NamedSourceReport[] = [];
    let errorCount = 0;

    results.forEach((result, i) => {
      const source = this.sources[i];
      if (result.status === 'fulfilled') {
        console.log(
          `[MultiSource:${this.name}] ${source.name} returned ${result.value.length} events`
        );
        merged.push(...result.value);
        // Trust the source's own account of what happened; fall back to
        // inferring from the count for sources that don't report.
        const self = source.lastFetchReport?.();
        const report = self ?? { status: result.value.length > 0 ? 'ok' : 'empty' as const };
        if (report.status === 'error') errorCount++;
        reports.push({ name: source.name, events: result.value.length, ...report });
      } else {
        // A source that throws is violating the never-throw contract, so it has
        // no report to give — synthesize one rather than losing the failure.
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[MultiSource:${this.name}] ${source.name} failed: ${reason}`);
        errorCount++;
        reports.push({ name: source.name, events: 0, status: 'error', detail: reason.slice(0, 80) });
      }
    });

    return { events: deduplicateEvents(merged), reports, errorCount };
  }
}

function eventKey(event: RawInjuryEvent): string {
  const name = event.athlete_name.trim().toLowerCase();
  const day = event.reported_at.toISOString().slice(0, 10);
  return `${event.sport}|${name}|${day}`;
}

function isRicher(candidate: RawInjuryEvent, existing: RawInjuryEvent): boolean {
  if (candidate.team_timeline && !existing.team_timeline) return true;
  if (!candidate.team_timeline && existing.team_timeline) return false;
  return (
    (candidate.injury_description?.length ?? 0) >
    (existing.injury_description?.length ?? 0)
  );
}

/**
 * Carries the loser's PUBLISHER onto the survivor before the loser is dropped.
 *
 * The merge itself is right — everything downstream wants one event per injury
 * — but it is also the only place in the pipeline that ever sees two
 * publishers on one story, and it used to throw that away with a console.log.
 * The defer queue's entire question is how many independent publishers said
 * this, so a same-day ESPN+Schefter pair has to arrive carrying both.
 */
function mergeProvenance(winner: RawInjuryEvent, loser: RawInjuryEvent): void {
  const own = sourceFamily(winner);
  const carried = new Set(winner.corroborating_families ?? []);
  for (const family of sourceFamilies(loser)) carried.add(family);
  // A survivor never corroborates itself.
  if (own) carried.delete(own);
  if (carried.size > 0) winner.corroborating_families = [...carried];
}

export function deduplicateEvents(events: RawInjuryEvent[]): RawInjuryEvent[] {
  const byKey = new Map<string, RawInjuryEvent>();
  for (const event of events) {
    const key = eventKey(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }

    // Log genuine cross-source merges (different source_name values). Both
    // directions: the incumbent-wins case used to be silent, which made a
    // second publisher on a story invisible in the logs half the time.
    const crossSource =
      !!event.source_name && !!existing.source_name && event.source_name !== existing.source_name;

    if (isRicher(event, existing)) {
      if (crossSource) {
        console.log(
          `[MultiSource] cross-source merge: ${key} — kept ${event.source_name}, dropped ${existing.source_name}`
        );
      }
      mergeProvenance(event, existing);
      byKey.set(key, event);
    } else {
      if (crossSource) {
        console.log(
          `[MultiSource] cross-source merge: ${key} — kept ${existing.source_name}, dropped ${event.source_name}`
        );
      }
      mergeProvenance(existing, event);
    }
  }
  return Array.from(byKey.values());
}
