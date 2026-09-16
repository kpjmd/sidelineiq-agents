// Retract ONE injury thread by id, with the reason stated by hand.
//
// close-backfill-shells.ts exists for the 2026-05-31 backfill pass and only for
// it: its eligibility predicate requires first_reported_at inside BACKFILL_WINDOW
// and its default void_reason names that script. A thread created outside that
// window is correctly refused by --entity-ids, and borrowing the reason anyway
// would write a false sentence into an immutable audit row.
//
// This script is the narrow alternative: one id, one reason you supply, and a
// refusal to touch anything that carries evidence of real coverage.
//
// A thread that has no post, no injury_updates row and no audit history is a
// shell — entities are minted BEFORE any post exists (resolveThreadAndDates,
// pre-OTM), so an event that dies anywhere downstream leaves one behind. It
// stays ACTIVE forever (nothing ages an entity out) and keeps absorbing later
// reports about that athlete as duplicates inside web_find_matching_entity's
// 21-day window.
//
// VOID, not RESOLVED: a shell never described a real injury, so there is no
// projection to score. web_thread_close writes the thread_voided audit row.
//
// Usage:
//   npx tsx src/scripts/void-thread.ts --entity-id=<uuid> --reason="..."
//   npx tsx src/scripts/void-thread.ts --entity-id=<uuid> --reason="..." --apply --confirm
//   npx tsx src/scripts/void-thread.ts --entity-id=<uuid> --reason="..." --allow-dated
//
// Dry run is the default. Both --apply and --confirm are required to write.
//
// --allow-dated permits an injury_date to be the ONLY remaining blocker. A date
// is resolver work, not coverage: resolveThreadAndDates writes one BEFORE any
// post exists, so a thread carrying a date and nothing else is a shell whose
// event died downstream — exactly what this script is for — and refusing it
// left the commonest shell shape unreachable. Every other blocker still stands,
// so the flag can never reach a thread with a post, an update, an audit row, a
// projection or an accuracy record.

import 'dotenv/config';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';

const DEFAULT_CLOSED_BY = 'ops:void-thread';

interface MCPResult {
  content?: Array<{ text?: string }>;
}

