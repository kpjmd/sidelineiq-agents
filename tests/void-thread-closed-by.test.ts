import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  initializeMCPClients: vi.fn(async () => {}),
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => true),
  disconnectAll: vi.fn(async () => {}),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { run, buildCloseArgs, CLOSED_BY, ACTOR_ID } from '../src/scripts/void-thread.js';

// What void-thread.ts sends to web_thread_close.
//
// FAILS-ON-OLD: the script used to default closed_by to 'ops:void-thread'.
// closeThread does
//   actor: closed_by && closed_by !== "system" ? "md" : "system"
// and exempts any non-'system' caller from its system-caller refusals, so every
// VOID this script wrote was audited as a physician's act. Five live
// thread_voided rows carry actor=md, actor_id=ops:void-thread for that reason.

const ENTITY_ID = '00000000-0000-4000-8000-000000000001';
const shell = {
  id: ENTITY_ID,
  player_id: 'p1',
  body_part: 'head',
  laterality: 'UNSPECIFIED',
  injury_type: null,
  status: 'ACTIVE',
  canonical_post_id: null,
  injury_date: null,
  otm_projection: null,
  accuracy_record: null,
  first_reported_at: '2026-08-08T00:00:00Z',
  last_updated_at: '2026-08-08T00:00:00Z',
  void_reason: null,
};

const mockCallTool = vi.mocked(callTool);
const ok = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const callsTo = (tool: string): any[] =>
  mockCallTool.mock.calls.filter((c) => c[1] === tool).map((c) => c[2]);

let argvBackup: string[];

function serve(): void {
  let voided = false;
  mockCallTool.mockImplementation(async (_server: string, tool: string, args: any) => {
    if (tool === 'web_thread_get') {
      return ok({
        entity: voided ? { ...shell, status: 'VOID', void_reason: 'r' } : shell,
        updates: [],
      });
    }
    if (tool === 'web_list_audit_entries') return ok({ entries: [] });
    if (tool === 'web_thread_close') {
      voided = true;
      return ok({ entity: { ...shell, status: 'VOID', void_reason: args.void_reason } });
    }
    if (tool === 'web_audit_append') return ok({ ok: true });
    throw new Error(`unexpected tool ${tool}`);
  });
}

function argv(...flags: string[]): void {
  process.argv = ['node', 'void-thread.ts', `--entity-id=${ENTITY_ID}`, '--reason=shell', ...flags];
}

beforeEach(() => {
  argvBackup = process.argv;
  mockCallTool.mockReset();
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = argvBackup;
  process.exitCode = 0;
});

describe('closed_by', () => {
  it("is the literal 'system'", () => {
    expect(CLOSED_BY).toBe('system');
    expect(buildCloseArgs(ENTITY_ID, 'r').closed_by).toBe('system');
  });

  it("reaches web_thread_close as 'system' on a live run", async () => {
    serve();
    argv('--apply', '--confirm');
    await run();
    const closes = callsTo('web_thread_close');
    expect(closes).toHaveLength(1);
    expect(closes[0]).toEqual({
      entity_id: ENTITY_ID,
      outcome: 'VOID',
      void_reason: 'shell',
      closed_by: 'system',
    });
    expect(process.exitCode).toBe(0);
  });

  it('records the script in a separate automation row, never as the close actor', async () => {
    serve();
    argv('--apply', '--confirm');
    await run();
    const appends = callsTo('web_audit_append');
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      actor: 'automation',
      actor_id: ACTOR_ID,
      entity_type: 'injury_thread',
      entity_id: ENTITY_ID,
    });
  });

  it('refuses --closed-by outright and issues no write', async () => {
    serve();
    for (const flag of ['--closed-by=ops:void-thread', '--closed-by=system', '--closed-by']) {
      mockCallTool.mockClear();
      process.exitCode = 0;
      argv('--apply', '--confirm', flag);
      await run();
      expect(process.exitCode).toBe(1);
      expect(mockCallTool).not.toHaveBeenCalled();
    }
  });

  it('a dry run issues no close and no audit append', async () => {
    serve();
    argv();
    await run();
    expect(callsTo('web_thread_close')).toHaveLength(0);
    expect(callsTo('web_audit_append')).toHaveLength(0);
  });
});
