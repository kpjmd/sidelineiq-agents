/**
 * The 8-week review gate report (spec "Scale path → 8-week review gate";
 * definitions in src/ledger/gate.ts). Read-only: it calls no write tool.
 *
 *   railway run --service sidelineiq-agents -- env \
 *     WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp \
 *     FARCASTER_MCP_URL= TWITTER_MCP_URL= npx tsx src/scripts/ledger-gate-report.ts
 *
 *   --json                 the report as JSON
 *   --as-of=YYYY-MM-DD     the view at the end of that New York day
 *   --record-fixtures      write the raw responses to tests/fixtures/ledger-gate/<as-of>/
 *                          (refuses an existing directory; user ids redacted — the repo is public)
 *
 * Needs WEB_MCP_URL + MCP_AUTH_SECRET (web) and X_API_MCP_URL + X_API_MCP_BEARER_TOKEN
 * (x_api). Every measure that cannot be read prints "not measurable" with why.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { CARD_IMPRESSIONS_KEY } from '../ledger/card-impressions.js';
import { assembleGate, type AssembledGate, type GateRawResponses } from '../ledger/gate-assemble.js';
import { buildGateReport, gateWeekBounds, GATE_THRESHOLDS, GATE_WEEKS, LOOP_GAP_CAP_MIN, type Cell, type GateReport } from '../ledger/gate.js';
import { endOfEtDayIso, etCalendarDate, isIsoDate } from '../ledger/dates.js';

const ACCOUNT_ID = '2039126663263387648'; // @Paratrosinjury, numeric id (handles change; the id does not)
const OPEN_QUESTION_FILE = resolve(process.cwd(), 'data/ledger-open-question-posts.json');
const MAX_TIMELINE_PAGES = 40;

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(n);
const opt = (n: string) => argv.find((a) => a.startsWith(`${n}=`))?.slice(n.length + 1) ?? null;

function text(raw: unknown, what: string): string {
  if (isMCPError(raw)) throw new Error(`${what} failed: ${extractMCPErrorMessage(raw)}`);
  const t = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!t) throw new Error(`${what} returned no content`);
  return t;
}

async function web(tool: string, args: Record<string, unknown>): Promise<string> {
  return text(await callTool('web', tool, args), tool);
}

async function xPostsTexts(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const raw = await callTool('x_api', 'get_posts_by_ids', {
      ids: ids.slice(i, i + 100).join(','),
      'post.fields': 'created_at,public_metrics,referenced_tweets',
    });
    out.push(text(raw, 'get_posts_by_ids'));
  }
  return out;
}

async function timelineTexts(): Promise<string[]> {
  const pages: string[] = [];
  let token: string | undefined;
  const startTime = gateWeekBounds(1).start;
  for (let i = 0; i < MAX_TIMELINE_PAGES; i++) {
    const args: Record<string, unknown> = {
      id: ACCOUNT_ID,
      max_results: 100,
      start_time: startTime,
      'post.fields': 'created_at,public_metrics,referenced_tweets',
    };
    if (token) args.pagination_token = token;
    const t = text(await callTool('x_api', 'get_users_posts', args), 'get_users_posts');
    pages.push(t);
    token = (JSON.parse(t) as { meta?: { next_token?: string } }).meta?.next_token;
    if (!token) return pages;
  }
  throw new Error(`timeline exceeded ${MAX_TIMELINE_PAGES} pages`);
}

async function readAll(): Promise<GateRawResponses> {
  const exportText = await web('web_export_ledger', {});
  const exp = JSON.parse(exportText) as { forecasts: Array<{ id: string; tier: number; version: number; x_post_id: string | null }> };
  const proposals = {
    pending: await web('web_list_ledger_proposals', { decision: 'pending' }),
    confirmed: await web('web_list_ledger_proposals', { decision: 'confirmed' }),
    rejected: await web('web_list_ledger_proposals', { decision: 'rejected' }),
  };
  const cards = exp.forecasts.filter((f) => f.tier === 1 && f.version === 1 && f.x_post_id);
  const audit: Record<string, string> = {};
  for (const f of cards) {
    audit[f.id] = await web('web_list_audit_entries', { entity_type: 'ledger_forecast', entity_id: f.id, limit: 500 });
  }

  let openQuestionFile: GateRawResponses['open_question_file'] = null;
  try {
    openQuestionFile = JSON.parse(readFileSync(OPEN_QUESTION_FILE, 'utf8'));
  } catch {
    openQuestionFile = null;
  }
  const oqIds = (openQuestionFile?.posts ?? []).map((p) => p.x_post_id).filter((x): x is string => !!x);

  if (!isServerAvailable('x_api')) throw new Error('x_api MCP unavailable — set X_API_MCP_URL and X_API_MCP_BEARER_TOKEN');
  const xPosts = await xPostsTexts([...new Set([...cards.map((f) => f.x_post_id!), ...oqIds])]);

  let timeline: string[] | null = null;
  let timelineError: string | undefined;
  try {
    timeline = await timelineTexts();
  } catch (err) {
    timelineError = err instanceof Error ? err.message : String(err);
  }

  const store = await callTool('web', 'web_get_social_state', { key: CARD_IMPRESSIONS_KEY });
  return { export: exportText, proposals, audit, x_posts: xPosts, timeline, timeline_error: timelineError, store, open_question_file: openQuestionFile };
}

// ── Fixtures ──────────────────────────────────────────────────────────

const REDACT_KEYS = new Set(['actor_id', 'confirmed_by', 'created_by', 'decided_by', 'updated_by', 'corrected_by', 'reviewer_user_id']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT_KEYS.has(k) && v !== null ? '<redacted>' : redact(v)]));
  }
  return value;
}

const redactText = (t: string) => JSON.stringify(redact(JSON.parse(t)));

function recordFixtures(raw: GateRawResponses, asOfDate: string): string {
  const dir = resolve(process.cwd(), 'tests/fixtures/ledger-gate', asOfDate);
  if (existsSync(dir)) throw new Error(`${dir} exists — fixtures are append-only; pick another --as-of or remove it by hand`);
  mkdirSync(dir, { recursive: true });
  const recorded: GateRawResponses = {
    export: redactText(raw.export),
    proposals: {
      pending: redactText(raw.proposals.pending),
      confirmed: redactText(raw.proposals.confirmed),
      rejected: redactText(raw.proposals.rejected),
    },
    audit: Object.fromEntries(Object.entries(raw.audit).map(([k, v]) => [k, redactText(v)])),
    x_posts: raw.x_posts,
    timeline: raw.timeline,
    timeline_error: raw.timeline_error,
    store: raw.store,
    open_question_file: raw.open_question_file,
  };
  const file = resolve(dir, 'responses.json');
  writeFileSync(file, JSON.stringify({ recorded_at: new Date().toISOString(), source: 'src/scripts/ledger-gate-report.ts --record-fixtures', ...recorded }, null, 1) + '\n');
  return file;
}

// ── Rendering ─────────────────────────────────────────────────────────

const fmt = (n: number | null, suffix = '') => (n === null ? '—' : `${n}${suffix}`);
const pad = (s: string, n: number) => s.padEnd(n);

function cellLine<T>(label: string, threshold: string, cell: Cell<T>, render: (v: T) => [string, string]): string {
  if ('not_measurable' in cell) return `  ${pad(label, 34)} ${pad(threshold, 22)} NOT MEASURABLE — ${cell.not_measurable}`;
  const [value, verdict] = render(cell.value);
  return `  ${pad(label, 34)} ${pad(threshold, 22)} ${pad(value, 34)} ${verdict}`;
}

function render(report: GateReport, a: AssembledGate): string {
  const L: string[] = [];
  L.push(`Prognosis Ledger — 8-week review gate (gate v${report.version})`);
  L.push(`as of ${report.as_of} · week ${report.current_week} of ${GATE_WEEKS} · review Tue 2026-12-01`);
  if (Date.now() - Date.parse(report.as_of) > 3_600_000) {
    L.push('note: a past --as-of reads X counts as they are NOW; only frozen readings stored before as_of are as-of values');
  }
  if (a.store_status === 'unreadable') L.push(`!! frozen card store unreadable (${a.store_reason}); impressions use live reads only`);
  L.push('');
  L.push('Wk  Start       Tue pass (due/in-window)   Passes  Entries  Resolved(+void)  Cards fz/live  Impr med  Loop active/wall min (n)');
  for (const w of report.weeks) {
    const tp = `${w.tuesday.tuesday} ${w.tuesday.status} (${w.tuesday.due}/${w.tuesday.decisions_in_window})`;
    L.push(
      `${pad(String(w.week), 3)} ${w.start}  ${pad(tp, 26)} ${pad(`${w.passes_done}/${w.passes_counted}`, 7)} ${pad(String(w.entries), 8)} ${pad(`${w.resolved} (+${w.void})`, 16)} ${pad(`${w.cards_frozen}/${w.cards_live}`, 14)} ${pad(fmt(w.impressions_median), 9)} ${fmt(w.loop_median_active)}/${fmt(w.loop_median_wall)} (${w.loop_n})`,
    );
  }
  L.push('');
  L.push(`  ${pad('Measure', 34)} ${pad('Minimum', 22)} ${pad('Now', 34)} Verdict`);
  const g = report.gate;
  L.push(cellLine('Tuesday passes completed', `${GATE_THRESHOLDS.tuesday_passes} of 8`, g.tuesday_passes, (v) => [
    `${v.done} done of ${v.counted} due (+${v.nothing_due} nothing due)`,
    v.done === v.counted ? 'on track' : 'BELOW: reduce intake scope before adding anything',
  ]));
  L.push(cellLine('Entries logged', `≥ ${GATE_THRESHOLDS.entries}`, g.entries, (v) => [String(v), v >= GATE_THRESHOLDS.entries ? 'pass' : 'below (loosen Tier 2 criteria)']));
  L.push(cellLine('Resolved fields', `≥ ${GATE_THRESHOLDS.resolved}`, g.resolved, (v) => [String(v), v >= GATE_THRESHOLDS.resolved ? 'pass' : 'below (timing-dependent)']));
  L.push(cellLine('Median impressions/T1 card, 5–8 vs 1–4', 'rising', g.impressions, (v) => [
    `${fmt(v.late_median)} (n=${v.late_n}) vs ${fmt(v.early_median)} (n=${v.early_n})`,
    v.verdict === 'rising' ? 'pass' : 'FLAT: move the vertical channel up',
  ]));
  L.push(cellLine('Reply rate, open-question vs other', 'above', g.reply_rate, (v) => [
    `${fmt(v.open_question.per_1000)} vs ${fmt(v.baseline.per_1000)} per 1k`,
    v.above ? 'pass' : 'below: drop the mechanic',
  ]));
  L.push(cellLine('Per-injury loop time (median)', `≤ ${GATE_THRESHOLDS.loop_median_min} min`, g.loop_time, (v) => [
    `${v.median_active} min active (${v.median_wall} wall, n=${v.n})`,
    v.median_active <= GATE_THRESHOLDS.loop_median_min ? 'pass' : 'above: automate card rendering first',
  ]));

  L.push('');
  L.push('Cards (impressions: frozen = read once at ≥7 days; live = younger, shown, not in a median)');
  for (const c of [...a.card_rows].sort((x, y) => x.posted_at.localeCompare(y.posted_at))) {
    const loop = a.loop_rows.find((l) => l.entry_id === c.entry_id);
    L.push(
      `  ${c.entry_id}  posted ${etCalendarDate(new Date(c.posted_at))}  ${c.frozen ? 'frozen' : 'live  '} age=${c.age_days}d  impr=${c.impressions}${c.frozen && c.live_impressions !== null ? ` (now ${c.live_impressions})` : ''}  replies=${c.reply_count}  loop=${loop ? `${loop.active_min}/${loop.wall_min} min` : '—'}`,
    );
  }
  for (const id of a.unmeasured_cards) L.push(`  ${id}  not measurable — X returned no metrics for the card`);

  L.push('');
  L.push('Definitions (src/ledger/gate.ts):');
  L.push('  Weeks run Sun–Sat, New York. Tuesday pass = every proposal due at Tue 00:00 ET decided before Wed 06:00 ET, with ≥1 decision');
  L.push('  in [Mon 18:00, Wed 06:00). Whether the resolution CARD was posted is not recorded anywhere and is not checked.');
  L.push('  Weeks 1–4 cards were frozen late (age shown); cumulative counts bias them UP, against "rising" — the conservative direction.');
  L.push(`  Reply rate = (reply_count − our own direct replies) per 1,000 impressions. Loop active = gaps ≤ ${LOOP_GAP_CAP_MIN} min between`);
  L.push('  the draft\'s audit rows through the X post, summed. It misses film/research before the draft is opened and any stretch');
  L.push(`  over ${LOOP_GAP_CAP_MIN} min without a save; the 30-min reply watch is outside the spec's 40. Wall = draft created → X post.`);
  return L.join('\n');
}

async function main(): Promise<void> {
  const asOfDate = opt('--as-of');
  if (asOfDate !== null && !isIsoDate(asOfDate)) throw new Error(`--as-of must be YYYY-MM-DD, got ${asOfDate}`);
  const asOf = asOfDate ? endOfEtDayIso(asOfDate) : new Date().toISOString();
  const effective = Date.parse(asOf) > Date.now() ? new Date().toISOString() : asOf;

  await initializeMCPClients();
  if (!isServerAvailable('web')) throw new Error('web MCP unavailable — set WEB_MCP_URL and MCP_AUTH_SECRET');
  try {
    const raw = await readAll();
    if (has('--record-fixtures')) {
      console.error(`[GateReport] fixtures written to ${recordFixtures(raw, asOfDate ?? etCalendarDate(new Date()))}`);
    }
    const assembled = assembleGate(raw, effective);
    const report = buildGateReport(assembled.input);
    if (has('--json')) console.log(JSON.stringify({ report, cards: assembled.card_rows, loops: assembled.loop_rows }, null, 2));
    else console.log(render(report, assembled));
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error(`[GateReport] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
