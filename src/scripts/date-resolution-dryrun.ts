/**
 * Read-only ship gate for the injury-date resolver fix.
 *
 * `resolveInjuryDate` is two Sonnet calls (four with a web search) and the
 * poller ran it on EVERY cycle that reached it, with no "already resolved"
 * check. Because the call is nondeterministic the same event resolved to a
 * different date on different cycles — Patrick Mahomes went 2025-12-14 →
 * 2025-12-15 → 2024-12-15 → 2025-12-15 across three system writes six hours
 * apart — and it twice reverted a date an MD had hand-corrected. Separately it
 * ran a year early on December injuries, and separately again it emitted
 * partial dates ('2026-07') the server rejected in silence.
 *
 * The repo convention is to diff old against new over the LIVE corpus before
 * shipping, with the numbers that must be zero stated up front; unit tests have
 * missed the real failure mode here repeatedly.
 *
 * THE NUMBERS THAT MUST BE ZERO (this script exits 1 on any of them):
 *   1. Settled threads that would still receive a system date write.
 *   2. Threads with NO stored date that the new predicate would freeze. First
 *      establishment must always resolve, or updateThreadDates' first
 *      otm_projection_reanchored never fires.
 *   3. Replayed system-initiated date changes that would still occur on a
 *      thread already settled at that instant.
 *   4. Stored dates the new validator would DROP that an MD hand-set.
 *   5. Threads flagged needs_date_review that are settled by md_manual and
 *      would therefore never be revisited.
 *   6. Recorded resolutions that disagree with the date an MD hand-corrected
 *      the thread to (--replay; needs a recorded fixture).
 *   7. Recorded resolutions emitting a malformed date.
 *   8. Replayed resolver/OTM pairs a year apart where the resolver would still
 *      win the anchor (--log; needs a Railway log).
 *   9. Backfill shells still inside web_find_matching_entity's 21-day window. A
 *      shell inside the window can still absorb a live report, so it is not
 *      inert and bulk-voiding it would remove real coverage. This is THE
 *      coverage gate — see Section E.
 *  10. Backfill shells carrying resolver or review state (otm_projection /
 *      date_resolution_sources / needs_date_review / accuracy_record). Any of
 *      those means the thread is not a shell and the predicate is wrong.
 *  11. Backfill shells with any audit_log history. Same argument, different
 *      evidence: a thread something has written to is not a shell.
 *  12. A corpus-wide audit probe that read zero entries. web_list_audit_entries
 *      keys on entity_type 'injury_thread'; passing 'injury_entity' returns []
 *      with no error, and a broken probe reads exactly like a clean sweep. If no
 *      thread in the whole corpus has history, gate 11 passed vacuously.
 *  13. Dateless ACTIVE threads created inside the backfill window that fail the
 *      shell predicate. The cohort must be homogeneous or the window is the
 *      wrong selector for it.
 *  14. Backfill shells that are the freshest ACTIVE thread in a
 *      player+body_part group that also holds a dated thread. States gate 9's
 *      property structurally, so it survives a change to the match window.
 *
 * Reported but NOT gates:
 *   - Total system date changes suppressed. That is the point of the change.
 *   - Stored dates failing the validator on threads no MD has touched. These
 *     are the live wrong-year rows; they are still in the DB on ship day and
 *     the MD decides what to do with them.
 *   - The settled/unsettled histogram.
 *   - RESIDUAL RESOLVER VARIANCE: how many distinct dates each recorded event
 *     produces across N real calls. This is deliberately NOT a gate. The model
 *     is nondeterministic and no prompt or temperature setting makes it
 *     otherwise — measured on 2026-09-09, Ashton Jeanty still answered
 *     2026-08-23 / 2026-08-24 / 2026-08-23 across three runs at temperature 0.
 *     That variance is the JUSTIFICATION for not re-resolving a settled date,
 *     not a regression to fail the build on. What is gated is that the variance
 *     never reaches a thread (zeros 1 and 3).
 *   - The backfill cohort's internal duplication (one injury split across up to
 *     five entities, because backfill-entities.ts matched at recency_days 60),
 *     and the shells that shadow a dated live thread. Both are consequences of
 *     the backfill, not of anything shipping here.
 *   - That the resolver has never run on ONE shell. Reported, because it is the
 *     evidence refuting a resolver backoff, not a regression to fail on.
 *   - That every shell's canonical post is PUBLISHED. Voiding a thread does not
 *     touch the post row.
 *
 * Usage:
 *   npx tsx src/scripts/date-resolution-dryrun.ts
 *   npx tsx src/scripts/date-resolution-dryrun.ts --limit 40        (smoke run)
 *       Section E classifies the ACTIVE corpus and names the backfill cohort.
 *   npx tsx src/scripts/date-resolution-dryrun.ts --log railway.log (scores zero 7)
 *   npx tsx src/scripts/date-resolution-dryrun.ts --emit-fixture --out tests/fixtures/date-resolution-threads.json
 *   npx tsx src/scripts/date-resolution-dryrun.ts --emit-cases 'Patrick Mahomes,Mykel Williams' --out tests/fixtures/date-resolution-cases.json
 *   npx tsx src/scripts/date-resolution-dryrun.ts --record 5 > /tmp/recorded.json
 *       COSTS MONEY: real Anthropic calls and live web searches. Prints the
 *       call count and waits for confirmation before spending anything.
 *   npx tsx src/scripts/date-resolution-dryrun.ts --replay          (free)
 *
 * Writes nothing to the database, publishes nothing. Makes model calls ONLY
 * under --record.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll }
  from '../utils/mcp-client-manager.js';
import {
  isSettledThreadDate,
  hasManualDate,
  assessAnchorDivergence,
  chooseDateAnchor,
} from '../agents/injury-intelligence/date-anchoring.js';
import { validateResolvedDates } from '../agents/injury-intelligence/date-validation.js';
import {
  resolveInjuryDate,
  _setClientForTesting,
  type DateConfidence,
} from '../agents/injury-intelligence/date-resolution.js';
import type { RawInjuryEvent } from '../types.js';
import type { ResolvedPlayerInfo, ExtractedInjuryMetadata }
  from '../agents/injury-intelligence/fact-validator.js';
import {
  classifyShell,
  daysStale,
  listRowsAreWide,
  defaultShellPolicy,
  type ShellCandidate,
  type ShellPolicy,
  type ShellReason,
} from '../utils/backfill-shells.js';

// ── Wire shapes ───────────────────────────────────────────────────────
interface ThreadListRow {
  id: string;
  player_id: string;
  athlete_name: string | null;
  sport: string | null;
  body_part: string | null;
  status: string;
  injury_date: string | null;
  injury_date_confidence: DateConfidence;
  surgery_date: string | null;
  surgery_confirmed: boolean;
  needs_date_review: boolean;
  otm_projection: { min_weeks?: number; max_weeks?: number } | null;
  accuracy_record: unknown | null;
  first_reported_at: string;
  last_updated_at: string;
  // OPTIONAL on purpose: absent ENTIRELY when this mcp-servers build predates
  // the listThreads widening. Absent is not the same as null — the column is
  // JSONB and is legitimately null on most rows.
  date_resolution_sources?: Array<{ stage?: string }> | null;
  canonical_post_id?: string | null;
}

interface ThreadEntity extends ThreadListRow {
  // Required once loaded, by either path.
  date_resolution_sources: Array<{ stage?: string }> | null;
  canonical_post_id: string | null;
}

type LoadMode = 'list' | 'per-entity';

interface AuditRow {
  ts: string;
  actor: string;
  action: string;
  payload: Record<string, unknown> | null;
}

const STATUSES = ['ACTIVE', 'RESOLVED', 'RETIRED', 'VOID'] as const;
const LIST_LIMIT = 500;

// ── Reporting scaffold (same shape as conflict-gap-dryrun) ────────────
const failures: string[] = [];
function mustBeZero(label: string, count: number, examples: string[] = []): void {
  const ok = count === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${count}`);
}
function report(label: string, count: number, examples: string[] = []): void {
  console.log(`  ---   ${label}: ${count}`);
  for (const e of examples.slice(0, 8)) console.log(`          ${e}`);
}

function unwrap<T>(res: unknown): T | null {
  const raw = res as { isError?: boolean; content?: Array<{ text?: string }> };
  if (raw?.isError === true) {
    throw new Error(`MCP error: ${raw.content?.[0]?.text ?? 'unknown'}`);
  }
  const text = raw?.content?.[0]?.text;
  return text ? (JSON.parse(text) as T) : null;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const has = (name: string): boolean => argv.includes(name);

const today = new Date().toISOString().slice(0, 10);

/**
 * Emit a fixture. Prefers `--out <path>` over stdout because the ESPN fetcher
 * and the MCP client both log to stdout, so a bare redirect produces a file
 * with log noise glued to the front of the JSON.
 */
