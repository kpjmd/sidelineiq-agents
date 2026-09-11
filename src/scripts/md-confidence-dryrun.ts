/**
 * md-confidence dry run — scores the md_review_confidence column old-vs-new
 * over the LIVE corpus.
 *
 * WHY. md_review_confidence was NULL on 183 of 472 PUBLISHED rows, and the
 * partition was perfect: every NULL sat on the auto-publish path, and no row
 * with md_review_required=true lacked a value. The column recorded "the gate
 * fired", not "a confidence was emitted". formatForWeb sent the number as a
 * flat `confidence` key, web_create_injury_post's zod object never declared it,
 * and z.object strips unknown keys and returns success.
 *
 * The fix is insert-only and changes nothing that is already stored, so almost
 * every gate here is a proof that NOTHING MOVED rather than a measurement of an
 * improvement. That is the honest shape of it: there are no readers of this
 * column outside post-content.ts, so what is being defended is the audit trail,
 * not a rendered number.
 *
 * MUST RUN INSIDE RAILWAY when WEB_MCP_URL is a *.railway.internal address:
 *   railway ssh -s sidelineiq-agents
 *   npx tsx src/scripts/md-confidence-dryrun.ts
 * (or export WEB_MCP_URL to the public https endpoint and run it anywhere).
 *
 *   --since <ISO>        score the acceptance window too (sections C, D2, F)
 *   --compare <manifest> diff against an earlier run's manifest (section G)
 *   --manifest <path>    where to write this run's manifest (always written)
 *   --baseline-from <ISO> floor of section F's comparison window
 *                        (default CONFIDENCE_RUBRIC_SINCE, PR #30's merge)
 *   --limit <n>          smoke test against the newest n rows
 *
 * The numbers that must be zero:
 *   A   rows whose reconstructed RTP confidence changes under the new chain
 *   A   rows with a NULL or non-finite rtp_confidence (what makes A non-vacuous)
 *   B   rows with md_review_required=true and a NULL md_review_confidence
 *   C   in-window PUBLISHED + not-required + NULL — with a NON-ZERO denominator
 *   D   flagged rows whose md_review_reason percentage contradicts the column
 *   E   in-window not-required rows whose status is not PUBLISHED
 *   G   stored values that changed, or went non-null -> null, since a prior run
 */
import 'dotenv/config';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeMCPClients, disconnectAll, isServerAvailable } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { reconstructPostContent, type StoredPostRow } from '../utils/post-content.js';

interface PostRow extends StoredPostRow {
  id: string;
  status: string | null;
  md_review_required: boolean | null;
  md_review_reason: string | null;
  created_at: string;
}

// ── Reporting scaffold (same shape as date-resolution-dryrun) ─────────
const failures: string[] = [];
function mustBeZero(label: string, count: number, examples: string[] = []): void {
  const ok = count === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${count}`);
}
function mustBePositive(label: string, count: number): void {
  const ok = count > 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  if (!ok) failures.push(`${label} = ${count} (expected > 0)`);
}
function report(label: string, count: number | string, examples: string[] = []): void {
  console.log(`  ---   ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
}

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1] ?? null;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
};

const short = (id: string): string => id.slice(0, 8);
const today = new Date().toISOString().slice(0, 10);

/**
 * `Number(null)` is 0 and `Number('')` is 0, both of which are finite — so the
 * type has to be checked, not the coercion. Postgres hands back DECIMAL as a
 * string ("0.500"), so a plain === between two of these lies.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const isNull = (v: unknown): boolean => num(v) === null;

// ── A. The RTP fallback chain, old vs new ─────────────────────────────
/**
 * The chain as it stood before this change. Inlined verbatim rather than
 * imported, because the point is to diff the two readings over real rows.
 */
function legacyRtpConfidence(row: PostRow): number {
  const nested = row.return_to_play_estimate as { confidence?: unknown } | null | undefined;
  return Number(
    nested?.confidence ?? row.rtp_confidence ?? row.md_review_confidence ?? 0,
  );
}

