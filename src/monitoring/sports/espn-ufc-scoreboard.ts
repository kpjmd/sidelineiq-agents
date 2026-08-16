// ESPN's MMA scoreboard, fetched over a rolling date window.
//
// Two callers with different needs read the same payload:
//
//   derived-tier-snapshot.ts — reads CARD POSITION to derive a fighter's tier.
//   roster-sync.ts           — reads IDENTITY to give UFC fighters player rows,
//                              which is what lets an injury_entity form for them.
//
// The fetch lives here rather than in either caller because the failure
// semantics are the interesting part and both callers need the same ones. A
// half-read window is worse than no read at all: for tiers it silently demotes
// every fighter in the missing pages, and for the roster it would make a
// fighter look absent from the sport. So a chunk that fails aborts the whole
// window and the caller keeps whatever it already had.
//
// Presence in this feed is trustworthy; ABSENCE is not. Nothing built on it may
// treat a fighter's absence as news about the world — no un-tiering, and above
// all no deleting of player rows.

const UFC_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard';

/** ESPN rejects very wide ranges; the window is fetched in chunks of this size. */
const SCOREBOARD_CHUNK_DAYS = 120;

/**
 * One fighter's slot in a bout.
 *
 * The ESPN athlete id is on the COMPETITOR, not on the nested athlete object —
 * `competitor.athlete.id` is undefined on every row of the live feed, while
 * `competitor.id` carries it (verified 2026-08-16 across the full ±(180/90)-day
 * window: 547 fighters, all with a competitor id). An earlier version of this
 * interface declared `athlete.id` and nothing ever read it, which is how the
 * mistake stayed invisible.
 */
export interface ScoreboardCompetitor {
  /** The ESPN athlete id. Stable, and the key player rows are upserted on. */
  id?: string;
  athlete?: {
    id?: string;
    displayName?: string;
    accolades?: Array<{ type?: string; name?: string }>;
  };
}

export interface ScoreboardCompetition {
  competitors?: ScoreboardCompetitor[];
}

export interface ScoreboardEvent {
  name?: string;
  date?: string;
  competitions?: ScoreboardCompetition[];
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchScoreboardChunk(from: Date, to: Date): Promise<ScoreboardEvent[] | null> {
  const url = `${UFC_SCOREBOARD_URL}?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=100`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`[UFCScoreboard] HTTP ${res.status} for ${url}`);
      return null;
    }
    const body = (await res.json()) as { events?: ScoreboardEvent[] };
    return body.events ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[UFCScoreboard] fetch failed: ${message}`);
    return null;
  }
}

/**
 * Every UFC event on, or booked for, the scoreboard between `windowBackDays`
 * ago and `windowForwardDays` from now. Returns null — never a partial list —
 * if any chunk fails or if the whole window comes back empty.
 *
 * The window looks BACKWARD as well as forward on purpose: an injury story is
 * usually about a fight that already happened ("McGregor suffered an ACL tear
 * in his return"), and recovery outlives the event by months. Forward-looking
 * matters for the opposite reason — an announced bout is precisely what makes a
 * current injury newsworthy, which is the fight-date conflict protocol in
 * SKILL.md §3.5.
 */
export async function fetchUfcScoreboardEvents(
  windowBackDays: number,
  windowForwardDays: number,
  now: Date = new Date(),
): Promise<ScoreboardEvent[] | null> {
  const start = new Date(now.getTime() - windowBackDays * 86400000);
  const end = new Date(now.getTime() + windowForwardDays * 86400000);

  const events: ScoreboardEvent[] = [];
  for (let from = start; from < end; ) {
    const to = new Date(Math.min(from.getTime() + SCOREBOARD_CHUNK_DAYS * 86400000, end.getTime()));
    const chunk = await fetchScoreboardChunk(from, to);
    // A failed chunk is a failed page, not a bad row: we do not know what we
    // missed, and a fighter silently absent is indistinguishable from one who
    // was never there.
    if (chunk === null) {
      console.warn('[UFCScoreboard] chunk failed — abandoning this read');
      return null;
    }
    events.push(...chunk);
    from = new Date(to.getTime() + 86400000);
  }

  if (events.length === 0) {
    console.warn(
      '[UFCScoreboard] zero events across the whole window — treating as a failed read ' +
        'rather than an empty sport',
    );
    return null;
  }

  return events;
}

/**
 * Dana White's Contender Series is a developmental show, not a UFC card. Its
 * fighters are not yet on the roster and main-eventing one says nothing about
 * prominence — including it would hand tier 2 to debutants.
 */
export function isExcludedEvent(eventName: string): boolean {
  return /contender series/i.test(eventName);
}

/**
 * ESPN books announced-but-unfilled bouts against a placeholder competitor —
 * "TBA", "Opponent TBA". They are not people, and a main-event placeholder
 * would otherwise be indexed as a tier-1 "fighter" whose name a news article
 * could conceivably match — or, now, minted as a player row.
 */
export function isPlaceholderFighter(name: string): boolean {
  return /^(tba|tbd|opponent tba|opponent tbd|to be announced)$/i.test(name.trim());
}
