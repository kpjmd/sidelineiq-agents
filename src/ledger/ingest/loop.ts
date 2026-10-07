/**
 * The resolution ingest loop (spec "Weekly workflow → Tuesday scoring pass",
 * "Implementation handoff → Automation boundary"). Reads every published entry
 * with an open field, fetches the three public sources, applies the
 * pre-registered rules, and — in `on` only — files PROPOSALS through
 * `web_propose_ledger_resolution`. Nothing here can resolve a field: the only
 * write tool it names is the proposal tool, and a test greps this directory for
 * the confirm, correction and linkage tools and for every social tool.
 *
 *   LEDGER_INGEST_MODE        off | shadow | on   (default shadow)
 *   LEDGER_INGEST_INTERVAL_MS default 24h, chained setTimeout (never setInterval)
 *
 * Shadow decides and logs and writes nothing, including the cases that look
 * obviously safe. The admin route may run a shadow pass whatever the env says,
 * and can never force `on`.
 *
 * Failure policy: every read happens BEFORE the first write. Any failed read —
 * the ledger export, a nflverse file, a transactions page, 404 included —
 * aborts the cycle with zero writes. A missing file read as "no games" or a
 * missing page read as "no transactions" would propose a confident 0.
 */
import { callTool, isServerAvailable } from '../../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../../utils/publishing-pipeline.js';
import { addDays, etCalendarDate, type IsoDate } from '../dates.js';
import type { ResolutionFacts } from '../rules.js';
import { fetchNflverseFacts, nflverseUrlsFromEnv, type FetchLike, type NflverseUrls, NflverseFactsUnavailableError } from './nflverse.js';
import {
  attributeTransactions,
  extractTransactionEvents,
  fetchTransactionsSince,
  teamNamesFrom,
  TransactionsUnavailableError,
  type FetchJson,
} from './espn-transactions.js';
import {
  buildEntryContext,
  openFieldsOf,
  resolveEntryTeam,
  proposeForEntry,
  teamIsScheduled,
  type HeldField,
  type IngestForecastRow,
  type IngestResolutionRow,
  type ResolutionProposal,
  type TeamSource,
} from './propose.js';
import { fetchEspnJson } from '../../monitoring/sports/espn-json.js';

export type LedgerIngestMode = 'off' | 'shadow' | 'on';

