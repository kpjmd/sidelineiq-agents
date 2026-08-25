/**
 * Read-only dry run for the supersede-pending change.
 *
 *   A — SAFETY, the ship gate. Run findSupersededPending over every live
 *       PENDING_REVIEW row against the PUBLISHED posts on its thread. Rows it
 *       selects whose status is not PENDING_REVIEW  MUST BE 0. Retiring a queue
 *       item is a write against the MD's work; selecting anything an audience
 *       has seen is the failure this gate exists to catch. (The mcp tool guards
 *       on the same predicate, so this is defence in depth, not the only
 *       barrier — but a mismatch here means the agent-side predicate is wrong
 *       and would be firing on rows it should not.)
 *
 *   B — HISTORICAL UPPER BOUND, explicitly not a gate. Replay each PUBLISHED
 *       post against the posts that existed before it, and count how many had
 *       an equivalent sibling that would have been retired. It is an UPPER
 *       BOUND and cannot be tightened: a row that was PENDING_REVIEW at time T
 *       and later approved now reads PUBLISHED, and nothing in the stored row
 *       distinguishes the two. Reported so the change is not mistaken for
 *       inert, not as evidence of how many rows it will retire.
 *
 *   C — FIXTURE RECORDER. Dumps any live candidate in fixture shape. The
 *       flagship case (Kamara c59cba69) was hard-deleted on rejection before
 *       migration 021, so tests/fixtures/kamara-supersede-pair.json currently
 *       reconstructs it; the first real occurrence should replace that.
 *
 * Usage:
 *   npx tsx src/scripts/supersede-pending-dryrun.ts [--emit-fixture out.json]
 */
import { writeFileSync } from 'node:fs';
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { findSupersededPending, type ExistingPost } from '../utils/publishing-pipeline.js';
import type { InjuryPostContent, InjurySeverity, ContentType } from '../types.js';

interface Row extends ExistingPost {
  injury_type?: string;
  team?: string;
}

