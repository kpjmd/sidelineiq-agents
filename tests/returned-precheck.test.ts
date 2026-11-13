import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  callToolWithRetry: vi.fn(),
  isServerAvailable: vi.fn(() => true),
  initializeMCPClients: vi.fn(),
  disconnectAll: vi.fn(),
  getServerStatus: vi.fn(() => ({})),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import {
  checkReturnedBeforeReport,
  decideReturned,
  returnedPrecheckMode,
  returnedSkipMinWeeks,
  DEFAULT_SKIP_MIN_WEEKS,
  voidUnneededThread,
} from '../src/monitoring/returned-precheck.js';
import { reportsFreshEvent, isGatingCarryover } from '../src/agents/injury-intelligence/carryover.js';
import type { RawInjuryEvent } from '../src/types.js';
import type { GamelogGame } from '../src/monitoring/sports/espn-gamelog.js';

const here = dirname(fileURLToPath(import.meta.url));
// Recorded 2026-11-03 from ESPN: Irving's 2026-27 game log, including preseason.
const IRVING_2026_27 = JSON.parse(
  readFileSync(resolve(here, 'fixtures/espn-gamelog-irving-2026-27.json'), 'utf-8'),
);

const THREAD = { injury_date: '2025-03-03', injury_date_confidence: 'confirmed' as const };

function event(overrides: Partial<RawInjuryEvent> = {}): RawInjuryEvent {
  return {
    athlete_name: 'Kyrie Irving',
    sport: 'NBA',
    team: 'Dallas Mavericks',
    injury_description: 'Knee - Left, injury management',
    espn_athlete_id: '6442',
    reported_at: new Date('2026-11-03T04:00:00Z'), // Nov 2 in the sport's local time.
    source_url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
    source_name: 'espn-nba',
    ...overrides,
  } as RawInjuryEvent;
}

function stubFetch(handler: (url: string) => { status: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const { status, body } = handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.RETURNED_PRECHECK_MODE;
  delete process.env.RETURNED_PRECHECK_SKIP_MIN_WEEKS;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Kyrie Irving, against his recorded game log', () => {
  beforeEach(() => {
    stubFetch((url) =>
      url.includes('season=2027')
        ? { status: 200, body: IRVING_2026_27 }
        : { status: 200, body: { seasonTypes: [], events: {} } },
    );
  });

  it('skips the maintenance row: five regular-season games, preseason not counted', async () => {
    const d = await checkReturnedBeforeReport(event(), THREAD, null);
    expect(d).toMatchObject({
      kind: 'skip',
      anchor: '2025-03-03',
      report_date: '2026-11-02',
      games: 5,
      first_game_date: '2026-10-21',
    });
  });

  it('sends a report with fresh language to review instead', async () => {
    const d = await checkReturnedBeforeReport(
      event({ injury_description: 'Irving aggravated his left knee in Friday\'s game' }),
      THREAD,
      null,
    );
    expect(d.kind).toBe('review');
  });
});

describe('every way of not knowing passes the event through', () => {
  it.each([404, 429, 503])('HTTP %i', async (status) => {
    stubFetch(() => ({ status }));
    const d = await checkReturnedBeforeReport(event(), THREAD, null);
    expect(d.kind).toBe('not_applicable');
  });

  it('a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    expect((await checkReturnedBeforeReport(event(), THREAD, null)).kind).toBe('not_applicable');
  });

  it.each([
    ['no athlete id', event({ espn_athlete_id: undefined }), THREAD, null],
    ['a sport with no game log', event({ sport: 'UFC' }), THREAD, null],
    ['no date', event(), { injury_date: null, injury_date_confidence: 'unknown' as const }, null],
    ['a guessed date', event(), { injury_date: '2025-03-03', injury_date_confidence: 'possible' as const }, null],
  ])('%s', async (_name, ev, thread, skipReason) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await checkReturnedBeforeReport(ev, thread, skipReason)).kind).toBe('not_applicable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mode off makes no request', async () => {
    process.env.RETURNED_PRECHECK_MODE = 'off';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await checkReturnedBeforeReport(event(), THREAD, null)).kind).toBe('not_applicable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('an MD-entered date counts at any confidence', () => {
  it('reads the game log on a possible date from md_manual', async () => {
    stubFetch((url) =>
      url.includes('season=2027')
        ? { status: 200, body: IRVING_2026_27 }
        : { status: 200, body: { seasonTypes: [], events: {} } },
    );
    const d = await checkReturnedBeforeReport(
      event(),
      { injury_date: '2025-03-03', injury_date_confidence: 'possible' },
      'md_manual',
    );
    expect(d.kind).toBe('skip');
  });
});

