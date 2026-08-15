/**
 * UFC card-position provider.
 *
 * The fixture is a real capture of .../mma/ufc/scoreboard from 2026-08-15,
 * trimmed to the fields the loader reads: a numbered pay-per-view with a
 * champion in the main event (UFC 330), a second PPV with no belt on the card
 * (UFC 326), a Fight Night, and a Contender Series show.
 *
 * ESPN publishes no card-segment field, so position within a card is inferred
 * from the ORDER of competitions[] and stature from the event NAME. Both were
 * verified against the live feed: competitions[] runs first prelim → main
 * event, and `competitor.order` is the corner (1 or 2), not the card slot.
 * If ESPN ever reverses the array these tests are what notices.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { _internals } from '../src/agents/injury-intelligence/derived-tier-snapshot.js';
import type { DerivedRow } from '../src/agents/injury-intelligence/significance.js';

const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/espn-ufc-scoreboard.json'),
    'utf-8',
  ),
) as { events: Array<{ name: string; date: string; competitions: unknown[] }> };

const NOW = new Date('2026-08-15T12:00:00Z');

/** Serves the whole fixture for any date range the loader asks for. */
function stubScoreboard(events = FIXTURE.events, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => ({ events }) })),
  );
}

async function load(): Promise<DerivedRow[] | null> {
  return _internals.loadCardRows('UFC', 180, 90, NOW);
}

function slotOf(rows: DerivedRow[] | null, name: string): string | undefined {
  const row = rows?.find((r) => r.full_name === name);
  return row?.signal.kind === 'card' ? row.signal.slot : undefined;
}

afterEach(() => vi.unstubAllGlobals());

describe('card stature and position', () => {
  beforeEach(() => stubScoreboard());

  it('gives a belt-holder the champion slot', async () => {
    // Islam Makhachev carries a `{type:"Belt"}` accolade at UFC 330.
    expect(slotOf(await load(), 'Islam Makhachev')).toBe('champion');
  });

  it('does NOT hand the champion slot to his opponent', async () => {
    // The belt is an athlete accolade, not a bout property. Ian Machado Garry
    // is the challenger; he earns tier 1 by main-eventing a pay-per-view, which
    // is a different claim from being the champion.
    expect(slotOf(await load(), 'Ian Machado Garry')).toBe('ppv_main_event');
  });

  it('ranks a champion above her position on the card, and her opponent by position', async () => {
    // Mackenzie Dern held the strawweight title while fighting the CO-MAIN at
    // UFC 330. A per-bout rule would have handed Gillian Robertson tier 1 off
    // the belt across the cage from her.
    const rows = await load();
    expect(slotOf(rows, 'Mackenzie Dern')).toBe('champion');
    expect(slotOf(rows, 'Gillian Robertson')).toBe('ppv_co_main');
  });

  it('gives a PPV main event with no belt the ppv_main_event slot', async () => {
    // UFC 326's main event is Oliveira vs Holloway, neither holding a belt.
    const rows = await load();
    expect(slotOf(rows, 'Charles Oliveira')).toBe('ppv_main_event');
    expect(slotOf(rows, 'Max Holloway')).toBe('ppv_main_event');
  });

  it('gives the rest of the televised card the main-card slot', async () => {
    // Third from the top on a 12-bout PPV.
    expect(slotOf(await load(), 'Jalin Turner')).toBe('ppv_main_card');
  });

  it('gives prelims no slot at all — they confer no prominence', async () => {
    // First bout of UFC 330: nine places below the main event.
    expect(slotOf(await load(), 'Jeremiah Wells')).toBeUndefined();
  });

  it('distinguishes a Fight Night main event from a pay-per-view one', async () => {
    const rows = await load();
    // Sean Strickland holds a belt, so the champion slot outranks his position.
    // His opponent main-evented a Fight Night, not a PPV — tier 2, not tier 1.
    expect(slotOf(rows, 'Sean Strickland')).toBe('champion');
    expect(slotOf(rows, 'Anthony Hernandez')).toBe('fight_night_main_event');
  });

  it('excludes Dana Whites Contender Series entirely', async () => {
    // A developmental show. Main-eventing one says nothing about prominence,
    // and including it would hand tier 2 to debutants.
    const rows = await load();
    expect(rows?.some((r) => r.full_name === 'Anthony Wint')).toBe(false);
    expect(rows?.some((r) => r.full_name === 'Matt Adams')).toBe(false);
  });

  it('never indexes a placeholder opponent as a fighter', async () => {
    // ESPN books announced-but-unfilled bouts against "TBA" / "Opponent TBA".
    // A main-event placeholder would otherwise be indexed as a tier-1 fighter.
    stubScoreboard([
      {
        name: 'UFC 332: Someone vs. TBA',
        date: '2026-10-01T00:00Z',
        competitions: [
          { competitors: [{ athlete: { displayName: 'Real Fighter' } }, { athlete: { displayName: 'TBA' } }] },
        ],
      },
    ] as never);

    const rows = await load();
    expect(rows?.map((r) => r.full_name)).toEqual(['Real Fighter']);
  });

  it('records the event that produced each slot, for audit', async () => {
    const row = (await load())?.find((r) => r.full_name === 'Islam Makhachev');
    expect(row?.signal.kind === 'card' && row.signal.event_name).toContain('UFC 330');
    expect(row?.signal.kind === 'card' && row.signal.event_date).toContain('2026-08-15');
  });
});

