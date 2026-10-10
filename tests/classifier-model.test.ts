/**
 * classifierModel() is the one switch for the Haiku-class classifiers. A typo in
 * the Railway variable must degrade to the known-good default rather than fail
 * every classifier call.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { classifierModel, CLASSIFIER_DEFAULT_MODEL } from '../src/config/models.js';

describe('classifierModel', () => {
  const saved = process.env.CLASSIFIER_MODEL;
  beforeEach(() => {
    delete process.env.CLASSIFIER_MODEL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLASSIFIER_MODEL;
    else process.env.CLASSIFIER_MODEL = saved;
    vi.restoreAllMocks();
  });

  it('defaults to Haiku 4.5 when unset or blank', () => {
    expect(classifierModel()).toBe('claude-haiku-4-5-20251001');
    process.env.CLASSIFIER_MODEL = '   ';
    expect(classifierModel()).toBe(CLASSIFIER_DEFAULT_MODEL);
  });

  it('accepts claude-haiku-5-5, trimmed', () => {
    process.env.CLASSIFIER_MODEL = ' claude-haiku-5-5 ';
    expect(classifierModel()).toBe('claude-haiku-5-5');
  });

  it('falls back to the default on an unrecognized value, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CLASSIFIER_MODEL = 'claude-haiku-5';
    expect(classifierModel()).toBe(CLASSIFIER_DEFAULT_MODEL);
    expect(warn).toHaveBeenCalled();
  });
});
