/**
 * The return detector's cycle, against recorded ESPN payloads and a mocked MCP.
 *
 * The properties under test are the ones whose failure is expensive and quiet:
 *
 *  - **A bad PAGE must abort.** ESPN rate-limits by dropping a contiguous block
 *    of requests. A 429 read as "these athletes played no games" closes a RUN
 *    of threads with no return, and a close is only reversible by a human.
 *  - **A bad ROW must not.** A 404 on one athlete is bounded and known; letting
 *    it stop the cycle would make one retired id block every other thread.
 *  - **Shadow writes nothing at all**, including in the cases that look
 *    obviously safe — that is what shadow means here and in
 *    ATHLETE_REANCHOR_MODE.
 *  - **Emit order**: the RESOLUTION update before the close, because
 *    maybeProposeReturnWatch fires off the append path and the close removes
 *    the thread from matching.
 *
 * FAILS-ON-OLD is not meaningful (the module is new); FAIL-CLOSED IN BOTH
 * DIRECTIONS is: the shadow case asserts ZERO writes and the `on` case asserts
 * real ones, so neither a detector that never writes nor one that always writes
 * can pass both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/utils/mcp-client-manager.js', () => ({
  callTool: vi.fn(),
  isServerAvailable: vi.fn(() => true),
}));
vi.mock('../src/monitoring/return-watch.js', () => ({
  maybeProposeReturnWatch: vi.fn(async () => undefined),
}));

import { callTool } from '../src/utils/mcp-client-manager.js';
import { maybeProposeReturnWatch } from '../src/monitoring/return-watch.js';
import {
  runReturnDetectCycle,
  decideThread,
  addWeeksIso,
  returnDetectMode,
  predictUnscoreable,
  type DetectorThread,
} from '../src/monitoring/return-detector.js';
import { parseRegularSeasonGames } from '../src/monitoring/sports/espn-gamelog.js';

const mockCallTool = vi.mocked(callTool);
const mockProposeReturnWatch = vi.mocked(maybeProposeReturnWatch);

interface Fixture {
  cases: Record<string, { url: string; status: number; body: unknown }>;
}
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/espn-gamelogs.json'), 'utf-8'),
) as Fixture;
const NFL_BODY = fixture.cases['nfl-regular-season'].body;
const NFL_GAMES = parseRegularSeasonGames(NFL_BODY, 'NFL').games;
// The recorded season runs through December 2025; anchor the clock just after
// it so gamelogSeasonsFor asks for the season the fixture actually is.
const NOW = new Date('2025-12-31T18:00:00Z');

function ok(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function mcpError(message: string) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

const THREAD: DetectorThread = {
  id: '770e8400-e29b-41d4-a716-446655440002',
  athlete_name: 'Patrick Mahomes',
  sport: 'NFL',
  status: 'ACTIVE',
  // Before the fixture's first recorded game, and long enough ago that the
  // too-early bar is satisfied for a 2-week minimum.
  injury_date: '2025-08-01',
  actual_return_date: null,
  espn_athlete_id: '3139477',
  otm_projection: { min_weeks: 2, max_weeks: 6 },
};

type ToolHandler = (server: string, tool: string, params: Record<string, unknown>) => unknown;

function routeMcp(threads: DetectorThread[], overrides: Partial<Record<string, ToolHandler>> = {}) {
  mockCallTool.mockImplementation(async (server, tool, params) => {
    const h = overrides[tool];
    if (h) return h(server, tool, params as Record<string, unknown>);
    if (tool === 'web_list_threads') {
      const sport = (params as { sport?: string }).sport;
      return ok({ threads: threads.filter((t) => t.sport === sport), total: 0, has_more: false, next_offset: null });
    }
    if (tool === 'web_append_injury_update') return ok({ update: { id: 'u1' } });
    if (tool === 'web_thread_close') return ok({ entity: { status: 'RESOLVED' } });
    if (tool === 'web_thread_get') return ok({ entity: { status: 'RESOLVED', actual_return_date: '2025-09-05' } });
    if (tool === 'web_thread_update_dates') return ok({ entity: { needs_date_review: true } });
    if (tool === 'web_audit_append') return ok({ entry: { id: 'a1' } });
    throw new Error(`unexpected tool ${tool}`);
  });
}

const schedules = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/espn-team-schedules.json'), 'utf-8'),
) as Fixture;
const KC_2025 = schedules.cases['nfl-kc-2025-pairs-with-gamelog'].body;
const EMPTY_SCHEDULE = schedules.cases['unknown-team-200-empty'].body;

/**
 * Stub ESPN. `status` is per-URL so one athlete can 404 while others succeed.
 * Team schedules: KC 2025 is recorded (it pairs with the gamelog fixture);
 * every other team-season answers the way ESPN really does — 200, empty.
 */
