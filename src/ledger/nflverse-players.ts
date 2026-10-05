/**
 * The nflverse player crosswalk (`players.csv`), used by the draft form to show
 * the gsis_id and pfr_id a forecast row will carry, and by Stage 3's resolution
 * ingest to key snap counts and injury reports (plan D1–D3; pre-registration
 * "Identity": a player missing an id is UNRESOLVABLE and is surfaced, never
 * matched by name).
 *
 * The file is ~7 MB and refreshes daily, so it is fetched once per 24h into
 * process memory (the agents service is long-lived on Railway) and looked up by
 * ESPN athlete id only. A fetch that fails or parses to nothing keeps the stale
 * cache and reports it — a transient error must never read as "no such player".
 */

export const NFLVERSE_PLAYERS_URL = 'https://github.com/nflverse/nflverse-data/releases/download/players/players.csv';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface NflversePlayer {
  espn_id: string;
  gsis_id: string | null;
  pfr_id: string | null;
  display_name: string;
  latest_team: string | null;
  position: string | null;
  status: string | null;
}

export type NflverseLookup =
  | {
      status: 'resolved';
      espn_id: string;
      gsis_id: string;
      pfr_id: string;
      nflverse_team: string | null;
      display_name: string;
      position: string | null;
      source_fetched_at: string;
    }
  | {
      status: 'unresolved';
      espn_id: string;
      /** no_row: the id is not in players.csv; missing_ids: the row lacks gsis_id and/or pfr_id. */
      reason: 'no_row' | 'missing_ids';
      missing: Array<'gsis_id' | 'pfr_id'>;
      partial: Partial<Pick<NflversePlayer, 'gsis_id' | 'pfr_id' | 'display_name' | 'latest_team' | 'position'>> | null;
      source_fetched_at: string;
    };

export class NflverseUnavailableError extends Error {
  constructor(message: string) {
    super(`nflverse players.csv unavailable: ${message}`);
    this.name = 'NflverseUnavailableError';
  }
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. Enough for players.csv. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const REQUIRED_COLUMNS = ['espn_id', 'gsis_id', 'pfr_id', 'display_name', 'latest_team', 'position', 'status'] as const;

/** Index the CSV by ESPN id. Throws when the header lacks a column we key on. */
export function indexPlayersCsv(text: string): Map<string, NflversePlayer> {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new NflverseUnavailableError('empty file');
  const header = rows[0];
  const col = new Map(header.map((h, i) => [h, i] as const));
  const missing = REQUIRED_COLUMNS.filter((c) => !col.has(c));
  if (missing.length > 0) throw new NflverseUnavailableError(`header lacks ${missing.join(', ')}`);
  const at = (r: string[], name: (typeof REQUIRED_COLUMNS)[number]): string | null => {
    const v = r[col.get(name)!];
    return v === undefined || v === '' || v === 'NA' ? null : v;
  };
  const byEspn = new Map<string, NflversePlayer>();
  for (const r of rows.slice(1)) {
    const espn = at(r, 'espn_id');
    if (!espn) continue;
    byEspn.set(espn, {
      espn_id: espn,
      gsis_id: at(r, 'gsis_id'),
      pfr_id: at(r, 'pfr_id'),
      display_name: at(r, 'display_name') ?? '',
      latest_team: at(r, 'latest_team'),
      position: at(r, 'position'),
      status: at(r, 'status'),
    });
  }
  if (byEspn.size === 0) throw new NflverseUnavailableError('no rows carry an espn_id');
  return byEspn;
}

interface Cache {
  fetchedAt: number;
  byEspn: Map<string, NflversePlayer>;
}

export interface NflverseDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  url?: string;
  ttlMs?: number;
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

export function _resetNflverseCacheForTests(): void {
  cache = null;
  inflight = null;
}

async function load(deps: NflverseDeps): Promise<Cache> {
  const url = deps.url ?? process.env.NFLVERSE_PLAYERS_URL ?? NFLVERSE_PLAYERS_URL;
  let res: Response;
  try {
    res = await deps.fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
  } catch (err) {
    throw new NflverseUnavailableError(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new NflverseUnavailableError(`HTTP ${res.status}`);
  const text = await res.text();
  return { fetchedAt: deps.now(), byEspn: indexPlayersCsv(text) };
}

async function ensure(deps: NflverseDeps): Promise<Cache> {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  if (cache && deps.now() - cache.fetchedAt < ttl) return cache;
  if (!inflight) {
    inflight = load(deps)
      .then((c) => {
        cache = c;
        return c;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    // Keep serving the stale index rather than turning a transient fetch
    // failure into "unresolved" for every player.
    if (cache) {
      console.warn(`[Ledger] nflverse refresh failed, serving stale index from ${new Date(cache.fetchedAt).toISOString()}: ${err instanceof Error ? err.message : String(err)}`);
      return cache;
    }
    throw err;
  }
}

/** The ids a forecast row carries for the resolution ingest, by ESPN athlete id. Never by name. */
export async function lookupNflverseIds(espnId: string, deps: NflverseDeps = { fetch: fetch as NflverseDeps['fetch'], now: Date.now }): Promise<NflverseLookup> {
  const id = espnId.trim();
  if (!/^\d{1,12}$/.test(id)) throw new Error(`espn_id must be numeric: ${JSON.stringify(espnId)}`);
  const c = await ensure(deps);
  const fetchedAt = new Date(c.fetchedAt).toISOString();
  const p = c.byEspn.get(id);
  if (!p) return { status: 'unresolved', espn_id: id, reason: 'no_row', missing: ['gsis_id', 'pfr_id'], partial: null, source_fetched_at: fetchedAt };
  const missing: Array<'gsis_id' | 'pfr_id'> = [];
  if (!p.gsis_id) missing.push('gsis_id');
  if (!p.pfr_id) missing.push('pfr_id');
  if (missing.length > 0) {
    return {
      status: 'unresolved',
      espn_id: id,
      reason: 'missing_ids',
      missing,
      partial: { gsis_id: p.gsis_id, pfr_id: p.pfr_id, display_name: p.display_name, latest_team: p.latest_team, position: p.position },
      source_fetched_at: fetchedAt,
    };
  }
  return {
    status: 'resolved',
    espn_id: id,
    gsis_id: p.gsis_id as string,
    pfr_id: p.pfr_id as string,
    nflverse_team: p.latest_team,
    display_name: p.display_name,
    position: p.position,
    source_fetched_at: fetchedAt,
  };
}
