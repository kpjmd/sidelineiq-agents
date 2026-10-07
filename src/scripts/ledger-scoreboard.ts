/**
 * Ledger scoreboard (spec "Scoring integrity → Computation", "Publication";
 * docs/ledger-preregistration.md "Computation"). Read-only.
 *
 *   npx tsx src/scripts/ledger-scoreboard.ts                 # human report from the prod ledger
 *   npx tsx src/scripts/ledger-scoreboard.ts --json          # the full report as JSON
 *   npx tsx src/scripts/ledger-scoreboard.ts --csv=out.csv   # the raw export, recomputable
 *   npx tsx src/scripts/ledger-scoreboard.ts --since=2026-10-06   # resolution-card window
 *   npx tsx src/scripts/ledger-scoreboard.ts --emit-fixture  # APPEND a live case to
 *       tests/fixtures/ledger-scoring-cases.json (never edits an existing case;
 *       refuses when nothing has resolved, or when the identical case exists)
 *
 * Needs WEB_MCP_URL and MCP_AUTH_SECRET. Both boards are always printed
 * together, over the same n, with voids and exclusions named.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { buildScoreboardReport, ledgerCsv, type LedgerExportPayload } from '../ledger/scoreboard.js';
import { BRIER_FIELDS, LEDGER_SCORING_VERSION, SCOREBOARD_LINE_MIN_N, summarizeLedger, type ScoreboardSummary } from '../ledger/scoring.js';
import { addDays, etCalendarDate, isIsoDate } from '../ledger/dates.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ledger-scoring-cases.json');
const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(name);
const opt = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

async function readExport(): Promise<LedgerExportPayload> {
  const raw = await callTool('web', 'web_export_ledger', {});
  if (isMCPError(raw)) throw new Error(`web_export_ledger failed: ${extractMCPErrorMessage(raw)}`);
  const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error('web_export_ledger returned no content');
  return JSON.parse(text) as LedgerExportPayload;
}

function printBoards(s: ScoreboardSummary): void {
  for (const kind of ['initial', 'latest'] as const) {
    console.log(`\n─── ${kind === 'initial' ? 'Initial board (headline)' : 'Latest board (last revision before each freeze)'} ───`);
    for (const f of BRIER_FIELDS) console.log(`  ${f}  Brier ${s[kind].brier[f].brier ?? '—'}  n=${s[kind].brier[f].n}`);
    console.log(`  F4  MAE ${s[kind].f4.mae ?? '—'}  coverage ${s[kind].f4.coverage ?? '—'}  n=${s[kind].f4.n}`);
  }
  console.log('\n─── Revision delta (latest − initial) ───');
  console.log(`  ${BRIER_FIELDS.map((f) => `${f} ${s.revision_delta.brier[f] ?? '—'}`).join('  ')}  F4 MAE ${s.revision_delta.f4_mae ?? '—'}`);
  console.log('\n─── Calibration (initial board; a bucket publishes at n ≥ 5) ───');
  for (const f of BRIER_FIELDS) {
    const used = s.calibration.initial[f].filter((b) => b.n > 0);
    if (used.length === 0) continue;
    console.log(`  ${f}: ${used.map((b) => `[${b.lo.toFixed(1)}–${b.hi.toFixed(1)}) n=${b.n} f=${b.forecast_mean} o=${b.observed_rate}${b.published ? '' : ' (unpublished)'}`).join('  ')}`);
  }
  console.log('\n─── Voids and exclusions ───');
  if (s.voids.length === 0 && s.exclusions.length === 0) console.log('  (none)');
  for (const v of s.voids) console.log(`  void      ${v.entry_id} ${v.field}  ${v.void_reason}`);
  for (const e of s.exclusions) console.log(`  excluded  ${e.entry_id} ${e.field}  ${e.reason}`);
}

/** Append one live case. Expectations are the helper's own output, labelled as such. */
function emitFixture(payload: LedgerExportPayload, today: string): void {
  const forecasts = payload.forecasts
    .filter((f) => f.status === undefined || f.status === 'published')
    .map((f) => ({ entry_id: f.entry_id, version: f.version, published_at: f.published_at, f1_ir: f.f1_ir, f2_next: f.f2_next, f3_4wk: f.f3_4wk, f4_point: f.f4_point, f4_low: f.f4_low, f4_high: f.f4_high, f5_reinjury: f.f5_reinjury }));
  const resolutions = payload.resolutions.map((r) => ({ entry_id: r.entry_id, field: r.field, status: r.status, outcome: r.outcome, freeze_at: r.freeze_at, ...(r.void_reason ? { void_reason: r.void_reason } : {}) }));
  if (!resolutions.some((r) => r.status !== 'open')) {
    console.log('nothing to append: no field has resolved or voided yet');
    return;
  }
  const s = summarizeLedger(forecasts, resolutions);
  const { kind: _ki, ...initial } = s.initial;
  const { kind: _kl, ...latest } = s.latest;
  const c = {
    name: `live ledger as of ${today}`,
    source: 'live',
    forecasts,
    resolutions,
    expect: {
      initial,
      latest,
      revision_delta: s.revision_delta,
      voids: s.voids,
      exclusions: s.exclusions,
      open_fields: s.open_fields,
      entries_scored: s.entries_scored,
      latest_versions: Object.fromEntries(s.observations.map((o) => [`${o.entry_id}/${o.field}`, o.latest_version])),
      calibration_initial_F2: s.calibration.initial.F2.filter((b) => b.n > 0),
    },
  };
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { scoring_version: number; cases: Array<{ forecasts: unknown; resolutions: unknown }> };
  if (fixture.scoring_version !== LEDGER_SCORING_VERSION) throw new Error(`fixture scoring_version ${fixture.scoring_version} ≠ ${LEDGER_SCORING_VERSION}`);
  const key = (x: { forecasts: unknown; resolutions: unknown }) => JSON.stringify([x.forecasts, x.resolutions]);
  if (fixture.cases.some((x) => key(x) === key(c))) {
    console.log('nothing to append: an identical case is already recorded');
    return;
  }
  fixture.cases.push(c);
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`appended "${c.name}" to ${FIXTURE} — copy it to sidelineiq-frontend/tests/fixtures/ too`);
}