function sectionA(rows: PostRow[]): void {
  console.log('\n── A. RTP fallback equivalence (post-content.ts) ──\n');

  const changed: string[] = [];
  for (const r of rows) {
    const { content } = reconstructPostContent(r);
    if (!content) continue; // fails closed for its own reasons; not this gate's business
    const now = content.return_to_play.confidence;
    const before = legacyRtpConfidence(r);
    if (now !== before) {
      changed.push(`${short(r.id)} ${r.athlete_name} ${before} -> ${now}`);
    }
  }
  mustBeZero(
    'rows whose reconstructed RTP confidence changes under the new chain',
    changed.length,
    changed,
  );

  // The gate above is only meaningful while this one is zero: the removed link
  // was reachable ONLY through a null rtp_confidence.
  const nullRtp = rows.filter((r) => isNull(r.rtp_confidence));
  mustBeZero(
    'rows with a NULL or non-finite rtp_confidence (makes the gate above vacuous if > 0)',
    nullRtp.length,
    nullRtp.map((r) => `${short(r.id)} ${r.athlete_name} ${r.content_type}`),
  );
}

// ── B. Column baseline ────────────────────────────────────────────────
const required = (r: PostRow): boolean => r.md_review_required === true;

function sectionB(rows: PostRow[]): void {
  console.log('\n── B. Column baseline (whole corpus) ──\n');

  const flaggedNull = rows.filter((r) => required(r) && isNull(r.md_review_confidence));
  mustBeZero(
    'rows with md_review_required=true and a NULL md_review_confidence',
    flaggedNull.length,
    flaggedNull.map((r) => `${short(r.id)} ${r.athlete_name} ${r.status}`),
  );

  const pub = rows.filter((r) => r.status === 'PUBLISHED');
  const gap = pub.filter((r) => !required(r) && isNull(r.md_review_confidence));
  report('PUBLISHED rows', pub.length);
  report('PUBLISHED + not required + NULL (the gap this change closes)', gap.length);
  report(
    'populated',
    `required=true ${rows.filter((r) => required(r) && !isNull(r.md_review_confidence)).length}` +
      ` | required=false ${rows.filter((r) => !required(r) && !isNull(r.md_review_confidence)).length}`,
  );
}

// ── C. Acceptance, post-deploy ────────────────────────────────────────
function sectionC(inWindow: PostRow[], since: string | null): void {
  console.log('\n── C. Acceptance (--since) ──\n');
  if (!since) {
    console.log('  SKIP  no --since given; run this after the mcp + agents deploys.');
    return;
  }

  // Without a denominator an empty window passes every gate below on no
  // evidence at all. That is the failure mode this exists to prevent.
  mustBePositive(`rows created since ${since}`, inWindow.length);
  if (inWindow.length === 0) return;

  const stillNull = inWindow.filter(
    (r) => r.status === 'PUBLISHED' && !required(r) && isNull(r.md_review_confidence),
  );
  mustBeZero(
    'in-window PUBLISHED + not required + NULL md_review_confidence',
    stillNull.length,
    stillNull.map((r) => `${short(r.id)} ${r.athlete_name} ${r.content_type} ${r.created_at}`),
  );

  const flaggedNull = inWindow.filter((r) => required(r) && isNull(r.md_review_confidence));
  mustBeZero(
    'in-window md_review_required=true with a NULL md_review_confidence',
    flaggedNull.length,
    flaggedNull.map((r) => `${short(r.id)} ${r.athlete_name}`),
  );
}

// ── D. Two writers, one column ────────────────────────────────────────
/**
 * The same regex the frontend admin queue uses to render the percentage
 * (components/admin/ReviewQueue.tsx) — it scrapes md_review_reason rather than
 * reading the column, so the reason string is the only INDEPENDENT witness of
 * what the create path wrote. After this change createPost and flagForMdReview
 * both write the column; they are fed the same variable today, but they are two
 * call sites.
 */
