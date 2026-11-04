import { describe, it, expect, vi } from 'vitest';
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

import { shouldForceElapsedClaimReview, ELAPSED_CLAIM_CODE } from '../src/monitoring/poller.js';

const read = (rel: string): string =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8');

const WRONG = { headline: 'Irving update', clinical_summary: 'He is now approximately 31 weeks post-op.' };
const ANCHORS = ['2025-03-03', '2025-03-26'];

describe('shouldForceElapsedClaimReview', () => {
  it('forces review and states both numbers, with no comma to break the reason list', () => {
    const gate = shouldForceElapsedClaimReview(WRONG, ANCHORS, '2026-11-02', '');
    expect(gate).toMatchObject({ fires: true, force: true, annotate: false });
    expect(gate.detail).toBe('prose 31w vs computed 83w');
    expect(gate.detail).not.toContain(',');
  });

  it('downgrades through MD_REVIEW_ANNOTATE_ONLY_CODES', () => {
    const gate = shouldForceElapsedClaimReview(WRONG, ANCHORS, '2026-11-02', ELAPSED_CLAIM_CODE);
    expect(gate).toMatchObject({ fires: true, force: false, annotate: true });
  });

  it('reads the headline too', () => {
    const post = { headline: 'He is now 31 weeks post-op', clinical_summary: '' };
    expect(shouldForceElapsedClaimReview(post, ANCHORS, '2026-11-02', '').fires).toBe(true);
  });

  it('does not fire on a correct number, or with no dates', () => {
    const right = { headline: '', clinical_summary: 'He is now 83 weeks post-op.' };
    expect(shouldForceElapsedClaimReview(right, ANCHORS, '2026-11-02', '').fires).toBe(false);
    expect(shouldForceElapsedClaimReview(WRONG, [null, undefined], '2026-11-02', '').fires).toBe(false);
  });
});

describe('wiring', () => {
  const poller = read('src/monitoring/poller.ts');

  it('checks for a return before spending the post-generation call', () => {
    const check = poller.indexOf('checkReturnedBeforeReport(event');
    const generate = poller.indexOf('await processInjuryEvent(classified');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(generate);
  });

  it('checks the prose after the final date anchor is set', () => {
    const anchor = poller.indexOf('post.injury_date = dateAnchor ?? undefined');
    const gate = poller.indexOf('const elapsedGate = shouldForceElapsedClaimReview');
    expect(anchor).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(anchor);
  });

  it('gives the model the computed figures', () => {
    expect(read('src/agents/injury-intelligence/agent.ts')).toContain('buildElapsedLine(thread');
  });
});
