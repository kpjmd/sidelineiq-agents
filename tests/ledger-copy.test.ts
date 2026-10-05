/**
 * The shared copy: disclaimer, AI disclosure, credit, bio, canned reply. One
 * source, pinned to a recorded fixture the frontend twin also loads, and
 * checked against the spec's own rules for what may and may not appear.
 */
import { describe, it, expect } from 'vitest';
import {
  LEDGER_COPY,
  LEDGER_COPY_VERSION,
  PHYSICIAN_CREDENTIAL,
  LEDGER_BRAND,
  FORBIDDEN_PUBLIC_WORDS,
  findForbiddenWords,
} from '../src/ledger/copy.js';
import { BRAND_NAME, BRAND_SIGNATURE } from '../src/config/brand.js';
import fixture from './fixtures/ledger-copy.json' with { type: 'json' };

describe('ledger copy fixture', () => {
  it('was recorded against this copy version and these strings', () => {
    expect(fixture.copy_version).toBe(LEDGER_COPY_VERSION);
    expect(fixture.copy).toEqual(LEDGER_COPY);
    expect(fixture.constants.PHYSICIAN_CREDENTIAL).toBe(PHYSICIAN_CREDENTIAL);
    expect(fixture.forbidden_public_words).toEqual(FORBIDDEN_PUBLIC_WORDS);
  });
});

describe('ledger copy content (spec: Liability framing, AI disclosure, Byline)', () => {
  it('uses the decided credential, name and degree only', () => {
    expect(PHYSICIAN_CREDENTIAL).toBe('Keith P. Johnson, MD');
    expect(PHYSICIAN_CREDENTIAL).not.toMatch(/board|certified|orthop/i);
  });

  it('spells the brand the way the site does', () => {
    expect(LEDGER_BRAND).toBe(BRAND_NAME);
    expect(LEDGER_COPY.publisher).toBe('Published by ParatrOs');
  });

  it('carries the spec\'s card disclaimer verbatim with the name filled in', () => {
    expect(LEDGER_COPY.card_disclaimer).toBe(
      'Educational commentary on publicly reported injuries. Keith P. Johnson, MD has not examined this athlete, reviewed imaging, or spoken with any treating clinician. Estimates are population-based and are not medical advice, a diagnosis, or a prediction about any individual\'s care. No reliance: see paratros.com/ledger.',
    );
  });

  it('the full disclaimer extends the card strip with the publisher, affiliation, warranty and relationship lines', () => {
    expect(LEDGER_COPY.full_disclaimer.startsWith(LEDGER_COPY.card_disclaimer)).toBe(true);
    for (const phrase of [
      'Enovyr LLC, d/b/a ParatrOs',
      'not affiliated with any team, league, player, agent or sportsbook',
      'provided as-is without warranty',
      'No physician-patient relationship is created',
      'Personal medical questions go to your own physician',
    ]) {
      expect(LEDGER_COPY.full_disclaimer).toContain(phrase);
    }
  });

  it('the AI disclosure is the one fixed line and never implies a model has judgement', () => {
    expect(LEDGER_COPY.ai_disclosure).toBe('Drafted with AI assistance. Every forecast is reviewed and signed by Keith P. Johnson, MD.');
    expect(LEDGER_COPY.ai_disclosure).not.toMatch(/AI physician/i);
  });

  it('the credit names the person and the publisher line names the entity, never "[Name], MD" alone as publisher', () => {
    expect(LEDGER_COPY.credit).toBe('Forecast reviewed by Keith P. Johnson, MD');
    expect(LEDGER_COPY.publisher).not.toContain('MD');
  });

  it('the reliance line says "no reliance", not "never for wagering"', () => {
    expect(LEDGER_COPY.reliance).toBe('Informational. Provided as-is, without warranty. No reliance for any purpose.');
    expect(LEDGER_COPY.reliance).not.toMatch(/wager|bet/i);
  });

  it('the bio retires "autonomous"', () => {
    expect(LEDGER_COPY.bio).toBe('AI sports injury intelligence. Every forecast reviewed by Keith P. Johnson, MD.');
    expect(LEDGER_COPY.bio.toLowerCase()).not.toContain('autonomous');
  });

  it('is a different line from the autonomous posts\' signature, by construction', () => {
    expect(LEDGER_COPY.ai_disclosure).not.toBe(BRAND_SIGNATURE);
    expect(Object.values(LEDGER_COPY).filter((v) => typeof v === 'string')).not.toContain(BRAND_SIGNATURE);
    expect(BRAND_SIGNATURE).not.toContain(PHYSICIAN_CREDENTIAL);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LEDGER_COPY)).toBe(true);
    expect(Object.isFrozen(LEDGER_COPY.source_tiers)).toBe(true);
  });
});

describe('forbidden public words', () => {
  it('none of the authored-register copy uses a forbidden word', () => {
    // The two disclaimers are legal copy and say what the ledger is NOT ("not
    // … a diagnosis"); the vocabulary rule governs forecast prose, so the sweep
    // covers every other line and the publish gate applies it to mechanism,
    // what_moves_this and post text, never to the fixed strip.
    const legal = new Set(['card_disclaimer', 'full_disclaimer']);
    for (const [key, value] of Object.entries(LEDGER_COPY)) {
      if (typeof value !== 'string' || legal.has(key)) continue;
      expect(findForbiddenWords(value), key).toEqual([]);
    }
    expect(findForbiddenWords(LEDGER_COPY.card_disclaimer)).toEqual(['diagnosis']);
  });

  it('flags the spec\'s banned vocabulary as whole words, in order of appearance', () => {
    expect(findForbiddenWords('Our assessment: he should sit. Lock it in.')).toEqual(['assessment', 'should', 'lock']);
    expect(findForbiddenWords('Autonomous AI picks')).toEqual(['autonomous', 'picks']);
    expect(findForbiddenWords('The team said Sunday. Ledger F2: 18%.')).toEqual([]);
  });

  it('does not match inside other words', () => {
    expect(findForbiddenWords('shoulder, locker room, oddsmakers aside, widespread')).toEqual([]);
    expect(findForbiddenWords('Prognosis Ledger')).toEqual(['prognosis']);
  });
});
