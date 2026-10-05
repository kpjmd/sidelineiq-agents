/**
 * A published ledger_forecasts row for tests, built from the RECORDED hash
 * fixture's first case so its row_hash is the one every repo agrees on. No
 * entry has been published live yet, so there is nothing to record; when the
 * first real row exists, replace this with tests/fixtures/ledger-published-row.json
 * recorded from web_get_ledger_forecast and keep the shape.
 */
import { ledgerRowHash } from '../../src/ledger/row-hash.js';
import type { LedgerForecastRow } from '../../src/ledger/publishable.js';
import hashFixture from '../fixtures/ledger-hash-cases.json' with { type: 'json' };

export const FORECAST_ID = '44444444-4444-4444-8444-444444444444';
export const MD_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A row whose hashed CONTENT was changed after the hash was stamped — the
 * tampered row assertPublishable must refuse. `publishedRow` hashes after the
 * overrides (a legitimately different row); this hashes before them.
 */
export function tamperedRow(overrides: Partial<LedgerForecastRow>): LedgerForecastRow {
  const row = publishedRow();
  Object.assign(row, overrides);
  return row;
}

export function publishedRow(overrides: Partial<LedgerForecastRow> = {}): LedgerForecastRow {
  const input = hashFixture.cases[0].input as Record<string, unknown>;
  const row = {
    id: FORECAST_ID,
    status: 'published',
    ...input,
    // NUMERIC comes back from the driver as strings; the row the publish
    // function reads looks like this, not like the fixture's numbers.
    f1_ir: String((input.f1_ir as number).toFixed(4)),
    f2_next: String((input.f2_next as number).toFixed(4)),
    f3_4wk: String((input.f3_4wk as number).toFixed(4)),
    f5_reinjury: input.f5_reinjury == null ? null : String((input.f5_reinjury as number).toFixed(4)),
    row_hash: null,
    confirmed_by: MD_ID,
    confirmed_at: '2026-10-06T18:04:05.123Z',
    commit_sha: null,
    commit_url: null,
    x_post_id: null,
    x_self_reply_id: null,
    farcaster_hash: null,
    reply_to_url: 'https://x.com/AdamSchefter/status/1972000000000000001',
    espn_athlete_id: '4262921',
    gsis_id: '00-0036322',
    pfr_id: 'ExamPl00',
    nflverse_team: 'BUF',
    season: 2026,
    ...overrides,
  } as LedgerForecastRow;
  if (!('row_hash' in overrides)) {
    try {
      row.row_hash = ledgerRowHash(row);
    } catch {
      row.row_hash = null; // the override made the row unhashable; the guard reports both
    }
  }
  return row;
}

export const mcpText = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
export const mcpError = (message: string) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] });
