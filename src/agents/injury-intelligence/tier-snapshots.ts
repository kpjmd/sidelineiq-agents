// One entry point for every tier snapshot, so a caller cannot refresh some of
// them and silently leave a sport on the flat default.
//
// There were four call sites reaching for refreshSalarySnapshotIfStale
// directly (poller, admin re-score, return-watch, the replay script). Adding a
// second provider to each of them by hand is exactly the kind of change that
// gets three of four right, and the failure is invisible: the missed sport just
// scores every athlete at prominence 40 forever.

import { refreshSalarySnapshotIfStale, invalidateSalarySnapshot } from './salary-snapshot.js';
import {
  refreshDerivedTierSnapshotIfStale,
  invalidateDerivedTierSnapshot,
} from './derived-tier-snapshot.js';
import { refreshDraftSnapshotIfStale } from './draft-snapshot.js';

/**
 * A refresh already running. Concurrent callers await it instead of starting
 * their own — see refreshTierSnapshotsIfStale.
 */
let inFlight: Promise<void> | null = null;

/**
 * Refresh whichever tier snapshots have gone stale. Cheap in the common case —
 * each provider does no I/O at all inside its TTL window — and safe to call at
 * the top of every poll cycle.
 *
 * Each provider is independently flagged and independently TTL'd, and neither
 * throws: a failure in one leaves the other's snapshot untouched.
 *
 * CONCURRENT CALLS ARE COALESCED, and that is not a micro-optimisation.
 * startPolling fires every enabled sport at once (poller.ts — `void
 * runAndReschedule(sport, …)` in a loop, deliberately unawaited so a slow sport
 * cannot delay another), and each sport's cycle calls this. Both providers
 * assign their `lastRefreshedAt` only AFTER their I/O completes, so a plain TTL
 * check is a check-then-act race: every sport that starts before the first
 * refresh finishes sees a stale timestamp and runs a full duplicate fetch.
 *
 * In production that showed up as doubled `[SalarySnapshot]` and
 * `[DerivedTierSnapshot]` lines at boot, ~2ms apart, with NFL and NBA enabled.
 * Harmless — both runs fetch identical data, the index swap is atomic, and a
 * failed run never installs anything so it cannot clobber a success — but it is
 * N times the work for N enabled sports, and PREMIER_LEAGUE and UFC are next.
 *
 * Coalescing lives HERE rather than in each provider because this is the single
 * entry point every caller already uses, so one guard covers both.
 */
export async function refreshTierSnapshotsIfStale(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await refreshSalarySnapshotIfStale();
      await refreshDerivedTierSnapshotIfStale();
      await refreshDraftSnapshotIfStale();
    } finally {
      // Cleared before the awaiting callers resume, so the NEXT cycle is free
      // to refresh again once its TTL genuinely expires.
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Drop every TTL so the next refresh actually reads. Called by roster-sync:
 * that cycle is what changes both salaries and club assignments, so waiting out
 * a full 6h window afterwards would leave freshly synced data unused.
 */
export function invalidateTierSnapshots(): void {
  invalidateSalarySnapshot();
  invalidateDerivedTierSnapshot();
  // The draft snapshot is DELIBERATELY not invalidated here, and the asymmetry
  // is the point: roster sync changes salaries and club assignments, it does
  // not change draft results. Those are immutable once a draft completes, so
  // wiring this in would spend ~180 HTTP calls every 6h re-reading data that
  // changes once a year, against a host that rate-limits. Pinned by a test.
}
