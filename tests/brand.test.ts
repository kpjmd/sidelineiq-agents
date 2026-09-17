/**
 * The ParatrOs rename (Phase 1). rebrandPersona is the guarantee behind a
 * prompt instruction: the skill files call the framework "OTM" throughout and
 * the model has always echoed it into published prose — 154 hits over 498
 * published posts, still 4 of 39 in September 2026. The cases below are those
 * live phrasings.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BRAND_NAME,
  BRAND_SIGNATURE,
  DEFAULT_SITE_URL,
  siteOrigin,
  BRAND_SLUG,
  rebrandPersona,
} from '../src/config/brand.js';

describe('brand constants', () => {
  it('uses the decided styling and the lowercase slug', () => {
    expect(BRAND_NAME).toBe('ParatrOs');
    expect(BRAND_SLUG).toBe('paratros');
    expect(BRAND_SIGNATURE).toBe('— ParatrOs | AI-generated analysis. Physician-founded.');
  });
});

describe('rebrandPersona', () => {
  const cases: Array<[string, string]> = [
    ['OTM will update as grade and imaging details emerge.', 'ParatrOs will update as grade and imaging details emerge.'],
    ['OTM is tracking whether Ward achieves a Full Participation.', 'ParatrOs is tracking whether Ward achieves a Full Participation.'],
    ['does not fit the OTM three-axis tissue taxonomy.', 'does not fit the three-axis tissue taxonomy.'],
    ['**OTM Three-Axis Classification:**', '**Three-Axis Classification:**'],
    ['per the OTM inference map', 'per the inference map'],
    ["sit at the top of OTM's stress injury watch list.", 'sit at the top of our stress injury watch list.'],
    ["The site is clear. OTM's rules are clear.", 'The site is clear. Our rules are clear.'],
    ["OTM's rules are clear.", 'Our rules are clear.'],
    ['Questionable Tag as OTM Tracks Recovery Arc', 'Questionable Tag as ParatrOs Tracks Recovery Arc'],
    ['the OTM estimate runs at least 8–14 weeks ahead', 'the ParatrOs estimate runs at least 8–14 weeks ahead'],
    ['— OrthoTriage Master', '— ParatrOs'],
    ['OrthoTriage Master (OTM) flags this', 'ParatrOs flags this'],
  ];
  it.each(cases)('%s', (input, expected) => {
    expect(rebrandPersona(input)).toBe(expected);
  });

  it('leaves identifiers and unrelated words alone', () => {
    for (const s of ['otm_projection', 'BOTTOM line', 'Hotmail', 'OTMX', 'custom']) {
      expect(rebrandPersona(s)).toBe(s);
    }
    expect(rebrandPersona('')).toBe('');
  });
});

describe('siteOrigin', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('falls back to the canonical host since the domain cutover', () => {
    vi.stubEnv('SITE_URL', undefined);
    expect(DEFAULT_SITE_URL).toBe('https://www.paratros.com');
    expect(siteOrigin()).toBe('https://www.paratros.com');
  });

  it('prefers SITE_URL and drops one trailing slash', () => {
    vi.stubEnv('SITE_URL', 'https://example.org/');
    expect(siteOrigin()).toBe('https://example.org');
  });
});
