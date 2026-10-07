/**
 * The ledger's HTTP surface on the agents service. Registered from index.ts
 * AFTER `app.use('/admin', requireAdminSecret)`, so every path here sits behind
 * the Bearer guard (tests/ledger-admin-routes.test.ts pins both facts). Thin:
 * each handler maps one module's result to a status code.
 *
 *   POST /admin/ledger/publish/:id   {dry_run?, force_standalone?}  → publish.ts
 *     force_standalone: post the card on its own (unparseable reply_to_url, or
 *     X refusing the reply because the report author never mentioned us)
 *   POST /admin/ledger/reply/:id                                     → publish-reply.ts
 *   GET  /admin/ledger/nflverse-ids?espn_id=                         → nflverse-players.ts
 */
import type express from 'express';
import { callTool, isServerAvailable } from '../utils/mcp-client-manager.js';
import { publishLedgerForecast, publishDepsFromEnv, LedgerPublishRefused, type PublishDeps } from './publish.js';
import { publishApprovedReply, ReplyPublishRefused, type ReplyPublishDeps } from './publish-reply.js';
import { lookupNflverseIds, NflverseUnavailableError } from './nflverse-players.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LedgerRouteDeps {
  publishDeps: () => PublishDeps;
  replyDeps: () => ReplyPublishDeps;
  lookup: typeof lookupNflverseIds;
}

export function defaultLedgerRouteDeps(): LedgerRouteDeps {
  const ct = callTool as PublishDeps['callTool'];
  const avail = isServerAvailable as PublishDeps['isServerAvailable'];
  return {
    publishDeps: () => publishDepsFromEnv(ct, avail),
    replyDeps: () => ({ callTool: ct, isServerAvailable: avail, log: (line) => console.log(line) }),
    lookup: lookupNflverseIds,
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