const REASON_PCT = /confidence\s+([\d.]+)/;

function sectionD(rows: PostRow[]): void {
  console.log('\n── D. Two writers, one column ──\n');

  const disagree: string[] = [];
  let noPct = 0;
  for (const r of rows.filter(required)) {
    const m = r.md_review_reason?.match(REASON_PCT);
    if (!m) {
      noPct++;
      continue;
    }
    const fromReason = num(m[1]);
    const stored = num(r.md_review_confidence);
    if (fromReason !== null && stored !== null && Math.abs(fromReason - stored) > 1e-6) {
      disagree.push(`${short(r.id)} ${r.athlete_name} reason=${fromReason} column=${stored}`);
    }
  }
  mustBeZero(
    'flagged rows whose md_review_reason percentage contradicts the column',
    disagree.length,
    disagree,
  );
  // Not a gate: forceMDReviewReason paths name a code, not a number, and
  // between Aug 16-18 2026 they were the only path taken.
  report('flagged rows whose reason carries no percentage (forced-review paths)', noPct);
}

// ── E. an auto-published row is PUBLISHED ─────────────────────────────
function sectionE(inWindow: PostRow[], since: string | null): void {
  console.log('\n── E. not-required rows land PUBLISHED (tripwire) ──\n');
  if (!since) {
    console.log('  SKIP  no --since given.');
    return;
  }
  // This was written when web_create_injury_post still stripped `status`, as a
  // tripwire for the day someone declared it. That day was 2026-09-11 (mcp
  // fix/review-status-on-create): the server now honours status and the agent
  // sends md_review_required alongside it, so a review-routed row is born
  // PENDING_REVIEW and required. The invariant this checks did not change — a
  // row nobody routed to review must still be PUBLISHED — and it is now the
  // check that the status change touched ONLY the review path. The review side
  // of the same change is src/scripts/review-routing-audit.ts.
  const odd = inWindow.filter((r) => !required(r) && r.status !== 'PUBLISHED');
  mustBeZero(
    'in-window not-required rows whose status is not PUBLISHED',
    odd.length,
    odd.map((r) => `${short(r.id)} ${r.athlete_name} status=${r.status}`),
  );
}

// ── F. Is the number meaningful, or merely non-NULL? ──────────────────
/**
 * PR #30's merge — when emit_injury_post's two confidence fields got distinct
 * descriptions and the model stopped copying one number into both.
 *
 * Section F's baseline has to start HERE. Comparing against the whole
 * pre-window corpus compared new rows against the defect PR #30 fixed: across
 * the 507-row corpus, byte-identical confidences are 100/263 (38.0%) before this
 * instant and 2/61 (3.3%) after. The first acceptance run printed "in-window 1/2
 * vs baseline 31.5%", and a reader could only conclude things were in line with
 * history — when the history that line summarised was mostly the bug.
 */
export const CONFIDENCE_RUBRIC_SINCE = '2026-08-18T01:32:10Z';

/** Rows created in `[fromMs, toMs)` — lower bound inclusive, upper exclusive. */
export function rowsCreatedBetween<T extends { created_at: string }>(
  rows: readonly T[],
  fromMs: number,
  toMs: number,
): T[] {
  return rows.filter((r) => {
    const t = Date.parse(r.created_at);
    // An unparseable timestamp belongs to no window. Silently counting it in
    // one would make the comparison depend on which way NaN falls.
    return Number.isFinite(t) && t >= fromMs && t < toMs;
  });
}

/**
 * PR #30's symptom: the two confidences byte-identical, which is what a model
 * does when it cannot tell two fields apart. Only rows carrying BOTH numbers
 * are in the denominator — before 2026-09-10 auto-published rows stored no
 * md_review_confidence at all, and counting them would dilute the rate.
 */
