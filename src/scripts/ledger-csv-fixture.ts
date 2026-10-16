/**
 * Records `tests/fixtures/ledger-csv-cases.json` from the LIVE ledger (spec
 * "Public site → raw export"; decision S4-1). Read-only against the database.
 *
 *   npx tsx src/scripts/ledger-csv-fixture.ts                       # live, as_of = none
 *   npx tsx src/scripts/ledger-csv-fixture.ts --as-of=2026-10-12,2026-10-13   # plus one as_of case each
 *
 * Each case is the raw `web_export_ledger` payload, the CSV the twin writes for
 * it (after `ledgerAsOf` when the case has one), and both boards as
 * `summarizeLedger` computes them. The file pins the twin
 * `src/ledger/export-csv.ts` ↔ frontend `lib/ledger-export-csv.ts`; copy it
 * across byte-for-byte after recording.
 *
 * Appends; never edits an existing case, and refuses a case name that exists.
 * Needs WEB_MCP_URL and MCP_AUTH_SECRET.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { LEDGER_CSV_VERSION, endOfEtDay, isAsOfDate, ledgerAsOf, ledgerCsv, type LedgerCsvPayload } from '../ledger/export-csv.js';
import { summarizeLedger, type ScoringForecastRow, type ScoringResolutionRow } from '../ledger/scoring.js';
import { etCalendarDate } from '../ledger/dates.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ledger-csv-cases.json');
const argv = process.argv.slice(2);
const opt = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

interface CsvCase {
  name: string;
  as_of: string | null;
  export: LedgerCsvPayload;
  csv: string;
  expect: { initial: unknown; latest: unknown; entries_scored: number; open_fields: number };
}
interface CsvFixture { csv_version: number; _recorded_from: string; _note: string; cases: CsvCase[] }

async function readExport(): Promise<LedgerCsvPayload> {
  const raw = await callTool('web', 'web_export_ledger', {});
  if (isMCPError(raw)) throw new Error(`web_export_ledger failed: ${extractMCPErrorMessage(raw)}`);
  const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error('web_export_ledger returned no content');
  return JSON.parse(text) as LedgerCsvPayload;
}

function caseFor(name: string, exp: LedgerCsvPayload, asOf: string | null): CsvCase {
  const view = asOf ? ledgerAsOf(exp, endOfEtDay(asOf)) : exp;
  const s = summarizeLedger(
    view.forecasts.filter((f) => f.status === undefined || f.status === 'published') as ScoringForecastRow[],
    view.resolutions as ScoringResolutionRow[],
  );
  const { kind: _ki, ...initial } = s.initial;
  const { kind: _kl, ...latest } = s.latest;
  return { name, as_of: asOf, export: exp, csv: ledgerCsv(view), expect: { initial, latest, entries_scored: s.entries_scored, open_fields: s.open_fields } };
}

async function main(): Promise<void> {
  const asOfs = (opt('--as-of') ?? '').split(',').filter(Boolean);
  for (const d of asOfs) if (!isAsOfDate(d)) throw new Error(`--as-of must be YYYY-MM-DD[,YYYY-MM-DD…], got ${d}`);
  await initializeMCPClients();
  if (!isServerAvailable('web')) throw new Error('web MCP server unavailable (WEB_MCP_URL / MCP_AUTH_SECRET)');
  const exp = await readExport();
  const today = etCalendarDate(new Date());

  const fixture: CsvFixture = existsSync(FIXTURE)
    ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as CsvFixture)
    : {
        csv_version: LEDGER_CSV_VERSION,
        _recorded_from: 'src/scripts/ledger-csv-fixture.ts (live web_export_ledger)',
        _note: 'Recorded live, never hand-written. Pins agents src/ledger/export-csv.ts and frontend lib/ledger-export-csv.ts. Append only.',
        cases: [],
      };
  if (fixture.csv_version !== LEDGER_CSV_VERSION) throw new Error(`fixture csv_version ${fixture.csv_version} ≠ LEDGER_CSV_VERSION ${LEDGER_CSV_VERSION}`);

  const wanted = [caseFor(`live ledger exported ${today}`, exp, null)];
  for (const d of asOfs) wanted.push(caseFor(`live ledger exported ${today}, as_of ${d}`, exp, d));
  for (const c of wanted) {
    if (fixture.cases.some((x) => x.name === c.name)) throw new Error(`case "${c.name}" already exists; never edited`);
    fixture.cases.push(c);
    console.log(`appended "${c.name}": ${c.export.forecasts.length} forecasts, ${c.export.resolutions.length} resolutions, entries_scored=${c.expect.entries_scored}, open=${c.expect.open_fields}`);
  }
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
