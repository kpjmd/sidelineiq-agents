/**
 * `row_hash`: the hash of a published forecast row that is printed on the card
 * and committed with the row (spec "Ledger schema": "Hash of all fields above;
 * printed on the card"; "Provenance": "the commit timestamp and row_hash are the
 * proof of when the number went out").
 *
 * Three copies of this algorithm exist on purpose and must stay byte-identical:
 * this file, the mcp web server (`src/servers/web/ledger-hash.ts`, which stamps
 * the hash at publish), and the frontend (`lib/ledger-row-hash.ts`, which
 * re-verifies a row before rendering its card). All three are pinned by
 * `tests/fixtures/ledger-hash-cases.json`; change one, bump
 * LEDGER_HASH_VERSION, re-record the fixture, copy all three across.
 *
 * What is hashed, and why the normalisation is the whole point:
 *  - exactly the spec's forecast fields (entry_id … tier) plus published_at
 *    (D7: the timestamp is inside the hash). Provenance columns written AFTER
 *    publish — commit sha, social ids, confirmer — are outside it, or the hash
 *    could never be printed before they exist.
 *  - probabilities as 4-decimal STRINGS. The Neon driver returns NUMERIC as a
 *    string and the frontend's JSON round-trip returns a number; "0.18" and 0.18
 *    must hash the same, and 0.1 + 0.2 must not depend on who added.
 *  - published_at as a millisecond ISO UTC string. Postgres keeps microseconds
 *    and JS Dates do not, so the publish statement truncates to milliseconds
 *    first and this normalises whatever representation arrives.
 *  - injury_date as YYYY-MM-DD; a Date from the driver is reduced to its UTC
 *    calendar day, which is what a DATE column round-trips to.
 *  - absent optional values as null, so an omitted key and an explicit null are
 *    the same row.
 *  - hash_version inside the input, so a later change to this list produces a
 *    visibly different hash rather than a silently different one.
 *
 * Canonical JSON (keys sorted recursively, no whitespace) + sha256, the same
 * `canonicalize` the mcp repo's `src/shared/hash.ts` uses.
 */
import { createHash } from 'node:crypto';

export const LEDGER_HASH_VERSION = 1;

/** The columns of a forecast row that the hash covers, in spec order. */
export const LEDGER_HASH_FIELDS = [
  'entry_id',
  'version',
  'published_at',
  'trigger',
  'player',
  'team',
  'position',
  'injury_date',
  'reported_injury',
  'source_tier',
  'source_urls',
  'mechanism',
  'base_rate_row',
  'base_rate_strength',
  'f1_ir',
  'f2_next',
  'f3_4wk',
  'f4_point',
  'f4_low',
  'f4_high',
  'f5_reinjury',
  'season_ending',
  'what_moves_this',
  'tier',
] as const;

export type LedgerHashField = (typeof LEDGER_HASH_FIELDS)[number];

/** A forecast row as any of the three repos sees it. Loose on purpose; normalisation tightens it. */
export interface HashableForecastRow {
  entry_id: string;
  version: number | string;
  published_at: string | Date;
  trigger?: string | null;
  player: string;
  team: string;
  position: string;
  injury_date: string | Date;
  reported_injury: string;
  source_tier: string;
  source_urls: string[] | null | undefined;
  mechanism: string;
  base_rate_row: string;
  base_rate_strength: string;
  f1_ir: number | string;
  f2_next: number | string;
  f3_4wk: number | string;
  f4_point: number | string;
  f4_low: number | string;
  f4_high: number | string;
  f5_reinjury?: number | string | null;
  season_ending: boolean | string;
  what_moves_this: string;
  tier: number | string;
}

/** The normalised object that is canonicalised and hashed. */
export interface LedgerHashInput {
  hash_version: number;
  entry_id: string;
  version: number;
  published_at: string;
  trigger: string | null;
  player: string;
  team: string;
  position: string;
  injury_date: string;
  reported_injury: string;
  source_tier: string;
  source_urls: string[];
  mechanism: string;
  base_rate_row: string;
  base_rate_strength: string;
  f1_ir: string;
  f2_next: string;
  f3_4wk: string;
  f4_point: number;
  f4_low: number;
  f4_high: number;
  f5_reinjury: string | null;
  season_ending: boolean;
  what_moves_this: string;
  tier: number;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fail(field: string, value: unknown, why: string): never {
  throw new Error(`ledger row_hash: ${field} ${why}: ${JSON.stringify(value)}`);
}

function requireString(field: string, value: unknown): string {
  if (typeof value !== 'string') fail(field, value, 'must be a string');
  return value;
}

function requireInt(field: string, value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) fail(field, value, 'must be an integer');
  return n;
}