function routeEspn(
  byAthlete: Record<string, { status: number; body?: unknown }>,
  schedule: { status: number } = { status: 200 },
) {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/schedule')) {
      if (schedule.status !== 200) {
        return { ok: false, status: schedule.status, json: async () => null } as unknown as Response;
      }
      const body = href.includes('/teams/12/') && href.includes('season=2025') ? KC_2025 : EMPTY_SCHEDULE;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    const id = href.match(/athletes\/(\d+)\//)?.[1] ?? '';
    const entry = byAthlete[id] ?? { status: 200, body: NFL_BODY };
    if (entry.status === 404) return { ok: false, status: 404, json: async () => null } as unknown as Response;
    if (entry.status !== 200) {
      return { ok: false, status: entry.status, json: async () => null } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => entry.body ?? NFL_BODY } as unknown as Response;
  });
}

function writeCalls() {
  const WRITES = ['web_append_injury_update', 'web_thread_close', 'web_thread_update_dates', 'web_audit_append'];
  return mockCallTool.mock.calls.filter(([, tool]) => WRITES.includes(tool as string));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('mode', () => {
  it('defaults to shadow, and only recognises off and on', () => {
    expect(returnDetectMode()).toBe('shadow');
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    expect(returnDetectMode()).toBe('on');
    vi.stubEnv('RETURN_DETECT_MODE', 'off');
    expect(returnDetectMode()).toBe('off');
    // A typo must not silently enable writes.
    vi.stubEnv('RETURN_DETECT_MODE', 'ON!');
    expect(returnDetectMode()).toBe('shadow');
  });
});

describe('shadow mode', () => {
  it('detects the return and writes absolutely nothing', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'shadow');
    routeMcp([THREAD]);
    routeEspn({});

    const summary = await runReturnDetectCycle(NOW);

    expect(summary.mode).toBe('shadow');
    expect(summary.returned).toBe(1);
    expect(writeCalls()).toHaveLength(0);
    expect(mockProposeReturnWatch).not.toHaveBeenCalled();
  });
});

describe('on mode', () => {
  it('appends the RESOLUTION update BEFORE closing, then reads back', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD]);
    routeEspn({});

    const summary = await runReturnDetectCycle(NOW);
    expect(summary.returned).toBe(1);
    expect(summary.errors).toBe(0);

    const order = mockCallTool.mock.calls.map(([, tool]) => tool);
    const appendAt = order.indexOf('web_append_injury_update');
    const closeAt = order.indexOf('web_thread_close');
    const readBackAt = order.lastIndexOf('web_thread_get');
    expect(appendAt).toBeGreaterThanOrEqual(0);
    // Closing first removes the thread from matching and the Desk "first game
    // back" candidate is never proposed.
    expect(appendAt).toBeLessThan(closeAt);
    expect(closeAt).toBeLessThan(readBackAt);

    const [, , appendArgs] = mockCallTool.mock.calls[appendAt];
    expect((appendArgs as { update_kind: string }).update_kind).toBe('RESOLUTION');
    expect(mockProposeReturnWatch).toHaveBeenCalledWith(THREAD.id, 'RESOLUTION', expect.anything());
  });

  it("closes as the literal 'system' and stamps return_source detector", async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD]);
    routeEspn({});
    await runReturnDetectCycle(NOW);

    const close = mockCallTool.mock.calls.find(([, tool]) => tool === 'web_thread_close');
    const args = close![2] as Record<string, unknown>;
    // Any other closed_by stamps the audit actor as a physician.
    expect(args.closed_by).toBe('system');
    expect(args.return_source).toBe('detector');
    expect(args.outcome).toBe('RESOLVED');
    expect(args.actual_return_date).toBe(NFL_GAMES[0].date);
  });

  it('counts an error when the close does not stick', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD], {
      // The md guard can refuse part of a write, so the echo is not proof.
      web_thread_get: () => ok({ entity: { status: 'ACTIVE', actual_return_date: null } }),
    });
    routeEspn({});
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.errors).toBe(1);
  });

  it('counts an error when the close is rejected, and does not abort the cycle', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    const second = { ...THREAD, id: 'second-thread', athlete_name: 'Someone Else' };
    routeMcp([THREAD, second], { web_thread_close: () => mcpError('thread is VOID') });
    routeEspn({});
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.errors).toBe(2);
    expect(summary.aborted).toBe(false);
    expect(summary.returned).toBe(2);
  });
});

