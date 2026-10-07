/**
 * The transaction wire, read as prose (plan D2, decision S3-4). Recorded items
 * come from tests/fixtures/ledger-ingest/espn-transactions.json; the trap
 * sentences are the shapes seen live on 2026-10-07, as inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  attributeTransactions,
  classifySentence,
  clauseNamesPlayer,
  extractTransactionEvents,
  fetchTransactionsSince,
  normalizePersonName,
  nflverseTeamOf,
  splitSentences,
  teamNamesFrom,
  TransactionsUnavailableError,
} from '../src/ledger/ingest/espn-transactions.js';
import { TransientEspnError } from '../src/monitoring/sports/espn-json.js';
import { TRANSACTIONS_URL } from '../src/ledger/rules.js';
import { transactionPages } from './helpers/ledger-ingest-fixture.js';

const recorded = transactionPages.flatMap((p) => p.body.transactions);

describe('sentence splitting', () => {
  it('does not split after a generational suffix or an initial', () => {
    expect(splitSentences('Placed LT Paris Johnson Jr. and TE Hunter Long on injured reserve.')).toHaveLength(1);
    expect(splitSentences('Signed WR A.J. Brown to the active roster.')).toHaveLength(1);
  });
  it('splits at every new sentence, including one after "Jr." that starts with a transaction verb', () => {
    expect(splitSentences('Placed LB Edgerrin Cooper on injured reserve. Signed LB Kristian Welch to the active roster.')).toHaveLength(2);
    expect(splitSentences('Waived RB Carlos Washington Jr. Placed S Caleb Ransaw on injured reserve.')).toEqual([
      'Waived RB Carlos Washington Jr.',
      'Placed S Caleb Ransaw on injured reserve.',
    ]);
  });
});

describe('classification: the prose traps', () => {
  const cases: Array<[string, ReturnType<typeof classifySentence>]> = [
    ['Placed LB Edgerrin Cooper on injured reserve.', 'IR'],
    ['Placed Cs Jovaughn Gwyn and Ethan Pocic on injured reserve.', 'IR'],
    ['Placed WR X on injured reserve with a designation to return.', 'IR'],
    ['Designated QB Dillon Gabriel and DT Kalia Davis to return from injured reserve.', null],
    ['Activated WR X from injured reserve.', null],
    ['Waived CB Tyreek Chappell from injured reserve.', 'RELEASE'],
    ['Waived CB Christian Braswell with an injury designation.', 'RELEASE'],
    ['Released OL Jose Ramirez.', 'RELEASE'],
    ['T Lane Johnson announced his retirement.', 'RETIRE'],
    ['Acquired WR X from the Jacksonville Jaguars in exchange for a 2027 fifth-round pick.', 'TRADE'],
    ['Traded LB X to the Chicago Bears.', 'TRADE'],
    ['Placed DE X on the reserve/suspended list.', 'SUSPEND'],
    ['Reinstated DE X from the reserve/suspended list.', null],
    ['Placed RB X on the reserve/non-football injury list.', null],
    ['Placed TE X on the reserve/physically unable to perform list.', null],
    ['Signed CB A.J. Woods to the practice squad.', null],
  ];
  it.each(cases)('%s → %s', (sentence, kind) => {
    expect(classifySentence(sentence)).toBe(kind);
  });
});

describe('names and teams', () => {
  it('normalizes punctuation and generational suffixes', () => {
    expect(normalizePersonName('A.J. Brown')).toBe('aj brown');
    expect(normalizePersonName("Paris Johnson Jr.")).toBe('paris johnson');
    expect(normalizePersonName("Ja'Marr Chase")).toBe('jamarr chase');
  });
  it('a surname alone never matches', () => {
    expect(clauseNamesPlayer('Placed QB Jackson on injured reserve.', 'Jackson')).toBe(false);
    expect(clauseNamesPlayer('Placed QB Lamar Jackson on injured reserve.', 'Lamar Jackson')).toBe(true);
    expect(clauseNamesPlayer('Placed G Donovan Jackson on injured reserve.', 'Lamar Jackson')).toBe(false);
  });
  it('maps ESPN codes to nflverse codes', () => {
    expect(nflverseTeamOf('LAR')).toBe('LA');
    expect(nflverseTeamOf('WSH')).toBe('WAS');
    expect(nflverseTeamOf('BAL')).toBe('BAL');
  });
  it('learns team names from the recorded items', () => {
    expect(teamNamesFrom(recorded).get('BAL')).toContain('Baltimore Ravens');
  });
});

describe('recorded items → attributed events', () => {
  const events = recorded.flatMap(extractTransactionEvents);

  it('reads the plural-position IR sentence on the recorded Ravens item, dated on the ET calendar', () => {
    const bal = events.filter((e) => e.team === 'BAL');
    expect(bal.some((e) => e.kind === 'IR' && e.date === '2026-10-03' && e.clause.includes('Ethan Pocic'))).toBe(true);
  });

  it('attributes it to Ethan Pocic and to Jovaughn Gwyn, never to Lamar Jackson', () => {
    const names = teamNamesFrom(recorded).get('BAL') ?? [];
    for (const player of ['Ethan Pocic', 'Jovaughn Gwyn']) {
      const tx = attributeTransactions(events, { player, team: 'BAL', teamNames: names });
      expect(tx).toEqual([{ kind: 'IR', date: '2026-10-03', team: 'BAL', sentence: 'Placed Cs Jovaughn Gwyn and Ethan Pocic on injured reserve.', url: TRANSACTIONS_URL }]);
    }
    expect(attributeTransactions(events, { player: 'Lamar Jackson', team: 'BAL', teamNames: names })).toEqual([]);
  });

  it('a same-named player on another team is not attributed', () => {
    expect(attributeTransactions(events, { player: 'Ethan Pocic', team: 'CLE', teamNames: ['Cleveland Browns'] })).toEqual([]);
  });

  it('a trade filed under the other club counts only when it names the entry team', () => {
    const ev = [{ kind: 'TRADE' as const, date: '2026-10-05', team: 'JAX', clause: 'Acquired WR Sam Example from the Baltimore Ravens.', description: '' }];
    expect(attributeTransactions(ev, { player: 'Sam Example', team: 'BAL', teamNames: ['Baltimore Ravens', 'Ravens'] })).toHaveLength(1);
    expect(attributeTransactions(ev, { player: 'Sam Example', team: 'CIN', teamNames: ['Cincinnati Bengals', 'Bengals'] })).toHaveLength(0);
  });
});

describe('paged fetch: every non-answer is a bad page', () => {
  const page = (n: number, dates: string[], pageCount = 5) => ({ pageCount, transactions: dates.map((d) => ({ date: `${d}T07:00Z`, description: 'Released OL X.', team: { abbreviation: 'BAL' } })) });

  it('stops a year once a page reaches past `since`, and filters older items', async () => {
    const urls: string[] = [];
    const out = await fetchTransactionsSince('2026-10-02', 2026, async (url) => {
      urls.push(url);
      return url.includes('page=1') ? page(1, ['2026-10-06', '2026-10-04']) : page(2, ['2026-10-03', '2026-09-30']);
    });
    expect(urls).toHaveLength(2);
    expect(out.map((t) => t.date.slice(0, 10))).toEqual(['2026-10-06', '2026-10-04', '2026-10-03']);
  });

  it('a 404 page throws', async () => {
    await expect(fetchTransactionsSince('2026-10-02', 2026, async () => null)).rejects.toBeInstanceOf(TransactionsUnavailableError);
  });

  it('a 503 / timeout throws', async () => {
    await expect(fetchTransactionsSince('2026-10-02', 2026, async () => {
      throw new TransientEspnError('HTTP 503');
    })).rejects.toBeInstanceOf(TransactionsUnavailableError);
  });

  it('crosses a calendar year when the window starts in the previous one', async () => {
    const urls: string[] = [];
    await fetchTransactionsSince('2026-12-30', 2027, async (url) => {
      urls.push(url);
      return page(1, ['2026-12-01'], 1);
    });
    expect(urls.map((u) => /season=(\d+)/.exec(u)![1])).toEqual(['2026', '2027']);
  });
});
