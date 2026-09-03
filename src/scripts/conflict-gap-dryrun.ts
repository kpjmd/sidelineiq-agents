/**
 * Read-only ship gate for the CONFLICT_FLAG anchor fix.
 *
 * `team_timeline_weeks` is weeks REMAINING from the report; `min_weeks`/
 * `max_weeks` are TOTAL from `injury_date`. Six sites subtracted one from the
 * other, so every gap carried an error exactly equal to the elapsed time since
 * injury: zero on breaking news, fifty weeks on Nick Bosa. The repo convention
 * is to diff old against new over the LIVE corpus before shipping, with the
 * numbers that must be zero stated up front — unit tests have missed the real
 * failure mode here repeatedly.
 *
 * THE NUMBERS THAT MUST BE ZERO (this script exits 1 on any of them):
 *   1. Fresh injuries (elapsed < 2w) whose verdict changes because of the
 *      anchor. That is the population the old code got right by accident, and
 *      the fix must be inert there. Measured by re-scoring each row with
 *      elapsed forced to 0 and comparing.
 *   2. Rows flipping no-conflict → conflict. The fix removes manufactured
 *      conflicts; it must not manufacture new ones. A CONFLICT_FLAG bypasses
 *      the significance gate entirely (always_process), so a manufactured
 *      conflict is a manufactured PUBLISH.
 *   3. Conflict verdicts returned with no usable anchor. No anchor, no verdict.
 *
 * Reported but NOT gates:
 *   - Rows flipping conflict → no-conflict. Expected; Bosa is the flagship.
 *   - Anchor-ambiguity hits: rows whose stored number is as plausible a TOTAL
 *     as a REMAINING count. These are the rows needing hand correction.
 *   - Display-only delta changes on fresh rows (|team − max| → distance
 *     outside the window). The old display formula never matched the detector
 *     that fired the flag, so these change on every row by design.
 *
 * Usage:
 *   npx tsx src/scripts/conflict-gap-dryrun.ts
 *   npx tsx src/scripts/conflict-gap-dryrun.ts --emit-fixture > cases.json
 *
 * Reads through listAllPosts — never an unpaged web_list_posts, which returns
 * 20 rows and would answer a whole-corpus question from the newest page.
 * Writes nothing, publishes nothing, makes no model calls.
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import {
  computeConflictGap,
  isConflict,
  CONFLICT_GAP_HELPER_VERSION,
  type ConflictGap,
} from '../utils/conflict-gap.js';
import { assessTimelineAnchorAmbiguity } from '../agents/injury-intelligence/agent.js';
import type { ReturnToPlayEstimate } from '../types.js';

interface Row {
  id: string;
  athlete_name: string;
  sport: string;
  status: string;
  content_type: string;
  conflict_reason: string | null;
  team_timeline_weeks: number | null;
  return_to_play_min_weeks: number | null;
  return_to_play_max_weeks: number | null;
  injury_date: string | null;
  created_at: string;
  farcaster_hash: string | null;
  twitter_id: string | null;
}

/**
 * The PRE-FIX detector, inlined verbatim from agent.ts so old-vs-new is a real
 * diff and not new-vs-itself. Midpoint rule, 2-week bar, no anchor anywhere.
 */
function legacyDetectConflict(teamTimelineWeeks: number | null, min: number, max: number): boolean {
  if (teamTimelineWeeks === null) return false;
  if (teamTimelineWeeks === 0 && min >= 4) return false;
  const otmMid = (min + max) / 2;
  return Math.abs(teamTimelineWeeks - otmMid) > 2;
}