function emit(payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  const out = flag('--out');
  if (out) {
    writeFileSync(resolve(process.cwd(), out), `${json}\n`);
    console.error(`[dryrun] wrote ${out}`);
  } else {
    console.log(json);
  }
}

/** Mirrors MODEL in date-resolution.ts; stamped into the recording. */
const MODEL_FOR_RECORD = 'claude-sonnet-4-6';
/**
 * Bump whenever the resolver's prompt changes. A recording made under a
 * different prompt answers a different question.
 */
const PROMPT_VERSION = 'calendar-block-v1';
const short = (id: string): string => id.slice(0, 8);

// ── Section A: corpus ─────────────────────────────────────────────────
async function loadThreads(
  limit: number | null,
): Promise<{ threads: ThreadEntity[]; mode: LoadMode }> {
  const listed: ThreadListRow[] = [];
  for (const status of STATUSES) {
    const res = await callTool('web', 'web_list_threads', { status, limit: LIST_LIMIT });
    const rows = unwrap<{ threads: ThreadListRow[] }>(res)?.threads ?? [];
    // web_list_threads has no offset, so a full page means the scan is
    // incomplete and every count below would be a floor, not an answer.
    if (rows.length >= LIST_LIMIT) {
      console.error(
        `[dryrun] FAIL: the ${status} thread scan hit the ${LIST_LIMIT}-row cap — ` +
          'results are not conclusive.',
      );
      process.exit(1);
    }
    listed.push(...rows);
  }

  const targets = limit === null ? listed : listed.slice(0, limit);

  // Decided ONCE, from the accumulated list, and by KEY PRESENCE. Since
  // mcp-servers PR #26 listThreads projects date_resolution_sources, which is
  // the only reason this was ever O(threads) instead of four list calls.
  const wide = listRowsAreWide(listed);
  const mode: LoadMode = wide ? 'list' : 'per-entity';

  const hydrate = async (t: ThreadListRow): Promise<ThreadEntity | null> => {
    const got = unwrap<{ entity: ThreadEntity }>(
      await callTool('web', 'web_thread_get', { entity_id: t.id }),
    );
    if (!got?.entity) return null;
    return {
      ...t,
      ...got.entity,
      id: t.id,
      athlete_name: t.athlete_name,
      sport: t.sport,
    };
  };

  if (!wide) {
    console.log(
      `[dryrun] thread load: mode=per-entity — this mcp-servers build's listThreads ` +
        `omits date_resolution_sources, so the md_manual half of the settled predicate ` +
        `is invisible from a list call. Falling back to ${targets.length} web_thread_get ` +
        `reads. Deploy the widened listThreads to skip them.`,
    );
    const out: ThreadEntity[] = [];
    for (const t of targets) {
      const e = await hydrate(t);
      if (e) out.push(e);
    }
    return { threads: out, mode };
  }

  // A rolling deploy can serve both shapes behind one URL. Read individually
  // only the rows that arrived narrow, so the corpus stays homogeneous.
  const mixed = targets.filter((t) => !('date_resolution_sources' in t));
  if (mixed.length > 0) {
    console.log(
      `[dryrun] WARNING: ${mixed.length} of ${targets.length} list rows arrived without ` +
        'date_resolution_sources (rolling deploy?) — reading those individually.',
    );
  }
  const narrowIds = new Set(mixed.map((t) => t.id));
  const out: ThreadEntity[] = [];
  for (const t of targets) {
    if (narrowIds.has(t.id)) {
      const e = await hydrate(t);
      if (e) out.push(e);
      continue;
    }
    out.push({
      ...t,
      date_resolution_sources: t.date_resolution_sources ?? null,
      canonical_post_id: t.canonical_post_id ?? null,
    });
  }
  console.log(
    `[dryrun] thread load: mode=list (${out.length} threads from ${STATUSES.length} list ` +
      `calls, ${mixed.length} per-entity reads).`,
  );
  return { threads: out, mode };
}

