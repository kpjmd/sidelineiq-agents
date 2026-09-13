import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { takeMetricsSnapshot, PLATFORM_READS } from '../src/monitoring/metrics-snapshot.js';
import schemaFixture from './fixtures/metrics-tools-schema.json' with { type: 'json' };

const mockCallTool = vi.mocked(callTool);

/** An MCP success envelope, as callTool returns it. */
function ok(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function mcpError(message: string) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

// Shapes returned by the mcp profile-stats tools (their fixtures were recorded
// from the production accounts on 2026-09-13).
const X_STATS = { id: '2039126663263387648', username: 'sidelineiq_', followers_count: 11, following_count: 19, tweet_count: 743 };
const FC_STATS = { fid: 3125237, username: 'sidelineiq', follower_count: 16, following_count: 1 };

type Handler = (server: string, tool: string, params: Record<string, unknown>) => unknown;

function route(overrides: Partial<Record<string, Handler>> = {}) {
  mockCallTool.mockImplementation(async (server, tool, params) => {
    const handler = overrides[tool];
    if (handler) return handler(server, tool, params);
    if (tool === 'twitter_get_profile_stats') return ok(X_STATS);
    if (tool === 'farcaster_get_profile_stats') return ok(FC_STATS);
    if (tool === 'web_record_metric_snapshot') return ok({ ...params, day: '2026-09-13' });
    throw new Error(`unexpected tool ${tool}`);
  });
}

function writes() {
  return mockCallTool.mock.calls.filter(([, tool]) => tool === 'web_record_metric_snapshot');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('takeMetricsSnapshot', () => {
  it('records both platforms from their own profile reads', async () => {
    route();
    const summary = await takeMetricsSnapshot();

    expect(summary).toMatchObject({ readings: { x_followers: 11, farcaster_followers: 16 }, written: 2, failed: 0 });
    expect(writes().map(([, , p]) => p)).toEqual([
      {
        metric: 'x_followers',
        value: 11,
        source: 'x_api',
        detail: { username: 'sidelineiq_', following_count: 19, tweet_count: 743 },
      },
      {
        metric: 'farcaster_followers',
        value: 16,
        source: 'neynar',
        detail: { fid: 3125237, username: 'sidelineiq', following_count: 1 },
      },
    ]);
    expect(console.log).toHaveBeenCalledWith(
      '[Metrics] x_followers=11 farcaster_followers=16 written=2 failed=0',
    );
  });

  it.each([
    ['throws', () => { throw new Error("MCP server 'twitter' is not available"); }],
    ['returns isError', () => mcpError('Twitter API rate limit exceeded')],
    ['returns no payload', () => ({ content: [] })],
    ['returns unparseable text', () => ({ content: [{ type: 'text', text: 'not json' }] })],
    ['returns a missing count', () => ok({ ...X_STATS, followers_count: undefined })],
    ['returns a string count', () => ok({ ...X_STATS, followers_count: '11' })],
    ['returns a negative count', () => ok({ ...X_STATS, followers_count: -1 })],
  ])('writes NO row when the X read %s — never a 0 — and still writes Farcaster', async (_label, handler) => {
    route({ twitter_get_profile_stats: handler as Handler });
    const summary = await takeMetricsSnapshot();

    expect(writes().map(([, , p]) => p.metric)).toEqual(['farcaster_followers']);
    expect(summary.readings).toEqual({ farcaster_followers: 16 });
    expect(summary).toMatchObject({ written: 1, failed: 1 });
    expect(summary.failures).toEqual([expect.objectContaining({ platform: 'x', stage: 'read' })]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Metrics] SNAPSHOT FAILED platform=x'));
    expect(console.log).toHaveBeenCalledWith(
      '[Metrics] x_followers=unread farcaster_followers=16 written=1 failed=1',
    );
  });

  it('writes nothing at all when both reads fail', async () => {
    route({
      twitter_get_profile_stats: () => mcpError('forbidden'),
      farcaster_get_profile_stats: () => { throw new Error('down'); },
    });
    const summary = await takeMetricsSnapshot();
    expect(writes()).toHaveLength(0);
    expect(summary).toMatchObject({ written: 0, failed: 2 });
  });

  it('counts a rejected write as a failure, loudly', async () => {
    route({
      web_record_metric_snapshot: (_s, _t, p) =>
        p.metric === 'x_followers' ? mcpError('Input validation error') : ok(p),
    });
    const summary = await takeMetricsSnapshot();

    expect(summary).toMatchObject({ written: 1, failed: 1 });
    expect(summary.failures).toEqual([expect.objectContaining({ platform: 'x', stage: 'write' })]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Metrics] SNAPSHOT WRITE REJECTED platform=x'));
  });

  it('counts a thrown write as a failure', async () => {
    route({ web_record_metric_snapshot: () => { throw new Error("MCP server 'web' is not available"); } });
    const summary = await takeMetricsSnapshot();
    expect(summary).toMatchObject({ written: 0, failed: 2 });
  });
});

/**
 * Every key we SEND must be a key the server ACCEPTS: mcp inputs are .strict(),
 * so one undeclared key fails the whole call. Checked against a RECORDED
 * tools/list (see the fixture's _note), never a hand-written schema.
 */
describe('contract with the recorded mcp tool schemas', () => {
  const tools = (schemaFixture as unknown as {
    tools: Record<string, { inputSchema: { properties: Record<string, { enum?: string[] }>; required?: string[] } }>;
  }).tools;

  it('reads each platform with no arguments, and the tool takes none', async () => {
    route();
    await takeMetricsSnapshot();
    for (const read of PLATFORM_READS) {
      const call = mockCallTool.mock.calls.find(([, tool]) => tool === read.tool);
      expect(call?.[2]).toEqual({});
      expect(Object.keys(tools[read.tool].inputSchema.properties)).toEqual([]);
    }
  });

  it('sends only accepted keys, all required keys, and enum-valid values to web_record_metric_snapshot', async () => {
    route();
    await takeMetricsSnapshot();
    const schema = tools.web_record_metric_snapshot.inputSchema;
    const accepted = new Set(Object.keys(schema.properties));

    for (const [, , params] of writes()) {
      expect(Object.keys(params).filter((k) => !accepted.has(k))).toEqual([]);
      for (const key of schema.required ?? []) expect(params).toHaveProperty(key);
      expect(schema.properties.metric.enum).toContain(params.metric);
      expect(schema.properties.source.enum).toContain(params.source);
    }
  });
});
