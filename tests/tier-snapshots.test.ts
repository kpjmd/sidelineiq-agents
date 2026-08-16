/**
 * The shared tier-snapshot entry point.
 *
 * startPolling fires every enabled sport at once, and each sport's cycle calls
 * refreshTierSnapshotsIfStale. Both providers set their TTL timestamp only after
 * their I/O completes, so without coalescing every sport that starts before the
 * first refresh finishes runs a full duplicate fetch — observed in production as
 * doubled [SalarySnapshot] / [DerivedTierSnapshot] lines ~2ms apart at boot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agents/injury-intelligence/salary-snapshot.js', () => ({
  refreshSalarySnapshotIfStale: vi.fn(),
  invalidateSalarySnapshot: vi.fn(),
}));
vi.mock('../src/agents/injury-intelligence/derived-tier-snapshot.js', () => ({
  refreshDerivedTierSnapshotIfStale: vi.fn(),
  invalidateDerivedTierSnapshot: vi.fn(),
}));

import { refreshSalarySnapshotIfStale, invalidateSalarySnapshot } from '../src/agents/injury-intelligence/salary-snapshot.js';
import {
  refreshDerivedTierSnapshotIfStale,
  invalidateDerivedTierSnapshot,
} from '../src/agents/injury-intelligence/derived-tier-snapshot.js';
import {
  refreshTierSnapshotsIfStale,
  invalidateTierSnapshots,
} from '../src/agents/injury-intelligence/tier-snapshots.js';

const mockSalary = vi.mocked(refreshSalarySnapshotIfStale);
const mockDerived = vi.mocked(refreshDerivedTierSnapshotIfStale);

/** A refresh that stays pending until released, like a real paged read. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSalary.mockResolvedValue(undefined);
  mockDerived.mockResolvedValue(undefined);
});

describe('refreshTierSnapshotsIfStale', () => {
  it('refreshes both providers', async () => {
    await refreshTierSnapshotsIfStale();
    expect(mockSalary).toHaveBeenCalledTimes(1);
    expect(mockDerived).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers into ONE refresh', async () => {
    // Four sports starting their cycles simultaneously, exactly as
    // startPolling does at boot.
    const gate = deferred();
    mockSalary.mockReturnValue(gate.promise);

    const cycles = [
      refreshTierSnapshotsIfStale(),
      refreshTierSnapshotsIfStale(),
      refreshTierSnapshotsIfStale(),
      refreshTierSnapshotsIfStale(),
    ];
    gate.resolve();
    await Promise.all(cycles);

    expect(mockSalary).toHaveBeenCalledTimes(1);
    expect(mockDerived).toHaveBeenCalledTimes(1);
  });

  it('every concurrent caller waits for the refresh to finish', async () => {
    // A caller that returned early would score its first events against a
    // snapshot that had not loaded yet — every athlete at the tier-3 default.
    const gate = deferred();
    let settled = false;
    mockDerived.mockReturnValue(gate.promise.then(() => { settled = true; }));

    const first = refreshTierSnapshotsIfStale();
    const second = refreshTierSnapshotsIfStale();
    gate.resolve();
    await Promise.all([first, second]);

    expect(settled).toBe(true);
  });

  it('allows a fresh refresh once the previous one has finished', async () => {
    await refreshTierSnapshotsIfStale();
    await refreshTierSnapshotsIfStale();
    expect(mockSalary).toHaveBeenCalledTimes(2);
  });

  it('does not wedge when a provider rejects', async () => {
    // Neither provider is supposed to throw, but a permanently-stuck in-flight
    // promise would silently freeze every future refresh for the process's life.
    mockSalary.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshTierSnapshotsIfStale()).rejects.toThrow('boom');

    mockSalary.mockResolvedValue(undefined);
    await refreshTierSnapshotsIfStale();
    expect(mockSalary).toHaveBeenCalledTimes(2);
    expect(mockDerived).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateTierSnapshots', () => {
  it('invalidates both providers', () => {
    invalidateTierSnapshots();
    expect(vi.mocked(invalidateSalarySnapshot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invalidateDerivedTierSnapshot)).toHaveBeenCalledTimes(1);
  });
});