/** The PRE-FIX display delta, inlined verbatim from content-formatter.ts. */
function legacyDisplayDelta(teamTimelineWeeks: number | null, max: number): number | null {
  return teamTimelineWeeks == null ? null : Math.abs(teamTimelineWeeks - max);
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

const failures: string[] = [];
function mustBeZero(label: string, count: number, examples: string[] = []): void {
  const ok = count === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${count}`);
}

interface Scored {
  row: Row;
  team: number | null;
  min: number | null;
  max: number | null;
  oldConflict: boolean;
  oldDelta: number | null;
  gap: ConflictGap;
  newConflict: boolean;
  /** The same row re-scored with elapsed forced to 0 — the fresh-injury control. */
  freshConflict: boolean;
  ambiguous: boolean;
}

function score(row: Row): Scored {
  const team = num(row.team_timeline_weeks);
  const min = num(row.return_to_play_min_weeks);
  const max = num(row.return_to_play_max_weeks);
  const gap = computeConflictGap({
    team_timeline_weeks: team,
    min_weeks: min,
    max_weeks: max,
    injury_date: row.injury_date,
    // The disclosure was remaining-weeks as of when the post was written,
    // never as of today.
    as_of: row.created_at,
  });
  const freshGap = computeConflictGap({
    team_timeline_weeks: team,
    min_weeks: min,
    max_weeks: max,
    injury_date: row.created_at,
    as_of: row.created_at,
  });
  const rtp = { min_weeks: min ?? 0, max_weeks: max ?? 0 } as ReturnToPlayEstimate;
  const ambiguity =
    team !== null && min !== null && max !== null
      ? assessTimelineAnchorAmbiguity(team, rtp, {
          injury_date: row.injury_date,
          now: new Date(row.created_at),
        })
      : null;
  return {
    row,
    team,
    min,
    max,
    oldConflict: min !== null && max !== null && legacyDetectConflict(team, min, max),
    oldDelta: max === null ? null : legacyDisplayDelta(team, max),
    gap,
    newConflict: isConflict(gap),
    freshConflict: isConflict(freshGap),
    ambiguous: ambiguity?.ambiguous ?? false,
  };
}

function line(s: Scored): string {
  const g = s.gap;
  const social = s.row.farcaster_hash || s.row.twitter_id ? ' [SOCIAL]' : '';
  return (
    `${s.row.id.slice(0, 8)} ${s.row.status.padEnd(14)} ${s.row.athlete_name.padEnd(20)} ` +
    `inj=${s.row.injury_date?.slice(0, 10) ?? 'none'} elapsed=${g.elapsed_weeks ?? '?'}w ` +
    `team=${s.team ?? '-'}w otm=${s.min ?? '?'}-${s.max ?? '?'}w ` +
    `oldΔ=${s.oldDelta ?? '-'} new=${g.status}${g.gap_weeks === 0 ? '' : `/${g.gap_weeks}`}` +
    `${s.ambiguous ? ' AMBIGUOUS' : ''}${social}`
  );
}

async function main(): Promise<void> {
  const emitFixture = process.argv.includes('--emit-fixture');
  if (!emitFixture) {
    console.log('═══ CONFLICT_FLAG gap anchor — read-only ship gate ═══');
    console.log(`  helper version ${CONFLICT_GAP_HELPER_VERSION}\n`);
  }

  await initializeMCPClients();
  try {
    const { posts, truncated } = await listAllPosts<Row>({ content_type: 'CONFLICT_FLAG' });
    if (truncated) {
      console.error('[dryrun] FAIL: the post scan was truncated — results are not conclusive.');
      process.exitCode = 1;
      return;
    }
    const scored = posts.map(score);

    if (emitFixture) {
      // Only rows with a real anchor and disclosure make useful fixture cases —
      // the rest are covered by the synthetic boundary cases.
      const cases = scored
        .filter((s) => s.team !== null && s.min !== null && s.max !== null)
        .map((s) => ({
          id: `live-${s.row.id.slice(0, 8)}`,
          source: 'live',
          note: `${s.row.athlete_name} (${s.row.status})`,
          input: {
            team_timeline_weeks: s.team,
            min_weeks: s.min,
            max_weeks: s.max,
            injury_date: s.row.injury_date ? s.row.injury_date.slice(0, 10) : null,
            as_of: s.row.created_at,
          },
          expected: {
            status: s.gap.status,
            elapsed_weeks: s.gap.elapsed_weeks,
            team_total_weeks: s.gap.team_total_weeks,
            gap_weeks: s.gap.gap_weeks,
            is_conflict: s.newConflict,
          },
        }));
      console.log(
        JSON.stringify(
          {
            helper_version: CONFLICT_GAP_HELPER_VERSION,
            _recorded_from: 'web_list_posts {content_type:CONFLICT_FLAG} against the live production DB',
            _recorded_at: new Date().toISOString().slice(0, 10),
            cases,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`══ A. Corpus ═══════════════════════════════════════════`);
    const byStatus = new Map<string, number>();
    for (const p of posts) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
    console.log(`  ${posts.length} CONFLICT_FLAG posts`);
    for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}: ${v}`);
    }
    const anchored = scored.filter((s) => s.gap.elapsed_weeks !== null);
    console.log(`  with a usable injury_date anchor: ${anchored.length}`);
    console.log(`  with no team disclosure: ${scored.filter((s) => s.team === null).length}`);

    console.log(`\n══ B. Verdict transition matrix ════════════════════════`);
    const cell = new Map<string, Scored[]>();
    for (const s of scored) {
      const k = `${s.oldConflict ? 'conflict' : 'no-conflict'} → ${s.newConflict ? 'conflict' : 'no-conflict'} (${s.gap.status})`;
      cell.set(k, [...(cell.get(k) ?? []), s]);
    }
    for (const [k, rows] of [...cell.entries()].sort()) {
      console.log(`  ${k.padEnd(46)} ${rows.length}`);
      for (const s of rows) console.log(`      ${line(s)}`);
    }

    console.log(`\n══ C. The numbers that must be zero ════════════════════`);
    // ANCHORED rows only. A row with no injury_date has null elapsed, and its
    // verdict changes because of the no-anchor rule, not because of the
    // arithmetic — counting those here would hide the check it is meant to be.
    const freshDiverged = scored.filter(
      (s) =>
        s.gap.elapsed_weeks !== null &&
        s.gap.elapsed_weeks < 2 &&
        s.newConflict !== s.freshConflict,
    );
    mustBeZero(
      'anchored fresh injuries (elapsed < 2w) whose verdict moved with the anchor',
      freshDiverged.length,
      freshDiverged.map(line),
    );
    const manufactured = scored.filter((s) => !s.oldConflict && s.newConflict);
    mustBeZero(
      'rows flipping no-conflict → conflict',
      manufactured.length,
      manufactured.map(line),
    );
    const verdictWithoutAnchor = scored.filter((s) => s.newConflict && s.gap.status === 'no_anchor');
    mustBeZero(
      'conflict verdicts with no usable anchor',
      verdictWithoutAnchor.length,
      verdictWithoutAnchor.map(line),
    );

    console.log(`\n══ D. Expected changes (reported, not gated) ═══════════`);
    const cleared = scored.filter((s) => s.oldConflict && !s.newConflict);
    const clearedNoAnchor = cleared.filter((s) => s.gap.status === 'no_anchor');
    const clearedAnchored = cleared.filter((s) => s.gap.status !== 'no_anchor');
    console.log(`  conflict → no-conflict: ${cleared.length}`);
    console.log(
      `    of which ${clearedNoAnchor.length} carry NO injury_date at all — they asserted a` +
        ' conflict without knowing when the injury happened, and now say so:',
    );
    for (const s of clearedNoAnchor) console.log(`      ${line(s)}`);
    console.log(`    and ${clearedAnchored.length} are anchored re-scores:`);
    for (const s of clearedAnchored) console.log(`      ${line(s)}`);
    const ambiguous = scored.filter((s) => s.ambiguous);
    console.log(`\n  anchor-ambiguous (stored number may be a TOTAL — hand correction): ${ambiguous.length}`);
    for (const s of ambiguous) console.log(`      ${line(s)}`);
    const social = scored.filter(
      (s) => (s.row.farcaster_hash || s.row.twitter_id) && s.oldDelta !== null,
    );
    const socialChanged = social.filter(
      (s) => s.gap.status !== 'no_anchor' && Math.abs(s.gap.gap_weeks) !== s.oldDelta,
    );
    console.log(
      `\n  PUBLISHED to social whose delta the old formula got wrong: ${socialChanged.length}`,
    );
    for (const s of socialChanged) {
      console.log(
        `      ${s.row.id.slice(0, 8)} ${s.row.athlete_name} — cast said ${s.oldDelta}+w, ` +
          `real ${Math.abs(s.gap.gap_weeks)}w ${s.gap.status} — fc=${s.row.farcaster_hash ?? '-'} tw=${s.row.twitter_id ?? '-'}`,
      );
    }

    console.log(`\n═══ Verdict ═══`);
    if (failures.length === 0) {
      console.log('  SHIP GATE PASSED — all must-be-zero checks passed.');
    } else {
      for (const f of failures) console.log(`  FAILED: ${f}`);
      process.exitCode = 1;
    }
  } finally {
    await disconnectAll().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
