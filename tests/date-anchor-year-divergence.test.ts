import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  callToolWithRetry: vi.fn(),
  isServerAvailable: vi.fn(() => true),
  initializeMCPClients: vi.fn(),
  disconnectAll: vi.fn(),
  getServerStatus: vi.fn(() => ({})),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import {
  unsettleThreadDate,
  shouldForceYearDivergenceReview,
  DATE_YEAR_DIVERGENCE_CODE,
} from '../src/monitoring/poller.js';
import { assessAnchorDivergence } from '../src/agents/injury-intelligence/date-anchoring.js';
import type { RawInjuryEvent } from '../src/types.js';

const mockedCallTool = vi.mocked(callTool);
const read = (rel: string): string =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8');

const EVENT = {
  athlete_name: 'Patrick Mahomes',
  sport: 'NFL',
} as unknown as RawInjuryEvent;

const ENTITY_ID = '614456e3-5fe0-44a0-a976-7cd151741f0b';
const ok = { content: [{ type: 'text', text: '{"entity":{}}' }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('unsettleThreadDate', () => {
  it('downgrades the confidence and flags review WITHOUT sending injury_date', async () => {
    mockedCallTool.mockResolvedValue(ok);

    await unsettleThreadDate(
      ENTITY_ID,
      EVENT,
      assessAnchorDivergence('2024-12-15', '2025-12-15'),
    );

    const write = mockedCallTool.mock.calls.find((c) => c[1] === 'web_thread_update_dates');
    expect(write).toBeDefined();
    const payload = write?.[2] as Record<string, unknown>;
    expect(payload.injury_date_confidence).toBe('possible');
    expect(payload.needs_date_review).toBe(true);
    // Key ABSENCE, not a null value: every column is COALESCE(param, column),
    // so omitting injury_date is what preserves the stored date. Sending it
    // back would at best be a no-op and at worst re-anchor the projection.
    expect(Object.keys(payload)).not.toContain('injury_date');
    expect(Object.keys(payload)).not.toContain('surgery_date');
  });

  it('records the divergence on the audit trail', async () => {
    mockedCallTool.mockResolvedValue(ok);
    await unsettleThreadDate(
      ENTITY_ID,
      EVENT,
      assessAnchorDivergence('2024-12-14', '2025-12-29'),
    );
    const audit = mockedCallTool.mock.calls.find((c) => c[1] === 'web_audit_append');
    const payload = audit?.[2] as { action: string; payload: Record<string, unknown> };
    expect(payload.action).toBe('date_anchor_year_divergence');
    expect(payload.payload.resolver_date).toBe('2024-12-14');
    expect(payload.payload.otm_date).toBe('2025-12-29');
    expect(payload.payload.days_apart).toBe(380);
  });

  it('logs and stops when the downgrade is rejected — no audit row claiming it happened', async () => {
    mockedCallTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: '{"error":"nope"}' }],
    });
    await unsettleThreadDate(ENTITY_ID, EVENT, assessAnchorDivergence('2024-12-15', '2025-12-15'));
    expect(mockedCallTool.mock.calls.filter((c) => c[1] === 'web_audit_append')).toHaveLength(0);
    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    expect(errors.some((l) => l.includes('date downgrade REJECTED'))).toBe(true);
  });

  it('never throws — a failure leaves the thread exactly as this check found it', async () => {
    mockedCallTool.mockRejectedValue(new Error('connection reset'));
    await expect(
      unsettleThreadDate(ENTITY_ID, EVENT, assessAnchorDivergence('2024-12-15', '2025-12-15')),
    ).resolves.toBeUndefined();
  });
});

describe('shouldForceYearDivergenceReview', () => {
  it('forces review by default', () => {
    expect(shouldForceYearDivergenceReview(undefined)).toEqual({
      fires: true,
      force: true,
      annotate: false,
    });
  });

  it('downgrades to an annotation via MD_REVIEW_ANNOTATE_ONLY_CODES', () => {
    expect(shouldForceYearDivergenceReview(DATE_YEAR_DIVERGENCE_CODE)).toEqual({
      fires: true,
      force: false,
      annotate: true,
    });
  });
});

describe('the poller re-chooses through chooseDateAnchor', () => {
  it('does not add a second "prefer OTM" rule', () => {
    const src = read('src/monitoring/poller.ts');
    expect(src).toContain('assessAnchorDivergence');
    expect(src).toContain(DATE_YEAR_DIVERGENCE_CODE);
    // On a year-scale divergence the anchor is re-derived by demoting the
    // thread's confidence and letting chooseDateAnchor fall through, so there
    // is exactly one anchor rule. A literal "post.injury_date" assignment in
    // the divergence branch would mean a second one.
    expect(src).toContain("injury_date_confidence: 'possible' },");
    expect(src.match(/chooseDateAnchor\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