export function identicalConfidenceShare(
  rows: readonly StoredPostRow[],
): { same: number; withBoth: number } {
  let same = 0;
  let withBoth = 0;
  for (const r of rows) {
    const a = num(r.md_review_confidence);
    const b = num(r.rtp_confidence);
    if (a === null || b === null) continue;
    withBoth++;
    if (a === b) same++;
  }
  return { same, withBoth };
}

function sectionF(
  inWindow: PostRow[],
  all: PostRow[],
  since: string | null,
  baselineFrom: string,
): void {
  console.log('\n── F. Distribution (reported, not gated) ──\n');
  if (!since) {
    console.log('  SKIP  no --since given.');
    return;
  }
  const vals = inWindow.map((r) => num(r.md_review_confidence)).filter((v): v is number => v !== null);
  if (vals.length === 0) {
    report('in-window rows carrying a value', 0);
    return;
  }
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [modal, modalN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  report('modal value', `${modal} (${modalN}/${vals.length}, ${((modalN / vals.length) * 100).toFixed(1)}%)`);

  const sinceMs = Date.parse(since);
  const fromMs = Date.parse(baselineFrom);
  const baseline = rowsCreatedBetween(all, fromMs, sinceMs);
  const history = rowsCreatedBetween(all, -Infinity, fromMs);

  const pct = ({ same, withBoth }: { same: number; withBoth: number }): string =>
    `${same}/${withBoth} (${withBoth === 0 ? 'n/a' : `${((same / withBoth) * 100).toFixed(1)}%`})`;
  const day = (iso: string): string => iso.slice(0, 10);

  // Non-NULL is not the same as meaningful. The in-window share is judged
  // against the baseline only; the pre-rubric line is there so the drop PR #30
  // produced stays visible, never as the comparison.
  report(
    'md_review_confidence === rtp_confidence',
    `in-window ${pct(identicalConfidenceShare(inWindow))}` +
      ` | baseline [${day(baselineFrom)} → ${day(since)}) ${pct(identicalConfidenceShare(baseline))}`,
  );
  report(
    `  for context: before ${day(baselineFrom)} (the defect PR #30 fixed)`,
    pct(identicalConfidenceShare(history)),
  );
}

// ── G. Nothing already stored moved ───────────────────────────────────
interface ManifestEntry {
  md_review_confidence: number | null;
  md_review_required: boolean;
  status: string | null;
  created_at: string;
}
type Manifest = { _written_at: string; _rows: number; entries: Record<string, ManifestEntry> };

function buildManifest(rows: PostRow[]): Manifest {
  const entries: Record<string, ManifestEntry> = {};
  for (const r of rows) {
    entries[r.id] = {
      md_review_confidence: num(r.md_review_confidence),
      md_review_required: required(r),
      status: r.status,
      created_at: r.created_at,
    };
  }
  return { _written_at: new Date().toISOString(), _rows: rows.length, entries };
}

function sectionG(current: Manifest, comparePath: string | null): void {
  console.log('\n── G. Nothing already stored moved ──\n');
  if (!comparePath) {
    console.log('  SKIP  no --compare given; pass a manifest from an earlier run.');
    return;
  }
  const prior = JSON.parse(readFileSync(resolve(process.cwd(), comparePath), 'utf-8')) as Manifest;
  const changed: string[] = [];
  const cleared: string[] = [];
  const filledUnflagged: string[] = [];
  const vanished: string[] = [];

  for (const [id, was] of Object.entries(prior.entries)) {
    const now = current.entries[id];
    if (!now) {
      // Deletion, or OFFSET paging skew over created_at DESC (documented in
      // web-posts.ts). Reported, never gated — this change cannot delete a row.
      vanished.push(`${short(id)} ${was.status}`);
      continue;
    }
    if (was.md_review_confidence !== null && now.md_review_confidence === null) {
      cleared.push(`${short(id)} ${was.md_review_confidence} -> null`);
    } else if (
      was.md_review_confidence !== null &&
      now.md_review_confidence !== null &&
      was.md_review_confidence !== now.md_review_confidence
    ) {
      changed.push(`${short(id)} ${was.md_review_confidence} -> ${now.md_review_confidence}`);
    } else if (
      was.md_review_confidence === null &&
      now.md_review_confidence !== null &&
      !now.md_review_required
    ) {
      // null -> non-null WITH the flag flipping true is flagForMdReview doing
      // its job. Without it, something wrote history.
      filledUnflagged.push(`${short(id)} null -> ${now.md_review_confidence}`);
    }
  }

  mustBeZero('stored values that changed since the prior run', changed.length, changed);
  mustBeZero('stored values cleared to null since the prior run', cleared.length, cleared);
  mustBeZero(
    'pre-existing unflagged rows that gained a value (the change is insert-only)',
    filledUnflagged.length,
    filledUnflagged,
  );
  report('rows in the prior manifest not seen this run (deletion or paging skew)', vanished.length, vanished);
}

// ── main ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initializeMCPClients();
  if (!isServerAvailable('web')) {
    console.error('[dryrun] the web MCP server is unavailable — nothing to score.');
    process.exitCode = 1;
    return;
  }

  const limit = flag('--limit') ? Number(flag('--limit')) : null;
  const { posts, pages, truncated } = await listAllPosts<PostRow>({});
  // A partial scan makes every "must be 0" an unknown, not a pass. This is the
  // exact confusion /admin/social-health shipped with for weeks.
  if (truncated) {
    console.error(`[dryrun] FAIL: the post scan was truncated after ${pages} page(s). Raise maxPages.`);
    process.exitCode = 1;
    return;
  }
  const rows = limit ? posts.slice(0, limit) : posts;

  const since = flag('--since');
  const sinceMs = since ? Date.parse(since) : NaN;
  if (since && !Number.isFinite(sinceMs)) {
    console.error(`[dryrun] FAIL: --since ${since} is not a parseable date.`);
    process.exitCode = 1;
    return;
  }
  const inWindow = since ? rows.filter((r) => Date.parse(r.created_at) >= sinceMs) : [];

  const baselineFrom = flag('--baseline-from') ?? CONFIDENCE_RUBRIC_SINCE;
  const baselineFromMs = Date.parse(baselineFrom);
  if (!Number.isFinite(baselineFromMs)) {
    console.error(`[dryrun] FAIL: --baseline-from ${baselineFrom} is not a parseable date.`);
    process.exitCode = 1;
    return;
  }
  // An inverted window is an empty baseline that prints "0/0 (n/a)" and looks
  // like an answer.
  if (since && baselineFromMs >= sinceMs) {
    console.error(`[dryrun] FAIL: --baseline-from ${baselineFrom} is not before --since ${since}.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n═══ md-confidence dry run (today=${today}, corpus=${rows.length} from ${pages} page(s)) ═══`,
  );

  sectionA(rows);
  sectionB(rows);
  sectionC(inWindow, since);
  sectionD(rows);
  sectionE(inWindow, since);
  sectionF(inWindow, rows, since, baselineFrom);

  const manifest = buildManifest(rows);
  sectionG(manifest, flag('--compare'));

  // Always written, including on a failing run — the container has no editor.
  const path = resolve(process.cwd(), flag('--manifest') ?? './md-confidence-manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n[dryrun] manifest → ${path}`);

  console.log('\n═══ Verdict ═══\n');
  if (failures.length === 0) {
    console.log('  PASS — every gated number is zero.');
  } else {
    console.log('  FAIL');
    for (const f of failures) console.log(`    ${f}`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so the tests can import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
    .catch((err) => {
      console.error(`[dryrun] fatal: ${err instanceof Error ? err.stack : String(err)}`);
      process.exitCode = 1;
    })
    .finally(() => {
      void disconnectAll().catch(() => {});
    });
}
