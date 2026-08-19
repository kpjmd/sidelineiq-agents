import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  refreshDraftSnapshot,
  refreshDraftSnapshotIfStale,
  draftTiersEnabled,
  _resetDraftSnapshotTimerForTesting,
} from '../src/agents/injury-intelligence/draft-snapshot.js';
import {
  tierFromDraft,
  lookupAthleteTier,
  _setConfigForTesting,
  _setTiersForTesting,
  _setDraftSnapshotForTesting,
  _setSalarySnapshotForTesting,
} from '../src/agents/injury-intelligence/significance.js';

const FIX = (n: string) =>
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf-8'));

// Recorded verbatim from ESPN on 2026-08-19.
const ROUNDS_2025 = FIX('espn-nfl-draft-rounds-2025.json');
const ROUNDS_EMPTY = FIX('espn-nfl-draft-rounds-2027-empty.json');
const ATHLETE = FIX('espn-nfl-draft-athlete-107910.json');

const CONFIG = {
  draft_tiers: { bands: { NFL: { tier_2_max_overall: 32, max_seasons_since_draft: 1 } } },
} as never;

/** Route round-list URLs to a payload and every ref to a namer. */
function mockFetch(opts: {
  rounds?: (year: number) => unknown;
  ref?: (url: string, n: number) => { status?: number; body?: unknown; throws?: boolean };
}) {
  let refCount = 0;
  let inFlight = 0;
  let peak = 0;
  const fn = vi.fn(async (url: string) => {
    if (url.includes('/draft/rounds')) {
      const year = Number(url.match(/seasons\/(\d+)/)?.[1] ?? 0);
      const body = opts.rounds ? opts.rounds(year) : ROUNDS_EMPTY;
      return { ok: true, status: 200, json: async () => body } as never;
    }
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const n = ++refCount;
    const r = opts.ref ? opts.ref(url, n) : { body: ATHLETE };
    if (r.throws) throw new Error('socket hang up');
    if (r.status && r.status !== 200) {
      return { ok: false, status: r.status, json: async () => ({}) } as never;
    }
    return { ok: true, status: 200, json: async () => r.body ?? ATHLETE } as never;
  });
  vi.stubGlobal('fetch', fn);
  return { fn, peak: () => peak, refCount: () => refCount };
}

describe('draft snapshot loader', () => {
  const prevFlag = process.env.DRAFT_TIER_ENABLED;
  beforeEach(() => {
    _setConfigForTesting(CONFIG);
    _setTiersForTesting({ athletes: [] } as never);
    _setSalarySnapshotForTesting(null);
    _setDraftSnapshotForTesting(null);
    _resetDraftSnapshotTimerForTesting();
    process.env.DRAFT_TIER_ENABLED = 'true';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _setConfigForTesting(null);
    _setTiersForTesting(null);
    _setDraftSnapshotForTesting(null);
    if (prevFlag === undefined) delete process.env.DRAFT_TIER_ENABLED;
    else process.env.DRAFT_TIER_ENABLED = prevFlag;
  });

  it('indexes picks and promotes the athletes it resolved', async () => {
    // Distinct names per pick: a repeated name is genuinely ambiguous and the
    // uniqueness guard is right to refuse it.
    let i = 0;
    mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
      ref: () => ({ body: { ...ATHLETE, fullName: i++ === 0 ? 'Cam Ward' : `Pick ${i}` } }),
    });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(true);
    expect(lookupAthleteTier('Cam Ward', 'NFL')).toEqual({ tier: 2, source: 'draft' });
  });

  it('never spends a ref call on a pick past the ceiling', async () => {
    // The fixture holds rounds 1 AND 2 (64 picks); the band ceiling is 32.
    const m = mockFetch({ rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY) });
    await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'));
    expect(m.refCount()).toBe(32);
  });

  it('treats a class year that has not happened as empty, not as a failure', async () => {
    // Verified live: 2027 answers HTTP 200 with items: []. "Not held yet" and
    // "read failed" must not look alike.
    const m = mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
    });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(true);
    expect(m.refCount()).toBeGreaterThan(0);
  });

  it('bounds concurrency so the endpoint is not stampeded', async () => {
    const m = mockFetch({ rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY) });
    await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'));
    expect(m.peak()).toBeLessThanOrEqual(5);
  });

  it('ABORTS on a transient ref failure rather than installing a partial index', async () => {
    // The rate-limit case. A dropped block of refs must never look like "these
    // picks have no athlete" — that would silently demote exactly the athletes
    // this exists to promote.
    _setDraftSnapshotForTesting([
      { full_name: 'Incumbent', sport: 'NFL', draft: { year: 2026, round: 1, overall: 1 } },
    ] as never);
    mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
      ref: (_u, n) => (n > 20 ? { throws: true } : { body: ATHLETE }),
    });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(false);
    // The incumbent survives untouched.
    expect(lookupAthleteTier('Incumbent', 'NFL')).toEqual({ tier: 2, source: 'draft' });
  });

  it('retries a transient ref once before giving up', async () => {
    let failed = false;
    const m = mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
      ref: () => {
        if (!failed) {
          failed = true;
          return { throws: true };
        }
        return { body: ATHLETE };
      },
    });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(true);
    expect(m.refCount()).toBe(33); // 32 picks + the one retry
  });

  it('skips a 404 ref as a bad ROW and still succeeds', async () => {
    // A forfeited or voided pick is bounded and known.
    mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
      ref: (_u, n) => (n === 3 ? { status: 404 } : { body: ATHLETE }),
    });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(true);
  });

  it('aborts when too many refs 404 — a decimated index is not a good one', async () => {
    _setDraftSnapshotForTesting(null);
    mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
      ref: (_u, n) => (n % 2 === 0 ? { status: 404 } : { body: ATHLETE }),
    });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(false);
  });

  it('aborts when a round-list call fails', async () => {
    _setDraftSnapshotForTesting(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as never),
    );
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(false);
    expect(tierFromDraft({ year: 2026, round: 1, overall: 1 }, 'NFL')).toBeNull();
  });

  it('aborts when every class year comes back empty — absence is not evidence', async () => {
    _setDraftSnapshotForTesting(null);
    mockFetch({ rounds: () => ROUNDS_EMPTY });
    expect(await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'))).toBe(false);
  });

  it('does no I/O at all until the flag is set', async () => {
    delete process.env.DRAFT_TIER_ENABLED;
    expect(draftTiersEnabled()).toBe(false);
    const m = mockFetch({ rounds: () => ROUNDS_2025 });
    await refreshDraftSnapshotIfStale(new Date('2026-08-19T00:00:00Z'));
    expect(m.fn).not.toHaveBeenCalled();
  });

  it('refreshes once, then no-ops inside the TTL', async () => {
    const m = mockFetch({ rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY) });
    await refreshDraftSnapshotIfStale(new Date('2026-08-19T00:00:00Z'));
    const after = m.fn.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    await refreshDraftSnapshotIfStale(new Date('2026-08-19T00:00:00Z'));
    expect(m.fn.mock.calls.length).toBe(after);
  });

  it('anchors the recency window on the newest class it actually saw', async () => {
    let i = 0;
    mockFetch({
      rounds: (y) => (y === 2026 ? ROUNDS_2025 : ROUNDS_EMPTY),
      ref: () => ({ body: { ...ATHLETE, fullName: `Pick ${++i}` } }),
    });
    await refreshDraftSnapshot(new Date('2026-08-19T00:00:00Z'));
    // The fixture is one class; with max_seasons_since_draft 1 it stays live.
    expect(lookupAthleteTier('Pick 1', 'NFL').source).toBe('draft');
  });
});