/** A probability in [0, 1] as a fixed 4-decimal string. */
export function normalizeProbability(field: string, value: unknown): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
    fail(field, value, 'must be a number in [0, 1]');
  }
  return n.toFixed(4);
}

/** A timestamp as a millisecond ISO UTC string. */
export function normalizeInstant(field: string, value: unknown): string {
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) fail(field, value, 'must be a timestamp');
  return d.toISOString();
}

/** A DATE column as YYYY-MM-DD. A Date from the driver is read as its UTC day. */
export function normalizeDate(field: string, value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(field, value, 'must be a date');
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return fail(field, value, 'must be a YYYY-MM-DD date');
}

function normalizeBool(field: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;
  return fail(field, value, 'must be a boolean');
}

/** Build the exact object that is hashed. Exported so a test can show the input beside the hash. */
export function ledgerHashInput(row: HashableForecastRow): LedgerHashInput {
  const urls = row.source_urls ?? [];
  if (!Array.isArray(urls) || urls.some((u) => typeof u !== 'string')) {
    fail('source_urls', row.source_urls, 'must be an array of strings');
  }
  const trigger = row.trigger == null || row.trigger === '' ? null : requireString('trigger', row.trigger);
  const version = requireInt('version', row.version);
  if (version > 1 && trigger === null) fail('trigger', row.trigger, 'is required when version > 1');
  const f4_point = requireInt('f4_point', row.f4_point);
  const f4_low = requireInt('f4_low', row.f4_low);
  const f4_high = requireInt('f4_high', row.f4_high);
  if (!(f4_low <= f4_point && f4_point <= f4_high)) {
    fail('f4', [f4_low, f4_point, f4_high], 'must satisfy low ≤ point ≤ high');
  }
  const tier = requireInt('tier', row.tier);
  if (tier !== 1 && tier !== 2) fail('tier', row.tier, 'must be 1 or 2');
  const source_tier = requireString('source_tier', row.source_tier);
  if (!['A', 'B', 'C'].includes(source_tier)) fail('source_tier', row.source_tier, 'must be A, B or C');
  const base_rate_strength = requireString('base_rate_strength', row.base_rate_strength);
  if (!['strong', 'moderate', 'thin'].includes(base_rate_strength)) {
    fail('base_rate_strength', row.base_rate_strength, 'must be strong, moderate or thin');
  }

  return {
    hash_version: LEDGER_HASH_VERSION,
    entry_id: requireString('entry_id', row.entry_id),
    version,
    published_at: normalizeInstant('published_at', row.published_at),
    trigger,
    player: requireString('player', row.player),
    team: requireString('team', row.team),
    position: requireString('position', row.position),
    injury_date: normalizeDate('injury_date', row.injury_date),
    reported_injury: requireString('reported_injury', row.reported_injury),
    source_tier,
    source_urls: [...urls],
    mechanism: requireString('mechanism', row.mechanism),
    base_rate_row: requireString('base_rate_row', row.base_rate_row),
    base_rate_strength,
    f1_ir: normalizeProbability('f1_ir', row.f1_ir),
    f2_next: normalizeProbability('f2_next', row.f2_next),
    f3_4wk: normalizeProbability('f3_4wk', row.f3_4wk),
    f4_point,
    f4_low,
    f4_high,
    f5_reinjury: row.f5_reinjury == null ? null : normalizeProbability('f5_reinjury', row.f5_reinjury),
    season_ending: normalizeBool('season_ending', row.season_ending),
    what_moves_this: requireString('what_moves_this', row.what_moves_this),
    tier,
  };
}

/** The 64-hex-character row hash. */
export function ledgerRowHash(row: HashableForecastRow): string {
  return sha256Hex(canonicalize(ledgerHashInput(row)));
}

/** The first 8 characters, as printed on the card and in post text. */
export function shortHash(rowHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(rowHash)) throw new Error(`not a row hash: ${JSON.stringify(rowHash)}`);
  return rowHash.slice(0, 8);
}