async function main(): Promise<void> {
  await initializeMCPClients();
  if (!isServerAvailable('web')) {
    console.error('web MCP unavailable (set WEB_MCP_URL and MCP_AUTH_SECRET)');
    process.exitCode = 1;
    return;
  }
  const payload = await readExport();
  const today = etCalendarDate(new Date());
  const sinceArg = opt('--since');
  if (sinceArg && !isIsoDate(sinceArg)) throw new Error('--since must be YYYY-MM-DD');
  const since = sinceArg ?? addDays(today, -7);
  const report = buildScoreboardReport(payload, today, since);

  const csvPath = opt('--csv');
  if (csvPath) {
    writeFileSync(csvPath, ledgerCsv(payload));
    console.log(`wrote ${csvPath}`);
  }
  if (has('--emit-fixture')) emitFixture(payload, today);
  if (has('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const s = report.summary;
  console.log(`═══ ParatrOs ledger scoreboard — as of ${today} (scoring v${LEDGER_SCORING_VERSION}) ═══`);
  console.log(`entries scored ${s.entries_scored} · open fields ${s.open_fields} · observations ${s.observations.length}`);
  if (s.entries_scored < SCOREBOARD_LINE_MIN_N) console.log(`card line withheld: ${s.entries_scored} < ${SCOREBOARD_LINE_MIN_N} entries scored`);
  else console.log(`card line: ${report.scoreboard_line}`);
  printBoards(s);
  console.log(`\n─── Resolution card text (confirmed since ${since}) ───\n${report.resolution_card_text}`);
  console.log(`\n─── Scoreboard card text ───\n${report.scoreboard_card_text}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void disconnectAll().catch(() => {}));