describe('slot classification, unit', () => {
  const { slotFor, isNumberedPPV, isExcludedEvent } = _internals;

  it.each([
    ['UFC 330: Makhachev vs. Machado Garry', true],
    ['UFC 300', true],
    ['UFC Fight Night: Strickland vs. Hernandez', false],
    ['Noche UFC', false],
    ['UFC on ABC 9', false],
  ])('%s → numbered PPV: %s', (name, expected) => {
    expect(isNumberedPPV(name)).toBe(expected);
  });

  it.each([
    ["Dana White's Contender Series: Season 10, Week 1", true],
    ['UFC 330: Makhachev vs. Machado Garry', false],
  ])('%s → excluded: %s', (name, expected) => {
    expect(isExcludedEvent(name)).toBe(expected);
  });

  it('reads position from the end of the array, not the start', () => {
    // The single assumption this whole provider rests on.
    expect(slotFor(11, 12, true, false)).toBe('ppv_main_event');
    expect(slotFor(0, 12, true, false)).toBeNull();
  });

  it('lets a belt outrank its holders position on the card', () => {
    expect(slotFor(0, 12, true, true)).toBe('champion');
    expect(slotFor(3, 14, false, true)).toBe('champion');
  });

  it('draws the main card at five bouts, and only on a pay-per-view', () => {
    expect(slotFor(7, 12, true, false)).toBe('ppv_main_card'); // 5th from top
    expect(slotFor(6, 12, true, false)).toBeNull(); // 6th — a prelim
    expect(slotFor(7, 12, false, false)).toBeNull(); // no main card on a Fight Night
  });
});

describe('a thin or failed read never becomes a demotion', () => {
  it('aborts rather than installing a snapshot when a chunk fails', async () => {
    stubScoreboard([], false, 503);
    expect(await load()).toBeNull();
  });

  it('treats an empty window as a failed read, not an empty sport', async () => {
    // The whole window returning zero events means the feed is broken; the UFC
    // does not stop running cards for six months. Silently indexing nobody
    // would demote every fighter to the flat default with no symptom.
    stubScoreboard([]);
    expect(await load()).toBeNull();
  });

  it('keeps a fighters BEST slot when they appear on more than one card', async () => {
    stubScoreboard([
      {
        name: 'UFC Fight Night: Test',
        date: '2026-06-01T00:00Z',
        competitions: [
          { competitors: [{ athlete: { displayName: 'Repeat Fighter' } }, { athlete: { displayName: 'Other' } }] },
        ],
      },
      {
        name: 'UFC 331: Test',
        date: '2026-07-01T00:00Z',
        competitions: Array.from({ length: 12 }, (_, i) => ({
          competitors:
            i === 11
              ? [{ athlete: { displayName: 'Repeat Fighter' } }, { athlete: { displayName: 'Someone' } }]
              : [{ athlete: { displayName: `Prelim ${i}` } }, { athlete: { displayName: `Foe ${i}` } }],
        })),
      },
    ] as never);

    expect(slotOf(await load(), 'Repeat Fighter')).toBe('ppv_main_event');
  });
});
