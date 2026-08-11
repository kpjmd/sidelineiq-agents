/**
 * Athlete-name agreement between source and classifier.
 *
 * The tier is resolved from the SOURCE's athlete name before classification
 * runs, and tier drives athlete_prominence — 35% of the significance score.
 * The post, however, is written about the CLASSIFIER's athlete name. When the
 * two denote different people, the event was scored as one athlete and
 * published as another.
 *
 * Observed in production 2026-08-10: a gate decision logged
 * `athlete="Luther Burden" tier=1 prom=95`, but Luther Burden is absent from
 * athlete-tiers.json and resolves to tier 3. The prominence of 95 came from
 * whoever the source named.
 *
 * The comparison has to tolerate the spellings sources genuinely disagree on,
 * or it would flag most events and make the signal useless.
 */
import { describe, it, expect } from 'vitest';
import { isSameAthleteName } from '../src/agents/injury-intelligence/significance.js';

describe('isSameAthleteName — tolerates benign spelling differences', () => {
  it.each([
    ['A.J. Brown', 'AJ Brown'],
    ['T.J. Watt', 'TJ Watt'],
    ['Amon-Ra St. Brown', 'Amon Ra St Brown'],
    ['Luther Burden III', 'Luther Burden'],
    ['Marvin Harrison Jr.', 'Marvin Harrison'],
    ['Odell Beckham Jr', 'Odell Beckham Jr.'],
    ['  Patrick   Mahomes ', 'Patrick Mahomes'],
    ['MICAH PARSONS', 'Micah Parsons'],
  ])('treats %j and %j as the same athlete', (a, b) => {
    expect(isSameAthleteName(a, b)).toBe(true);
  });
});

describe('isSameAthleteName — catches genuine substitutions', () => {
  it.each([
    ['Rome Odunze', 'Luther Burden'],
    ['Patrick Mahomes', 'Travis Kelce'],
    ['Coby Bryant', 'Kobe Bryant'],
    // Same surname, different player — the case most likely to slip through.
    ['Dyami Brown', 'A.J. Brown'],
    ['Justin Jefferson', 'Jordan Addison'],
  ])('flags %j vs %j as different athletes', (a, b) => {
    expect(isSameAthleteName(a, b)).toBe(false);
  });

  it('is symmetric', () => {
    expect(isSameAthleteName('A.J. Brown', 'Dyami Brown')).toBe(
      isSameAthleteName('Dyami Brown', 'A.J. Brown'),
    );
  });
});