/**
 * One audit read per thread, hoisted so sections B and E share it.
 *
 * entity_type is 'injury_thread'. 'injury_entity' — the table name, and the
 * obvious guess — returns `entries: []` with no error for every thread, which
 * reads as "no history anywhere" and would make Section E's history gate pass
 * vacuously. Gate 12 exists to catch exactly that.
 */
async function loadAuditIndex(threads: ThreadEntity[]): Promise<Map<string, AuditRow[]>> {
  const out = new Map<string, AuditRow[]>();
  for (const t of threads) {
    const rows =
      unwrap<{ entries: AuditRow[] }>(
        await callTool('web', 'web_list_audit_entries', {
          entity_type: 'injury_thread',
          entity_id: t.id,
          limit: LIST_LIMIT,
        }),
      )?.entries ?? [];
    out.set(t.id, rows);
  }
  return out;
}

function sectionA(threads: ThreadEntity[]): void {
  console.log('\nA. Corpus\n');
  const active = threads.filter((t) => t.status === 'ACTIVE');
  const settled = active.filter((t) => isSettledThreadDate(t).settled);
  const anchored = settled.filter((t) => isSettledThreadDate(t).reason === 'anchored');
  const manual = settled.filter((t) => isSettledThreadDate(t).reason === 'md_manual');

  console.log(`  threads=${threads.length} active=${active.length}`);
  console.log(
    `  settled=${settled.length} (anchored=${anchored.length} md_manual=${manual.length}) ` +
      `unsettled=${active.length - settled.length}`,
  );
  const pct = active.length ? Math.round((100 * settled.length) / active.length) : 0;
  console.log(`  → the resolver is skipped on ${settled.length}/${active.length} = ${pct}% of ACTIVE threads`);

  const byConfidence = new Map<string, number>();
  for (const t of active) {
    const key = `${t.injury_date_confidence}/${t.injury_date ? 'dated' : 'no-date'}`;
    byConfidence.set(key, (byConfidence.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...byConfidence].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(22)} ${v}`);
  }

  console.log('\nA1. The numbers that must be zero (corpus)\n');

  // 1. A settled thread must not attract a system date write.
  const wouldWrite = settled.filter((t) => !isSettledThreadDate(t).settled);
  mustBeZero('settled threads that would still receive a system date write', wouldWrite.length);

  // 2. First establishment must always resolve.
  const frozenWithoutDate = active.filter(
    (t) => isSettledThreadDate(t).settled && !t.injury_date && !hasManualDate(t),
  );
  mustBeZero(
    'threads with no stored date that the predicate would freeze',
    frozenWithoutDate.length,
    frozenWithoutDate.map((t) => `${short(t.id)} ${t.athlete_name}`),
  );

  // 5. An md_manual thread the MD has flagged would never be revisited by the
  //    resolver, so the flag has to be the MD's own lever, not a machine's.
  const flaggedManual = active.filter((t) => t.needs_date_review && hasManualDate(t));
  mustBeZero(
    'needs_date_review threads settled by md_manual',
    flaggedManual.length,
    flaggedManual.map((t) => `${short(t.id)} ${t.athlete_name} conf=${t.injury_date_confidence}`),
  );

  const owedReanchor = active.filter((t) => !t.injury_date && t.otm_projection);
  report(
    'threads with no date but a stored otm_projection (first re-anchor owed)',
    owedReanchor.length,
    owedReanchor.slice(0, 5).map((t) => `${short(t.id)} ${t.athlete_name}`),
  );
}

// ── Section B: audit replay ───────────────────────────────────────────
interface Replay {
  suppressed: number;
  stillOccurs: number;
  firstEstablishments: number;
  inferred: number;
  ladders: string[];
  stillExamples: string[];
}

function sectionB(threads: ThreadEntity[], audit: Map<string, AuditRow[]>): void {
  console.log('\nB. Audit replay — would the new logic have made these writes?\n');
  const r: Replay = {
    suppressed: 0, stillOccurs: 0, firstEstablishments: 0, inferred: 0,
    ladders: [], stillExamples: [],
  };

  for (const t of threads) {
    const rows = audit.get(t.id) ?? [];
    const reanchors = rows
      .filter((a) => a.action === 'otm_projection_reanchored')
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (reanchors.length === 0) continue;

    // Walk the thread's date history forward, carrying the state each write
    // left behind, and ask of every SYSTEM write whether the state immediately
    // before it was settled.
    let heldDate: string | null = null;
    let mdTouched = false;
    const ladder: string[] = [];

    for (const a of reanchors) {
      const prev = (a.payload?.previous_injury_date as string | null) ?? heldDate;
      const next = (a.payload?.new_injury_date as string | null) ?? null;
      const isSystem = a.actor === 'system';

      // The reanchor payload does NOT carry the confidence at that instant,
      // and no other audit action records one either — so EVERY row here uses
      // the thread's CURRENT confidence as a stand-in. That is an assumption,
      // it is counted, and it is printed: an unstated inference is how a replay
      // comes to lie about its own gate. It biases toward "settled", because a
      // thread that ended up confirmed was probably confirmed earlier too —
      // which makes `stillOccurs` a FLOOR, the conservative direction for a
      // must-be-zero.
      const confidence: DateConfidence = t.injury_date_confidence;
      r.inferred += 1;

      const settledThen = isSettledThreadDate({
        injury_date: prev,
        injury_date_confidence: confidence,
        date_resolution_sources: mdTouched ? [{ stage: 'md_manual' }] : null,
      }).settled;

      if (!isSystem) {
        mdTouched = true;
        ladder.push(`md     ${prev ?? 'none'} → ${next ?? 'none'}`);
      } else if (prev === null) {
        r.firstEstablishments += 1;
        ladder.push(`system ${prev ?? 'none'} → ${next ?? 'none'}  [first establishment — kept]`);
      } else if (settledThen) {
        r.suppressed += 1;
        ladder.push(`system ${prev} → ${next ?? 'none'}  [SUPPRESSED]`);
      } else {
        r.stillOccurs += 1;
        r.stillExamples.push(`${short(t.id)} ${t.athlete_name} ${prev} → ${next} conf=${confidence}`);
        ladder.push(`system ${prev} → ${next ?? 'none'}  [still occurs, conf=${confidence}]`);
      }
      heldDate = next;
    }

    r.ladders.push(
      `  ${short(t.id)} ${t.athlete_name} (${t.sport})\n` +
        ladder.map((l) => `      ${l}`).join('\n'),
    );
  }

  for (const l of r.ladders) console.log(l);
  console.log('');
  report('system date changes SUPPRESSED (the point of the change)', r.suppressed);
  report('first establishments preserved', r.firstEstablishments);
  report(
    'confidence values INFERRED rather than read (the replay\'s known limitation)',
    r.inferred,
  );
  mustBeZero(
    'system date changes on an already-settled thread that would still occur',
    r.stillOccurs,
    r.stillExamples,
  );
}

// ── Section C: the validator over stored data ─────────────────────────
function sectionC(threads: ThreadEntity[]): void {
  console.log('\nC. Validator over stored dates\n');
  const dropped: string[] = [];
  const droppedManual: string[] = [];
  const downgraded: string[] = [];

  for (const t of threads) {
    if (!t.injury_date && !t.surgery_date) continue;
    const v = validateResolvedDates({
      injury_date: t.injury_date,
      injury_date_confidence: t.injury_date_confidence,
      surgery_date: t.surgery_date,
      surgery_confirmed: t.surgery_confirmed,
      today,
    });
    if (v.violations.length === 0) continue;
    const line = `${short(t.id)} ${t.athlete_name} inj=${t.injury_date} surg=${t.surgery_date} ${v.violations.join('|')}`;
    if (t.injury_date && v.injury_date === null) {
      (hasManualDate(t) ? droppedManual : dropped).push(line);
    } else {
      downgraded.push(line);
    }
  }

  mustBeZero('MD-set dates the validator would DROP', droppedManual.length, droppedManual);
  report('machine-set dates the validator would drop', dropped.length, dropped);
  report('stored rows the validator would downgrade', downgraded.length, downgraded);
}

// ── Section D: determinism and year resolution ────────────────────────
interface RecordedCase {
  label: string;
  event: Omit<RawInjuryEvent, 'reported_at'> & { reported_at: string };
  player: ResolvedPlayerInfo;
  metadata: ExtractedInjuryMetadata;
  today: string;
  /** What an MD corrected the date to, where one did. */
  truth?: string | null;
  responses: unknown[];
}

interface RecordedFixture {
  _recorded_from: string;
  _recorded_at: string;
  _model: string;
  _temperature: number;
  _prompt_version: string;
  cases: RecordedCase[];
}

async function sectionD(): Promise<void> {
  console.log('\nD. Determinism and year resolution\n');
  const path = resolve(process.cwd(), 'tests/fixtures/date-resolution-recorded.json');
  let fixture: RecordedFixture;
  try {
    fixture = JSON.parse(readFileSync(path, 'utf-8')) as RecordedFixture;
  } catch {
    console.log(`  no recording at ${path} — skipped.`);
    console.log('  Record one with: npx tsx src/scripts/date-resolution-dryrun.ts --record 5');
    return;
  }
  console.log(
    `  fixture recorded ${fixture._recorded_at} from ${fixture._recorded_from}\n` +
      `  model=${fixture._model} temperature=${fixture._temperature} prompt=${fixture._prompt_version}`,
  );

  const variance: string[] = [];
  const wrongVsTruth: string[] = [];
  const malformed: string[] = [];

  for (const c of fixture.cases) {
    const dates = new Set<string>();
    const confidences = new Set<string>();
    for (const response of c.responses) {
      // Each recorded response is one complete resolveInjuryDate transcript:
      // the Anthropic messages in call order.
      const messages = response as unknown[];
      let i = 0;
      _setClientForTesting({
        messages: { create: async () => (messages[i++] ?? messages[messages.length - 1]) as never },
      });
      const r = await resolveInjuryDate({
        event: { ...c.event, reported_at: new Date(c.event.reported_at) } as RawInjuryEvent,
        player: c.player,
        metadata: c.metadata,
        reportedAt: new Date(c.event.reported_at),
        today: c.today,
      });
      dates.add(r.injury_date ?? 'none');
      confidences.add(r.injury_date_confidence);
      if (r.violations.some((v) => v.includes('malformed'))) {
        malformed.push(`${c.label}: ${r.violations.join('|')}`);
      }
      if (c.truth && r.injury_date && r.injury_date !== c.truth) {
        wrongVsTruth.push(`${c.label}: got ${r.injury_date}, MD says ${c.truth}`);
      }
    }
    _setClientForTesting(null);
    const line =
      `${c.label.padEnd(20)} ${dates.size} distinct date(s) [${[...dates].join(', ')}] ` +
      `conf [${[...confidences].join(', ')}]${c.truth ? ` truth=${c.truth}` : ''}`;
    console.log(`    ${line}`);
    if (dates.size > 1) variance.push(line);
  }

  console.log('');
  report(
    'recorded events still producing more than one date (residual variance — the reason the skip exists)',
    variance.length,
    variance,
  );
  mustBeZero(
    'recorded resolutions disagreeing with the MD-corrected date',
    wrongVsTruth.length,
    wrongVsTruth,
  );
  mustBeZero('recorded resolutions emitting a malformed date', malformed.length, malformed);
}

// ── Section D2: would the resolver still win a year-scale divergence? ──
//
// This one needs a Railway log, not the DB. OTM's own emitted injury_date is
// never persisted — the poller reconciles it with the resolver's and stores
// only the winner — so the ONLY record of a resolver/OTM disagreement is the
// `[Poller] ... date anchor divergence` line. Scoring the DB alone would report
// a comfortable zero for entirely the wrong reason.
const DIVERGENCE_RE =
  /date anchor divergence for ([^(]+)\([^)]*\): OTM said (\d{4}-\d{2}-\d{2}), resolver said (\d{4}-\d{2}-\d{2}) \(confidence (\w+)\)/;

function sectionD2(logPath: string | null): void {
  console.log('\nD2. Year-scale anchor divergence (Railway log replay)\n');
  if (!logPath) {
    console.log('  no --log given; skipped. (Dump one with `railway logs -n 5000 > railway.log`.)');
    console.log('  NOTE: this section cannot be scored from the database — OTM\'s emitted');
    console.log('        injury_date is never stored, only the winner of the reconciliation.');
    return;
  }

  let lines: string[];
  try {
    lines = readFileSync(logPath, 'utf-8').split('\n');
  } catch (err) {
    console.error(`  could not read ${logPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const stillWins: string[] = [];
  const caught: string[] = [];
  const benign: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const m = DIVERGENCE_RE.exec(line);
    if (!m) continue;
    const [, athleteRaw, otmDate, resolverDate, confidence] = m;
    const athlete = athleteRaw.trim();
    const key = `${athlete}|${otmDate}|${resolverDate}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const d = assessAnchorDivergence(resolverDate, otmDate);
    const desc = `${athlete}: resolver ${resolverDate} vs OTM ${otmDate} (${d.days_apart}d, ${confidence})`;

    if (d.kind !== 'year_apart') {
      benign.push(desc);
      continue;
    }
    caught.push(desc);

    // NEW behaviour: demote the thread's confidence and re-choose through the
    // SAME rule. If the resolver's date still comes back, the downgrade is not
    // doing its job.
    const anchor = chooseDateAnchor(
      { injury_date: resolverDate, injury_date_confidence: 'possible' },
      otmDate,
    );
    if (anchor !== otmDate) stillWins.push(`${desc} — anchor stayed ${anchor}`);
  }

  console.log(`  divergence lines parsed: ${seen.size}`);
  report('caught as year_apart → downgraded and routed to MD review', caught.length, caught);
  report('left alone as ordinary injury-vs-surgery divergence', benign.length, benign);
  mustBeZero('year-apart cases where the resolver date would still win', stillWins.length, stillWins);
}

// ── --emit-cases: build the --record input from the LIVE feed ─────────
//
// The determinism cases are pulled from the real ESPN feed and the real player
// table rather than typed, so the events carry the prose that actually breaks
// the resolver — Mahomes' row says "Dec. 15 surgery" with no year, which is the
// whole December failure in one clause. `truth` is the date an MD corrected the
// thread to, where one did.
const MD_CORRECTED: Record<string, string> = {
  'Patrick Mahomes': '2025-12-15',
  'Micah Parsons': '2025-12-14',
  'Noah Sewell': '2025-12-28',
  'Mykel Williams': '2025-11-02',
};

async function emitCases(names: string[]): Promise<void> {
  const { ESPNNFLSource } = await import('../monitoring/sports/espn-nfl.js');
  const { extractInjuryMetadata } = await import('../agents/injury-intelligence/fact-validator.js');
  const events = await new ESPNNFLSource().fetchLatestEvents();

  const cases: Array<Omit<RecordedCase, 'responses'>> = [];
  for (const name of names) {
    const ev = events.find((e) => e.athlete_name === name);
    if (!ev) {
      // An athlete can simply age off the feed (Micah Parsons and Danny Pinter
      // both had by 2026-09-09). Say so; do not silently emit fewer cases.
      console.error(`[dryrun] ${name}: not in the live feed today — skipped`);
      continue;
    }
    const resolved = unwrap<{ resolved: boolean; player: ResolvedPlayerInfo }>(
      await callTool('web', 'web_resolve_player', { name, sport: ev.sport }),
    );
    if (!resolved?.resolved) {
      console.error(`[dryrun] ${name}: unresolved against the player table — skipped`);
      continue;
    }
    cases.push({
      label: name,
      event: { ...ev, reported_at: ev.reported_at.toISOString() },
      player: resolved.player,
      metadata: extractInjuryMetadata(ev.injury_description, ev.injury_details),
      today,
      truth: MD_CORRECTED[name] ?? null,
    });
    console.error(`[dryrun] ${name}: ok`);
  }

  emit({
    _recorded_from:
      'live ESPN NFL injuries feed + web_resolve_player, via date-resolution-dryrun --emit-cases',
    _recorded_at: today,
    _note:
      'Input spec for --record. Events are RECORDED from the live feed, never hand-authored. ' +
      '`truth` is the date an MD corrected the thread to, where one did.',
    cases,
  });
}

// ── --record: the ONLY path that spends money ─────────────────────────
//
// Determinism cannot be asserted from a stub — the whole defect is that the
// live model answers differently on identical input. So this makes N real
// resolveInjuryDate calls per event, intercepts every Anthropic response, and
// prints them as a fixture. Replay is then free and repeatable.
//
// Recorded, never hand-authored: four fixtures in this repo have passed against
// broken code because they were written to match it.
/**
 * Replace opaque server-tool blobs with a size marker.
 *
 * `encrypted_content` / `encrypted_stdout` come back on web_search and code
 * blocks, are meaningless to us, and dominate the file. Nothing the resolver
 * reads — the emit tool_use input, the web_search_result url/title, stop_reason
 * — is touched. Recorded fixtures stay faithful to what the code consumes.
 */
const OPAQUE_KEYS = new Set(['encrypted_content', 'encrypted_stdout', 'encrypted_index', 'page_age']);
function scrubOpaquePayloads(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubOpaquePayloads);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        OPAQUE_KEYS.has(k) && typeof v === 'string'
          ? `<stripped ${v.length} chars>`
          : scrubOpaquePayloads(v);
    }
    return out;
  }
  return value;
}

async function record(n: number): Promise<void> {
  const specPath = resolve(process.cwd(), 'tests/fixtures/date-resolution-cases.json');
  let spec: { cases: Array<Omit<RecordedCase, 'responses'>> };
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf-8')) as typeof spec;
  } catch {
    console.error(
      `[dryrun] --record needs an input spec at ${specPath}: ` +
        '{"cases":[{label, event, player, metadata, today, truth}]}. ' +
        'Build it from real RawInjuryEvents (the ESPN feed), never by hand-typing prose.',
    );
    process.exit(2);
  }

  const total = spec.cases.length * n;
  console.error(
    `[dryrun] --record will make up to ${total * 4} REAL Anthropic calls ` +
      `(${spec.cases.length} events x ${n} replays, up to 4 calls each) with live web search. ` +
      'This costs money. Ctrl-C within 5s to abort.',
  );
  await new Promise((r) => setTimeout(r, 5000));

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const real = new Anthropic();

  const cases: RecordedCase[] = [];
  for (const c of spec.cases) {
    const responses: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const transcript: unknown[] = [];
      _setClientForTesting({
        messages: {
          create: async (params) => {
            const res = await real.messages.create(params as never);
            transcript.push(res);
            return res as never;
          },
        },
      });
      const r = await resolveInjuryDate({
        event: { ...c.event, reported_at: new Date(c.event.reported_at) } as RawInjuryEvent,
        player: c.player,
        metadata: c.metadata,
        reportedAt: new Date(c.event.reported_at),
        today: c.today,
      });
      console.error(`  ${c.label} run ${i + 1}/${n}: ${r.injury_date} (${r.injury_date_confidence})`);
      responses.push(transcript);
    }
    _setClientForTesting(null);
    cases.push({ ...c, responses });
  }

  const fixture: RecordedFixture = {
    // Opaque server-tool payloads are replaced with a size marker before the
    // fixture is written: encrypted_content and encrypted_stdout are unread by
    // the resolver and are ~75% of the file. Everything the resolver DOES read
    // is recorded verbatim.
    _recorded_from: 'live Anthropic API via src/scripts/date-resolution-dryrun.ts --record',
    _recorded_at: today,
    _model: MODEL_FOR_RECORD,
    _temperature: 0,
    // Without this an old recording is silently compared against a new prompt
    // and the determinism number stops meaning anything.
    _prompt_version: PROMPT_VERSION,
    cases: scrubOpaquePayloads(cases) as RecordedCase[],
  };
  emit(fixture);
}


// ── Section E: what the dateless ACTIVE threads actually are ──────────
/** The dryrun's ThreadEntity is already a ShellCandidate; this only narrows. */
function asCandidate(t: ThreadEntity): ShellCandidate {
  return {
    id: t.id,
    player_id: t.player_id,
    athlete_name: t.athlete_name,
    body_part: t.body_part,
    status: t.status,
    injury_date: t.injury_date,
    otm_projection: t.otm_projection ?? null,
    date_resolution_sources: t.date_resolution_sources,
    accuracy_record: t.accuracy_record ?? null,
    needs_date_review: t.needs_date_review,
    canonical_post_id: t.canonical_post_id,
    first_reported_at: t.first_reported_at,
    last_updated_at: t.last_updated_at,
  };
}

const groupKey = (t: ThreadEntity): string => `${t.player_id}|${(t.body_part ?? '').toLowerCase()}`;

function sectionE(
  threads: ThreadEntity[],
  audit: Map<string, AuditRow[]>,
  mode: LoadMode,
): void {
  console.log(`\nE. The ACTIVE corpus: what the dateless threads actually are   [load mode=${mode}]\n`);

  const policy: ShellPolicy = defaultShellPolicy(Date.parse(`${today}T12:00:00Z`));
  const active = threads.filter((t) => t.status === 'ACTIVE');
  const auditCount = (t: ThreadEntity): number => (audit.get(t.id) ?? []).length;

  const verdict = new Map<string, ShellReason>();
  for (const t of active) verdict.set(t.id, classifyShell(asCandidate(t), policy, auditCount(t)).reason);

  const dated = active.filter((t) => t.injury_date);
  const dateless = active.filter((t) => !t.injury_date);
  const shells = active.filter((t) => verdict.get(t.id) === 'ok');
  const unexplained = dateless.filter((t) => verdict.get(t.id) !== 'ok');

  console.log(
    `  ACTIVE=${active.length}  dated(live)=${dated.length}  ` +
      `backfill shells=${shells.length}  unexplained dateless=${unexplained.length}`,
  );
  console.log(
    '  shell predicate: ACTIVE ^ no injury_date ^ no otm_projection ^ no\n' +
      '    date_resolution_sources ^ !needs_date_review ^ no accuracy_record ^\n' +
      '    first_reported_at in\n' +
      `    [${policy.createdFrom}, ${policy.createdTo}] ^\n` +
      `    last_updated_at older than ${policy.matchWindowDays}d ^ zero audit_log rows`,
  );

  // Creation clustering: the whole causal claim rests on it, so it is printed
  // rather than asserted.
  console.log('\n  creation clustering (dateless ACTIVE, bucketed to the minute):');
  const buckets = new Map<string, number>();
  for (const t of dateless) {
    const k = t.first_reported_at.slice(0, 16);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${k}Z   n=${v}`);
  }
  const inWindow = dateless.filter((t) => {
    const c = Date.parse(t.first_reported_at);
    return c >= Date.parse(policy.createdFrom) && c <= Date.parse(policy.createdTo);
  });
  const stamps = inWindow.map((t) => t.first_reported_at).sort();
  if (stamps.length > 0) {
    console.log(
      `    -> ${inWindow.length}/${dateless.length} created in one pass ` +
        `(${stamps[0]} -> ${stamps[stamps.length - 1]}), i.e.\n` +
        '       src/scripts/backfill-entities.ts. That script has no resolver import\n' +
        '       and never writes a date.',
    );
  }
  for (const t of dateless.filter((t) => !inWindow.includes(t)).slice(0, 5)) {
    console.log(
      `    outlier: ${short(t.id)} ${t.athlete_name} ${t.first_reported_at.slice(0, 10)} ` +
        `(canonical_post_id=${t.canonical_post_id ?? 'null'}, reason=${verdict.get(t.id)})`,
    );
  }

  console.log('\nE1. The numbers that must be zero (backfill cohort)\n');

  // 9. THE coverage gate. A shell inside the match window is a live absorber.
  const notInert = shells.filter(
    (t) => daysStale(t, policy.now) < policy.matchWindowDays,
  );
  mustBeZero(
    `backfill shells still inside web_find_matching_entity's ${policy.matchWindowDays}-day window ` +
      '(a live absorber, not an inert row)',
    notInert.length,
    notInert.map((t) => `${short(t.id)} ${t.athlete_name} stale=${daysStale(t, policy.now)}d`),
  );

  // 10/11. Structural: the predicate already excludes these, so a non-zero here
  // means classifyShell and this section disagree about what a shell is.
  const carryingState = shells.filter(
    (t) =>
      t.otm_projection != null ||
      (Array.isArray(t.date_resolution_sources) && t.date_resolution_sources.length > 0) ||
      t.needs_date_review ||
      t.accuracy_record != null,
  );
  mustBeZero(
    'backfill shells carrying resolver or review state ' +
      '(otm_projection / date_resolution_sources / needs_date_review / accuracy_record)',
    carryingState.length,
    carryingState.map((t) => `${short(t.id)} ${t.athlete_name}`),
  );

  const withHistory = shells.filter((t) => auditCount(t) > 0);
  mustBeZero(
    'backfill shells with any audit_log history',
    withHistory.length,
    withHistory.map((t) => `${short(t.id)} ${t.athlete_name} entries=${auditCount(t)}`),
  );

  // 12. The probe control. entity_type 'injury_entity' returns [] for every
  // thread with no error, and gate 11 would then pass because the probe is
  // broken, not because the threads are clean.
  const probeSaw = threads.reduce((n, t) => n + auditCount(t), 0);
  mustBeZero(
    'the audit probe read zero entries across the ENTIRE corpus ' +
      "(a broken probe reads exactly like a clean sweep — check entity_type='injury_thread')",
    probeSaw > 0 ? 0 : 1,
    probeSaw > 0 ? [] : [`scanned ${threads.length} threads, found 0 audit rows anywhere`],
  );
  report(`audit rows seen across the corpus (probe control)`, probeSaw);

  // 13. Homogeneity of the cohort.
  const windowMisfits = inWindow.filter((t) => verdict.get(t.id) !== 'ok');
  mustBeZero(
    'dateless ACTIVE threads created inside the backfill window that fail the shell predicate',
    windowMisfits.length,
    windowMisfits.map((t) => `${short(t.id)} ${t.athlete_name} reason=${verdict.get(t.id)}`),
  );

  // 14. Gate 9's property, stated structurally so it survives a window change.
  const byGroup = new Map<string, ThreadEntity[]>();
  for (const t of active) {
    const k = groupKey(t);
    byGroup.set(k, [...(byGroup.get(k) ?? []), t]);
  }
  const freshestShell = shells.filter((t) => {
    const peers = byGroup.get(groupKey(t)) ?? [];
    if (!peers.some((p) => p.injury_date)) return false;
    return peers.every((p) => Date.parse(p.last_updated_at) <= Date.parse(t.last_updated_at));
  });
  mustBeZero(
    'backfill shells that are the freshest ACTIVE thread in a player+body_part group ' +
      'that also holds a dated thread',
    freshestShell.length,
    freshestShell.map((t) => `${short(t.id)} ${t.athlete_name} ${t.body_part}`),
  );

  console.log('\nE2. Reported, not gated\n');

  const shellGroups = new Map<string, number>();
  for (const t of shells) shellGroups.set(groupKey(t), (shellGroups.get(groupKey(t)) ?? 0) + 1);
  const multi = [...shellGroups].filter(([, c]) => c > 1);
  report(
    'shell (player_id, body_part) groups holding more than one shell',
    multi.length,
    multi
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, c]) => {
        const name = shells.find((t) => groupKey(t) === k)?.athlete_name ?? k;
        return `${name} x${c}`;
      }),
  );
  report(
    'redundant shell rows inside those groups (rows - groups)',
    multi.reduce((n, [, c]) => n + c - 1, 0),
  );

  const datedGroups = new Set(dated.map(groupKey));
  const shadowing = shells.filter((t) => datedGroups.has(groupKey(t)));
  report(
    'shells shadowing a dated ACTIVE thread on the same player+body_part',
    shadowing.length,
    shadowing.map((t) => `${short(t.id)} ${t.athlete_name} ${t.body_part}`),
  );
  report(
    'shells on which the resolver ever ran (date_resolution_sources set)',
    shells.filter((t) => Array.isArray(t.date_resolution_sources) && t.date_resolution_sources.length > 0)
      .length,
  );
  report(
    'shells with a canonical_post_id — voiding the THREAD does not touch the post row; ' +
      'the pointer runs entity->post and publish-side dedup reads web_list_posts, never entities',
    shells.filter((t) => t.canonical_post_id != null).length,
  );
  // Not a conjunct, and the reason is in backfill-shells.ts: a NULL here is the
  // ON DELETE SET NULL signature of a pre-migration-021 reject deleting the post,
  // leaving a post-less ACTIVE thread — the Greenard shape, which retraction fits
  // better than anything else, not worse.
  report(
    'shells whose canonical post was later DELETED (canonical_post_id nulled by ' +
      "the pre-migration-021 Reject button — post-less ACTIVE threads)",
    shells.filter((t) => t.canonical_post_id == null).length,
  );

  console.log('\n  REFUTATION OF THE BACKOFF PREMISE');
  console.log(
    "    PR #43's follow-up claimed these threads re-resolve every 6h at ~169 model\n" +
      '    calls per cycle, having "already failed repeatedly". That is false in both\n' +
      '    directions, and this section is the evidence.\n' +
      `      * date_resolution_sources is NULL and audit_log is EMPTY on ${shells.length}/${shells.length}\n` +
      '        shells. The resolver has not run on ONE of them, once. Nothing was\n' +
      '        attempted, so there is nothing to back off.\n' +
      `      * web_find_matching_entity gates on last_updated_at >= NOW() - ${policy.matchWindowDays}d,\n` +
      `        and these are ${shells.length ? daysStale(shells[0], policy.now) : 0}d stale, so no new report routes to them either.\n` +
      '    A resolver backoff would suppress ZERO calls and gate a path these rows\n' +
      '    never enter. The cost is inert rows in the ACTIVE list; the fix is\n' +
      '    retraction (VOID) — see src/scripts/close-backfill-shells.ts.',
  );
}