describe('the HTTP failure split', () => {
  it('404 is a bad ROW: skip that athlete, keep going', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    const gone = { ...THREAD, id: 'gone', athlete_name: 'Retired Guy', espn_athlete_id: '999999999' };
    routeMcp([gone, THREAD]);
    routeEspn({ '999999999': { status: 404 } });

    const summary = await runReturnDetectCycle(NOW);
    expect(summary.skipped.athlete_not_found).toBe(1);
    expect(summary.aborted).toBe(false);
    // The other thread was still processed and closed.
    expect(summary.returned).toBe(1);
    expect(mockCallTool.mock.calls.some(([, t]) => t === 'web_thread_close')).toBe(true);
  });

  it('503 is a bad PAGE: abort, close nothing, leave threads ACTIVE', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD]);
    routeEspn({ '3139477': { status: 503 } });

    const summary = await runReturnDetectCycle(NOW);
    expect(summary.aborted).toBe(true);
    expect(summary.abort_reason).toMatch(/503/);
    expect(summary.returned).toBe(0);
    expect(writeCalls()).toHaveLength(0);
  });

  it('429 aborts before reaching a later, healthy athlete', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    const limited = { ...THREAD, id: 'limited', espn_athlete_id: '111111' };
    routeMcp([limited, THREAD]);
    routeEspn({ '111111': { status: 429 } });

    const summary = await runReturnDetectCycle(NOW);
    expect(summary.aborted).toBe(true);
    // The whole point: a dropped contiguous block must not be read as "nobody
    // returned" for the athletes behind it.
    expect(summary.returned).toBe(0);
    expect(writeCalls()).toHaveLength(0);
  });
});

describe('skips', () => {
  it.each([
    ['no injury_date', { injury_date: null }, 'no_injury_date'],
    ['an already-recorded return', { actual_return_date: '2025-10-01' }, 'already_returned'],
    ['no espn_athlete_id', { espn_athlete_id: null }, 'no_espn_athlete_id'],
  ])('skips a thread with %s', async (_label, patch, reason) => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([{ ...THREAD, ...(patch as Partial<DetectorThread>) }]);
    routeEspn({});
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.skipped[reason as keyof typeof summary.skipped]).toBe(1);
    expect(writeCalls()).toHaveLength(0);
  });

  it('never asks about PREMIER_LEAGUE or UFC', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([]);
    routeEspn({});
    await runReturnDetectCycle(NOW);
    const sports = mockCallTool.mock.calls
      .filter(([, t]) => t === 'web_list_threads')
      .map(([, , p]) => (p as { sport: string }).sport);
    expect(sports).toEqual(['NFL', 'NBA']);
  });
});

describe('the too-early bar', () => {
  it('flags the DATE for review instead of closing the thread', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    // An ACL-shaped window against an injury date two days before the first
    // recorded game: the date is wrong, not the athlete superhuman.
    const acl: DetectorThread = {
      ...THREAD,
      injury_date: addWeeksIso(NFL_GAMES[0].date, -0.3),
      otm_projection: { min_weeks: 39, max_weeks: 52 },
    };
    routeMcp([acl]);
    routeEspn({});

    const summary = await runReturnDetectCycle(NOW);
    expect(summary.date_review).toBe(1);
    expect(summary.returned).toBe(0);
    // The thread stays ACTIVE — closing it would freeze a wrong injury_date
    // into an accuracy record.
    expect(mockCallTool.mock.calls.some(([, t]) => t === 'web_thread_close')).toBe(false);
    const flag = mockCallTool.mock.calls.find(([, t]) => t === 'web_thread_update_dates');
    expect((flag![2] as { needs_date_review: boolean }).needs_date_review).toBe(true);
  });

  it('has no bar to apply when the thread carries no projection, and says so', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([{ ...THREAD, otm_projection: null }]);
    routeEspn({});
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.returned).toBe(1);
    expect(summary.unscoreable).toBe(1);
  });
});

