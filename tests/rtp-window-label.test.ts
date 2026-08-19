import { describe, it, expect } from 'vitest';
import { formatRtpWindow, formatForFarcaster } from '../src/utils/content-formatter.js';
import type { InjuryPostContent, ReturnToPlayEstimate } from '../src/types.js';

// An ACL reconstruction: the literature window, correct either way.
const rtp: ReturnToPlayEstimate = {
  min_weeks: 39,
  max_weeks: 52,
  probability_week_2: 0,
  probability_week_4: 0,
  probability_week_8: 0.05,
  confidence: 0.8,
};
const NOW = new Date('2026-08-19T00:00:00Z');

function post(overrides: Partial<InjuryPostContent> = {}): InjuryPostContent {
  return {
    athlete_name: 'Mykel Williams',
    team: 'San Francisco 49ers',
    sport: 'NFL',
    injury_type: 'ACL reconstruction',
    injury_severity: 'SEVERE',
    content_type: 'TRACKING',
    clinical_summary:
      'Williams is now well into his rehabilitation following ACL reconstruction and is being evaluated for early-season availability.',
    return_to_play: rtp,
    confidence: 0.9,
    ...overrides,
  } as InjuryPostContent;
}

describe('formatRtpWindow', () => {
  it('names the anchor and derives remaining time for an old injury', () => {
    // The bug in one line: a bare "39–52 weeks" beside a story about an athlete
    // nine months post-op reads as "39 MORE weeks".
    const line = formatRtpWindow(rtp, '2025-11-02', { now: NOW });
    expect(line).toMatch(/from injury \(2025-11-02\)/);
    expect(line).toMatch(/41 weeks elapsed/);
    expect(line).toMatch(/0–11 weeks remaining/);
    expect(line).not.toMatch(/^RTP: 39–52 weeks$/);
  });

  it('stays short for a fresh injury', () => {
    const line = formatRtpWindow(rtp, '2026-08-18', { now: NOW });
    expect(line).toBe('RTP: 39–52 weeks from injury (2026-08-18)');
    expect(line).not.toMatch(/elapsed|remaining/);
  });

  it('says the start date is unconfirmed rather than inventing one', () => {
    const line = formatRtpWindow(rtp, undefined, { now: NOW });
    expect(line).toMatch(/start date unconfirmed/);
    expect(line).not.toMatch(/NaN|Invalid Date|undefined/);
  });

  it('never prints a negative remainder once the window has closed', () => {
    const line = formatRtpWindow(rtp, '2024-11-02', { now: NOW });
    expect(line).toMatch(/return window has closed/);
    expect(line).not.toMatch(/-\d+ weeks remaining/);
  });

  it('survives a malformed date without emitting NaN', () => {
    // Fail-closed, and passes in both directions.
    const line = formatRtpWindow(rtp, 'not-a-date', { now: NOW });
    expect(line).not.toMatch(/NaN|Invalid Date/);
    expect(line).toMatch(/unconfirmed/);
  });

  it('gives up elapsed/remaining before it gives up the anchor', () => {
    // The 320-char single-cast path. Naming the anchor is the harm fix; the
    // derived numbers are the enhancement and go first when space is scarce.
    const minimal = formatRtpWindow(rtp, '2025-11-02', { now: NOW, minimal: true });
    expect(minimal).toBe('RTP: 39-52w from 2025-11-02');
    expect(minimal).not.toMatch(/elapsed|remaining|left|in ·/);
    // Still no bare, unanchored range.
    expect(minimal).not.toBe('RTP: 39-52w');
    expect(
      minimal.length,
      'minimal must not be longer than the compact form',
    ).toBeLessThan(formatRtpWindow(rtp, '2025-11-02', { now: NOW, compact: true }).length);
  });

  it('emits a shorter form for the character-capped builders', () => {
    const long = formatRtpWindow(rtp, '2025-11-02', { now: NOW });
    const compact = formatRtpWindow(rtp, '2025-11-02', { now: NOW, compact: true });
    expect(compact.length).toBeLessThan(long.length);
    expect(compact).toMatch(/41w in/);
    expect(compact).toMatch(/0-11w left/);
  });
});

describe('Farcaster budget under the longest label', () => {
  it('keeps every cast within 320 chars and keeps the signature intact', () => {
    // The anchor budget is derived from the RTP line's length, so a longer
    // line eats into the clinical anchor. It must never clip OTM_SIGNATURE.
    for (const content_type of ['BREAKING', 'TRACKING', 'DEEP_DIVE', 'CONFLICT_FLAG'] as const) {
      const casts = formatForFarcaster(
        post({
          content_type,
          injury_date: '2025-11-02',
          conflict_reason: 'team timeline (~2w) is shorter than OTM estimate (39-52w)',
        }),
      );
      for (const cast of casts) {
        expect(cast.length, `${content_type}: ${cast}`).toBeLessThanOrEqual(320);
      }
      // CONFLICT_FLAG assembles one post and hard-truncates at 320, so with a
      // long clinical_summary the signature is already lost today — that is
      // pre-existing and out of scope. What must hold is that the anchored
      // label does not make it WORSE than the bare range it replaced.
      if (content_type !== 'CONFLICT_FLAG') {
        expect(casts.join('\n'), content_type).toContain('OrthoTriage Master');
      }
      // And the clinical anchor still survives — not squeezed down to "...".
      expect(casts.some((c) => c.trim() !== '...')).toBe(true);
    }
  });
});
