/**
 * Scoreboard assembly, card text and the two Stage 3 routes. The boards' own
 * arithmetic is pinned by ledger-scoring-cases.json; this file pins what is
 * built AROUND it: the CSV recomputes to the boards, the card text carries the
 * static elements and no forbidden word, and the routes never exceed the env.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { buildScoreboardReport, ledgerCsv, type LedgerExportPayload } from '../src/ledger/scoreboard.js';
import { buildResolutionCardText, buildScoreboardCardText, outcomeWords } from '../src/ledger/card-text.js';
import { summarizeLedger } from '../src/ledger/scoring.js';
import { LEDGER_COPY, findForbiddenWords } from '../src/ledger/copy.js';
import { parseCsv } from '../src/ledger/nflverse-players.js';
import { registerLedgerAdminRoutes, requestIngestMode, type LedgerRouteDeps } from '../src/ledger/admin-routes.js';
import fixture from './fixtures/ledger-scoring-cases.json' with { type: 'json' };
import { recordedExport } from './helpers/ledger-ingest-fixture.js';

type Case = { name: string; forecasts: LedgerExportPayload['forecasts']; resolutions: LedgerExportPayload['resolutions'] };
const first = (fixture as unknown as { cases: Case[] }).cases[0];
// The scoring fixture's first case, with every resolution confirmed on 2026-10-06.
const payload: LedgerExportPayload = { forecasts: first.forecasts, resolutions: first.resolutions.map((r) => ({ ...r, confirmed_at: r.status === 'open' ? null : '2026-10-06T15:00:00.000Z' })) };

describe('CSV export', () => {
  it('has one row per resolution and recomputes to the same boards', () => {
    const rows = parseCsv(ledgerCsv(payload)).filter((r) => r.length > 1);
    const header = rows[0];
    const at = (r: string[], c: string) => r[header.indexOf(c)];
    expect(rows.length - 1).toBe(payload.resolutions.length);
    // Rebuild v1 + latest rows from the CSV alone and score them.
    const forecasts = new Map<string, Record<string, unknown>>();
    const res = rows.slice(1).map((r) => ({ entry_id: at(r, 'entry_id'), field: at(r, 'field') as 'F1', status: at(r, 'status') as 'open', outcome: at(r, 'outcome') || null, freeze_at: at(r, 'freeze_at') || null, void_reason: at(r, 'void_reason') || null }));
    const col: Record<string, string> = { F1: 'f1_ir', F2: 'f2_next', F3: 'f3_4wk', F5: 'f5_reinjury', F4: 'f4_point' };
    for (const r of rows.slice(1)) {
      for (const which of ['v1', 'latest'] as const) {
        const version = which === 'v1' ? '1' : at(r, 'latest_version');
        const key = `${at(r, 'entry_id')}|${version}`;
        const row = forecasts.get(key) ?? { entry_id: at(r, 'entry_id'), version: Number(version), published_at: at(r, which === 'v1' ? 'v1_published_at' : 'latest_published_at') };
        row[col[at(r, 'field')]] = at(r, `${which}_forecast`) || null;
        if (at(r, 'field') === 'F4') {
          row.f4_low = at(r, `${which}_f4_low`);
          row.f4_high = at(r, `${which}_f4_high`);
        }
        forecasts.set(key, row);
      }
    }
    const fromCsv = summarizeLedger([...forecasts.values()] as never, res);
    const direct = summarizeLedger(payload.forecasts, payload.resolutions);
    expect(fromCsv.initial).toEqual(direct.initial);
    expect(fromCsv.latest).toEqual(direct.latest);
  });
});

describe('card text', () => {
  const report = buildScoreboardReport(payload, '2026-10-07', '2026-10-06');

  it('the resolution card lists entry · field · forecast · actual, v1 first, with the counting revision beside it', () => {
    const t = report.resolution_card_text;
    expect(t.startsWith(LEDGER_COPY.resolution_card_heading)).toBe(true);
    expect(t).toContain('PT-2026-001 · F2 Next game · forecast 10%; v2 0% · actual: did not play');
    expect(t).toContain('PT-2026-001 · F1 IR · forecast 20% · actual: placed on IR');
    expect(t).toContain('PT-2026-001 · F4 Games missed · forecast 3 (2–5); v2 6 (4–8) · actual: 6 games missed');
    expect(t).toContain('PT-2026-002 · F5 Re-injury · void, not scored: traded');
  });
  it('a resolution confirmed before the window is left out', () => {
    expect(buildResolutionCardText(payload.forecasts, payload.resolutions, '2026-10-07')).toContain('No fields resolved in this window.');
  });
  it('the scoreboard card prints both boards and the revision delta', () => {
    const t = report.scoreboard_card_text;
    expect(t).toContain(LEDGER_COPY.initial_board_label);
    expect(t).toContain(LEDGER_COPY.latest_board_label);
    expect(t).toContain('F1 IR: Brier 0.325 (n=2)');
    expect(t).toContain(LEDGER_COPY.revision_delta_label);
    expect(t).toContain(LEDGER_COPY.scoreboard_floor_note);
  });
  it('both cards carry the static elements and no forbidden word', () => {
    for (const t of [report.resolution_card_text, report.scoreboard_card_text, buildScoreboardCardText(summarizeLedger([], []), '2026-10-07')]) {
      for (const s of [LEDGER_COPY.credit, LEDGER_COPY.publisher, LEDGER_COPY.ai_disclosure, LEDGER_COPY.card_disclaimer]) expect(t).toContain(s);
      // The disclaimer itself names "a diagnosis" to disclaim it; check everything above it.
      expect(findForbiddenWords(t.replace(LEDGER_COPY.card_disclaimer, ''))).toEqual([]);
    }
  });
  it('outcome words', () => {
    expect(outcomeWords('F4', 1)).toBe('1 game missed');
    expect(outcomeWords('F3', 0)).toBe('did not play');
  });
});

describe('routes', () => {
  const ingestCalls: string[] = [];
  const deps: LedgerRouteDeps = {
    publishDeps: () => { throw new Error('unused'); },
    replyDeps: () => { throw new Error('unused'); },
    lookup: async () => { throw new Error('unused'); },
    ingest: async (mode) => {
      ingestCalls.push(mode);
      return { mode, aborted: false } as never;
    },
    envIngestMode: () => 'on',
    exportLedger: async () => JSON.parse(JSON.stringify({ ...recordedExport(), resolutions: recordedExport().resolutions })) as LedgerExportPayload,
    now: () => new Date('2026-10-07T18:00:00Z'),
  };
  const app = express();
  app.use(express.json());
  registerLedgerAdminRoutes(app, deps);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => server.close());

  it('a request may run shadow, never more than the env', async () => {
    expect(requestIngestMode('on', 'shadow')).toBe('shadow');
    expect(requestIngestMode('on', 'on')).toBe('on');
    expect(requestIngestMode('shadow', 'on')).toBe('shadow');
    expect(requestIngestMode('off', undefined)).toBe('shadow');
    await fetch(`${base}/admin/ledger/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'shadow' }) });
    expect(ingestCalls).toEqual(['shadow']);
  });
  it('the scoreboard route answers JSON with both card texts, and CSV on request', async () => {
    const j = (await (await fetch(`${base}/admin/ledger/scoreboard?since=2026-10-01`)).json()) as { since: string; summary: { open_fields: number }; resolution_card_text: string };
    expect(j.since).toBe('2026-10-01');
    expect(j.summary.open_fields).toBe(5);
    expect(j.resolution_card_text).toContain(LEDGER_COPY.credit);
    const csv = await fetch(`${base}/admin/ledger/scoreboard?format=csv`);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect((await csv.text()).split('\n')[1]).toMatch(/^PT-2026-001,F1,open,/);
    expect((await fetch(`${base}/admin/ledger/scoreboard?since=yesterday`)).status).toBe(400);
  });
});