function unwrap<T>(res: unknown): T | null {
  if (isMCPError(res)) {
    throw new Error(extractMCPErrorMessage(res));
  }
  try {
    const text = (res as MCPResult)?.content?.[0]?.text;
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

interface Entity {
  id: string;
  player_id: string;
  body_part: string | null;
  laterality: string | null;
  injury_type: string | null;
  status: string;
  canonical_post_id: string | null;
  injury_date: string | null;
  otm_projection: unknown;
  accuracy_record: unknown;
  first_reported_at: string;
  last_updated_at: string;
  void_reason: string | null;
}

function parseArgs(argv: string[]) {
  const flag = (name: string): string | null => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  return {
    entityId: flag('entity-id'),
    reason: flag('reason'),
    closedBy: flag('closed-by') ?? DEFAULT_CLOSED_BY,
    apply: argv.includes('--apply'),
    confirm: argv.includes('--confirm'),
    allowDated: argv.includes('--allow-dated'),
  };
}

/**
 * Refuses anything that carries evidence the thread covered something real.
 *
 * Deliberately stricter than close-backfill-shells' predicate on the dimensions
 * that matter here and silent on the window, which is the whole point: this
 * script trades a scoped window for a hand-written reason, so the safety has to
 * come from the thread's own emptiness instead.
 */
export function blockers(
  entity: Entity,
  updateCount: number,
  auditCount: number,
  allowDated = false,
): string[] {
  const out: string[] = [];
  if (entity.status !== 'ACTIVE') out.push(`status is ${entity.status}, not ACTIVE`);
  if (entity.canonical_post_id) out.push(`has a canonical post (${entity.canonical_post_id})`);
  if (updateCount > 0) out.push(`has ${updateCount} injury_updates row(s)`);
  if (auditCount > 0) out.push(`has ${auditCount} audit_log row(s)`);
  // A date alone is resolver work, not evidence the thread covered anything —
  // see --allow-dated above. It stays a blocker by default because a dated
  // thread is the one a careless sweep would take.
  if (entity.injury_date && !allowDated) {
    out.push(`has an injury_date (${entity.injury_date}); pass --allow-dated if that is the only blocker`);
  }
  if (entity.otm_projection != null) out.push('has an otm_projection');
  if (entity.accuracy_record != null) out.push('has an accuracy_record');
  return out;
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.entityId) {
    console.error('[void-thread] --entity-id=<uuid> is required');
    process.exitCode = 1;
    return;
  }
  if (!opts.reason || opts.reason.trim().length === 0) {
    console.error(
      '[void-thread] --reason="..." is required. The reason lands in an immutable audit row; ' +
        'write what is actually true of THIS thread.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    opts.apply && opts.confirm
      ? '[void-thread] LIVE RUN — will VOID one thread'
      : '[void-thread] DRY RUN — nothing will be written. Add --apply --confirm to retract.',
  );

  const thread = unwrap<{ entity: Entity; updates: unknown[] }>(
    await callTool('web', 'web_thread_get', { entity_id: opts.entityId }),
  );
  if (!thread?.entity) {
    console.error(`[void-thread] no thread found for entity_id=${opts.entityId}`);
    process.exitCode = 1;
    return;
  }
  const { entity } = thread;
  const updates = thread.updates ?? [];

  const audit = unwrap<{ entries: unknown[] }>(
    await callTool('web', 'web_list_audit_entries', {
      // 'injury_thread' is the string this table is keyed on — 'injury_entity'
      // returns entries:[] with no error at all.
      entity_type: 'injury_thread',
      entity_id: opts.entityId,
      limit: 50,
    }),
  );
  const auditEntries = audit?.entries ?? [];

  console.log('[void-thread] thread:');
  console.log(`  id                = ${entity.id}`);
  console.log(`  player_id         = ${entity.player_id}`);
  console.log(`  body_part         = ${entity.body_part ?? 'null'}`);
  console.log(`  laterality        = ${entity.laterality ?? 'null'}`);
  console.log(`  injury_type       = ${entity.injury_type ?? 'null'}`);
  console.log(`  status            = ${entity.status}`);
  console.log(`  canonical_post_id = ${entity.canonical_post_id ?? 'null'}`);
  console.log(`  injury_date       = ${entity.injury_date ?? 'null'}`);
  console.log(`  first_reported_at = ${entity.first_reported_at}`);
  console.log(`  last_updated_at   = ${entity.last_updated_at}`);
  console.log(`  injury_updates    = ${updates.length}`);
  console.log(`  audit_log rows    = ${auditEntries.length}`);

  const stop = blockers(entity, updates.length, auditEntries.length, opts.allowDated);
  if (opts.allowDated && entity.injury_date) {
    console.log(
      `  [--allow-dated] injury_date ${entity.injury_date} waived; every other blocker still applies`,
    );
  }
  if (stop.length > 0) {
    console.error(
      `[void-thread] REFUSING to void ${entity.id} — this thread carries evidence of real coverage:\n` +
        stop.map((b) => `  • ${b}`).join('\n') +
        '\nIf it should still be closed, do it deliberately through web_thread_close by hand.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[void-thread] no blockers. reason:\n  ${opts.reason}`);

  if (!opts.apply || !opts.confirm) {
    console.log('[void-thread] dry run complete — re-run with --apply --confirm to write.');
    return;
  }

  const closed = unwrap<{ entity: Entity }>(
    await callTool('web', 'web_thread_close', {
      entity_id: entity.id,
      outcome: 'VOID',
      void_reason: opts.reason,
      closed_by: opts.closedBy,
    }),
  );
  if (!closed?.entity) {
    console.error('[void-thread] web_thread_close returned no entity — verify by hand');
    process.exitCode = 1;
    return;
  }

  // Read back rather than trusting the write's own echo: the post-write read is
  // the only thing that proves the row actually moved.
  const after = unwrap<{ entity: Entity }>(
    await callTool('web', 'web_thread_get', { entity_id: entity.id }),
  );
  if (after?.entity?.status !== 'VOID') {
    console.error(
      `[void-thread] read-back says status=${after?.entity?.status ?? 'unknown'}, expected VOID — verify by hand`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[void-thread] ${entity.id} is VOID. void_reason stored:\n  ${after.entity.void_reason}`);
}

async function main(): Promise<void> {
  await initializeMCPClients();
  try {
    await run();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[void-thread] fatal:', err);
  process.exit(1);
});