export function ledgerIngestMode(env: NodeJS.ProcessEnv = process.env): LedgerIngestMode {
  const raw = (env.LEDGER_INGEST_MODE ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'on' ? raw : 'shadow';
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 60 * 1000;

export function ledgerIngestIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.LEDGER_INGEST_INTERVAL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

export type IngestCallTool = (server: 'web', tool: string, params: Record<string, unknown>) => Promise<unknown>;

export interface IngestDeps {
  callTool: IngestCallTool;
  isServerAvailable: (server: 'web') => boolean;
  /** For the nflverse CSVs. */
  fetch: FetchLike;
  /** For the ESPN transactions feed (404 → null, other failures throw TransientEspnError). */
  fetchJson: FetchJson;
  now: () => Date;
  log: (line: string) => void;
  urls?: NflverseUrls;
}

export function defaultIngestDeps(): IngestDeps {
  return {
    callTool: callTool as unknown as IngestCallTool,
    isServerAvailable: isServerAvailable as unknown as IngestDeps['isServerAvailable'],
    fetch: (input, init) => fetch(input, init),
    fetchJson: fetchEspnJson,
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

export type ProposeStatus = 'created' | 'duplicate' | 'field_locked' | 'rejected';

export interface ProposalOutcome extends ResolutionProposal {
  write: ProposeStatus | 'not_written';
  error?: string;
}

export interface LedgerIngestSummary {
  mode: LedgerIngestMode;
  today: IsoDate | null;
  entries: number;
  entries_with_open: number;
  open_fields: number;
  proposed: number;
  created: number;
  duplicate: number;
  field_locked: number;
  rejected: number;
  held: number;
  unresolvable: number;
  bad_entries: Array<{ entry_id: string; reason: string }>;
  proposals: ProposalOutcome[];
  held_fields: HeldField[];
  /** What each entry was resolved against — the team code, its source, the season and the ids. */
  contexts: Array<{ entry_id: string; team: string; team_source: TeamSource; season: number; season_assumed: boolean; pfr_id: string | null; gsis_id: string | null; open: string[] }>;
  sources: Array<{ source: string; url: string; rows: number }>;
  transactions_read: number;
  aborted: boolean;
  abort_reason?: string;
  errors: number;
}

function emptySummary(mode: LedgerIngestMode): LedgerIngestSummary {
  return {
    mode,
    today: null,
    entries: 0,
    entries_with_open: 0,
    open_fields: 0,
    proposed: 0,
    created: 0,
    duplicate: 0,
    field_locked: 0,
    rejected: 0,
    held: 0,
    unresolvable: 0,
    bad_entries: [],
    proposals: [],
    held_fields: [],
    contexts: [],
    sources: [],
    transactions_read: 0,
    aborted: false,
    errors: 0,
  };
}

function parseText<T>(raw: unknown): T {
  if (isMCPError(raw)) throw new Error(extractMCPErrorMessage(raw));
  const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error('MCP returned no content');
  return JSON.parse(text) as T;
}

interface LedgerExportShape {
  forecasts: Array<IngestForecastRow & { status?: string }>;
  resolutions: IngestResolutionRow[];
}

function summaryLine(s: LedgerIngestSummary): string {
  return (
    `[LedgerIngest] mode=${s.mode} today=${s.today ?? '-'} entries=${s.entries} with_open=${s.entries_with_open} open=${s.open_fields} ` +
    `proposed=${s.proposed} created=${s.created} dup=${s.duplicate} locked=${s.field_locked} rejected=${s.rejected} ` +
    `held=${s.held} unresolvable=${s.unresolvable} bad_entries=${s.bad_entries.length} tx_read=${s.transactions_read} ` +
    `errors=${s.errors} aborted=${s.aborted}`
  );
}

/**
 * One pass. `mode` defaults to the env; a caller may only pass something at
 * most as permissive (the admin route passes 'shadow' or the env mode).
 */
export async function runLedgerIngestCycle(opts: { mode?: LedgerIngestMode } = {}, deps: IngestDeps = defaultIngestDeps()): Promise<LedgerIngestSummary> {
  const mode = opts.mode ?? ledgerIngestMode();
  const summary = emptySummary(mode);
  if (mode === 'off') {
    deps.log('[LedgerIngest] mode=off — nothing to do');
    return summary;
  }
  const now = deps.now();
  const today = etCalendarDate(now);
  summary.today = today;

  const abort = (reason: string): LedgerIngestSummary => {
    summary.aborted = true;
    summary.abort_reason = reason;
    summary.errors++;
    deps.log(`[LedgerIngest] ABORTED — ${reason} (no proposals written)`);
    deps.log(summaryLine(summary));
    return summary;
  };

  if (!deps.isServerAvailable('web')) return abort('web MCP server unavailable');

  // ── Read 1: the ledger ──────────────────────────────────────────────
  let exported: LedgerExportShape;
  try {
    exported = parseText<LedgerExportShape>(await deps.callTool('web', 'web_export_ledger', {}));
  } catch (err) {
    return abort(`web_export_ledger failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const published = (exported.forecasts ?? []).filter((f) => f.status === undefined || f.status === 'published');
  const byEntry = new Map<string, IngestForecastRow[]>();
  for (const f of published) byEntry.set(f.entry_id, [...(byEntry.get(f.entry_id) ?? []), f]);
  summary.entries = byEntry.size;

  const work: Array<{ built: Extract<ReturnType<typeof buildEntryContext>, { ok: true }>; open: ReturnType<typeof openFieldsOf> }> = [];
  for (const [entryId, versions] of [...byEntry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const open = openFieldsOf(entryId, exported.resolutions ?? []);
    if (open.length === 0) continue;
    summary.entries_with_open++;
    summary.open_fields += open.length;
    const built = buildEntryContext(versions);
    if (!built.ok) {
      summary.bad_entries.push({ entry_id: entryId, reason: built.reason });
      continue;
    }
    work.push({ built, open });
  }
  if (work.length === 0) {
    deps.log(summaryLine(summary));
    return summary;
  }

  // ── Read 2: nflverse ────────────────────────────────────────────────
  const seasons = [...new Set(work.map((w) => w.built.ctx.season))];
  let nfl: Awaited<ReturnType<typeof fetchNflverseFacts>>;
  try {
    nfl = await fetchNflverseFacts(seasons, deps.fetch, deps.urls ?? nflverseUrlsFromEnv());
  } catch (err) {
    if (err instanceof NflverseFactsUnavailableError) return abort(err.message);
    return abort(`nflverse read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  summary.sources.push(...nfl.sources);

  // ── Read 3: transactions, from the day before the earliest open injury ──
  const earliest = work.map((w) => w.built.ctx.injury_date).sort()[0];
  let rawTx: Awaited<ReturnType<typeof fetchTransactionsSince>>;
  try {
    rawTx = await fetchTransactionsSince(addDays(earliest, -1), Number(today.slice(0, 4)), deps.fetchJson);
  } catch (err) {
    if (err instanceof TransactionsUnavailableError) return abort(err.message);
    return abort(`transactions read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  summary.transactions_read = rawTx.length;
  summary.sources.push({ source: 'espn_transactions', url: 'https://www.espn.com/nfl/transactions', rows: rawTx.length });
  const events = rawTx.flatMap(extractTransactionEvents);
  const teamNames = teamNamesFrom(rawTx);

  // ── Decide (pure) ───────────────────────────────────────────────────
  const proposals: ResolutionProposal[] = [];
  const scheduledTeams = new Set(nfl.schedule.filter((g) => g.game_type === 'REG').flatMap((g) => [g.home_team, g.away_team]));
  for (const { built: raw, open } of work) {
    const built = resolveEntryTeam(raw, scheduledTeams, teamNames);
    summary.contexts.push({
      entry_id: built.ctx.entry_id,
      team: built.ctx.team,
      team_source: built.team_source,
      season: built.ctx.season,
      season_assumed: built.season_assumed,
      pfr_id: built.ctx.pfr_id,
      gsis_id: built.ctx.gsis_id,
      open: [...open],
    });
    const facts: ResolutionFacts = {
      schedule: nfl.schedule,
      snaps: nfl.snaps,
      injuries: nfl.injuries,
      transactions: attributeTransactions(events, { player: built.player, team: built.ctx.team, teamNames: teamNames.get(built.ctx.team) ?? [] }),
      today,
    };
    if (!teamIsScheduled(built.ctx, facts)) {
      deps.log(`[LedgerIngest] ${built.ctx.entry_id}: team ${built.ctx.team || '(none)'} has no ${built.ctx.season} schedule — every field held unresolvable`);
    }
    const res = proposeForEntry(built, open, facts);
    proposals.push(...res.proposals);
    summary.held_fields.push(...res.held);
  }
  summary.proposed = proposals.length;
  summary.held = summary.held_fields.filter((h) => h.status === 'open').length;
  summary.unresolvable = summary.held_fields.filter((h) => h.status === 'unresolvable').length;

  for (const p of proposals) {
    deps.log(
      `[LedgerIngest] PROPOSE ${p.entry_id} ${p.field} ${p.proposed_status}` +
        (p.proposed_status === 'resolved' ? ` outcome=${p.proposed_outcome} on ${p.outcome_date}` : ` reason=${p.void_reason}`) +
        ` freeze_at=${p.freeze_at ?? '-'} — ${p.evidence.note}${mode === 'shadow' ? ' (shadow)' : ''}`,
    );
  }
  for (const h of summary.held_fields) {
    deps.log(`[LedgerIngest] HOLD ${h.entry_id} ${h.field} ${h.status}: ${h.reason}`);
  }

  // ── Write (on only): proposals, nothing else ────────────────────────
  if (mode !== 'on') {
    summary.proposals = proposals.map((p) => ({ ...p, write: 'not_written' }));
    deps.log(summaryLine(summary));
    return summary;
  }
  for (const p of proposals) {
    const input: Record<string, unknown> = {
      entry_id: p.entry_id,
      field: p.field,
      proposed_status: p.proposed_status,
      proposed_outcome: p.proposed_outcome,
      outcome_date: p.outcome_date,
      freeze_at: p.freeze_at,
      void_reason: p.void_reason,
      evidence_url: p.evidence_url,
      evidence: p.evidence,
      proposer: 'ingest',
    };
    try {
      const raw = await deps.callTool('web', 'web_propose_ledger_resolution', input);
      if (isMCPError(raw)) {
        const error = extractMCPErrorMessage(raw);
        summary.rejected++;
        summary.errors++;
        deps.log(`[LedgerIngest] PROPOSE REJECTED ${p.entry_id} ${p.field}: ${error}`);
        summary.proposals.push({ ...p, write: 'rejected', error });
        continue;
      }
      const out = parseText<{ status: 'created' | 'duplicate' | 'field_locked' }>(raw);
      if (out.status === 'created') summary.created++;
      else if (out.status === 'duplicate') summary.duplicate++;
      else if (out.status === 'field_locked') summary.field_locked++;
      summary.proposals.push({ ...p, write: out.status });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.rejected++;
      summary.errors++;
      deps.log(`[LedgerIngest] PROPOSE FAILED ${p.entry_id} ${p.field}: ${error}`);
      summary.proposals.push({ ...p, write: 'rejected', error });
    }
  }
  deps.log(summaryLine(summary));
  return summary;
}

// ── Scheduling ─────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let stopped = false;

function scheduleNext(intervalMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, intervalMs);
}

async function runAndReschedule(intervalMs: number): Promise<void> {
  try {
    await runLedgerIngestCycle();
  } catch (err) {
    console.error(`[LedgerIngest] cycle crashed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    scheduleNext(intervalMs);
  }
}

export function startLedgerIngest(): void {
  const mode = ledgerIngestMode();
  if (mode === 'off') {
    console.log('[LedgerIngest] mode=off — skipping startup');
    return;
  }
  stopped = false;
  const intervalMs = ledgerIngestIntervalMs();
  console.log(`[LedgerIngest] Starting — mode=${mode} interval=${intervalMs}ms (first run in ${STARTUP_DELAY_MS}ms)`);
  timer = setTimeout(() => {
    void runAndReschedule(intervalMs);
  }, STARTUP_DELAY_MS);
}

export function stopLedgerIngest(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
