/**
 * Replays the RECORDED ingest inputs in tests/fixtures/ledger-ingest/ (written
 * by `ledger-ingest-dryrun.ts --live --emit-fixture`, never typed). Tests that
 * need a different entry derive it from the recorded row with `withForecast`,
 * which says exactly which columns it changes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IngestDeps, IngestCallTool } from '../../src/ledger/ingest/loop.js';
import type { NflverseUrls } from '../../src/ledger/ingest/nflverse.js';
import { TransientEspnError } from '../../src/monitoring/sports/espn-json.js';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/ledger-ingest');
const read = <T>(name: string): T => JSON.parse(readFileSync(resolve(DIR, name), 'utf8')) as T;

export const meta = read<{ as_of: string; urls: NflverseUrls; teams: string[] }>('meta.json');
export const AS_OF = new Date(meta.as_of);

const exportRecord = read<{ response: { content: Array<{ type: string; text: string }> } }>('ledger-export.json');
export interface ExportShape {
  forecasts: Array<Record<string, unknown>>;
  resolutions: Array<{ entry_id: string; field: string; status: string }>;
  corrections: unknown[];
}
export const recordedExport = (): ExportShape => JSON.parse(exportRecord.response.content[0].text) as ExportShape;

export const csvText: Record<string, string> = {};
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.csv.json'))) {
  const rec = read<{ url: string; text: string }>(f);
  csvText[rec.url] = rec.text;
}
export const gamesCsv = csvText[meta.urls.games];
export const snapsCsv = Object.entries(csvText).find(([u]) => u.includes('snap_counts'))![1];
export const injuriesCsv = Object.entries(csvText).find(([u]) => u.includes('injuries'))![1];

export const transactionPages = read<{ pages: Array<{ url: string; body: { transactions: Array<{ date: string; description: string; team: { abbreviation: string; displayName?: string; name?: string } }> } }> }>(
  'espn-transactions.json',
).pages;

/** The recorded export with the first forecast row's named columns replaced. */
export function withForecast(patch: Record<string, unknown>, base: ExportShape = recordedExport()): ExportShape {
  return { ...base, forecasts: base.forecasts.map((f, i) => (i === 0 ? { ...f, ...patch } : f)) };
}

/** Ids as the recorded nflverse CSVs carry them for the recorded athlete (snap_counts pfr, injuries gsis). */
export const LAMAR_IDS = { espn_athlete_id: '3916387', pfr_id: 'JackLa00', gsis_id: '00-0034796', nflverse_team: 'BAL' };

export type Inject = { source: 'export' | 'games' | 'snap_counts' | 'injuries' | 'transactions'; status: 404 | 503 } | null;

export interface IngestHarness {
  deps: IngestDeps;
  calls: Array<{ tool: string; params: Record<string, unknown> }>;
  logs: string[];
}

export function ingestHarness(opts: { exported?: ExportShape; inject?: Inject; proposeResponse?: (p: Record<string, unknown>) => unknown } = {}): IngestHarness {
  const calls: IngestHarness['calls'] = [];
  const logs: string[] = [];
  const exported = opts.exported ?? recordedExport();
  const callTool: IngestCallTool = async (_server, tool, params) => {
    calls.push({ tool, params });
    if (tool === 'web_export_ledger') {
      if (opts.inject?.source === 'export') return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `HTTP ${opts.inject.status}` }) }] };
      return { content: [{ type: 'text', text: JSON.stringify(exported) }] };
    }
    if (tool === 'web_propose_ledger_resolution') {
      if (opts.proposeResponse) return opts.proposeResponse(params);
      return { content: [{ type: 'text', text: JSON.stringify({ proposal: { id: 'p1' }, status: 'created' }) }] };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  const fetchFn: IngestDeps['fetch'] = async (input) => {
    const url = String(input);
    const src = url === meta.urls.games ? 'games' : url.includes('snap_counts') ? 'snap_counts' : url.includes('injuries') ? 'injuries' : null;
    if (opts.inject && opts.inject.source === src) return new Response('injected', { status: opts.inject.status });
    const t = csvText[url];
    return t === undefined ? new Response('not recorded', { status: 404 }) : new Response(t, { status: 200 });
  };
  const fetchJson: IngestDeps['fetchJson'] = async (url) => {
    if (opts.inject?.source === 'transactions') {
      if (opts.inject.status === 404) return null;
      throw new TransientEspnError(`HTTP ${opts.inject.status}`);
    }
    const page = transactionPages.find((p) => p.url === url);
    return page ? page.body : null;
  };
  return {
    calls,
    logs,
    deps: { callTool, isServerAvailable: () => true, fetch: fetchFn, fetchJson, now: () => AS_OF, log: (l) => logs.push(l), urls: meta.urls },
  };
}
