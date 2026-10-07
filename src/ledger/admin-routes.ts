/**
 * The ledger's HTTP surface on the agents service. Registered from index.ts
 * AFTER `app.use('/admin', requireAdminSecret)`, so every path here sits behind
 * the Bearer guard (tests/ledger-admin-routes.test.ts pins both facts). Thin:
 * each handler maps one module's result to a status code.
 *
 *   POST /admin/ledger/publish/:id   {dry_run?, force_standalone?}  → publish.ts
 *     force_standalone: skip the reply attempt (required for an unparseable
 *     reply_to_url). X refusing the reply falls back to standalone on its own.
 *   POST /admin/ledger/reply/:id                                     → publish-reply.ts
 *   GET  /admin/ledger/nflverse-ids?espn_id=                         → nflverse-players.ts
 *   POST /admin/ledger/ingest        {mode?: 'shadow'}               → ingest/loop.ts
 *     Runs one ingest pass. A request can only make it LESS permissive: it
 *     runs shadow when asked, and shadow when the env says off (a read-only
 *     pass is what the Tuesday hand-check needs). It never forces `on`.
 *   GET  /admin/ledger/scoreboard?since=YYYY-MM-DD[&format=csv]      → scoreboard.ts
 *     Both boards, calibration, revision delta, voids, the card line, and the
 *     resolution-card / scoreboard-card TEXT. format=csv is the raw export.
 */
import type express from 'express';
import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { publishLedgerForecast, publishDepsFromEnv, LedgerPublishRefused, type PublishDeps } from './publish.js';
import { publishApprovedReply, ReplyPublishRefused, type ReplyPublishDeps } from './publish-reply.js';
import { lookupNflverseIds, NflverseUnavailableError } from './nflverse-players.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { runLedgerIngestCycle, ledgerIngestMode, type LedgerIngestMode, type LedgerIngestSummary } from './ingest/loop.js';
import { buildScoreboardReport, ledgerCsv, type LedgerExportPayload } from './scoreboard.js';
import { addDays, etCalendarDate, isIsoDate } from './dates.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LedgerRouteDeps {
  publishDeps: () => PublishDeps;
  replyDeps: () => ReplyPublishDeps;
  lookup: typeof lookupNflverseIds;
  ingest: (mode: LedgerIngestMode) => Promise<LedgerIngestSummary>;
  envIngestMode: () => LedgerIngestMode;
  exportLedger: () => Promise<LedgerExportPayload>;
  now: () => Date;
}

async function exportLedgerViaMcp(): Promise<LedgerExportPayload> {
  if (!isServerAvailable('web')) throw new Error('web MCP server unavailable');
  const raw = await callTool('web', 'web_export_ledger', {});
  if (isMCPError(raw)) throw new Error(`web_export_ledger failed: ${extractMCPErrorMessage(raw)}`);
  const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error('web_export_ledger returned no content');
  return JSON.parse(text) as LedgerExportPayload;
}

/** The mode a request may run: never more permissive than the env, shadow when asked or when the env is off. */
export function requestIngestMode(env: LedgerIngestMode, requested: unknown): LedgerIngestMode {
  if (requested === 'shadow' || env === 'off') return 'shadow';
  return env;
}

export function defaultLedgerRouteDeps(): LedgerRouteDeps {
  const ct = callTool as PublishDeps['callTool'];
  const avail = isServerAvailable as PublishDeps['isServerAvailable'];
  return {
    publishDeps: () => publishDepsFromEnv(ct, avail),
    replyDeps: () => ({ callTool: ct, isServerAvailable: avail, log: (line) => console.log(line) }),
    lookup: lookupNflverseIds,
    ingest: (mode) => runLedgerIngestCycle({ mode }),
    envIngestMode: () => ledgerIngestMode(),
    exportLedger: exportLedgerViaMcp,
    now: () => new Date(),
  };
}

export function registerLedgerAdminRoutes(app: express.Express, deps: LedgerRouteDeps = defaultLedgerRouteDeps()): void {
  app.post('/admin/ledger/publish/:id', async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ success: false, error: 'forecast id must be a UUID' });
      return;
    }
    const body = (req.body ?? {}) as { dry_run?: unknown; force_standalone?: unknown };
    try {
      const outcome = await publishLedgerForecast(id, { dryRun: body.dry_run === true, forceStandalone: body.force_standalone === true }, deps.publishDeps());
      res.status(200).json(outcome);
    } catch (err) {
      if (err instanceof LedgerPublishRefused) {
        res.status(err.httpStatus).json({ success: false, error: err.message, detail: err.detail ?? null });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Ledger] publish ${id} failed: ${message}`);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/admin/ledger/reply/:id', async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ success: false, error: 'proposal id must be a UUID' });
      return;
    }
    try {
      const outcome = await publishApprovedReply(id, deps.replyDeps());
      res.status(outcome.success ? 200 : 502).json(outcome);
    } catch (err) {
      if (err instanceof ReplyPublishRefused) {
        res.status(err.httpStatus).json({ success: false, error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Ledger] reply ${id} failed: ${message}`);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.post('/admin/ledger/ingest', async (req, res) => {
    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = requestIngestMode(deps.envIngestMode(), body.mode);
    try {
      const summary = await deps.ingest(mode);
      res.status(summary.aborted ? 503 : 200).json({ success: !summary.aborted, ...summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[LedgerIngest] manual pass failed: ${message}`);
      res.status(500).json({ success: false, error: message });
    }
  });

  app.get('/admin/ledger/scoreboard', async (req, res) => {
    const today = etCalendarDate(deps.now());
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : '';
    if (sinceRaw && !isIsoDate(sinceRaw)) {
      res.status(400).json({ success: false, error: 'since must be YYYY-MM-DD' });
      return;
    }
    // Default window: the last 7 days — the Tuesday pass's week.
    const since = sinceRaw || addDays(today, -7);
    try {
      const payload = await deps.exportLedger();
      if (req.query.format === 'csv') {
        res.status(200).type('text/csv').set('Content-Disposition', `attachment; filename="paratros-ledger-${today}.csv"`).send(ledgerCsv(payload));
        return;
      }
      res.status(200).json({ success: true, since, ...buildScoreboardReport(payload, today, since) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({ success: false, error: message });
    }
  });

  app.get('/admin/ledger/nflverse-ids', async (req, res) => {
    const espnId = typeof req.query.espn_id === 'string' ? req.query.espn_id : '';
    if (!/^\d{1,12}$/.test(espnId)) {
      res.status(400).json({ success: false, error: 'espn_id (numeric) is required' });
      return;
    }
    try {
      const lookup = await deps.lookup(espnId);
      res.status(200).json({ success: true, lookup });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Unavailable is 503, not an "unresolved" answer: the two must never read alike.
      res.status(err instanceof NflverseUnavailableError ? 503 : 500).json({ success: false, error: message });
    }
  });
}
