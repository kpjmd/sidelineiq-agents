// Retract the May 2026 backfill shells.
//
// On 2026-05-31T23:18:44.996Z → 23:19:34.586Z — one fifty-second pass of
// src/scripts/backfill-entities.ts — 166 injury_entities were minted so that
// already-published posts would have threads. That script has no resolver import
// and never writes a date, so every one of those rows is still an ACTIVE thread
// with no injury_date, no otm_projection, no date_resolution_sources, zero
// audit_log history, and last_updated_at frozen at its creation instant.
//
// They are inert, not harmful: web_find_matching_entity gates on
// last_updated_at >= NOW() - 21 days, so at 100+ days stale nothing routes to
// them. That is also WHY they were never resolved — an unreachable resolution,
// not a failing one. What they cost is 166 rows in the MD's ACTIVE list and an
// inflated denominator under every statistic about threads the resolver can see:
// date-resolution-dryrun.ts reports "the resolver is skipped on 73/242 = 30% of
// ACTIVE threads" where the real figure over reachable threads is 73/76.
//
// VOID, not RETIRED. closeThread computes no accuracy_record for VOID by design
// (migration 020) and VOID is excluded from matching, from the frontend Accuracy
// view, and from the dashboard's listings. RETIRED would inject 166 recordless
// rows into ThreadsQueue's {withinCount}/{threads.length} denominator and drag
// down the accuracy number the platform is judged on. void_reason records why;
// RETIRED has nowhere to put it.
//
// The predicate lives in src/utils/backfill-shells.ts and is SHARED with
// date-resolution-dryrun.ts Section E, which gates on it. A divergence between
// what the ship gate measured and what this script voids is the failure mode
// this repo keeps having, so there is one definition and both import it.
//
// MUST RUN INSIDE RAILWAY. WEB_MCP_URL is *.railway.internal:
//
//   railway ssh -s sidelineiq-agents
//
// Usage (inside the container):
//   npx tsx src/scripts/close-backfill-shells.ts                       # DRY RUN
//   npx tsx src/scripts/close-backfill-shells.ts --apply --confirm     # writes
//   npx tsx src/scripts/close-backfill-shells.ts --emit-fixture --out=<path>
//
// Flags:
//   --created-from=<ISO>      inclusive (default 2026-05-31T23:00:00Z)
//   --created-to=<ISO>        inclusive (default 2026-06-01T00:00:00Z)
//   --match-window-days=<n>   default 21 — must match web_find_matching_entity
//   --max=<n>                 default 170 — ABORTS if more match; never truncates
//   --manifest=<path>         default ./close-backfill-shells-manifest.json
//   --entity-ids=<uuid,…>     restrict to named ids; each must be an eligible match
//   --void-reason=<text>      override the default reason
//   --delay-ms=<n>            default 250
//   --emit-fixture --out=<p>  record real payloads for tests; writes nothing to the DB
//   --apply --confirm         BOTH required before a single write happens
//
// The manifest is written on a DRY RUN too, so it can be diffed against the
// post-apply copy and kept as the record of what was retracted. The container
// has no editor, so it is printed as well.
//
// Re-runnable: the predicate requires status ACTIVE, so a second run matches
// nothing. closeThread is idempotent regardless.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll }
  from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import {
  classifyShell,
  daysStale,
  assertBlastRadius,
  defaultShellPolicy,
  BACKFILL_WINDOW,
  MATCH_WINDOW_DAYS,
  type ShellCandidate,
  type ShellPolicy,
  type ShellReason,
} from '../utils/backfill-shells.js';

const LIST_LIMIT = 500;
const ACTOR_ID = 'close-backfill-shells';

const DEFAULT_VOID_REASON =
  'backfill shell: created by src/scripts/backfill-entities.ts in the 2026-05-31 ' +
  'migration pass with no injury_date; never resolved (date_resolution_sources ' +
  'null, zero audit_log rows) and inert since — last_updated_at is older than ' +
  "web_find_matching_entity's recency window, so nothing has routed to it. " +
  'Retracted, not resolved: there is no projection to score.';

