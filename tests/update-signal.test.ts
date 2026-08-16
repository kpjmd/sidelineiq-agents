/**
 * resolveUpdateSignal — which of two signals decides that an event reports
 * something NEW about an injury we already track.
 *
 * This is the function that decides between two opposite failures. With no
 * substitute for the source flag, a sport sourced purely from news goes silent
 * for 21 days after its first post about an injury. With the source flag
 * ignored, the structured feeds change behaviour — which is the one thing this
 * change must not do, since they are what publishes today.
 */
import { describe, it, expect } from 'vitest';
import { resolveUpdateSignal } from '../src/monitoring/poller.js';
import type { RawInjuryEvent } from '../src/types.js';

const feedEvent = (isUpdate: boolean): RawInjuryEvent =>
  ({ is_update: isUpdate, source_kind: 'feed' }) as RawInjuryEvent;
const newsEvent = (): RawInjuryEvent => ({ source_kind: 'article' }) as RawInjuryEvent;

describe('the source wins wherever it has a status field', () => {
  // Exhaustive over the input space rather than sampled — the space is 6 cells,
  // and this is the property that protects NFL/NBA.
  it.each([
    [true, true],
    [true, false],
    [true, undefined],
  ])('is_update=true stays true whatever the classifier says (is_new=%s)', (_sf, isNew) => {
    const r = resolveUpdateSignal(feedEvent(true), isNew as boolean | undefined);
    expect(r).toEqual({ isUpdate: true, updateSignal: 'source' });
  });

  it.each([
    [false, true],
    [false, false],
    [false, undefined],
  ])('is_update=false stays false whatever the classifier says (is_new=%s)', (_sf, isNew) => {
    // The load-bearing half. ESPN's structured feed sets is_update explicitly
    // both ways, so `false` is a real answer — "this is not a status change" —
    // and must not be overridden by a classifier that thinks otherwise.
    // Collapsing false into undefined here would hand the whole NFL/NBA corpus
    // to the classifier fallback and change what publishes today.
    const r = resolveUpdateSignal(feedEvent(false), isNew as boolean | undefined);
    expect(r).toEqual({ isUpdate: false, updateSignal: 'source' });
  });
});

describe('the classifier stands in where the source cannot speak', () => {
  it('treats is_new=false as an update', () => {
    // "McGregor to undergo surgery" five days after the ACL report. Without
    // this the entity match suppresses it for the rest of the 21-day window.
    expect(resolveUpdateSignal(newsEvent(), false)).toEqual({
      isUpdate: true,
      updateSignal: 'classifier',
    });
  });

  it('treats is_new=true as not an update', () => {
    expect(resolveUpdateSignal(newsEvent(), true)).toEqual({
      isUpdate: false,
      updateSignal: 'none',
    });
  });

  it('treats an absent classifier verdict as not an update', () => {
    // The conservative direction: no signal means no escape, so a classifier
    // outage cannot open the floodgates.
    expect(resolveUpdateSignal(newsEvent(), undefined)).toEqual({
      isUpdate: false,
      updateSignal: 'none',
    });
  });
});

describe('the rule is about the source, not the sport', () => {
  it('applies to every news source, not just UFC', () => {
    // Keying this on sport === 'UFC' would rebuild the carve-out this change
    // removes. A PL or NFL news-sourced event has exactly the same problem:
    // no status field, so no way to report a follow-up.
    for (const sport of ['UFC', 'PREMIER_LEAGUE', 'NFL', 'NBA'] as const) {
      const r = resolveUpdateSignal({ sport, source_kind: 'article' } as RawInjuryEvent, false);
      expect(r).toEqual({ isUpdate: true, updateSignal: 'classifier' });
    }
  });
});
