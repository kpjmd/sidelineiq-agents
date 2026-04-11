import type { RawInjuryEvent } from '../../types.js';

/**
 * Common interface for any sport injury data source.
 * Implementations must never throw — return [] on failure.
 */
export interface SportDataSource {
  readonly name: string;
  fetchLatestEvents(): Promise<RawInjuryEvent[]>;
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
    if (this.sources.length === 0) return [];

    const results = await Promise.allSettled(
      this.sources.map((s) => s.fetchLatestEvents())
    );

    const merged: RawInjuryEvent[] = [];
    results.forEach((result, i) => {
      const source = this.sources[i];
      if (result.status === 'fulfilled') {
        console.log(
          `[MultiSource:${this.name}] ${source.name} returned ${result.value.length} events`
        );
        merged.push(...result.value);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[MultiSource:${this.name}] ${source.name} failed: ${reason}`);
      }
    });

    return deduplicateEvents(merged);
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

export function deduplicateEvents(events: RawInjuryEvent[]): RawInjuryEvent[] {
  const byKey = new Map<string, RawInjuryEvent>();
  for (const event of events) {
    const key = eventKey(event);
    const existing = byKey.get(key);
    if (!existing || isRicher(event, existing)) {
      byKey.set(key, event);
    }
  }
  return Array.from(byKey.values());
}