export interface SweepRow extends ShellCandidate {
  sport: string | null;
}

export interface ManifestEntry {
  entity_id: string;
  athlete_name: string | null;
  sport: string | null;
  body_part: string | null;
  status: string;
  first_reported_at: string;
  last_updated_at: string;
  days_stale: number;
  canonical_post_id: string | null;
  audit_entries: number;
  decision: 'void' | 'skip';
  reason: ShellReason;
  outcome?: 'voided' | 'skipped_reverify' | 'error';
  error?: string;
}

/**
 * Pure. Everything the tests drive goes through here, so the decision can be
 * exercised without a database and without the write loop.
 */
export function buildManifest(
  rows: SweepRow[],
  auditCounts: Map<string, number>,
  policy: ShellPolicy,
): ManifestEntry[] {
  return rows.map((r) => {
    const { shell, reason } = classifyShell(r, policy, auditCounts.get(r.id) ?? 0);
    return {
      entity_id: r.id,
      athlete_name: r.athlete_name ?? null,
      sport: r.sport,
      body_part: r.body_part,
      status: r.status,
      first_reported_at: r.first_reported_at,
      last_updated_at: r.last_updated_at,
      days_stale: daysStale(r, policy.now),
      canonical_post_id: r.canonical_post_id,
      audit_entries: auditCounts.get(r.id) ?? 0,
      decision: shell ? 'void' : 'skip',
      reason,
    };
  });
}

