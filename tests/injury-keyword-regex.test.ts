/**
 * Injury keyword regexes.
 *
 * These regexes are written as stems (`injur`, `fractur`, `concuss`) so they
 * catch every inflection. A stem followed by `\b` does the opposite: `\b` needs
 * a non-word character after the stem, so `\binjur\b` fails on "injury",
 * "injured" and "injuries" — every word it exists to match. The bug was silent
 * because the same alternation also lists whole words like "knee" and "torn",
 * which kept hit rates non-zero.
 *
 * The stems must carry an explicit `\w*`. These tests fail if anyone drops it.
 */
import { describe, it, expect } from 'vitest';
import { INJURY_KEYWORD_RE } from '../src/monitoring/sports/text-extraction.js';

const MUST_MATCH = [
  // The inflections that a bare stem + \b silently misses
  'injury',
  'injured',
  'injuries',
  'injury scare',
  'fracture',
  'fractured',
  'concussion',
  'concussed',
  'sidelined',
  'ruptured',
  'rupture',
  'strained',
  'sprained',
  'tearing',
  'surgery',
  'surgeries',
  // Whole words that always worked
  'knee',
  'torn',
  'hurt',
  'hamstring',
  'achilles',
  'ankle',
  'shoulder',
  'ACL',
  'MCL',
  'out for the season',
  // Real headlines from the live ESPN soccer feed
  "Man United being 'careful' with Mason Mount after injury scare",
  "Liverpool's preseason: Injuries, squad depth a concern for Iraola & Co.",
];

const MUST_NOT_MATCH = [
  'Summer transfer window: Grading big signings in men’s soccer',
  'Transfer rumors, news: Arsenal, Man Utd eye Inter’s Esposito',
  'Contract extension signed through 2029',
  'Traded to the Warriors for a second-round pick',
];

describe('INJURY_KEYWORD_RE', () => {
  it.each(MUST_MATCH)('matches %j', (text) => {
    expect(INJURY_KEYWORD_RE.test(text)).toBe(true);
  });

  it.each(MUST_NOT_MATCH)('does not match %j', (text) => {
    expect(INJURY_KEYWORD_RE.test(text)).toBe(false);
  });

  it('is not a global regex — lastIndex must not leak between calls', () => {
    // A stray /g flag would make alternating .test() calls return false on
    // every other invocation, which is nearly impossible to debug in prod.
    expect(INJURY_KEYWORD_RE.global).toBe(false);
    expect(INJURY_KEYWORD_RE.test('injury')).toBe(true);
    expect(INJURY_KEYWORD_RE.test('injury')).toBe(true);
  });
});
