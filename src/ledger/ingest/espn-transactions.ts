/**
 * The transaction wire (plan D2; docs/ledger-preregistration.md "Sources"):
 * ESPN's NFL transactions feed, read for F1 (IR placement) and for the void
 * triggers (trade, release, retirement, suspension).
 *
 * The feed is prose. Every reading of it is a PROPOSAL that quotes the clause
 * it came from, and the physician confirms it. This is the ONE place the ingest
 * reads an athlete's name (decision S3-4, 2026-10-07): a transaction sentence
 * carries no id. The match is evidence selection for a human, scoped to the
 * entry's team, never identity resolution — no snap, schedule or injury-report
 * fact is ever keyed on a name.
 *
 * Shape (verified live 2026-10-07):
 *   GET …/nfl/transactions?limit=50&page=N&season=YYYY
 *   { count, pageIndex, pageCount, transactions: [{ date: "2026-10-03T07:00Z",
 *     description: "Placed LT Braxton Jones on injured reserve. Elevated …",
 *     team: { abbreviation, displayName, name, location, … } }] }
 *   - `season` is a CALENDAR year (2025 ends with 2025-12-31 items).
 *   - `page` pages; `pageIndex` is ignored by the API.
 *   - newest first; dates are midnight Eastern, so the ET calendar date is the day.
 *   - ESPN spells two teams differently from nflverse: LAR → LA, WSH → WAS.
 *
 * Prose traps, each a test case:
 *   "Designated X to return from injured reserve"   not an IR placement
 *   "Activated X from injured reserve"              not an IR placement
 *   "Waived X from injured reserve"                 a release, not IR
 *   "Waived X with an injury designation"           a release
 *   "Placed Cs Jovaughn Gwyn and Ethan Pocic on …"  plural position token
 *   "T Lane Johnson announced his retirement"       retirement, position-led
 *   "Placed X on the reserve/non-football injury list" not IR
 *
 * Failure policy: every page is fetched through `fetchEspnJson`. A timeout,
 * 429 or 5xx throws `TransientEspnError` (bad PAGE). A 404 returns null, and
 * here that is ALSO a bad page: there is no row-level fetch on this feed, and a
 * missing page read as "no transactions" would resolve F1 to 0 on a player who
 * was placed on IR. So every non-answer aborts the cycle.
 */
import { fetchEspnJson, TransientEspnError } from '../../monitoring/sports/espn-json.js';
import { type IsoDate, compareDates, etCalendarDate } from '../dates.js';
import { TRANSACTIONS_URL, type TransactionEvent, type TransactionKind } from '../rules.js';

export const ESPN_TRANSACTIONS_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/transactions';
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 60;

/** ESPN abbreviation → nflverse (games.csv) abbreviation, where they differ. */
const ESPN_TO_NFLVERSE: Readonly<Record<string, string>> = Object.freeze({ LAR: 'LA', WSH: 'WAS' });

export function nflverseTeamOf(espnAbbr: string): string {
  const a = espnAbbr.trim().toUpperCase();
  return ESPN_TO_NFLVERSE[a] ?? a;
}

export interface RawTransaction {
  date: string;
  description: string;
  team: { abbreviation: string; displayName?: string; name?: string; location?: string };
}

/** One classified clause of one transaction item. */
export interface ClauseEvent {
  kind: TransactionKind;
  /** ET calendar date of the item. */
  date: IsoDate;
  /** nflverse abbreviation of the team the item is filed under. */
  team: string;
  /** The sentence the kind was read from — what the physician sees. */
  clause: string;
  /** The full item description, for context. */
  description: string;
}

// ── Sentence splitting ─────────────────────────────────────────────────

const LEADING_VERBS =
  'Placed|Signed|Released|Waived|Activated|Designated|Elevated|Promoted|Acquired|Traded|Claimed|Reinstated|Suspended|Re-signed|Exercised|Agreed|Restored|Recalled|Terminated|Converted|Announced|Removed|Moved|Added|Named|Hired|Fired|Extended|Retired|Declined|Reverted|Granted|Assigned|Returned|Received|Sent';