function asContent(row: Row): InjuryPostContent {
  return {
    athlete_name: row.athlete_name ?? '',
    sport: row.sport ?? '',
    team: row.team ?? '',
    injury_type: row.injury_type ?? '',
    injury_severity: (row.injury_severity ?? 'UNKNOWN') as InjurySeverity,
    content_type: (row.content_type ?? 'BREAKING') as ContentType,
    headline: '',
    clinical_summary: '',
    return_to_play: {
      min_weeks: 0,
      max_weeks: 0,
      probability_week_2: 0,
      probability_week_4: 0,
      probability_week_8: 0,
      confidence: 0,
    },
    confidence: 1,
    ...(row.parent_post_id ? { parent_post_id: row.parent_post_id } : {}),
    ...(row.team_timeline_weeks !== undefined && row.team_timeline_weeks !== null
      ? { team_timeline_weeks: Number(row.team_timeline_weeks) }
      : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flagIndex = argv.indexOf('--emit-fixture');
  const fixturePath = flagIndex >= 0 ? (argv[flagIndex + 1] ?? null) : null;

  await initializeMCPClients();
  let failures = 0;
  try {
    const { posts, truncated } = await listAllPosts<Row>({});
    if (truncated) {
      console.error('[dryrun] FAIL: the post scan was truncated — results are not conclusive.');
      process.exitCode = 1;
      return;
    }
    const pending = posts.filter((p) => p.status === 'PENDING_REVIEW');
    console.log(`[dryrun] corpus: ${posts.length} posts, ${pending.length} PENDING_REVIEW\n`);

    // ── A. Safety ────────────────────────────────────────────────────────
    const candidates: Array<{ publisher: Row; retired: ExistingPost[] }> = [];
    let unsafe = 0;
    for (const publisher of posts.filter((p) => p.status === 'PUBLISHED')) {
      const selected = findSupersededPending(asContent(publisher), posts, publisher.id);
      if (selected.length === 0) continue;
      candidates.push({ publisher, retired: selected });
      for (const row of selected) {
        if (row.status !== 'PENDING_REVIEW') {
          unsafe++;
          console.error(`  UNSAFE: ${publisher.id} would retire ${row.id} (status ${row.status})`);
        } else {
          console.log(
            `  candidate: ${publisher.id} (${publisher.athlete_name} ${publisher.content_type}) ` +
              `would retire pending ${row.id}`,
          );
        }
      }
    }
    console.log(
      `[dryrun] A: rows selected whose status is not PENDING_REVIEW = ${unsafe} (must be 0); ` +
        `${candidates.length} live candidate(s)`,
    );
    if (unsafe > 0) failures++;

    // ── B. Historical upper bound ────────────────────────────────────────
    let reach = 0;
    for (const publisher of posts) {
      const at = publisher.created_at ? new Date(publisher.created_at).getTime() : NaN;
      if (!Number.isFinite(at)) continue;
      const priorAsPending: Row[] = posts
        .filter((p) => {
          if (p.id === publisher.id || !p.created_at) return false;
          return new Date(p.created_at).getTime() < at;
        })
        .map((p) => ({ ...p, status: 'PENDING_REVIEW' }));
      reach += findSupersededPending(asContent(publisher), priorAsPending, publisher.id).length;
    }
    // A bare 0 here would be unreadable: it could mean "this never happens",
    // "the evidence was destroyed", or "the predicate is too tight". Report the
    // denominator — same-thread, same-content_type pairs of ANY status — and
    // the first field that separates each one, so the reading is not a guess.
    const threaded = posts.filter((p) => p.parent_post_id);
    const pairs: Array<[Row, Row]> = [];
    for (const p of threaded) {
      for (const q of posts) {
        if (q.id === p.id || q.content_type !== p.content_type) continue;
        if (q.id !== p.parent_post_id && q.parent_post_id !== p.parent_post_id) continue;
        if (!pairs.some(([a, b]) => a.id === q.id && b.id === p.id)) pairs.push([p, q]);
      }
    }
    console.log(
      `[dryrun] B: historical reach (UPPER BOUND, not a gate) = ${reach} sibling(s) across ` +
        `${posts.length} posts; ${threaded.length} threaded, ${pairs.length} same-thread ` +
        `same-content_type pair(s) of any status.`,
    );
    const dw = (v: unknown) => {
      const n = Number(v);
      return v === null || v === undefined || v === '' || !Number.isFinite(n) || n <= 0 ? null : n;
    };
    for (const [a, b] of pairs) {
      const why =
        a.injury_severity !== b.injury_severity
          ? `severity ${a.injury_severity} vs ${b.injury_severity}`
          : dw(a.team_timeline_weeks) !== dw(b.team_timeline_weeks)
            ? `disclosed weeks ${dw(a.team_timeline_weeks)} vs ${dw(b.team_timeline_weeks)}`
            : 'nothing — these ask the same question';
      console.log(`[dryrun]    pair ${a.id} / ${b.id} (${a.athlete_name}): separated by ${why}`);
    }
    console.log(
      '[dryrun]    Every pair separated by a real material change means the predicate is ' +
        'working, not too tight. A pair separated by "nothing" that was NOT counted in the ' +
        'reach above would mean it is. Note also that the flagship case (Kamara c59cba69) is ' +
        'absent entirely: it was hard-DELETED on rejection, which is what Item 1 stops.',
    );

    // ── C. Fixture recorder ──────────────────────────────────────────────
    if (fixturePath) {
      if (candidates.length === 0) {
        console.log('[dryrun] C: no live candidate to record — fixture not written.');
      } else {
        writeFileSync(
          fixturePath,
          JSON.stringify(
            {
              _recorded_from: 'listAllPosts against the live production DB, via supersede-pending-dryrun',
              _note:
                'A real supersede candidate: the publisher and the pending sibling(s) it ' +
                'would retire, verbatim. Replaces the reconstructed Kamara pair.',
              candidates,
            },
            null,
            2,
          ) + '\n',
        );
        console.log(`[dryrun] C: wrote ${candidates.length} candidate(s) to ${fixturePath}`);
      }
    }

    console.log(`\n[dryrun] ${failures === 0 ? 'PASS' : `FAIL: ${failures} section(s)`}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
