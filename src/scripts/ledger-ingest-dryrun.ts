/**
 * Ledger resolution ingest — dry run and fixture recorder (spec "Implementation
 * handoff → Automation boundary"; plan Stage 3). It NEVER writes: every
 * `web_propose_ledger_resolution` call is intercepted and counted, and only the
 * read `web_export_ledger` reaches the MCP.
 *
 *   npx tsx src/scripts/ledger-ingest-dryrun.ts --live           # prod ledger, live sources
 *   npx tsx src/scripts/ledger-ingest-dryrun.ts --fixture        # recorded inputs, offline
 *   npx tsx src/scripts/ledger-ingest-dryrun.ts --live --emit-fixture
 *       records tests/fixtures/ledger-ingest/*.json from the live responses
 *       (CSV rows trimmed to the open entries' teams; never typed by hand)
 *
 * Gates — the numbers that must be zero:
 *   A. a proposal resolving/voiding a field without the evidence of its freeze
 *      point (freezeEvidenceViolations in propose.ts)
 *   B. a proposal on a field that is not open in the ledger
 *   C. decisions differing across two runs over the same inputs
 *   D. any write under an injected 404 or 503 on each source (export, games,
 *      snap counts, injuries, transactions) — each must also abort
 *   E. a gamebook field (F2–F4) proposed without a pfr_id, or F5 without a gsis_id
 *   F. a player resolved by name: any parsed snap/injury fact carrying a name
 *      column, or a name-bearing lookup in src/ledger/ingest/
 *
 * Reported, not gated: held fields and why, unresolvable fields, entries with an
 * assumed season, and the baseline count of proposals an `on` pass would file
 * (proves gate D is not vacuous).
 *
 * Exit 0 on PASS, 1 on any gate failing.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runLedgerIngestCycle,
  type IngestDeps,
  type LedgerIngestSummary,
  type IngestCallTool,
} from '../ledger/ingest/loop.js';
import { freezeEvidenceViolations } from '../ledger/ingest/propose.js';
import { parseInjuriesCsv, parseSnapsCsv, nflverseUrlsFromEnv, type NflverseUrls } from '../ledger/ingest/nflverse.js';
import { parseCsv } from '../ledger/nflverse-players.js';
import { fetchEspnJson, TransientEspnError } from '../monitoring/sports/espn-json.js';

const FIXTURE_DIR = resolve(process.cwd(), 'tests/fixtures/ledger-ingest');
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

const failures: string[] = [];
function mustBeZero(label: string, count: number, examples: string[] = []): void {
  const ok = count === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(label);
}
const report = (label: string, value: unknown) => console.log(`  ---   ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
const rule = (t: string) => console.log(`\n─── ${t} ${'─'.repeat(Math.max(0, 70 - t.length))}`);

// ── Recorded inputs ────────────────────────────────────────────────────

interface Recording {
  as_of: string;
  export: unknown;
  text: Record<string, string>;
  json: Record<string, unknown>;
}

function loadFixture(): Recording {
  const meta = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'meta.json'), 'utf8')) as { as_of: string; urls: NflverseUrls };
  const exp = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'ledger-export.json'), 'utf8')) as { response: unknown };
  const text: Record<string, string> = {};
  for (const f of readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.csv.json'))) {
    const rec = JSON.parse(readFileSync(resolve(FIXTURE_DIR, f), 'utf8')) as { url: string; text: string };
    text[rec.url] = rec.text;
  }
  const tx = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'espn-transactions.json'), 'utf8')) as { pages: Array<{ url: string; body: unknown }> };
  const json: Record<string, unknown> = {};
  for (const p of tx.pages) json[p.url] = p.body;
  process.env.NFLVERSE_GAMES_URL = meta.urls.games;
  process.env.NFLVERSE_SNAPS_URL_TEMPLATE = meta.urls.snapsTemplate;
  process.env.NFLVERSE_INJURIES_URL_TEMPLATE = meta.urls.injuriesTemplate;
  return { as_of: meta.as_of, export: exp.response, text, json };
}

// ── Deps: live or replayed, always write-intercepted ───────────────────

type Injection = { source: 'export' | 'games' | 'snap_counts' | 'injuries' | 'transactions'; status: 404 | 503 } | null;

interface Harness {
  deps: IngestDeps;
  writes: Array<Record<string, unknown>>;
  captured: { export?: unknown; text: Record<string, string>; json: Record<string, unknown> };
}

function sourceOfUrl(url: string, urls: NflverseUrls): NonNullable<Injection>['source'] | null {
  if (url === urls.games) return 'games';
  if (url.includes('snap_counts')) return 'snap_counts';
  if (url.includes('injuries')) return 'injuries';
  if (url.includes('/transactions')) return 'transactions';
  return null;
}

function makeHarness(opts: { live: boolean; rec?: Recording; liveCallTool?: IngestCallTool; inject: Injection; now: Date }): Harness {
  const writes: Array<Record<string, unknown>> = [];
  const captured: Harness['captured'] = { text: {}, json: {} };
  const urls = nflverseUrlsFromEnv();

  const callTool: IngestCallTool = async (server, tool, params) => {
    if (tool === 'web_propose_ledger_resolution') {
      writes.push(params);
      return { content: [{ type: 'text', text: JSON.stringify({ proposal: null, status: 'created' }) }] };
    }
    if (tool !== 'web_export_ledger') throw new Error(`dry run refuses ${tool}`);
    if (opts.inject?.source === 'export') {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: `injected HTTP ${opts.inject.status}` }) }] };
    }
    if (!opts.live) return opts.rec!.export;
    const raw = await opts.liveCallTool!(server, tool, params);
    captured.export = raw;
    return raw;
  };

  const fetchFn: IngestDeps['fetch'] = async (input, init) => {
    const url = String(input);
    const src = sourceOfUrl(url, urls);
    if (opts.inject && src === opts.inject.source) return new Response('injected', { status: opts.inject.status });
    if (!opts.live) {
      const t = opts.rec!.text[url];
      return t === undefined ? new Response('not recorded', { status: 404 }) : new Response(t, { status: 200 });
    }
    const res = await fetch(url, init);
    const t = await res.text();
    if (res.ok) captured.text[url] = t;
    return new Response(t, { status: res.status });
  };

  const fetchJson: IngestDeps['fetchJson'] = async (url) => {
    if (opts.inject?.source === 'transactions') {
      if (opts.inject.status === 404) return null;
      throw new TransientEspnError(`injected HTTP ${opts.inject.status}`);
    }
    if (!opts.live) {
      if (!(url in opts.rec!.json)) return null;
      return opts.rec!.json[url];
    }
    const body = await fetchEspnJson(url);
    if (body !== null) captured.json[url] = body;
    return body;
  };

  return {
    writes,
    captured,
    deps: {
      callTool,
      isServerAvailable: () => true,
      fetch: fetchFn,
      fetchJson,
      now: () => opts.now,
      log: () => {},
    },
  };
}

// ── Fixture emission ───────────────────────────────────────────────────

function trimCsv(text: string, keep: (row: Record<string, string>) => boolean): string {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''));
  const header = rows[0];
  const quote = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const kept = rows.slice(1).filter((r) => keep(Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))));
  return [header, ...kept].map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

function emitFixture(h: Harness, summary: LedgerIngestSummary, now: Date): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const urls = nflverseUrlsFromEnv();
  // The RESOLVED team code of every entry the cycle looked at.
  const teams = new Set(summary.contexts.map((c) => c.team).filter(Boolean));
  const stamp = {
    _recorded_from: "src/scripts/ledger-ingest-dryrun.ts --live --emit-fixture (live responses; CSV rows trimmed to the entries' teams, never typed)",
    _recorded_at: now.toISOString(),
  };
  const seasons = new Set(summary.contexts.map((c) => String(c.season)));
  const teamGame = (r: Record<string, string>) => seasons.has(r.season) && (teams.has(r.home_team) || teams.has(r.away_team));

  writeFileSync(resolve(FIXTURE_DIR, 'meta.json'), JSON.stringify({ ...stamp, as_of: now.toISOString(), teams: [...teams].sort(), urls }, null, 2) + '\n');
  writeFileSync(resolve(FIXTURE_DIR, 'ledger-export.json'), JSON.stringify({ ...stamp, tool: 'web_export_ledger', response: h.captured.export }, null, 2) + '\n');

  const gamesText = h.captured.text[urls.games];
  const gameIds = gamesText ? new Set(parseCsv(trimCsv(gamesText, teamGame)).slice(1).map((r) => r[0])) : new Set<string>();
  for (const [url, text] of Object.entries(h.captured.text)) {
    const [name, trimmed] =
      url === urls.games
        ? ['games', trimCsv(text, teamGame)]
        : url.includes('snap_counts')
          ? ['snap-counts', trimCsv(text, (r) => gameIds.has(r.game_id))]
          : ['injuries', trimCsv(text, (r) => teams.has(r.team))];
    writeFileSync(resolve(FIXTURE_DIR, `${name}.csv.json`), JSON.stringify({ ...stamp, url, text: trimmed }, null, 2) + '\n');
  }
  // Team objects reduced to the fields the ingest reads (the logo arrays are most of the bytes).
  const slimTeam = (t: Record<string, unknown>) => ({ id: t.id, abbreviation: t.abbreviation, displayName: t.displayName, name: t.name, location: t.location });
  const pages = Object.entries(h.captured.json).map(([url, body]) => {
    const b = body as { transactions?: Array<Record<string, unknown>> };
    return {
      url,
      body: { ...b, transactions: (b.transactions ?? []).map((t) => ({ ...t, team: slimTeam((t.team ?? {}) as Record<string, unknown>) })) },
    };
  });
  writeFileSync(resolve(FIXTURE_DIR, 'espn-transactions.json'), JSON.stringify({ ...stamp, pages }, null, 2) + '\n');
  console.log(`wrote fixtures to ${FIXTURE_DIR} (teams ${[...teams].join(', ')})`);
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const live = has('--live');
  const fixture = has('--fixture');
  if (live === fixture) {
    console.error('usage: ledger-ingest-dryrun.ts (--live [--emit-fixture] | --fixture)');
    process.exitCode = 2;
    return;
  }
  let rec: Recording | undefined;
  let liveCallTool: IngestCallTool | undefined;
  let disconnect: (() => Promise<void>) | undefined;
  let now = new Date();
  if (fixture) {
    rec = loadFixture();
    now = new Date(rec.as_of);
  } else {
    const mcp = await import('../utils/mcp-client-manager.js');
    await mcp.initializeMCPClients();
    disconnect = mcp.disconnectAll;
    if (!mcp.isServerAvailable('web')) {
      console.error('web MCP unavailable (set WEB_MCP_URL)');
      process.exitCode = 1;
      return;
    }
    liveCallTool = mcp.callTool as unknown as IngestCallTool;
  }

  try {
    console.log(`═══ Ledger ingest dry run — ${live ? 'LIVE (read-only)' : 'FIXTURE'} — as of ${now.toISOString()} ═══`);

    // Run 1 (shadow) and the baseline 'on' pass with writes intercepted.
    const h1 = makeHarness({ live, rec, liveCallTool, inject: null, now });
    const s1 = await runLedgerIngestCycle({ mode: 'on' }, h1.deps);
    if (has('--emit-fixture')) {
      if (!live) throw new Error('--emit-fixture needs --live');
      emitFixture(h1, s1, now);
    }
    // Every later run replays run 1's captured responses, so they see the same inputs.
    const replay: Recording = rec ?? { as_of: now.toISOString(), export: h1.captured.export, text: h1.captured.text, json: h1.captured.json };
    const h2 = makeHarness({ live: false, rec: replay, inject: null, now });
    const s2 = await runLedgerIngestCycle({ mode: 'on' }, h2.deps);

    rule('A. Corpus');
    report('entries', s1.entries);
    report('entries with an open field', s1.entries_with_open);
    report('open fields', s1.open_fields);
    report('transactions read', s1.transactions_read);
    for (const src of s1.sources) report(`source ${src.source}`, `${src.rows} rows  ${src.url}`);
    report('aborted', s1.aborted ? `YES — ${s1.abort_reason}` : 'no');
    for (const b of s1.bad_entries) report(`bad entry ${b.entry_id}`, b.reason);
    for (const c of s1.contexts) {
      report(`context ${c.entry_id}`, `team=${c.team} (${c.team_source}) season=${c.season}${c.season_assumed ? ' (assumed)' : ''} pfr=${c.pfr_id ?? '—'} gsis=${c.gsis_id ?? '—'} open=${c.open.join(',')}`);
    }

    rule('B. Proposals (what an on pass would file)');
    if (s1.proposals.length === 0) console.log('  (none)');
    for (const p of s1.proposals) {
      console.log(
        `  ${p.entry_id} ${p.field} ${p.proposed_status.padEnd(8)} ` +
          (p.proposed_status === 'resolved' ? `outcome=${p.proposed_outcome} on ${p.outcome_date}` : `void=${p.void_reason}`) +
          `  freeze_at=${p.freeze_at ?? '-'}`,
      );
      console.log(`      ${p.evidence.note}`);
      if (p.evidence.sentence) console.log(`      “${p.evidence.sentence}”`);
      for (const u of p.evidence.urls.slice(0, 3)) console.log(`      ${u}`);
    }
    rule('C. Held');
    for (const hf of s1.held_fields) console.log(`  ${hf.entry_id} ${hf.field} ${hf.status.padEnd(12)} ${hf.reason}${hf.freeze_at ? `  (freezes ${hf.freeze_at})` : ''}`);
    const assumed = s1.contexts.filter((c) => c.season_assumed).map((c) => c.entry_id);
    report('entries with an assumed season', assumed);
    report('baseline proposals an on pass would file (intercepted)', h1.writes.length);

    rule('D. Gates');
    const nowIso = now.toISOString();
    const aViol = s1.proposals.flatMap((p) => freezeEvidenceViolations(p, nowIso).map((v) => `${p.entry_id} ${p.field}: ${v}`));
    mustBeZero('A. proposals without freeze-point evidence', aViol.length, aViol);

    const exportText = (replay.export as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
    const resolutions = exportText ? ((JSON.parse(exportText) as { resolutions: Array<{ entry_id: string; field: string; status: string }> }).resolutions ?? []) : [];
    const openKey = new Set(resolutions.filter((r) => r.status === 'open').map((r) => `${r.entry_id}|${r.field}`));
    const bViol = s1.proposals.filter((p) => !openKey.has(`${p.entry_id}|${p.field}`)).map((p) => `${p.entry_id} ${p.field}`);
    mustBeZero('B. proposals on a field that is not open', bViol.length, bViol);

    const strip = (s: LedgerIngestSummary) => JSON.stringify({ p: s.proposals.map(({ write: _w, ...rest }) => rest), h: s.held_fields });
    mustBeZero('C. decisions differing across two runs', strip(s1) === strip(s2) ? 0 : 1);

    const dViol: string[] = [];
    const sources: NonNullable<Injection>['source'][] = ['export', 'games', 'snap_counts', 'injuries', 'transactions'];
    const needsReads = s1.entries_with_open > 0;
    for (const source of sources) {
      for (const status of [404, 503] as const) {
        const h = makeHarness({ live: false, rec: replay, inject: { source, status }, now });
        const s = await runLedgerIngestCycle({ mode: 'on' }, h.deps);
        if (h.writes.length > 0) dViol.push(`${source} ${status}: ${h.writes.length} write(s)`);
        // With nothing open the cycle stops before fetching; only the export must abort then.
        if (!s.aborted && (source === 'export' || needsReads)) dViol.push(`${source} ${status}: did not abort`);
      }
    }
    mustBeZero('D. writes (or a non-abort) under an injected 404/503', dViol.length, dViol);

    const eViol = s1.proposals
      .filter((p) => (['F2', 'F3', 'F4'].includes(p.field) && p.proposed_status === 'resolved' && !p.evidence.basis.pfr_id) || (p.field === 'F5' && p.proposed_status === 'resolved' && !p.evidence.basis.gsis_id))
      .map((p) => `${p.entry_id} ${p.field}`);
    mustBeZero('E. gamebook/report field proposed without its id', eViol.length, eViol);

    const fViol: string[] = [];
    const nameKeys = ['player', 'full_name', 'display_name', 'first_name', 'last_name'];
    for (const [url, text] of Object.entries(replay.text)) {
      const rows = url.includes('snap_counts') ? parseSnapsCsv(text) : url.includes('injuries') ? parseInjuriesCsv(text) : [];
      const leaked = rows.length > 0 ? Object.keys(rows[0]).filter((k) => nameKeys.includes(k)) : [];
      if (leaked.length) fViol.push(`${url}: parsed rows carry ${leaked.join(', ')}`);
    }
    const ingestDir = resolve(process.cwd(), 'src/ledger/ingest');
    for (const f of readdirSync(ingestDir).filter((n) => n.endsWith('.ts'))) {
      const code = readFileSync(resolve(ingestDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/web_resolve_player|lookupByName|byName\(|\.full_name|\.display_name/.test(code)) fViol.push(`${f}: name-keyed lookup`);
    }
    mustBeZero('F. players resolved by name', fViol.length, fViol);

    console.log('');
    if (failures.length === 0) console.log('PASS — every gated number is zero.');
    else {
      console.log(`FAIL — ${failures.join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    if (disconnect) await disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
