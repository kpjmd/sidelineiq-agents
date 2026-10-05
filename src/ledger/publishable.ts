/**
 * The row shape the publish path accepts, and the ONE check that narrows a
 * stored `ledger_forecasts` row to it (spec "Provenance": no card and no post
 * without entry id, version and row_hash; "Automation boundary": the system
 * records who confirmed and when).
 *
 * `assertPublishable` is the first line of `publishLedgerForecast` and the
 * precondition of every text builder in post-text.ts. A draft, a row with no
 * hash, a row nobody confirmed, or a row whose stored hash does not re-derive
 * from its own fields is refused here, before anything is rendered — so there is
 * no code path by which unconfirmed content reaches a social tool or the ledger
 * repository. Pure; no I/O.
 */
import { ledgerRowHash, type HashableForecastRow } from './row-hash.js';

/** A `ledger_forecasts` row as web_get_ledger_forecast returns it (NUMERIC as strings, dates as ISO strings after JSON). */
export interface LedgerForecastRow extends HashableForecastRow {
  id: string;
  status: 'draft' | 'published';
  entry_id: string;
  version: number | string;
  published_at: string | Date;
  row_hash: string | null;
  confirmed_by: string | null;
  confirmed_at: string | Date | null;
  commit_sha: string | null;
  commit_url: string | null;
  x_post_id: string | null;
  x_self_reply_id: string | null;
  farcaster_hash: string | null;
  reply_to_url: string | null;
  espn_athlete_id?: string | null;
  gsis_id?: string | null;
  pfr_id?: string | null;
  nflverse_team?: string | null;
  season?: number | null;
}

/** The narrowed type: every field a card, post or commit needs is present and verified. */
export interface PublishedLedgerRow extends LedgerForecastRow {
  status: 'published';
  entry_id: string;
  version: number;
  published_at: string;
  row_hash: string;
  confirmed_by: string;
}

export class LedgerNotPublishableError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`ledger row is not publishable: ${reasons.join('; ')}`);
    this.name = 'LedgerNotPublishableError';
    this.reasons = reasons;
  }
}

const ENTRY_ID_RE = /^PT-\d{4}-\d{3,}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Narrow a stored row or throw with every reason at once. Collects rather than
 * stops at the first, because the operator reading a 422 needs the whole list.
 */
export function assertPublishable(row: unknown): asserts row is PublishedLedgerRow {
  const reasons: string[] = [];
  const r = (row ?? {}) as Partial<LedgerForecastRow>;
  if (typeof row !== 'object' || row === null) reasons.push('row is not an object');
  if (r.status !== 'published') reasons.push(`status is ${JSON.stringify(r.status)}, not published`);
  if (typeof r.entry_id !== 'string' || !ENTRY_ID_RE.test(r.entry_id)) reasons.push('entry_id missing or malformed');
  const version = typeof r.version === 'string' ? Number(r.version) : r.version;
  if (!Number.isInteger(version) || (version as number) < 1) reasons.push('version missing');
  if (r.published_at == null || Number.isNaN(new Date(r.published_at).getTime())) reasons.push('published_at missing');
  if (typeof r.row_hash !== 'string' || !HASH_RE.test(r.row_hash)) reasons.push('row_hash missing');
  if (typeof r.confirmed_by !== 'string' || r.confirmed_by.length === 0) reasons.push('confirmed_by missing');
  if (reasons.length === 0) {
    // The stored hash must re-derive from the stored fields. A row whose hash
    // does not is either corrupt or produced by a different hash version, and
    // the card would print a hash8 that verifies nothing.
    let derived: string | null = null;
    try {
      derived = ledgerRowHash(r as HashableForecastRow);
    } catch (err) {
      reasons.push(`row_hash cannot be re-derived: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (derived !== null && derived !== r.row_hash) reasons.push('row_hash does not match the stored fields');
  }
  if (reasons.length > 0) throw new LedgerNotPublishableError(reasons);
  // Normalise the two fields callers read as numbers/strings.
  (row as PublishedLedgerRow).version = version as number;
  (row as PublishedLedgerRow).published_at = new Date(r.published_at as string | Date).toISOString();
}
