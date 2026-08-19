import type { RawInjuryEvent, SportKey } from '../../types.js';
import type { SportDataSource, SourceFetchReport } from './multi-source.js';

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
    /**
     * ESPN's lapsed ESTIMATED return, NOT a carryover signal. 64 of 111 live
     * rows carry one BEFORE the row's own date, median lag −2 days; Mykel
     * Williams' is −6, indistinguishable from the pack. Declared so the shape
     * is documented, and deliberately NEVER copied onto RawInjuryEvent —
     * making it structurally unreachable from detectCarryoverSignals is a
     * stronger guarantee than a comment telling the next reader not to use it.
     */
    returnDate?: string;
    /**
     * Which roster LIST the player is on — a different question from `status`.
     * Williams is status "Out" and fantasyStatus "PUP-P".
     */
    fantasyStatus?: { description?: string; abbreviation?: string };
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
  /** Whole USD. Undefined when ESPN reports no contract — see extractSalary. */
  salary?: number;
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

export interface ESPNRawAthlete {
  id?: string | number;
  displayName?: string;
  fullName?: string;
  jersey?: string;
  position?: { abbreviation?: string };
  // ESPN serves contract data under two different keys depending on the
  // endpoint's mood, and both appear in live NFL and NBA responses. Neither
  // appears at all in soccer/eng.1, where athletes carry no contract field.
  contract?: { salary?: unknown };
  contracts?: Array<{ salary?: unknown }>;
  // Needed only to detect rookies, whose `salary` means something different.
  experience?: { years?: unknown };
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

  // Floor on a plausible /teams response, set below the real league size but
  // well above any truncation. fetchTeams() reads only sports[0].leagues[0] and
  // returns [] on any error, so a shape change upstream degrades to a SHORT
  // list, not an obviously broken one — and a short list is indistinguishable
  // from a mass relegation. Anything that reasons about which teams are MISSING
  // must refuse to run below this. Public because roster-sync reads it.
  readonly expectedMinTeams: number = 0;

  private report: SourceFetchReport = { status: 'empty' };

  lastFetchReport(): SourceFetchReport {
    return this.report;
  }

