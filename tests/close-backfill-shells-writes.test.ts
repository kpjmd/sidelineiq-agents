import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  initializeMCPClients: vi.fn(async () => {}),
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => true),
  disconnectAll: vi.fn(async () => {}),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { run, parseOptions, DEFAULT_VOID_REASON } from '../src/scripts/close-backfill-shells.js';
import type { ShellCandidate, ShellPolicy } from '../src/utils/backfill-shells.js';

// The write loop. Everything here is about what reaches web_thread_close.
//
// FAILS-ON-OLD: set closed_by to the script name instead of the literal 'system'
// and `stamps the audit actor as system` fails. closeThread does
//   actor: closed_by && closed_by !== "system" ? "md" : "system"
// so that one word is the difference between the permanent audit trail saying a
// script retracted these threads and it saying a physician did.
//
// FAIL-CLOSED IN BOTH DIRECTIONS: the dry-run case asserts ZERO closes are
// issued without --apply, and the apply case asserts real closes are, so neither
// a script that never writes nor one that always writes can pass both.

interface Fixture {
  _policy: ShellPolicy;
  rows: ShellCandidate[];
  audit_counts: Record<string, number>;
}
const fx = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/backfill-shell-threads.json'), 'utf-8'),
) as Fixture;
const SHELLS = fx.rows.filter(
  (r) => !r.injury_date && r.first_reported_at.startsWith('2026-05-31'),
);

const mockCallTool = vi.mocked(callTool);
const ok = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const mcpError = (msg: string) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
});

let dir: string;
let argvBackup: string[];

/** Serve a corpus of N shells built by cloning the recorded ones. */
function serve(opts: {
  closeResponse?: (entityId: string, n: number) => unknown;
  entities?: ShellCandidate[];
  freshOverride?: Record<string, Partial<ShellCandidate>>;
}) {
  const entities = opts.entities ?? SHELLS;
  let closeCalls = 0;
  const seenGet = new Map<string, number>();
  mockCallTool.mockImplementation(async (_server: string, tool: string, args: any) => {
    if (tool === 'web_list_threads') {
      return ok({
        threads: entities.map((e) => ({
          id: e.id,
          athlete_name: e.athlete_name,
          sport: 'NFL',
          first_reported_at: e.first_reported_at,
        })),
      });
    }
    if (tool === 'web_thread_get') {
      const e = entities.find((x) => x.id === args.entity_id)!;
      const nth = (seenGet.get(args.entity_id) ?? 0) + 1;
      seenGet.set(args.entity_id, nth);
      // The second read of an entity is the pre-write re-verify.
      const override = nth > 1 ? (opts.freshOverride?.[args.entity_id] ?? {}) : {};
      return ok({ entity: { ...e, ...override } });
    }
    if (tool === 'web_list_audit_entries') return ok({ entries: [] });
    if (tool === 'web_thread_close') {
      closeCalls += 1;
      const custom = opts.closeResponse?.(args.entity_id, closeCalls);
      if (custom) return custom;
      return ok({ entity: { status: 'VOID', void_reason: args.void_reason } });
    }
    if (tool === 'web_audit_append') return ok({ ok: true });
    throw new Error(`unexpected tool ${tool}`);
  });
}

