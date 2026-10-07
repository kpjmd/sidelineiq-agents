/**
 * Post text renders ONLY from a published row, carries the five fields in the
 * fixed order with id · version · hash8, stays inside each platform's budget,
 * and never borrows the autonomous posts' signature.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertPublishable, LedgerNotPublishableError } from '../src/ledger/publishable.js';
import {
  buildXCardText,
  buildXSelfReplyText,
  buildFarcasterText,
  renderLedgerTexts,
  tweetIdFromUrl,
  entryUrl,
  ledgerIndexUrl,
  pct,
  f4Label,
  utf8Bytes,
  FARCASTER_MAX_BYTES,
} from '../src/ledger/post-text.js';
import { LEDGER_COPY } from '../src/ledger/copy.js';
import { shortHash } from '../src/ledger/row-hash.js';
import { publishedRow, tamperedRow } from './helpers/ledger-published-row.js';

function published() {
  const row = publishedRow();
  assertPublishable(row);
  return row;
}

describe('assertPublishable (spec: Provenance — no post without entry id, version, hash, confirmer)', () => {
  it('accepts a published, hashed, confirmed row and normalises version/published_at', () => {
    const row = publishedRow({ version: '1' as unknown as number });
    assertPublishable(row);
    expect(row.version).toBe(1);
    expect(row.published_at).toBe('2026-10-06T18:04:05.123Z');
  });

  it.each([
    ['a draft', { status: 'draft' as const }, /not published/],
    ['no entry_id', { entry_id: null as unknown as string }, /entry_id/],
    ['no row_hash', { row_hash: null }, /row_hash missing/],
    ['no confirmer', { confirmed_by: null }, /confirmed_by/],
    ['no published_at', { published_at: null as unknown as string }, /published_at/],
    ['a hash that does not re-derive', { row_hash: 'a'.repeat(64) }, /does not match/],
    ['a field edited after hashing', { f2_next: '0.9900' }, /does not match/],
  ])('refuses %s', (name, overrides, re) => {
    const row = name === 'a field edited after hashing' ? tamperedRow(overrides as never) : publishedRow(overrides as never);
    expect(() => assertPublishable(row)).toThrow(LedgerNotPublishableError);
    expect(() => assertPublishable(row)).toThrow(re);
  });

  it('lists every reason at once', () => {
    try {
      assertPublishable(publishedRow({ status: 'draft', row_hash: null, confirmed_by: null }));
      throw new Error('did not throw');
    } catch (err) {
      expect((err as LedgerNotPublishableError).reasons).toHaveLength(3);
    }
  });
});

describe('X card text (spec: Card content spec items 1–5)', () => {
  const row = published();
  const text = buildXCardText(row);

  it('carries the five fields in the fixed order, F4 as point (low–high)', () => {
    const idx = ['F1 IR within 7 days: 18%', 'F2 plays next game: 12%', 'F3 returns within 4 weeks: 61%', 'F4 games missed: 3 (2–5)', 'F5 re-injury within 6 games of return: 22%'].map((s) => text.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('carries entry id · version · hash8, the credit, the publisher, the AI line, and ends with the entry URL', () => {
    expect(text).toContain(`PT-2026-001 · v1 · ${shortHash(row.row_hash)}`);
    expect(text).toContain(LEDGER_COPY.credit);
    expect(text).toContain(LEDGER_COPY.publisher);
    expect(text).toContain(LEDGER_COPY.ai_disclosure);
    expect(text.trim().endsWith(entryUrl(row))).toBe(true);
    expect(entryUrl(row)).toBe('https://www.paratros.com/ledger/PT-2026-001');
  });

  it('names the source as reported, the tier and the injury date; never a diagnosis', () => {
    expect(text).toContain('reported: Grade 2 hamstring strain (tier B)');
    expect(text).toContain('injury Oct 4, 2026');
    expect(text).toContain('Mechanism: Non-contact.');
    expect(text).toContain('What would move this: An IR designation');
  });

  it('a revision names its trigger; a concussion row says F5 is not forecast', () => {
    const rev = publishedRow({ version: 2, trigger: 'Placed on IR 2026-10-07' });
    rev.row_hash = null;
    const r2 = publishedRow({ version: 2, trigger: 'Placed on IR 2026-10-07' });
    assertPublishable(r2);
    expect(buildXCardText(r2)).toContain('Revision v2 — trigger: Placed on IR 2026-10-07');
    const c = publishedRow({ f5_reinjury: null });
    assertPublishable(c);
    expect(buildXCardText(c)).toContain('F5 re-injury within 6 games of return: not forecast');
    expect(rev.version).toBe(2);
  });
});

describe('self-reply (S2-1: ledger index + the commit URL + the reliance line)', () => {
  it('links the index and the commit', () => {
    const row = published();
    const t = buildXSelfReplyText(row, 'https://github.com/kpjmd/paratros-ledger/commit/abc');
    expect(t).toContain(ledgerIndexUrl());
    expect(ledgerIndexUrl()).toBe('https://www.paratros.com/ledger');
    expect(t).toContain('committed: https://github.com/kpjmd/paratros-ledger/commit/abc');
    expect(t).toContain(LEDGER_COPY.reliance);
    expect(t).not.toContain('Report:');
  });

  it('a standalone card cites the report URL, never as the last line, and the vocabulary rule covers it', () => {
    const row = published();
    const report = 'https://x.com/AdamSchefter/status/1972000000000000001';
    const t = buildXSelfReplyText(row, 'https://github.com/kpjmd/paratros-ledger/commit/abc', report);
    const lines = t.split('\n');
    expect(lines).toContain(`Report: ${report}`);
    expect(lines[lines.length - 1]).toBe(LEDGER_COPY.reliance);
    expect(renderLedgerTexts(row, null, report).x_self_reply).toContain(`Report: ${report}`);
    expect(buildXSelfReplyText(row, null, `${report}?s=20#x`)).toContain(`Report: ${report}\n`);
    expect(renderLedgerTexts(row, null, 'https://example.com/should-pick').forbidden).toEqual(expect.arrayContaining(['should', 'pick']));
  });
});

describe('Farcaster mirror (320 BYTES, not characters)', () => {
  it('fits the budget with ASCII separators and keeps fields, id, version, hash8 and credit', () => {
    const row = published();
    const t = buildFarcasterText(row);
    expect(utf8Bytes(t)).toBeLessThanOrEqual(FARCASTER_MAX_BYTES);
    expect(t).toContain('IR 18% | Next game 12% | 4 wk 61% | Games missed 3 (2-5) | Re-injury 22%');
    expect(t).toContain(`PT-2026-001 v1 ${shortHash(row.row_hash)}`);
    expect(t).toContain(LEDGER_COPY.credit);
    expect(t).not.toContain('http');
  });

  it('drops the mechanism, then the date, then truncates the injury wording — and never a field', () => {
    const long = publishedRow({
      player: 'Christian Thaddeus Montgomery-Wellington III',
      reported_injury: 'Grade 2 right hamstring strain with reported involvement of the proximal tendon per the team',
      mechanism: 'Non-contact. Acceleration out of a cut, right leg, with the hip extended and the knee near full extension at footstrike. Q3 2:14.',
    });
    assertPublishable(long);
    const t = buildFarcasterText(long);
    expect(utf8Bytes(t)).toBeLessThanOrEqual(FARCASTER_MAX_BYTES);
    expect(t).not.toContain('Non-contact');
    expect(t).toContain('Games missed 3 (2-5)');
    expect(t).toContain(LEDGER_COPY.credit);
  });

  it('measures multibyte input in bytes', () => {
    const row = publishedRow({ player: 'Ødegaard Ñúñez–Kääriäinen Łukasz Þór' });
    assertPublishable(row);
    const t = buildFarcasterText(row);
    expect(utf8Bytes(t)).toBeLessThanOrEqual(320);
    expect(utf8Bytes(t)).toBeGreaterThan(t.length);
  });
});

describe('tweetIdFromUrl', () => {
  it.each([
    ['https://x.com/AdamSchefter/status/1972000000000000001', '1972000000000000001'],
    ['https://twitter.com/AdamSchefter/status/197200/photo/1', '197200'],
    ['https://www.x.com/i/web/status/42?s=20', '42'],
    ['https://mobile.twitter.com/a_b/statuses/7', '7'],
    ['https://x.com/AdamSchefter', null],
    ['https://example.com/AdamSchefter/status/1', null],
    ['not a url', null],
    ['', null],
    [null, null],
  ])('%s → %s', (url, expected) => {
    expect(tweetIdFromUrl(url)).toBe(expected);
  });
});

describe('vocabulary rule and formatting helpers', () => {
  it('renderLedgerTexts reports forbidden words across all three texts', () => {
    const clean = renderLedgerTexts(published(), null);
    expect(clean.forbidden).toEqual([]);
    const dirty = publishedRow({ what_moves_this: 'Whether the team should pick a lock.' });
    assertPublishable(dirty);
    expect(renderLedgerTexts(dirty, null).forbidden).toEqual(expect.arrayContaining(['should', 'pick', 'lock']));
  });

  it('pct rounds to whole numbers; f4Label is the spec shape', () => {
    expect(pct('0.1849')).toBe('18%');
    expect(pct(0.615)).toBe('62%');
    expect(f4Label(3, 2, 6)).toBe('3 (2–6)');
  });

  it('src/ledger never imports BRAND_SIGNATURE (the autonomous posts\' line)', () => {
    for (const f of ['post-text.ts', 'publish.ts', 'publish-reply.ts', 'github-commit.ts', 'publishable.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../src/ledger/${f}`, import.meta.url)), 'utf8');
      expect(src, f).not.toContain('BRAND_SIGNATURE');
    }
  });
});
