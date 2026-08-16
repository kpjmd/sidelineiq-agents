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

/**
 * Refresh whichever tier snapshots have gone stale. Cheap in the common case —
 * each provider does no I/O at all inside its TTL window — and safe to call at
 * the top of every poll cycle.
 *
 * Each provider is independently flagged and independently TTL'd, and neither
 * throws: a failure in one leaves the other's snapshot untouched.
 */
export async function refreshTierSnapshotsIfStale(): Promise<void> {
  await refreshSalarySnapshotIfStale();
  await refreshDerivedTierSnapshotIfStale();
}

/**
 * Drop every TTL so the next refresh actually reads. Called by roster-sync:
 * that cycle is what changes both salaries and club assignments, so waiting out
 * a full 6h window afterwards would leave freshly synced data unused.
 */
export function invalidateTierSnapshots(): void {
  invalidateSalarySnapshot();
  invalidateDerivedTierSnapshot();
}
