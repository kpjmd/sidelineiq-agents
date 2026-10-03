/**
 * Re-score physician closes under pre-registration Amendment 1.
 *
 * A1.4 says Amendment 1 applies to EVERY close. The detector's own closes were
 * re-scored on 2026-09-17 by reopening them and letting the detector close them
 * again. That route is closed to a physician's close, twice over:
 *   - web_thread_reopen CLEARS actual_return_date and return_source, so it
 *     would erase the date the MD typed and hand the thread to the detector,
 *     which would re-derive its own;
 *   - a system caller may not re-close a RESOLVED thread at all.
 * What remains is the path the tool already offers a person: a named MD may
 * close their own close again. This script makes that call with the MD's own
 * user id, the SAME return date and the A1.3 schedule answer, so the record is
 * recomputed by mcp `computeAccuracyRecord` — the one scoring path, no second
 * formula — and the date is untouched.
 *
 * ELIGIBILITY — its own predicate, deliberately narrow:
 *   status RESOLVED, return_source 'md', and an accuracy_record that is NULL or
 *   carries no `scoreable` key (written before 2026-09-15). Nothing else. It
 *   never borrows close-backfill-shells.ts' predicate, window or wording.
 *   --expect=<n> aborts unless exactly that many match.
 *
 * Every read happens before any write, so an ESPN failure part-way through
 * changes nothing. ESPN's split is the detector's: a 404 is a bad ROW (that
 * thread gets no censoring answer, recorded as null), a timeout/429/5xx is a
 * bad PAGE (abort the run).
 *
 * Usage:
 *   npx tsx src/scripts/rescore-md-closes.ts --expect=7                  # DRY RUN
 *   npx tsx src/scripts/rescore-md-closes.ts --expect=7 --md-user-id=<uuid> --apply --confirm
 *
 * --md-user-id must be a user whose role is 'md' (checked with web_get_user).
 * The close is recorded as that physician's act; run it only at their direction.
 */