describe('decideReturned', () => {
  const game = (date: string) => ({ date } as GamelogGame);

  it('ignores a game on the anchor date: the one he was hurt in', () => {
    expect(decideReturned([game('2026-10-04')], '2026-10-04', '2026-10-10', false).kind).toBe('not_returned');
  });

  it('ignores a game on the report date', () => {
    expect(decideReturned([game('2026-10-10')], '2026-10-04', '2026-10-10', false).kind).toBe('not_returned');
  });

  it('counts a game strictly between them', () => {
    expect(decideReturned([game('2026-10-05')], '2026-10-04', '2026-10-10', false).kind).toBe('inform');
  });

  // Shadow week 2026-11-09..13: both were real "out again" stories.
  it('informs, never skips, a young anchor: Markkanen, sprain 10-26, four games, out 11-09', () => {
    const games = ['2026-10-31', '2026-11-02', '2026-11-04', '2026-11-06'].map(game);
    expect(decideReturned(games, '2026-10-26', '2026-11-09', false)).toMatchObject({
      kind: 'inform',
      anchor_age_days: 14,
      games: 4,
      first_game_date: '2026-10-31',
      last_game_date: '2026-11-06',
    });
  });

  it('informs Trey Murphy III: tendinopathy 11-04, played 11-06 and 11-08', () => {
    const games = ['2026-11-06', '2026-11-08'].map(game);
    expect(decideReturned(games, '2026-11-04', '2026-11-09', false).kind).toBe('inform');
  });

  it('skips at the cutoff and informs one day short of it', () => {
    const weeks = DEFAULT_SKIP_MIN_WEEKS;
    const g = [game('2026-01-10')];
    // 2026-01-01 + 182 days = 2026-07-02.
    expect(weeks * 7).toBe(182);
    expect(decideReturned(g, '2026-01-01', '2026-07-02', false, weeks).kind).toBe('skip');
    expect(decideReturned(g, '2026-01-01', '2026-07-01', false, weeks).kind).toBe('inform');
  });

  it('sends fresh wording to review whatever the anchor age', () => {
    expect(decideReturned([game('2026-11-06')], '2026-11-04', '2026-11-09', true).kind).toBe('review');
    expect(decideReturned([game('2025-10-21')], '2025-03-03', '2026-11-02', true).kind).toBe('review');
  });
});

describe('the skip cutoff', () => {
  it('defaults to 26 weeks', () => {
    expect(returnedSkipMinWeeks()).toBe(26);
  });

  it('takes a positive override and ignores anything else', () => {
    process.env.RETURNED_PRECHECK_SKIP_MIN_WEEKS = '40';
    expect(returnedSkipMinWeeks()).toBe(40);
    for (const bad of ['0', '-3', 'abc', '']) {
      process.env.RETURNED_PRECHECK_SKIP_MIN_WEEKS = bad;
      expect(returnedSkipMinWeeks()).toBe(26);
    }
  });
});

describe('reportsFreshEvent', () => {
  const ev = (injury_description: string, injury_description_long?: string) =>
    ({ injury_description, injury_description_long } as RawInjuryEvent);

  it.each([
    'Irving re-injured his left knee',
    'aggravated the knee in practice',
    'left the game in the third quarter and did not return',
    'He suffered a setback this week',
    'will undergo an MRI on the knee',
    'An MRI revealed a torn meniscus',
    'He reported swelling in the knee after practice',
    'The knee showed increased swelling Monday',
    'had surgery on Friday',
    'placed on injured reserve',
  ])('fresh: %s', (text) => {
    expect(reportsFreshEvent(ev(text))).toBe(true);
  });

  it.each([
    'Knee - Left, injury management',
    'Questionable for Sunday with a knee',
    'Irving sustained the injury in March 2025 and returned this season',
    'He left his Dallas home in April', // Not a game.
    // Mahomes 2026-11-13: good news, read as a re-injury before the narrowing.
    'Mahomes has had "limited swelling" and "limited pain" in his right elbow',
    'He had an MRI that checked out fine and has practiced fully this week.',
    'The MRI came back clean.',
    'An MRI showed no structural damage.',
    'There was no swelling.',
  ])('not fresh: %s', (text) => {
    expect(reportsFreshEvent(ev(text))).toBe(false);
  });

  it('reads the long comment too', () => {
    expect(reportsFreshEvent(ev('Knee', 'He aggravated it on Tuesday.'))).toBe(true);
  });
});

describe('isGatingCarryover is untouched by the wider fresh test', () => {
  it('still gates a re-injury wording the old veto never knew', () => {
    const e = { injury_description: 'ACL tear, aggravated in rehab', injury_details: { detail: 'Surgery' } } as unknown as RawInjuryEvent;
    expect(isGatingCarryover({ strength: 'prose', codes: [] } as never, e)).toBe(true);
  });
});

describe('voidUnneededThread', () => {
  const hit = { kind: 'skip' as const, anchor: '2025-03-03', report_date: '2026-11-02', anchor_age_days: 609, games: 5, first_game_date: '2026-10-21', last_game_date: '2026-10-30' };

  it("sends the literal 'system' as closed_by and says why", async () => {
    vi.mocked(callTool).mockResolvedValue({ content: [{ type: 'text', text: '{}' }] } as never);
    await voidUnneededThread('e1', event(), hit);
    const [, tool, args] = vi.mocked(callTool).mock.calls[0];
    expect(tool).toBe('web_thread_close');
    expect(args).toMatchObject({ entity_id: 'e1', outcome: 'VOID', closed_by: 'system' });
    expect((args as { void_reason: string }).void_reason).toContain('2026-10-21');
  });

  it('never throws', async () => {
    vi.mocked(callTool).mockRejectedValue(new Error('down'));
    await expect(voidUnneededThread('e1', event(), hit)).resolves.toBeUndefined();
  });
});

describe('the mode', () => {
  it('defaults to shadow', () => {
    expect(returnedPrecheckMode()).toBe('shadow');
  });
});