describe('calendar censoring (Amendment 1, A1.3)', () => {
  it('sends return_censored=true for an offseason injury back in Week 1, and predicts calendar_censored', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD]);
    routeEspn({});
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.returned).toBe(1);
    expect(summary.censored).toBe(1);
    // 2-6w from 2025-08-01: the floor is 2025-08-15, Week 1 is after it.
    expect(summary.unscoreable).toBe(1);
    const close = mockCallTool.mock.calls.find(([, t]) => t === 'web_thread_close');
    expect((close![2] as { return_censored?: boolean }).return_censored).toBe(true);
  });

  it('sends return_censored=false when the team played a game the athlete missed', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    // Injured the day after Week 1; KC played Week 2 on 2025-09-14. Drop the
    // athlete's Week 2 stat line so his next game is Week 3.
    const body = structuredClone(NFL_BODY) as {
      seasonTypes: Array<{ categories: Array<{ events: Array<{ eventId: string }> }> }>;
    };
    for (const st of body.seasonTypes) {
      for (const c of st.categories) c.events = c.events.filter((e) => e.eventId !== '401772837');
    }
    routeMcp([{ ...THREAD, injury_date: '2025-09-07', otm_projection: { min_weeks: 1, max_weeks: 3 } }]);
    routeEspn({ '3139477': { status: 200, body } });
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.returned).toBe(1);
    expect(summary.censored).toBe(0);
    const close = mockCallTool.mock.calls.find(([, t]) => t === 'web_thread_close');
    expect((close![2] as { return_censored?: boolean; actual_return_date: string }).return_censored).toBe(false);
    expect((close![2] as { actual_return_date: string }).actual_return_date).toBe('2025-09-21'); // 00:20Z Sunday night
  });

  it('leaves the thread ACTIVE when the schedule cannot answer (200, empty)', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD]);
    // A different team-season than the recording: ESPN's empty 200.
    const body = structuredClone(NFL_BODY) as { events: Record<string, { team?: { id: string } }> };
    for (const ev of Object.values(body.events)) if (ev.team) ev.team.id = '999';
    routeEspn({ '3139477': { status: 200, body } });
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.returned).toBe(0);
    expect(summary.skipped.schedule_unavailable).toBe(1);
    expect(summary.aborted).toBe(false);
    expect(writeCalls()).toHaveLength(0);
  });

  it('aborts on a schedule 503 and closes nothing', async () => {
    vi.stubEnv('RETURN_DETECT_MODE', 'on');
    routeMcp([THREAD, { ...THREAD, id: '770e8400-e29b-41d4-a716-446655440003' }]);
    routeEspn({}, { status: 503 });
    const summary = await runReturnDetectCycle(NOW);
    expect(summary.aborted).toBe(true);
    expect(summary.returned).toBe(0);
    expect(writeCalls()).toHaveLength(0);
  });

  it('judges the too-early bar against scored_window, not otm_projection', () => {
    // otm_projection says 0-0 (a later concussion post); the scored window is
    // the first published 20-30w estimate, so a Week 1 return is too early.
    const t: DetectorThread = {
      ...THREAD,
      otm_projection: { min_weeks: 0, max_weeks: 0 },
      scored_window: { post_id: 'p1', min_weeks: 20, max_weeks: 30 },
    };
    expect(decideThread(t, NFL_GAMES).kind).toBe('too_early');
    // No published estimate and a 0-0 display projection: no bar to apply.
    expect(decideThread({ ...t, scored_window: null }, NFL_GAMES).kind).toBe('returned');
  });

  it('falls back to otm_projection for the bar when there is no published estimate (Alfred Collins)', () => {
    // Injured two days before Week 1, a 3-6w display projection, nothing published.
    const t: DetectorThread = {
      ...THREAD,
      injury_date: '2025-09-03',
      otm_projection: { min_weeks: 3, max_weeks: 6 },
      scored_window: null,
    };
    const out = decideThread(t, NFL_GAMES);
    expect(out.kind).toBe('too_early');
    // …and the fallback never makes the close scoreable.
    const game = NFL_GAMES[0];
    expect(predictUnscoreable(t, game, true)).toBe('no_projection');
    expect(predictUnscoreable(t, game, false)).toBe('no_projection');
  });
});

describe('decideThread (pure)', () => {
  it('is strictly after the injury date', () => {
    const out = decideThread({ ...THREAD, injury_date: NFL_GAMES[0].date }, NFL_GAMES);
    expect(out.kind).toBe('returned');
    if (out.kind === 'returned') expect(out.game.date).toBe(NFL_GAMES[1].date);
  });

  it('reaches the same verdict twice — a replay must not drift', () => {
    const a = decideThread(THREAD, NFL_GAMES);
    const b = decideThread(THREAD, NFL_GAMES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reports no_return when the athlete has not played since', () => {
    expect(decideThread({ ...THREAD, injury_date: '2099-01-01' }, NFL_GAMES).kind).toBe('no_return');
  });
});

describe('addWeeksIso', () => {
  it('adds whole and fractional weeks without drifting across a month boundary', () => {
    expect(addWeeksIso('2026-01-01', 4)).toBe('2026-01-29');
    expect(addWeeksIso('2026-01-01', 0.5)).toBe('2026-01-05');
    expect(addWeeksIso('2026-02-27', 1)).toBe('2026-03-06');
  });
});