export function renderTable(entries: ManifestEntry[]): string {
  const head = [
    'entity  athlete                   sport  body_part   stale  audit  canon  decision  reason',
    '------  ------------------------  -----  ----------  -----  -----  -----  --------  ------',
  ];
  const body = entries.map((e) =>
    [
      e.entity_id.slice(0, 6),
      (e.athlete_name ?? '?').slice(0, 24).padEnd(24),
      (e.sport ?? '?').padEnd(5),
      (e.body_part ?? '-').slice(0, 10).padEnd(10),
      `${e.days_stale}d`.padStart(5),
      String(e.audit_entries).padStart(5),
      (e.canonical_post_id ? 'yes' : 'no').padStart(5),
      e.decision.padEnd(8),
      e.outcome ? `${e.reason} → ${e.outcome}${e.error ? ` (${e.error})` : ''}` : e.reason,
    ].join('  '),
  );
  return [...head, ...body].join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────
// Read lazily rather than captured at import: parseOptions is exported and the
// write-loop tests drive it by setting process.argv, which a module-level
// snapshot would silently ignore.
const getArgv = (): string[] => process.argv.slice(2);
const flag = (name: string): string | null => {
  const argv = getArgv();
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => {
  const argv = getArgv();
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
};

interface Options {
  policy: ShellPolicy;
  max: number;
  manifestPath: string;
  entityIds: Set<string>;
  voidReason: string;
  delayMs: number;
  apply: boolean;
  confirm: boolean;
  emitFixture: boolean;
  out: string | null;
}

export function parseOptions(now: number = Date.now()): Options {
  const base = defaultShellPolicy(now);
  const apply = has('--apply');
  const confirm = has('--confirm');
  if (apply && !confirm) {
    throw new Error(
      '--apply requires --confirm. Read the dry-run manifest first: this voids ' +
        'threads in bulk and there is no undo beyond re-opening each by hand.',
    );
  }
  return {
    policy: {
      now,
      createdFrom: flag('--created-from') ?? base.createdFrom,
      createdTo: flag('--created-to') ?? base.createdTo,
      matchWindowDays: Number(flag('--match-window-days') ?? MATCH_WINDOW_DAYS),
    },
    max: Number(flag('--max') ?? 170),
    manifestPath: flag('--manifest') ?? './close-backfill-shells-manifest.json',
    entityIds: new Set(
      (flag('--entity-ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ),
    voidReason: flag('--void-reason') ?? DEFAULT_VOID_REASON,
    delayMs: Number(flag('--delay-ms') ?? 250),
    apply,
    confirm,
    emitFixture: has('--emit-fixture'),
    out: flag('--out'),
  };
}

/** Throws on isError; used only where a failure must stop the whole run. */
function unwrap<T>(res: unknown): T | null {
  if (isMCPError(res)) throw new Error(`MCP error: ${extractMCPErrorMessage(res)}`);
  const raw = res as { content?: Array<{ text?: string }> };
  const text = raw?.content?.[0]?.text;
  return text ? (JSON.parse(text) as T) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ListRow {
  id: string;
  athlete_name: string | null;
  sport: string | null;
  first_reported_at: string;
}

/** The full entity plus the display fields only the list join carries. */
async function readEntity(id: string, listRow: ListRow): Promise<SweepRow | null> {
  const got = unwrap<{ entity: Record<string, unknown> }>(
    await callTool('web', 'web_thread_get', { entity_id: id }),
  );
  if (!got?.entity) return null;
  const e = got.entity;
  return {
    id,
    player_id: String(e.player_id ?? ''),
    athlete_name: listRow.athlete_name,
    sport: listRow.sport,
    body_part: (e.body_part as string | null) ?? null,
    status: String(e.status ?? ''),
    injury_date: (e.injury_date as string | null) ?? null,
    otm_projection: e.otm_projection ?? null,
    date_resolution_sources: (e.date_resolution_sources as unknown[] | null) ?? null,
    accuracy_record: e.accuracy_record ?? null,
    needs_date_review: Boolean(e.needs_date_review),
    canonical_post_id: (e.canonical_post_id as string | null) ?? null,
    first_reported_at: String(e.first_reported_at ?? listRow.first_reported_at),
    last_updated_at: String(e.last_updated_at ?? ''),
  };
}

/**
 * Cheapest "does this thread have any history" test.
 *
 * entity_type is 'injury_thread'. 'injury_entity' — the table name — returns
 * `entries: []` with no error for every thread, and a broken probe here reads
 * exactly like a clean sweep, which would authorise voiding threads that DO have
 * history. date-resolution-dryrun.ts Section E gate 12 is the corpus-wide control.
 */
async function auditCount(id: string): Promise<number> {
  const got = unwrap<{ entries: unknown[] }>(
    await callTool('web', 'web_list_audit_entries', {
      entity_type: 'injury_thread',
      entity_id: id,
      limit: 1,
    }),
  );
  return got?.entries?.length ?? 0;
}

async function run(): Promise<void> {
  const opts = parseOptions();

  try {
    await initializeMCPClients();
  } catch (err) {
    console.error(`[shells] MCP init failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isServerAvailable('web')) {
    throw new Error('the web MCP server is unavailable — nothing can be read or written.');
  }

  console.log(
    opts.apply
      ? `[shells] LIVE RUN — will VOID up to ${opts.max} thread(s)`
      : '[shells] DRY RUN — nothing will be written. Add --apply --confirm to retract.',
  );
  console.log(
    `[shells] window=[${opts.policy.createdFrom}, ${opts.policy.createdTo}] ` +
      `match_window=${opts.policy.matchWindowDays}d max=${opts.max}`,
  );

  const listed =
    unwrap<{ threads: ListRow[] }>(
      await callTool('web', 'web_list_threads', { status: 'ACTIVE', limit: LIST_LIMIT }),
    )?.threads ?? [];
  // No offset on web_list_threads, so a full page means the candidate list is
  // incomplete and --max would be measured against a truncated set.
  if (listed.length >= LIST_LIMIT) {
    throw new Error(
      `the ACTIVE thread scan hit the ${LIST_LIMIT}-row cap — the candidate list is incomplete.`,
    );
  }

  // Pre-filter on the list row's creation time only. Every field that DECIDES a
  // write is re-read per entity below, so this script does not depend on the
  // widened listThreads shape and works either side of that deploy.
  const from = Date.parse(opts.policy.createdFrom);
  const to = Date.parse(opts.policy.createdTo);
  // --emit-fixture reads the WHOLE ACTIVE set so the recording can carry
  // negative controls: every in-window row shares reason 'ok', so a fixture
  // built from candidates alone can only ever prove the predicate is not
  // vacuously false, never that it is not vacuously true.
  const candidates = opts.emitFixture
    ? listed
    : listed.filter((t) => {
        const c = Date.parse(t.first_reported_at);
        return Number.isFinite(c) && c >= from && c <= to;
      });
  console.log(
    opts.emitFixture
      ? `[shells] ${listed.length} ACTIVE thread(s); reading all of them for the recording`
      : `[shells] ${listed.length} ACTIVE thread(s); ${candidates.length} created inside the window`,
  );

  const rows: SweepRow[] = [];
  const counts = new Map<string, number>();
  for (const t of candidates) {
    const row = await readEntity(t.id, t);
    if (!row) continue;
    rows.push(row);
    counts.set(t.id, await auditCount(t.id));
  }

  if (opts.emitFixture) {
    emitFixture(rows, counts, opts);
    return;
  }

  let entries = buildManifest(rows, counts, opts.policy);

  if (opts.entityIds.size > 0) {
    const eligible = new Set(entries.filter((e) => e.decision === 'void').map((e) => e.entity_id));
    const bad = [...opts.entityIds].filter((id) => !eligible.has(id));
    if (bad.length > 0) {
      throw new Error(
        `--entity-ids names ${bad.length} id(s) that are not eligible matches: ${bad.join(', ')}. ` +
          'Read the manifest — each one has a reason.',
      );
    }
    entries = entries.filter((e) => opts.entityIds.has(e.entity_id) || e.decision === 'skip');
  }

  const toVoid = entries.filter((e) => e.decision === 'void');
  // ABORTS, never truncates: a count above what the operator expected means the
  // predicate or the window is wrong, and voiding the first N of a wrong set is
  // worse than voiding none.
  assertBlastRadius(toVoid.length, opts.max);

  console.log(`\n${renderTable(entries)}\n`);
  console.log(
    `[shells] ${toVoid.length} to VOID, ${entries.length - toVoid.length} skipped ` +
      `(${summarizeReasons(entries)})`,
  );

  let anyFailure = false;

  if (opts.apply) {
    for (const entry of toVoid) {
      try {
        // Re-verify against a FRESH read. The sweep is slow and a thread could
        // in principle be touched mid-run; the snapshot is not authority.
        const listRow = candidates.find((c) => c.id === entry.entity_id)!;
        const fresh = await readEntity(entry.entity_id, listRow);
        const freshAudit = await auditCount(entry.entity_id);
        const recheck = fresh
          ? classifyShell(fresh, opts.policy, freshAudit)
          : { shell: false, reason: 'not_active' as ShellReason };
        if (!recheck.shell) {
          entry.outcome = 'skipped_reverify';
          entry.reason = recheck.reason;
          console.log(`[shells] SKIP ${entry.entity_id} — re-verify failed (${recheck.reason})`);
          continue;
        }

        const res = await callTool('web', 'web_thread_close', {
          entity_id: entry.entity_id,
          outcome: 'VOID',
          void_reason: opts.voidReason,
          // MUST be the literal 'system'. closeThread does
          //   actor: closed_by && closed_by !== "system" ? "md" : "system"
          // so passing the script name would stamp the permanent audit trail
          // with a claim that a physician retracted 166 threads.
          closed_by: 'system',
        });
        if (isMCPError(res)) {
          entry.outcome = 'error';
          entry.error = extractMCPErrorMessage(res);
          anyFailure = true;
          console.error(`[shells] VOID REJECTED ${entry.entity_id} — ${entry.error}`);
          continue;
        }
        const closed = unwrap<{ entity: { status?: string; void_reason?: string | null } }>(res);
        if (closed?.entity?.status !== 'VOID' || !closed.entity.void_reason) {
          entry.outcome = 'error';
          entry.error = `write did not land: status=${closed?.entity?.status ?? 'none'}`;
          anyFailure = true;
          console.error(`[shells] VOID DID NOT LAND ${entry.entity_id}`);
          continue;
        }

        // closeThread's own audit row is correctly actor 'system' and carries no
        // script identity. This one says which run did it and under what policy.
        await callTool('web', 'web_audit_append', {
          actor: 'automation',
          actor_id: ACTOR_ID,
          entity_type: 'injury_thread',
          entity_id: entry.entity_id,
          action: 'backfill_shell_voided',
          payload: {
            policy: opts.policy,
            days_stale: entry.days_stale,
            first_reported_at: entry.first_reported_at,
            canonical_post_id: entry.canonical_post_id,
          },
        });

        entry.outcome = 'voided';
        console.log(`[shells] VOID ${entry.entity_id} ${entry.athlete_name ?? '?'}`);
      } catch (err) {
        entry.outcome = 'error';
        entry.error = err instanceof Error ? err.message : String(err);
        anyFailure = true;
        console.error(`[shells] ERROR ${entry.entity_id} — ${entry.error}`);
      }
      await sleep(opts.delayMs);
    }
  }

  writeManifest(entries, opts);
  if (anyFailure) process.exitCode = 1;
}

function summarizeReasons(entries: ManifestEntry[]): string {
  const c = new Map<string, number>();
  for (const e of entries.filter((x) => x.decision === 'skip')) {
    c.set(e.reason, (c.get(e.reason) ?? 0) + 1);
  }
  return c.size === 0 ? 'none' : [...c].map(([k, v]) => `${k}=${v}`).join(' ');
}

function writeManifest(entries: ManifestEntry[], opts: Options): void {
  const payload = {
    _written_at: new Date(opts.policy.now).toISOString(),
    _mode: opts.apply ? 'apply' : 'dry-run',
    _policy: opts.policy,
    _void_reason: opts.voidReason,
    entries,
  };
  const path = resolve(process.cwd(), opts.manifestPath);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[shells] manifest → ${path}`);
}

/**
 * Record real payloads for the tests. Selection is MECHANICAL — the repo has
 * been burned five times by fixtures hand-written to match the code's blind spot.
 */
function emitFixture(
  rows: SweepRow[],
  counts: Map<string, number>,
  opts: Options,
): void {
  // Keyed on (reason, has-canonical-post) rather than reason alone: the
  // in-window cohort splits into 139 rows with a canonical post and 27 whose
  // post was DELETED by a pre-migration-021 reject (ON DELETE SET NULL). Both
  // are shells and both must be in the recording, or a future edit that
  // reinstates a canonical_post_id conjunct passes its tests.
  const seen = new Set<string>();
  const selected: SweepRow[] = [];
  for (const r of rows) {
    const { reason } = classifyShell(r, opts.policy, counts.get(r.id) ?? 0);
    const key = `${reason}|${r.canonical_post_id ? 'canon' : 'no-canon'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(r);
  }
  const payload = {
    _recorded_from:
      'live production DB via src/scripts/close-backfill-shells.ts --emit-fixture',
    _recorded_at: new Date(opts.policy.now).toISOString().slice(0, 10),
    _note:
      'Selection is mechanical: the first entity per (ShellReason x has-canonical-post) ' +
      'pair present in the live ACTIVE corpus — candidates AND negative controls, since ' +
      'every in-window row shares reason ok. Payloads are raw web_thread_get entity rows plus the two ' +
      'display fields only the list join carries. Never hand-author these — four fixtures ' +
      'in this repo have shared the code\'s blind spot because they were written to match it.',
    _policy: opts.policy,
    _selected_from: rows.length,
    rows: selected,
    audit_counts: Object.fromEntries(selected.map((r) => [r.id, counts.get(r.id) ?? 0])),
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (opts.out) {
    writeFileSync(resolve(process.cwd(), opts.out), json);
    console.error(`[shells] wrote ${opts.out} (${selected.length} of ${rows.length} rows)`);
  } else {
    console.log(json);
  }
}

// Only run when invoked directly, so the tests can import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run()
    .catch((err) => {
      console.error(`[shells] fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(() => {
      void disconnectAll().catch(() => {});
    });
}

export { run, DEFAULT_VOID_REASON, BACKFILL_WINDOW };
