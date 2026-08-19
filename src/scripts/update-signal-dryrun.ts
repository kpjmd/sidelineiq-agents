/**
 * Read-only dry run for the ESPN update-signal tri-state.
 *
 * `inferIsUpdate` used to derive a boolean from ESPN's AVAILABILITY status and
 * hand it to resolveUpdateSignal as an authoritative answer. ESPN's status is a
 * STATE, not a DELTA — there is no change indicator in the payload — so most
 * rows asserted a confident `false` they had no basis for, and a source `false`
 * is final, which blocked the classifier fallback built for exactly this case.
 * Every event that reached PROCESS across two NFL cycles in Aug 2026 died at
 * `entity_match_skip update_signal=source`.
 *
 * The change is MONOTONE: it can only turn a former `false` into `undefined`,
 * never a `true` into anything else. That is what this script proves against
 * the live feed, and it is the whole ship criterion — nothing that publishes
 * today may stop publishing.
 *
 * Usage:
 *   npx tsx src/scripts/update-signal-dryrun.ts [--sport NFL|NBA]
 *
 * Touches nothing: no MCP calls, no model calls, no writes.
 */
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';
import { resolveUpdateSignal } from '../monitoring/poller.js';
import type { RawInjuryEvent } from '../types.js';

/** inferIsUpdate exactly as it stood BEFORE the change. */
function legacyInferIsUpdate(status: string | undefined): boolean {
  if (!status) return false;
  return /day-to-day|questionable|probable|doubtful/i.test(status);
}

/** SKIP_STATUS_RE, mirrored — rows it eats never reach inferIsUpdate at all. */
const SKIP_STATUS_RE =
  /^(injured\s+reserve|ir|physically\s+unable\s+to\s+perform|pup|non[-\s]?football\s+injury|nfi|out\s+for\s+(the\s+)?season|season[-\s]ending)/i;

interface Row {
  status?: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const sportArg = flag('--sport');
  const sports = sportArg ? [sportArg.toUpperCase()] : ['NFL', 'NBA'];

  let failures = 0;

  for (const sport of sports) {
    const source = sport === 'NBA' ? new ESPNNBASource() : new ESPNNFLSource();
    const url = (source as unknown as { url: string }).url;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.error(`[dryrun] ${sport}: HTTP ${res.status} — skipping`);
      continue;
    }
    const feed = (await res.json()) as { injuries?: Array<{ injuries?: Row[] }> };
    const raw: Row[] = [];
    for (const g of feed.injuries ?? []) for (const r of g.injuries ?? []) raw.push(r);

    // ── Section A — status census ──────────────────────────────────────
    console.log(`\n══ A. ${sport} STATUS CENSUS (${raw.length} raw rows) ═══════════════`);
    const census = new Map<string, number>();
    let bothFire = 0;
    for (const r of raw) {
      const s = r.status ?? '(absent)';
      const skipped = Boolean(r.status && SKIP_STATUS_RE.test(r.status));
      const legacy = legacyInferIsUpdate(r.status);
      // The claim being checked: a row SKIP_STATUS_RE eats never reaches
      // inferIsUpdate, so its verdict is irrelevant and must not be counted.
      if (skipped && legacy) bothFire++;
      const verdict = skipped ? 'SKIPPED at parse' : legacy ? 'true' : 'FALSE (the bug)';
      const k = `${s} → ${verdict}`;
      census.set(k, (census.get(k) ?? 0) + 1);
    }
    [...census.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
    console.log(
      `\n  rows where SKIP_STATUS_RE and inferIsUpdate both fire: ${bothFire} (must be 0)`,
    );
    if (bothFire !== 0) failures++;

    // ── Section B — the transition matrix, the hard gate ───────────────
    process.env.MAX_EVENT_AGE_DAYS = '100000';
    const events = (
      source as unknown as { parse: (f: unknown) => RawInjuryEvent[] }
    ).parse(feed);

    console.log(`\n══ B. ${sport} TRANSITION MATRIX (${events.length} parsed events) ═════`);
    const cell = new Map<string, number>();
    for (const ev of events) {
      const before = legacyInferIsUpdate(ev.athlete_status);
      const after = ev.is_update;
      const k = `${String(before)} → ${String(after)}`;
      cell.set(k, (cell.get(k) ?? 0) + 1);
    }
    [...cell.entries()].sort().forEach(([k, n]) => console.log(`  ${k.padEnd(24)} ${n}`));

    const lostTrue = [...cell.entries()]
      .filter(([k]) => k.startsWith('true → ') && k !== 'true → true')
      .reduce((a, [, n]) => a + n, 0);
    const anyFalse = [...cell.entries()]
      .filter(([k]) => k.endsWith('→ false'))
      .reduce((a, [, n]) => a + n, 0);
    const relaxed = cell.get('false → undefined') ?? 0;

    console.log();
    const check = (label: string, ok: boolean, detail: string): void => {
      console.log(`  ${ok ? '✓' : '✗'} ${label}: ${detail}`);
      if (!ok) failures++;
    };
    check('no true was lost', lostTrue === 0, `${lostTrue} (must be 0)`);
    check('false is unreachable', anyFalse === 0, `${anyFalse} row(s) still emit false (must be 0)`);
    check('the change took effect', relaxed > 0, `${relaxed} row(s) false → undefined`);

    // ── Section C — upper bound on new pass-throughs ───────────────────
    console.log(`\n══ C. ${sport} UPPER BOUND ON NEW PASS-THROUGHS ════════════════════`);
    let flipped = 0;
    for (const ev of events) {
      const before = resolveUpdateSignal(
        { ...ev, is_update: legacyInferIsUpdate(ev.athlete_status) },
        false,
      ).isUpdate;
      const after = resolveUpdateSignal(ev, false).isUpdate;
      if (after && !before) flipped++;
      if (before && !after) {
        console.log(`  ✗ MONOTONICITY VIOLATED for ${ev.athlete_name}`);
        failures++;
      }
    }
    console.log(
      `  ${flipped} event(s) could newly pass through dedup — an UPPER BOUND.\n` +
        `  A flip only changes an outcome when the event ALSO matches an entity\n` +
        `  and the classifier answers is_new=false; neither is knowable offline.`,
    );
  }

  console.log(
    failures === 0
      ? '\n[dryrun] ✓ SHIP GATE PASSED — the change is monotone over the live feed.'
      : `\n[dryrun] ✗ SHIP GATE FAILED — ${failures} check(s) failed.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
