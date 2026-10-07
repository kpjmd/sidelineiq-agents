/**
 * The ingest loop (spec "Automation boundary": ingest proposes, the physician
 * confirms). Driven over RECORDED inputs with an injected callTool/fetch.
 *
 * What these pin:
 *  - shadow decides and writes nothing; `on` writes PROPOSALS ONLY;
 *  - every read precedes the first write, so a 404 or 503 on any source aborts
 *    with zero writes — proven with a proposal present, so it is not vacuous;
 *  - the ingest directory names no confirm, correction, linkage or social tool.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ledgerIngestMode, ledgerIngestIntervalMs, runLedgerIngestCycle } from '../src/ledger/ingest/loop.js';
import { ingestHarness, withForecast, LAMAR_IDS, type Inject } from './helpers/ledger-ingest-fixture.js';

// The recorded row, linked, with base_rate_row 'concussion' so F5 voids by rule
// today: one proposal exists on the recorded inputs. Columns changed: the
// linkage ids and base_rate_row.
const withProposal = () => withForecast({ ...LAMAR_IDS, base_rate_row: 'concussion' });

describe('mode', () => {
  it('defaults to shadow; only exact off/on are honoured', () => {
    expect(ledgerIngestMode({})).toBe('shadow');
    expect(ledgerIngestMode({ LEDGER_INGEST_MODE: 'ON' })).toBe('on');
    expect(ledgerIngestMode({ LEDGER_INGEST_MODE: 'off' })).toBe('off');
    expect(ledgerIngestMode({ LEDGER_INGEST_MODE: 'yes' })).toBe('shadow');
    expect(ledgerIngestIntervalMs({})).toBe(24 * 60 * 60 * 1000);
  });
  it('off reads nothing', async () => {
    const h = ingestHarness();
    const s = await runLedgerIngestCycle({ mode: 'off' }, h.deps);
    expect(h.calls).toEqual([]);
    expect(s.proposed).toBe(0);
  });
});

describe('shadow and on', () => {
  it('shadow computes the proposal and writes nothing', async () => {
    const h = ingestHarness({ exported: withProposal() });
    const s = await runLedgerIngestCycle({ mode: 'shadow' }, h.deps);
    expect(s.aborted).toBe(false);
    expect(s.proposals.map((p) => [p.field, p.proposed_status, p.void_reason, p.write])).toEqual([['F5', 'void', 'concussion_rule', 'not_written']]);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_export_ledger']);
  });

  it('on files the proposal through web_propose_ledger_resolution and nothing else', async () => {
    const h = ingestHarness({ exported: withProposal() });
    const s = await runLedgerIngestCycle({ mode: 'on' }, h.deps);
    expect(h.calls.map((c) => c.tool)).toEqual(['web_export_ledger', 'web_propose_ledger_resolution']);
    expect(h.calls[1].params).toMatchObject({ entry_id: 'PT-2026-001', field: 'F5', proposed_status: 'void', void_reason: 'concussion_rule', proposer: 'ingest' });
    expect(Object.keys(h.calls[1].params).sort()).toEqual(
      ['entry_id', 'evidence', 'evidence_url', 'field', 'freeze_at', 'outcome_date', 'proposed_outcome', 'proposed_status', 'proposer', 'void_reason'],
    );
    expect(s.created).toBe(1);
  });

  it('counts duplicate, field_locked and a rejected call separately', async () => {
    for (const [status, key] of [['duplicate', 'duplicate'], ['field_locked', 'field_locked']] as const) {
      const h = ingestHarness({ exported: withProposal(), proposeResponse: () => ({ content: [{ type: 'text', text: JSON.stringify({ proposal: null, status }) }] }) });
      const s = await runLedgerIngestCycle({ mode: 'on' }, h.deps);
      expect(s[key]).toBe(1);
    }
    const h = ingestHarness({ exported: withProposal(), proposeResponse: () => ({ isError: true, content: [{ type: 'text', text: '{"error":"Input validation error"}' }] }) });
    const s = await runLedgerIngestCycle({ mode: 'on' }, h.deps);
    expect(s.rejected).toBe(1);
    expect(h.logs.some((l) => l.includes('PROPOSE REJECTED'))).toBe(true);
  });

  it('two runs over the same inputs decide identically', async () => {
    const a = await runLedgerIngestCycle({ mode: 'shadow' }, ingestHarness({ exported: withProposal() }).deps);
    const b = await runLedgerIngestCycle({ mode: 'shadow' }, ingestHarness({ exported: withProposal() }).deps);
    expect(JSON.stringify([a.proposals, a.held_fields])).toBe(JSON.stringify([b.proposals, b.held_fields]));
  });
});

describe('a failed read aborts before the first write (404 and 503 alike)', () => {
  const cases: NonNullable<Inject>[] = [];
  for (const source of ['export', 'games', 'snap_counts', 'injuries', 'transactions'] as const) for (const status of [404, 503] as const) cases.push({ source, status });
  it.each(cases)('$source $status', async (inject) => {
    const baseline = ingestHarness({ exported: withProposal() });
    await runLedgerIngestCycle({ mode: 'on' }, baseline.deps);
    expect(baseline.calls.filter((c) => c.tool === 'web_propose_ledger_resolution')).toHaveLength(1);

    const h = ingestHarness({ exported: withProposal(), inject });
    const s = await runLedgerIngestCycle({ mode: 'on' }, h.deps);
    expect(s.aborted).toBe(true);
    expect(h.calls.filter((c) => c.tool !== 'web_export_ledger')).toEqual([]);
  });
});

describe('the automation boundary, as source text', () => {
  it('src/ledger/ingest names no confirm, correction, linkage, publish or social tool', () => {
    const dir = fileURLToPath(new URL('../src/ledger/ingest/', import.meta.url));
    const forbidden = /web_decide_ledger_proposal|web_record_ledger_correction|web_record_ledger_linkage|web_publish_ledger_forecast|web_record_ledger_provenance|web_update_ledger_draft|twitter_|farcaster_/;
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.ts') && forbidden.test(readFileSync(dir + f, 'utf8')));
    expect(offenders).toEqual([]);
    const loop = readFileSync(dir + 'loop.ts', 'utf8');
    expect(loop).toContain("'web_propose_ledger_resolution'");
  });
});