  async fetchLatestEvents(): Promise<RawInjuryEvent[]> {
    try {
      const res = await fetch(this.url, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        console.warn(`[${this.name}] HTTP ${res.status} from ${this.url}`);
        this.report = { status: 'error', detail: `HTTP ${res.status}` };
        return [];
      }
      const feed = (await res.json()) as ESPNInjuryFeed;
      const events = this.parse(feed);
      // An upstream that answers 200 with an empty feed is a data gap, not a
      // failure — ESPN's soccer injuries endpoint does exactly this. Reporting
      // it as 'empty' rather than staying silent is what surfaces the gap.
      this.report =
        events.length > 0 ? { status: 'ok' } : { status: 'empty', detail: this.emptyDetail(feed) };
      return events;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] fetch failed: ${message}`);
      this.report = { status: 'error', detail: message.slice(0, 80) };
      return [];
    }
  }

  /** Distinguishes "upstream sent no rows" from "our filters removed them all". */
  private emptyDetail(feed: ESPNInjuryFeed): string {
    const rows = (feed.injuries ?? []).reduce((n, g) => n + (g.injuries?.length ?? 0), 0);
    return rows === 0 ? 'no rows upstream' : `${rows} rows filtered out`;
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
          // Every event carries the SAME url — this is the league-wide injuries
          // endpoint, not a story. Anything keyed on source_url must know that.
          source_kind: 'feed',
          // The tagged athlete's OWN status, and the source's fielded view of
          // the injury. buildDescription() flattens `details` into prose that
          // downstream regexes then try to pick apart again; carrying the
          // fields themselves lets the fact validator read ESPN's answer
          // instead of re-deriving it. `status` additionally says whether the
          // tagged athlete is the injured one at all — a row on an Active
          // player exists to carry a comment about a teammate.
          ...(record.status && { athlete_status: record.status }),
          ...(record.details && {
            injury_details: {
              type: record.details.type,
              location: record.details.location,
              detail: record.details.detail,
              side: record.details.side,
            },
          }),
          // Prose context buildDescription drops (it takes shortComment and
          // discards longComment on 790 of 800 rows). Carried as a SIBLING so
          // injury_description stays byte-identical — it keys body-part
          // extraction, the classifier, significance, dedup and entity
          // matching. Only date resolution reads this.
          ...(record.longComment?.trim() && {
            injury_description_long: record.longComment.trim(),
          }),
          ...(record.details?.fantasyStatus?.abbreviation?.trim() && {
            roster_designation: record.details.fantasyStatus.abbreviation.trim(),
          }),
          ...(teamTimeline && { team_timeline: teamTimeline }),
          // Set ONLY when the status actually encodes a change. This source
          // has a status field, but it answers a different question — see
          // inferIsUpdate. An ABSENT key is what resolveUpdateSignal's
          // classifier fallback keys on, and for most rows absent is the
          // truthful answer.
          ...(isUpdate !== undefined && { is_update: isUpdate }),
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

/**
 * ESPN's reported annual contract salary in whole USD, or undefined when it
 * reports none.
 *
 * Two shapes, both live: `contract.salary` (a single object) covers ~62% of
 * NFL and NBA athletes, and falling back to `contracts[0].salary` (an array)
 * lifts that to 68% NFL / 74% NBA. Reading only the first would leave a tenth
 * of each league silently unsalaried. soccer/eng.1 athletes carry neither key,
 * which is why PREMIER_LEAGUE has no salary bands at all.
 *
 * Rejects anything that is not already a positive finite number rather than
 * coercing. A string "20000000" would coerce fine, but a "$20M" variant would
 * coerce to 20 — a salary of twenty dollars, which bands to the flat default
 * and is therefore indistinguishable from "no contract" in every log and every
 * output. Failing to read a new shape is recoverable; misreading one is not.
 *
 * ROOKIES ARE EXCLUDED, because for them `salary` means something else.
 * Verified against live rosters: Fernando Mendoza (experience 0) reports
 * salary $38,996,344 with yearsRemaining 3 and signedThrough 2029 — that is
 * the TOTAL value of his rookie deal, not an annual figure. Saquon Barkley
 * (experience 11) reports $16,750,100 with salaryRemaining $35,200,100, which
 * is plainly annual. Mixing the two units put five incoming NFL rookies into
 * tier 1 ahead of most of the league, which the dry-run caught before ship.
 *
 * salaryRemaining < salary looks like a cleaner discriminator and is not: the
 * NBA reports salaryRemaining as 0 for essentially every athlete, so it would
 * reject that whole league, and it also flags genuine veterans in a contract's
 * final years. Experience year 0 is the honest signal, and it costs 71 of 1851
 * salaried NFL athletes (5 would-be tier-1s, 17 tier-2s) and 1 of 322 in the
 * NBA. Those rookies fall back to tier 3 — the pre-existing default — and the
 * genuinely prominent ones are what athlete-tiers.json is for.
 *
 * A missing experience field is treated as "not a rookie". If ESPN stopped
 * sending it, rejecting instead would silently disable the feature league-wide,
 * which is far worse than re-admitting ~22 inflated rookies.
 *
 * Exported for direct unit testing — no network, no MCP, following the
 * diffCoverage precedent in roster-sync.
 */
export function extractSalary(raw: ESPNRawAthlete): number | undefined {
  const years = raw?.experience?.years;
  if (typeof years === 'number' && years === 0) return undefined;

  const single = raw?.contract?.salary;
  const fromArray = Array.isArray(raw?.contracts) ? raw.contracts[0]?.salary : undefined;
  const value = typeof single === 'number' ? single : fromArray;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
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
    salary: extractSalary(raw),
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

/**
 * Whether this row reports a CHANGE — or, far more often, whether ESPN simply
 * cannot say.
 *
 * `RawInjuryEvent.is_update` is a tri-state, and `undefined` means "this source
 * has nothing to answer the question with". This feed is one of those sources
 * for most of its rows, and returning a confident `false` for them was a
 * category error: ESPN's `status` is a STATE, not a DELTA. There is no change
 * indicator anywhere in the payload. "Out" does not mean "newly out" — and a
 * transition TO "Out", the most newsworthy transition in the sport, read here
 * as "not an update". `resolveUpdateSignal` treats a source-supplied `false` as
 * final, so that answer also blocked the classifier fallback built for exactly
 * this case. Across two NFL cycles in Aug 2026 every one of the six events that
 * reached PROCESS died at `entity_match_skip update_signal=source`.
 *
 * So: `true` ONLY for the day-to-day family, whose designations genuinely are a
 * live, re-evaluated availability question. Everything else — INCLUDING
 * "Active" and "Out" — returns undefined and lets the classifier's `is_new`
 * judgement stand in.
 *
 * `false` is now unreachable from this feed, and that is the honest answer: no
 * ESPN injuries status supports the claim "this report is not a change".
 *
 * "Active" gets the same treatment as "Out", and the intuition that they should
 * differ is the same category error one layer down: they sit at opposite ends
 * of the AVAILABILITY axis, while is_update asks about the NOVELTY axis, on
 * which ESPN publishes nothing at all.
 *
 * THE CHANGE IS MONOTONE — it can only turn a former `false` into `undefined`,
 * never a `true` into anything else. Every downstream effect therefore only
 * ADDS pass-throughs and can never remove one. See update-signal-inference.test.ts.
 *
 * Note "Injured Reserve" never reaches this function: SKIP_STATUS_RE drops
 * those rows earlier in parse(). Do not count them when reasoning about the
 * feed's status distribution.
 */
const DAY_TO_DAY_STATUS_RE = /day-to-day|questionable|probable|doubtful/i;

/**
 * `legacy` restores the pre-fix boolean, so the widest-blast-radius change in
 * this area is revertible from Railway without a deploy — the same lever shape
 * as ATHLETE_REANCHOR_MODE and MD_REVIEW_ANNOTATE_ONLY_CODES. Default is the
 * tri-state; `legacy` exists to be turned ON in an emergency, not left on.
 */
function legacyUpdateSignal(): boolean {
  return process.env.ESPN_UPDATE_SIGNAL_MODE === 'legacy';
}

function inferIsUpdate(status: string | undefined): boolean | undefined {
  if (legacyUpdateSignal()) return status ? DAY_TO_DAY_STATUS_RE.test(status) : false;
  if (!status) return undefined;
  return DAY_TO_DAY_STATUS_RE.test(status) ? true : undefined;
}