/**
 * Split an item into sentences. A period followed by a space and a capital
 * ends a sentence, EXCEPT after an initial or a generational suffix ("A.J.",
 * "Jr.") — unless the next word is a transaction verb, which always starts one.
 */
export function splitSentences(description: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /\.\s+(?=[A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    const before = description.slice(start, m.index);
    const lastWord = /([A-Za-z]+)$/.exec(before)?.[1] ?? '';
    const next = description.slice(m.index + m[0].length);
    const nextIsVerb = new RegExp(`^(${LEADING_VERBS})\\b`).test(next);
    const isAbbrev = /^(Jr|Sr|St|Mr|[A-Z])$/.test(lastWord) || /\b[A-Z]\.[A-Z]$/.test(before);
    if (isAbbrev && !nextIsVerb) continue;
    out.push(description.slice(start, m.index + 1).trim());
    start = m.index + m[0].length;
  }
  const tail = description.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.length > 0);
}

// ── Classification ─────────────────────────────────────────────────────

const IR_RE = /\bplaced\b[^.]*?\bon\s+(?:the\s+)?(?:injured\s+reserve|reserve\/injured)\b/i;
const NOT_IR_RE = /\b(?:return|returned|activated|reinstated)\s+(?:\w+\s+){0,6}?from\s+(?:the\s+)?(?:injured\s+reserve|reserve\/injured)\b/i;
const TRADE_RE = /\b(?:traded|acquired)\b/i;
const RELEASE_RE = /\b(?:released|waived|terminated\s+the\s+contract)\b/i;
const RETIRE_RE = /\b(?:retired|retirement|retires)\b/i;
const SUSPEND_RE = /\b(?:suspended|reserve\/suspended)\b/i;
const REINSTATE_RE = /\breinstated\b/i;

/**
 * The kind of one sentence, or null when it is none of the five the rules read.
 * Order matters: a waiver "from injured reserve" is a release, and "designated
 * to return from injured reserve" is nothing.
 */
export function classifySentence(sentence: string): TransactionKind | null {
  if (RELEASE_RE.test(sentence)) return 'RELEASE';
  if (TRADE_RE.test(sentence)) return 'TRADE';
  if (RETIRE_RE.test(sentence)) return 'RETIRE';
  if (REINSTATE_RE.test(sentence)) return null;
  if (SUSPEND_RE.test(sentence)) return 'SUSPEND';
  if (NOT_IR_RE.test(sentence)) return null;
  if (IR_RE.test(sentence)) return 'IR';
  return null;
}

export function extractTransactionEvents(item: RawTransaction): ClauseEvent[] {
  const ms = Date.parse(item.date);
  if (Number.isNaN(ms) || typeof item.description !== 'string' || !item.team?.abbreviation) return [];
  const date = etCalendarDate(new Date(ms));
  const team = nflverseTeamOf(item.team.abbreviation);
  const out: ClauseEvent[] = [];
  for (const clause of splitSentences(item.description)) {
    const kind = classifySentence(clause);
    if (kind) out.push({ kind, date, team, clause, description: item.description });
  }
  return out;
}

// ── Attribution (the one name read; S3-4) ──────────────────────────────

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** Lower-case, drop periods/apostrophes, collapse punctuation to spaces, drop suffixes. */
export function normalizePersonName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(' ');
}

/** True when the normalized full name appears as a whole phrase in the normalized clause. */
export function clauseNamesPlayer(clause: string, player: string): boolean {
  const name = normalizePersonName(player);
  if (!name.includes(' ')) return false; // a bare surname is never enough
  const text = ` ${normalizePersonName(clause)} `;
  return text.includes(` ${name} `);
}

export interface AttributionTarget {
  /** The forecast row's `player`, as published. */
  player: string;
  /** nflverse abbreviation of the entry's team. */
  team: string;
  /** Team names as ESPN prints them (displayName, name, location), for a trade filed under the OTHER club. */
  teamNames: readonly string[];
}