// ── main ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const limitArg = flag('--limit');
  const limit = limitArg ? Number(limitArg) : null;

  try {
    await initializeMCPClients();
  } catch (err) {
    console.error(`[dryrun] MCP init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const emitCasesArg = flag('--emit-cases');
  if (emitCasesArg !== null && isServerAvailable('web')) {
    await emitCases(emitCasesArg.split(',').map((n) => n.trim()).filter(Boolean));
    return;
  }

  if (has('--record')) {
    await record(Number(flag('--record') ?? '3'));
    return;
  }

  if (!isServerAvailable('web')) {
    if (has('--replay')) {
      await sectionD();
      console.log(failures.length ? `\n═══ Verdict: FAIL ═══` : '\n═══ Verdict: PASS ═══');
      process.exitCode = failures.length ? 1 : 0;
      return;
    }
    console.error('[dryrun] the web MCP server is unavailable — nothing to score.');
    process.exit(1);
  }

  const { threads, mode } = await loadThreads(limit);

  if (has('--emit-fixture')) {
    // Provenance is mechanical, never typed by hand: four fixtures in this repo
    // have shared the code's blind spot because they were written to match it.
    // Mechanical selection, not a hand-picked list: the six threads whose
    // flip-flops motivated the change, plus one representative of every
    // (confidence x has-date x md_manual) combination present in the corpus. A
    // fixture that is chosen by hand ends up sharing the code's blind spot —
    // which has happened four times in this repo.
    const NAMED = new Set([
      'Patrick Mahomes', 'Micah Parsons', 'Danny Pinter',
      'Ashton Jeanty', 'Alvin Kamara', 'Jayden Higgins',
    ]);
    const seenShapes = new Set<string>();
    const selected = threads.filter((t) => {
      if (t.athlete_name && NAMED.has(t.athlete_name)) return true;
      const shape = `${t.injury_date_confidence}|${t.injury_date ? 'dated' : 'no-date'}|${hasManualDate(t)}`;
      if (seenShapes.has(shape)) return false;
      seenShapes.add(shape);
      return true;
    });
    emit({
      _recorded_from: 'live production DB via src/scripts/date-resolution-dryrun.ts --emit-fixture',
      _recorded_at: today,
      _note:
        'web_thread_get entity payloads. Pins isSettledThreadDate against real column shapes ' +
        'and real date_resolution_sources arrays. Selection is mechanical (the six named ' +
        'flip-flop threads plus one per confidence/date/provenance shape). Never hand-author these.',
      _selected_from: threads.length,
      threads: selected,
    });
    return;
  }

  const audit = await loadAuditIndex(threads);

  console.log(`\n═══ date-resolution dry run (today=${today}) ═══`);
  sectionA(threads);
  sectionB(threads, audit);
  sectionC(threads);
  sectionE(threads, audit, mode);
  sectionD2(flag('--log'));
  await sectionD();

  console.log('\n═══ Verdict ═══\n');
  if (failures.length === 0) {
    console.log('  PASS — every gated number is zero.');
  } else {
    console.log('  FAIL');
    for (const f of failures) console.log(`    ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`[dryrun] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectAll().catch(() => {});
  });
