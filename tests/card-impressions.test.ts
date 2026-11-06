import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { captureCardImpressions, CARD_IMPRESSIONS_KEY, type CardImpressionStore } from '../src/ledger/card-impressions.js';

// Recorded from prod by `ledger-gate-report.ts --record-fixtures`.
const RECORDED = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/ledger-gate/2026-11-06/responses.json'), 'utf8')) as {
  recorded_at: string;
  export: string;
  x_posts: string[];
  store: unknown;
};
const NOW = new Date(RECORDED.recorded_at);
const mockCallTool = vi.mocked(callTool);
const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const mcpError = (m: string) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: m }) }] });

type Handler = (params: Record<string, unknown>) => unknown;
function route(over: Partial<Record<string, Handler>> = {}) {
  mockCallTool.mockImplementation(async (_server, tool, params) => {
    const h = over[tool];
    if (h) return h(params as Record<string, unknown>);
    if (tool === 'web_get_social_state') return RECORDED.store;
    if (tool === 'web_export_ledger') return text(RECORDED.export);
    if (tool === 'get_posts_by_ids') return text(RECORDED.x_posts[0]);
    if (tool === 'web_set_social_state') return text(JSON.stringify({ ok: true }));
    throw new Error(`unexpected tool ${tool}`);
  });
}
const sets = () => mockCallTool.mock.calls.filter(([, t]) => t === 'web_set_social_state');
const stored = () => JSON.parse((sets()[0][2] as { value: string }).value) as CardImpressionStore;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.LEDGER_CARD_IMPRESSIONS_MODE;
});

describe('captureCardImpressions', () => {
  it('freezes every Tier 1 card ≥7 days old, once, and asks X with a comma-joined ids string', async () => {
    route();
    const s = await captureCardImpressions(NOW);
    expect(s).toMatchObject({ status: 'written', frozen_now: 14, too_young: 4, unreadable_posts: 0 });
    const xCall = mockCallTool.mock.calls.find(([, t]) => t === 'get_posts_by_ids')!;
    expect(typeof (xCall[2] as { ids: unknown }).ids).toBe('string');
    expect((xCall[2] as { ids: string }).ids.split(',')).toHaveLength(18);
    expect(sets()).toHaveLength(1);
    expect((sets()[0][2] as { key: string }).key).toBe(CARD_IMPRESSIONS_KEY);
    const pt1 = stored().readings['2107646920856342649'];
    expect(pt1).toMatchObject({ entry_id: 'PT-2026-001', impressions: 158, reply_count: 1, posted_at: '2026-10-07T01:39:18.000Z' });
    expect(pt1.age_days).toBeGreaterThan(30);
  });

  it('never overwrites a stored reading', async () => {
    const existing: CardImpressionStore = {
      version: 1,
      readings: {
        '2107646920856342649': { entry_id: 'PT-2026-001', impressions: 1, reply_count: 0, posted_at: '2026-10-07T01:39:18.000Z', read_at: '2026-10-14T02:00:00.000Z', age_days: 7 },
      },
    };
    route({ web_get_social_state: () => text(JSON.stringify({ key: CARD_IMPRESSIONS_KEY, value: JSON.stringify(existing) })) });
    const s = await captureCardImpressions(NOW);
    expect(s).toMatchObject({ frozen_now: 13, already_frozen: 1 });
    const xCall = mockCallTool.mock.calls.find(([, t]) => t === 'get_posts_by_ids')!;
    expect((xCall[2] as { ids: string }).ids).not.toContain('2107646920856342649');
    expect(stored().readings['2107646920856342649'].impressions).toBe(1);
  });

  it('writes nothing when the store cannot be read', async () => {
    route({ web_get_social_state: () => mcpError('db down') });
    expect((await captureCardImpressions(NOW)).status).toBe('aborted');
    expect(sets()).toHaveLength(0);
  });

  it('writes nothing when the stored value is not a store it knows', async () => {
    route({ web_get_social_state: () => text(JSON.stringify({ key: CARD_IMPRESSIONS_KEY, value: '{"entries":[]}' })) });
    expect((await captureCardImpressions(NOW)).status).toBe('aborted');
    expect(sets()).toHaveLength(0);
  });

  it('writes nothing when X fails', async () => {
    route({ get_posts_by_ids: () => mcpError('429 Too Many Requests') });
    expect((await captureCardImpressions(NOW)).status).toBe('aborted');
    expect(sets()).toHaveLength(0);
  });

  it('skips a card whose count is missing instead of storing 0', async () => {
    const body = JSON.parse(RECORDED.x_posts[0]);
    const pt1 = body.data.find((p: { id: string }) => p.id === '2107646920856342649');
    delete pt1.public_metrics.impression_count;
    route({ get_posts_by_ids: () => text(JSON.stringify(body)) });
    const s = await captureCardImpressions(NOW);
    expect(s).toMatchObject({ frozen_now: 13, unreadable_posts: 1 });
    expect(stored().readings['2107646920856342649']).toBeUndefined();
  });

  it('calls no write tool other than web_set_social_state', async () => {
    route();
    await captureCardImpressions(NOW);
    const tools = new Set(mockCallTool.mock.calls.map(([, t]) => t));
    expect([...tools].sort()).toEqual(['get_posts_by_ids', 'web_export_ledger', 'web_get_social_state', 'web_set_social_state']);
  });

  it('does nothing at all when the mode is off', async () => {
    process.env.LEDGER_CARD_IMPRESSIONS_MODE = 'off';
    route();
    expect((await captureCardImpressions(NOW)).status).toBe('skipped');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