/**
 * The events about THIS athlete: filed under the entry's team and naming him,
 * or a TRADE filed under another club whose sentence also names the entry's
 * team ("Acquired WR X from the Baltimore Ravens"). Returned as the rules'
 * TransactionEvent with the clause as the evidence sentence.
 */
export function attributeTransactions(events: readonly ClauseEvent[], target: AttributionTarget): TransactionEvent[] {
  const names = target.teamNames.filter((n) => n && n.length >= 4).map((n) => n.toLowerCase());
  const out: TransactionEvent[] = [];
  for (const e of events) {
    if (!clauseNamesPlayer(e.clause, target.player)) continue;
    const sameTeam = e.team === target.team;
    const tradeElsewhere = !sameTeam && e.kind === 'TRADE' && names.some((n) => e.clause.toLowerCase().includes(n));
    if (!sameTeam && !tradeElsewhere) continue;
    out.push({ kind: e.kind, date: e.date, team: e.team, sentence: e.clause, url: TRANSACTIONS_URL });
  }
  return out.sort((a, b) => compareDates(a.date, b.date) || a.kind.localeCompare(b.kind));
}

/** nflverse abbreviation → the names ESPN uses for that team, learned from the items themselves. */
export function teamNamesFrom(items: readonly RawTransaction[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const it of items) {
    const t = it.team;
    if (!t?.abbreviation) continue;
    const key = nflverseTeamOf(t.abbreviation);
    if (map.has(key)) continue;
    map.set(key, [t.displayName, t.name].filter((x): x is string => typeof x === 'string' && x.length > 0));
  }
  return map;
}

// ── Fetch ──────────────────────────────────────────────────────────────

export type FetchJson = (url: string) => Promise<unknown>;

export class TransactionsUnavailableError extends Error {
  constructor(message: string) {
    super(`ESPN transactions unavailable: ${message}`);
    this.name = 'TransactionsUnavailableError';
  }
}

interface TransactionsPage {
  pageCount?: number;
  transactions?: RawTransaction[];
}

/**
 * Every transaction dated on or after `since` (ET), for each calendar year from
 * `since`'s year to `untilYear`. Pages newest-first and stops a year once a
 * page's oldest item predates `since`. Any non-answer throws.
 */
export async function fetchTransactionsSince(
  since: IsoDate,
  untilYear: number,
  fetchJson: FetchJson = fetchEspnJson,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<RawTransaction[]> {
  const out: RawTransaction[] = [];
  const firstYear = Number(since.slice(0, 4));
  for (let year = firstYear; year <= untilYear; year++) {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${ESPN_TRANSACTIONS_API}?limit=${PAGE_SIZE}&page=${page}&season=${year}`;
      let body: unknown;
      try {
        body = await fetchJson(url);
      } catch (err) {
        if (err instanceof TransientEspnError) throw new TransactionsUnavailableError(`${url}: ${err.message}`);
        throw err;
      }
      if (body === null) throw new TransactionsUnavailableError(`${url}: HTTP 404`);
      const p = body as TransactionsPage;
      if (!Array.isArray(p.transactions)) throw new TransactionsUnavailableError(`${url}: no transactions array`);
      out.push(...p.transactions);
      const pageCount = typeof p.pageCount === 'number' ? p.pageCount : page;
      const dates = p.transactions.map((t) => Date.parse(t.date)).filter((n) => !Number.isNaN(n));
      const oldest = dates.length ? etCalendarDate(new Date(Math.min(...dates))) : null;
      if (page >= pageCount || p.transactions.length === 0) break;
      if (oldest !== null && compareDates(oldest, since) < 0) break;
      if (page === maxPages) throw new TransactionsUnavailableError(`${year}: more than ${maxPages} pages before ${since}`);
    }
  }
  return out.filter((t) => {
    const ms = Date.parse(t.date);
    return !Number.isNaN(ms) && compareDates(etCalendarDate(new Date(ms)), since) >= 0;
  });
}