const closeCallArgs = (): any[] =>
  mockCallTool.mock.calls.filter((c) => c[1] === 'web_thread_close').map((c) => c[2]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shells-'));
  argvBackup = process.argv;
  mockCallTool.mockReset();
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = argvBackup;
  process.exitCode = 0;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function argv(...flags: string[]): void {
  process.argv = ['node', 'close-backfill-shells.ts', `--manifest=${join(dir, 'm.json')}`,
    '--delay-ms=0', ...flags];
}
const manifest = () => JSON.parse(readFileSync(join(dir, 'm.json'), 'utf-8'));

describe('dry run is the default state', () => {
  it('issues ZERO web_thread_close calls but still writes a manifest', async () => {
    serve({});
    argv();
    await run();
    expect(closeCallArgs()).toHaveLength(0);
    const m = manifest();
    expect(m._mode).toBe('dry-run');
    expect(m.entries.filter((e: any) => e.decision === 'void')).toHaveLength(SHELLS.length);
    expect(m.entries.every((e: any) => e.outcome === undefined)).toBe(true);
  });

  it('--apply without --confirm throws before anything is read', () => {
    argv('--apply');
    expect(() => parseOptions()).toThrowError(/--confirm/);
  });
});

describe('--apply --confirm', () => {
  it('closes every shell as VOID with a reason and no actual_return_date', async () => {
    serve({});
    argv('--apply', '--confirm');
    await run();
    const calls = closeCallArgs();
    expect(calls).toHaveLength(SHELLS.length);
    for (const a of calls) {
      expect(a.outcome).toBe('VOID');
      expect(a.void_reason).toBe(DEFAULT_VOID_REASON);
      // closeThread REJECTS actual_return_date for VOID — a voided thread never
      // described a real injury, so there is no return to record.
      expect('actual_return_date' in a).toBe(false);
    }
    expect(manifest().entries.filter((e: any) => e.outcome === 'voided'))
      .toHaveLength(SHELLS.length);
    expect(process.exitCode).toBe(0);
  });

  it('stamps the audit actor as system, not md', async () => {
    serve({});
    argv('--apply', '--confirm');
    await run();
    // FAILS-ON-OLD. closeThread reads any non-"system" closed_by as an MD acting.
    for (const a of closeCallArgs()) expect(a.closed_by).toBe('system');
  });

  it('records its own provenance row as actor automation', async () => {
    serve({});
    argv('--apply', '--confirm');
    await run();
    const appends = mockCallTool.mock.calls.filter((c) => c[1] === 'web_audit_append');
    expect(appends).toHaveLength(SHELLS.length);
    for (const c of appends) {
      const a = c[2] as any;
      expect(a.actor).toBe('automation');
      expect(a.actor_id).toBe('close-backfill-shells');
      expect(a.entity_type).toBe('injury_thread');
      expect(a.action).toBe('backfill_shell_voided');
    }
  });
});

describe('a rejected close is a value carrying isError, not a throw', () => {
  it('records the error, keeps going, and exits 1', async () => {
    const many = [0, 1, 2].map((i) => ({
      ...SHELLS[0],
      id: `0000000${i}-0000-4000-8000-00000000000${i}`,
    }));
    serve({
      entities: many,
      closeResponse: (_id, n) => (n === 2 ? mcpError('entity is already VOID') : undefined),
    });
    argv('--apply', '--confirm');
    await run();

    expect(closeCallArgs()).toHaveLength(3);
    const outcomes = manifest().entries.map((e: any) => e.outcome);
    expect(outcomes).toEqual(['voided', 'error', 'voided']);
    expect(manifest().entries[1].error).toContain('already VOID');
    expect(process.exitCode).toBe(1);
  });

  it('a close that reports success without landing VOID is an error', async () => {
    serve({ closeResponse: () => ({ content: [{ type: 'text',
      text: JSON.stringify({ entity: { status: 'ACTIVE', void_reason: null } }) }] }) });
    argv('--apply', '--confirm');
    await run();
    expect(manifest().entries.every((e: any) => e.outcome === 'error')).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('re-verify immediately before the write', () => {
  it('skips a thread that stopped being a shell since the snapshot', async () => {
    const target = SHELLS[0].id;
    serve({ freshOverride: { [target]: { needs_date_review: true } } });
    argv('--apply', '--confirm');
    await run();

    const closed = closeCallArgs().map((a) => a.entity_id);
    expect(closed).not.toContain(target);
    const entry = manifest().entries.find((e: any) => e.entity_id === target);
    expect(entry.outcome).toBe('skipped_reverify');
    expect(entry.reason).toBe('needs_date_review');
  });
});

describe('blast radius and named ids', () => {
  it('aborts without writing when more match than --max', async () => {
    serve({});
    argv('--apply', '--confirm', '--max=0');
    await expect(run()).rejects.toThrowError(/--max is 0/);
    expect(closeCallArgs()).toHaveLength(0);
  });

  it('refuses --entity-ids naming something that is not an eligible match', async () => {
    serve({});
    argv('--entity-ids=deadbeef-0000-4000-8000-000000000000');
    await expect(run()).rejects.toThrowError(/not eligible matches/);
  });

  it('restricts the run to the named ids', async () => {
    serve({});
    argv('--apply', '--confirm', `--entity-ids=${SHELLS[0].id}`);
    await run();
    expect(closeCallArgs().map((a) => a.entity_id)).toEqual([SHELLS[0].id]);
  });
});

describe('the ACTIVE scan must not be truncated', () => {
  it('throws when the list comes back at the page cap', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `id-${i}`, athlete_name: 'x', sport: 'NFL',
      first_reported_at: '2026-05-31T23:19:00.000Z',
    }));
    mockCallTool.mockImplementation(async (_s: string, tool: string) => {
      if (tool === 'web_list_threads') return ok({ threads: many });
      throw new Error(`unexpected ${tool}`);
    });
    argv();
    await expect(run()).rejects.toThrowError(/500-row cap/);
  });
});