import 'dotenv/config';
import { initializeMCPClients, callTool, isServerAvailable, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { loadGames, addWeeksIso } from '../monitoring/return-detector.js';
import { firstGameAfter } from '../monitoring/sports/espn-gamelog.js';
import { loadCalendarCensoring, type ScheduleCache } from '../monitoring/sports/espn-schedule.js';
import { localCalendarDate } from '../agents/injury-intelligence/season-calendar.js';

const ACTOR_ID = 'rescore-md-closes';
const AUDIT_ACTION = 'md_close_rescored_amendment_1';

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

interface Rec {
  scoreable?: boolean;
  within_range?: boolean | null;
  unscoreable_reason?: string | null;
  otm_min_weeks?: number | null;
  otm_max_weeks?: number | null;
  censored?: boolean | null;
  [k: string]: unknown;
}
interface Row {
  id: string;
  athlete_name: string | null;
  sport: string | null;
  status: string;
  injury_date: string | null;
  actual_return_date: string | null;
  return_source: string | null;
  espn_athlete_id: string | null;
  scored_window: { post_id: string; min_weeks: number; max_weeks: number } | null;
  accuracy_record: Rec | null;
}

function parse<T>(raw: unknown, what: string): T {
  if (isMCPError(raw)) throw new Error(`${what} failed: ${extractMCPErrorMessage(raw)}`);
  const text = (raw as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error(`${what} returned no content`);
  return JSON.parse(text) as T;
}

/** The eligibility predicate. Exported shape kept local: nothing else uses it. */
function isEligible(t: Row): boolean {
  return (
    t.status === 'RESOLVED' &&
    t.return_source === 'md' &&
    (t.accuracy_record == null || !('scoreable' in t.accuracy_record))
  );
}

async function listResolved(): Promise<Row[]> {
  const out: Row[] = [];
  let offset = 0;
  for (;;) {
    const page = parse<{ threads: Row[]; has_more?: boolean; next_offset?: number | null }>(
      await callTool('web', 'web_list_threads', { status: 'RESOLVED', limit: 500, offset }),
      'web_list_threads',
    );
    out.push(...page.threads);
    if (!page.has_more || page.next_offset == null || page.next_offset <= offset) break;
    offset = page.next_offset;
  }
  return out;
}

/** What computeAccuracyRecord will write, for the manifest only. mcp decides. */
function predict(t: Row, ret: string, censored: boolean | undefined): string {
  const w = t.scored_window;
  if (!w) return 'no_projection';
  if (!t.injury_date) return 'no_injury_date';
  const floor = addWeeksIso(t.injury_date, w.min_weeks);
  const ceil = addWeeksIso(t.injury_date, w.max_weeks);
  if (censored === true && ret >= floor) return 'calendar_censored';
  return `scored within_range=${ret >= floor && ret <= ceil} (${w.min_weeks}-${w.max_weeks}w)`;
}

function describeOld(r: Rec | null): string {
  if (!r) return 'NULL';
  return r.within_range == null ? `legacy within_range=null` : `legacy within_range=${r.within_range}`;
}

async function main(): Promise<void> {
  const apply = has('--apply');
  const confirm = has('--confirm');
  const expectRaw = opt('--expect');
  const mdUserId = opt('--md-user-id');

  await initializeMCPClients();
  if (!isServerAvailable('web')) throw new Error('web MCP is unavailable');

  const eligible = (await listResolved()).filter(isEligible);
  console.log(`\n═══ Re-score physician closes under Amendment 1 — ${apply ? 'APPLY' : 'DRY RUN'} ═══\n`);
  console.log(`  eligible: ${eligible.length}`);
  if (expectRaw === null) throw new Error('--expect=<n> is required; it is the blast-radius check');
  if (eligible.length !== Number(expectRaw)) {
    throw new Error(`expected exactly ${expectRaw} eligible threads, found ${eligible.length} — aborting, nothing written`);
  }

  // ── Every read before any write ──────────────────────────────────────
  const cache: ScheduleCache = new Map();
  const plan: Array<{ t: Row; ret: string; censored: boolean | undefined; predicted: string; note: string }> = [];
  for (const t of eligible) {
    const ret = t.actual_return_date ? String(t.actual_return_date).slice(0, 10) : null;
    if (!ret) throw new Error(`${t.id} has no actual_return_date — the predicate should not admit it`);
    let censored: boolean | undefined;
    let note = '';
    if (!t.injury_date) note = 'no injury_date: censoring not asked';
    else if (!t.espn_athlete_id) note = 'no ESPN id: censoring not asked';
    else if (t.sport !== 'NFL' && t.sport !== 'NBA') note = `sport ${t.sport}: no gamelog`;
    else {
      const today = localCalendarDate(new Date(), t.sport).date;
      const loaded = await loadGames(t.sport, t.espn_athlete_id, t.injury_date, today);
      const game = loaded?.games.find((g) => g.date === ret);
      // Shown, never written: an MD's date is theirs, and may not be a game day.
      const first = loaded ? firstGameAfter(loaded.games, t.injury_date) : null;
      if (!game) note = `no stat line on ${ret}: censoring unknown; first stat line after injury: ${first?.date ?? 'none'}`;
      else {
        const answer = await loadCalendarCensoring(t.sport, t.injury_date, game, cache);
        if (answer === null) note = 'schedule could not answer';
        else censored = answer;
      }
    }
    plan.push({ t, ret, censored, predicted: predict(t, ret, censored), note });
  }

  for (const p of plan) {
    console.log(
      `  ${p.t.id}  ${(p.t.athlete_name ?? '?').padEnd(20)} injury=${p.t.injury_date ?? '-'} return=${p.ret}\n` +
        `      now: ${describeOld(p.t.accuracy_record)}\n` +
        `      after: ${p.predicted}   return_censored=${p.censored === undefined ? '(omitted → null)' : p.censored}` +
        `${p.note ? `   [${p.note}]` : ''}`,
    );
  }

  if (!apply) {
    console.log('\n  DRY RUN — nothing written. Re-run with --md-user-id=<uuid> --apply --confirm.\n');
    return;
  }
  if (!confirm) throw new Error('--apply needs --confirm as well');
  if (!mdUserId) throw new Error('--apply needs --md-user-id=<uuid>');
  const user = parse<{ user: { id: string; role: string } | null }>(
    await callTool('web', 'web_get_user', { user_id: mdUserId }),
    'web_get_user',
  ).user;
  if (!user || user.role !== 'md') throw new Error(`${mdUserId} is not a user with role 'md' — aborting, nothing written`);

  // ── Writes ───────────────────────────────────────────────────────────
  let failed = 0;
  for (const p of plan) {
    const closeRes = await callTool('web', 'web_thread_close', {
      entity_id: p.t.id,
      outcome: 'RESOLVED',
      actual_return_date: p.ret,
      closed_by: mdUserId,
      return_source: 'md',
      ...(p.censored === undefined ? {} : { return_censored: p.censored }),
    });
    if (isMCPError(closeRes)) {
      failed++;
      console.error(`  CLOSE FAILED ${p.t.id}: ${extractMCPErrorMessage(closeRes)}`);
      continue;
    }
    const auditRes = await callTool('web', 'web_audit_append', {
      actor: 'automation',
      actor_id: ACTOR_ID,
      entity_type: 'injury_thread',
      entity_id: p.t.id,
      action: AUDIT_ACTION,
      payload: {
        authorized_by: mdUserId,
        previous_accuracy_record: p.t.accuracy_record,
        actual_return_date: p.ret,
        return_censored: p.censored ?? null,
        reason:
          'Pre-registration Amendment 1 (A1.4) applies to every close. A physician close cannot be reopened without erasing its return date, so the physician re-closed it with the same date to recompute the record through computeAccuracyRecord.',
      },
    });
    if (isMCPError(auditRes)) console.warn(`  audit append failed for ${p.t.id}: ${extractMCPErrorMessage(auditRes)}`);
  }

  // ── Read back ────────────────────────────────────────────────────────
  console.log('\n─── Read back ───');
  for (const p of plan) {
    const got = parse<{ entity: Row }>(await callTool('web', 'web_thread_get', { entity_id: p.t.id }), 'web_thread_get').entity;
    const r = got.accuracy_record;
    const dateKept = String(got.actual_return_date).slice(0, 10) === p.ret && got.return_source === 'md';
    if (!dateKept) failed++;
    console.log(
      `  ${(p.t.athlete_name ?? '?').padEnd(20)} ${r?.scoreable ? `scored within_range=${r.within_range}` : r?.unscoreable_reason ?? 'NULL'}` +
        ` censored=${r?.censored ?? null} date_kept=${dateKept}`,
    );
  }
  if (failed > 0) {
    process.exitCode = 1;
    console.error(`\n  ${failed} failure(s).`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
