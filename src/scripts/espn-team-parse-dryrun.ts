/**
 * Read-only dry run for the ESPN injuries-feed team parse.
 *
 * `parse()` read the team from `group.team.*`. The live feed names it on the
 * GROUP (`{ id, displayName, injuries }`) and has no `team` object, so every
 * row parsed as `team: 'Unknown'`. fact-validator treats Unknown as a gap and
 * fills it from the roster, so for ESPN feed rows the team check never compared
 * anything. Reading the group turns that check back on for every feed row:
 *
 *   - team_mismatch            hard DROP  (T3/unknown source)
 *   - team_mismatch_unconfirmed soft, forces MD review (T1/T2 — ESPN is T1)
 *
 * The numbers that MUST BE ZERO:
 *   1. rows whose parse differs in anything OTHER than `team`
 *   2. new hard drops
 *   3. new forced reviews on a row whose roster team (resolved by ESPN athlete
 *      id, the strong key) actually matches ESPN's team
 *
 * Everything else that changes is printed row by row for a human to judge —
 * a new forced review where the roster disagrees with ESPN is the check doing
 * its job (a stale roster or an ESPN mis-file), not a regression.
 *
 * Two resolutions per row, both read-only `web_resolve_player`:
 *   - by NAME — what the poller does today. parse() carries no espn_athlete_id
 *     for feed rows, so this is the production-faithful arm, and it is the one
 *     the before/after outcomes are scored on.
 *   - by ESPN athlete ID — the ground truth for "what team does OUR roster say
 *     this athlete is on". Read out of `athlete.links[].href` (`/id/<n>/`).
 *
 * Not modelled: the athlete re-anchor (needs the classifier). For a feed row it
 * overwrites event.team WITH the roster team, so it can only turn a mismatch
 * into a match — the counts here are an upper bound.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=<repo>/.env npx tsx src/scripts/espn-team-parse-dryrun.ts
 *   … [--sport NFL|NBA] [--max-age-days N] [--concurrency N]
 *   … --emit-fixture tests/fixtures/espn-injuries-team-shape.json   (no MCP)
 *
 * WEB_MCP_URL must be the PUBLIC endpoint. Exits non-zero if any must-be-zero
 * number is non-zero, or if any resolve call failed (a failed lookup is a bad
 * PAGE, not "no such player" — it is never scored).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';
import { callTool, initializeMCPClients, disconnectAll, isServerAvailable } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import {
  validateEvent,
  teamClaimCheck,
  type ResolvedPlayerInfo,
  type ValidationResult,
} from '../agents/injury-intelligence/fact-validator.js';
import { partitionSoftFailures } from '../monitoring/poller.js';
import type { RawInjuryEvent, SportKey } from '../types.js';

// ── Raw feed shape (only what this script reads) ─────────────────────────
interface RawTeam {
  id?: string;
  displayName?: string;
}
interface RawRecord {
  date?: string;
  status?: string;
  athlete?: {
    displayName?: string;
    fullName?: string;
    team?: RawTeam;
    links?: Array<{ href?: string }>;
  };
}
interface RawGroup {
  id?: string;
  displayName?: string;
  team?: unknown;
  injuries?: RawRecord[];
}
interface RawFeed {
  injuries?: RawGroup[];
  [k: string]: unknown;
}

const SOURCES: Record<'NFL' | 'NBA', () => ESPNNFLSource | ESPNNBASource> = {
  NFL: () => new ESPNNFLSource(),
  NBA: () => new ESPNNBASource(),
};

type Parser = { parse: (f: unknown) => RawInjuryEvent[]; url: string };

function athleteIdOf(r: RawRecord): string | undefined {
  for (const l of r.athlete?.links ?? []) {
    const m = l.href?.match(/\/id\/(\d+)(?:\/|$)/);
    if (m) return m[1];
  }
  return undefined;
}

/** Joins a parsed event back to its raw row (for the athlete id). */
const rowKey = (team: string | undefined, name: string, at: Date | null): string =>
  `${team}|${name}|${at?.getTime()}`;

/**
 * The feed exactly as the OLD code saw it. The old chain read ONLY
 * `group.team.*`; deleting the group-level fields the new chain reads makes the
 * new code reproduce the old result byte for byte, with no copy of the old
 * function to drift.
 */
function asLegacyFeed(feed: RawFeed): RawFeed {
  const clone = structuredClone(feed);
  for (const g of clone.injuries ?? []) {
    delete g.displayName;
    delete g.id;
  }
  return clone;
}

// ── Resolution ───────────────────────────────────────────────────────────
class ResolveFailed extends Error {}

async function resolve(
  name: string,
  sport: SportKey,
  espnAthleteId?: string,
): Promise<ResolvedPlayerInfo | null> {
  // Same call shape as poller.resolvePlayer, minus its catch: a failure there
  // degrades to "unresolved", which here would be scored as an outcome.
  const res = await callTool('web', 'web_resolve_player', {
    name,
    sport,
    ...(espnAthleteId && { espn_athlete_id: espnAthleteId }),
  });
  if (isMCPError(res)) throw new ResolveFailed(`${name}: ${extractMCPErrorMessage(res)}`);
  const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new ResolveFailed(`${name}: empty response`);
  const parsed = JSON.parse(text) as { resolved: boolean; player: ResolvedPlayerInfo | null };
  return parsed.resolved ? parsed.player : null;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ── Outcome ──────────────────────────────────────────────────────────────
type Verdict = 'DROP' | 'REVIEW' | 'PASS';

interface Outcome {
  verdict: Verdict;
  hard: string[];
  forcing: string[];
  annotate: string[];
  teamCorrection: string | null;
}

function outcomeOf(v: ValidationResult): Outcome {
  const { forcing, annotateOnly } = partitionSoftFailures(v.softFailures);
  const verdict: Verdict = !v.passed ? 'DROP' : forcing.length > 0 ? 'REVIEW' : 'PASS';
  const corr = v.corrections.find((c) => c.field === 'team');
  return {
    verdict,
    hard: v.hardFailures.map((f) => f.code),
    forcing: forcing.map((f) => f.code),
    annotate: annotateOnly.map((f) => f.code),
    teamCorrection: corr ? `${corr.from} → ${corr.to}` : null,
  };
}

const sameCodes = (a: Outcome, b: Outcome): boolean =>
  a.verdict === b.verdict &&
  a.hard.join() === b.hard.join() &&
  a.forcing.join() === b.forcing.join() &&
  a.annotate.join() === b.annotate.join();

const rosterTeamOf = (p: ResolvedPlayerInfo | null): string =>
  !p
    ? '(unresolved)'
    : p.confidence === 'ambiguous'
      ? `(ambiguous ×${p.match_count})`
      : (p.current_team_name ?? p.current_team_abbreviation ?? '(no team)');

// ── Fixture ──────────────────────────────────────────────────────────────
const FIXTURE_NFL_GROUPS = 3;

/**
 * The reduction is uniform and stated in the file. No key is dropped because
 * the parser ignores it, and nothing is flattened — the group-level
 * `{id, displayName}` and the stale `athlete.team` are exactly as served, which
 * is the whole point of this fixture.
 */
function reduce(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(reduce);
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'logos' || k === 'headshot') continue;
      out[k] = k === 'links' && Array.isArray(v) ? v.slice(0, 1).map(reduce) : reduce(v);
    }
    return out;
  }
  return o;
}

async function emitFixture(path: string): Promise<void> {
  const cases: Record<string, unknown> = {};
  for (const sport of ['NFL', 'NBA'] as const) {
    const url = (SOURCES[sport]() as unknown as Parser).url;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${sport}: HTTP ${res.status}`);
    const feed = reduce(await res.json()) as RawFeed;
    if (sport === 'NFL') feed.injuries = (feed.injuries ?? []).slice(0, FIXTURE_NFL_GROUPS);
    cases[sport] = feed;
  }
  const body = {
    _recorded_from: 'https://site.api.espn.com/apis/site/v2/sports/{football/nfl,basketball/nba}/injuries',
    _recorded_at: new Date().toISOString(),
    _note:
      'Recorded live, verbatim. Do not hand-edit. The 2026-08-19 espn-nfl-injuries.json pruned every team field, ' +
      "so it could not show that the live group is {id, displayName, injuries} with no 'team' object — which is " +
      "why parse() set team: 'Unknown' on every row.",
    _reduction:
      'Uniform transformations applied to every body, and nothing else: (1) every \'logos\' array and every ' +
      "'headshot' object is removed — image URLs; (2) every 'links' array is truncated to its first element, " +
      "which preserves athlete.links[0].href (the only place a feed row carries the ESPN athlete id); " +
      `(3) NFL keeps only the first ${FIXTURE_NFL_GROUPS} team groups in served order, whole — the full feed is ~2.8MB. ` +
      'NBA is complete: it carries the traded athletes whose athlete.team is stale.',
    cases,
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  console.log(`[dryrun] fixture written to ${path}`);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };

  const fixturePath = flag('--emit-fixture');
  if (fixturePath) return emitFixture(fixturePath);

  const sportArg = flag('--sport')?.toUpperCase();
  const sports = (sportArg ? [sportArg] : ['NFL', 'NBA']) as Array<'NFL' | 'NBA'>;
  // Every row by default: the question is what the parse does to the feed,
  // not to today's recency window.
  process.env.MAX_EVENT_AGE_DAYS = flag('--max-age-days') ?? '100000';
  const concurrency = Number(flag('--concurrency') ?? 6);

  // Only the web server is needed, and only for reads. Unset the rest so this
  // never so much as opens a connection to a publishing server.
  delete process.env.FARCASTER_MCP_URL;
  delete process.env.TWITTER_MCP_URL;
  delete process.env.X_API_MCP_URL;
  if (!process.env.WEB_MCP_URL?.startsWith('https://')) {
    throw new Error('WEB_MCP_URL must be set to the PUBLIC https endpoint');
  }
  await initializeMCPClients();
  if (!isServerAvailable('web')) throw new Error('web MCP server unavailable');

  const now = new Date();
  const zero = { otherFieldDiffs: 0, newHardDrops: 0, newReviewsRosterAgrees: 0, resolveFailures: 0 };

  try {
    for (const sport of sports) {
      const parser = SOURCES[sport]() as unknown as Parser;
      const res = await fetch(parser.url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${sport}: HTTP ${res.status} from ${parser.url}`);
      const feed = (await res.json()) as RawFeed;
      const groups = feed.injuries ?? [];

      // ── A. Shape ────────────────────────────────────────────────────────
      console.log(`\n══ ${sport} — A. FEED SHAPE ══════════════════════════════════════`);
      const groupKeys = new Map<string, number>();
      let rawRows = 0;
      let rowsWithAthleteTeam = 0;
      const disagree: Array<[string, string, string, string]> = [];
      const idByKey = new Map<string, string | undefined>();
      const athleteTeamByKey = new Map<string, string | undefined>();
      for (const g of groups) {
        const k = Object.keys(g).sort().join(',');
        groupKeys.set(k, (groupKeys.get(k) ?? 0) + 1);
        for (const r of g.injuries ?? []) {
          rawRows++;
          const at = r.athlete?.team?.displayName;
          if (at) rowsWithAthleteTeam++;
          const name = r.athlete?.displayName ?? r.athlete?.fullName ?? '';
          if (at && at !== g.displayName) disagree.push([name, g.displayName ?? '?', at, r.status ?? '']);
          const key = rowKey(g.displayName, name, r.date ? new Date(r.date) : null);
          idByKey.set(key, athleteIdOf(r));
          athleteTeamByKey.set(key, at);
        }
      }
      for (const [k, n] of groupKeys) console.log(`  group keys {${k}} × ${n}`);
      console.log(`  groups with a nested 'team' object: ${groups.filter((g) => g.team !== undefined).length} of ${groups.length}`);
      console.log(`  raw rows ${rawRows}; rows carrying athlete.team ${rowsWithAthleteTeam}`);
      console.log(`  rows whose athlete.team ≠ group.displayName: ${disagree.length}`);
      for (const [n, g, a, s] of disagree) console.log(`    ${n.padEnd(24)} group="${g}"  athlete.team="${a}"  (${s})`);

      // ── B. Parse both ways ─────────────────────────────────────────────
      const silence = console.log;
      console.log = () => {};
      const oldEvents = parser.parse(asLegacyFeed(feed));
      const newEvents = parser.parse(feed);
      console.log = silence;

      console.log(`\n══ ${sport} — B. PARSE OLD vs NEW ═══════════════════════════════`);
      const tally = (evs: RawInjuryEvent[]) => evs.filter((e) => e.team === 'Unknown').length;
      console.log(`  parsed rows: old ${oldEvents.length}, new ${newEvents.length}`);
      console.log(`  team 'Unknown': old ${tally(oldEvents)}, new ${tally(newEvents)}`);
      if (oldEvents.length !== newEvents.length) zero.otherFieldDiffs += Math.abs(oldEvents.length - newEvents.length);
      let otherDiffs = 0;
      for (let i = 0; i < Math.min(oldEvents.length, newEvents.length); i++) {
        const a = { ...oldEvents[i], team: null };
        const b = { ...newEvents[i], team: null };
        if (JSON.stringify(a) !== JSON.stringify(b)) otherDiffs++;
      }
      zero.otherFieldDiffs += otherDiffs;
      console.log(`  rows differing in anything other than team: ${otherDiffs}   ← MUST BE 0`);

      // ── C. Resolve + validate ──────────────────────────────────────────
      interface Row {
        oldE: RawInjuryEvent;
        newE: RawInjuryEvent;
        espnId?: string;
        athleteTeam?: string;
        byName: ResolvedPlayerInfo | null;
        byId: ResolvedPlayerInfo | null;
        before: Outcome;
        after: Outcome;
      }
      let done = 0;
      const rows = await pool(newEvents.map((e, i) => [oldEvents[i], e] as const), concurrency, async ([oldE, newE]) => {
        const key = rowKey(newE.team, newE.athlete_name, newE.reported_at);
        const espnId = idByKey.get(key);
        let byName: ResolvedPlayerInfo | null = null;
        let byId: ResolvedPlayerInfo | null = null;
        try {
          byName = await resolve(newE.athlete_name, sport);
          byId = espnId ? await resolve(newE.athlete_name, sport, espnId) : null;
        } catch (err) {
          zero.resolveFailures++;
          console.error(`  RESOLVE FAILED ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
        const before = outcomeOf(await validateEvent(oldE, byName, { now }));
        const after = outcomeOf(await validateEvent(newE, byName, { now }));
        if (++done % 100 === 0) process.stderr.write(`  … ${sport} ${done}/${newEvents.length}\n`);
        const row: Row = { oldE, newE, espnId, athleteTeam: athleteTeamByKey.get(key), byName, byId, before, after };
        return row;
      });
      const scored = rows.filter((r): r is Row => r !== null);

      console.log(`\n══ ${sport} — C. RESOLUTION ═════════════════════════════════════`);
      const noId = scored.filter((r) => !r.espnId).length;
      const byConf = (pick: (r: Row) => ResolvedPlayerInfo | null) => {
        const m = new Map<string, number>();
        for (const r of scored) {
          const p = pick(r);
          const k = p ? p.confidence : 'miss';
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        return [...m].map(([k, n]) => `${k}=${n}`).join(' ');
      };
      console.log(`  scored ${scored.length} of ${newEvents.length} (resolve failures ${newEvents.length - scored.length})`);
      console.log(`  rows with no ESPN athlete id in links: ${noId}`);
      console.log(`  by name (production): ${byConf((r) => r.byName)}`);
      console.log(`  by ESPN id (truth):    ${byConf((r) => r.byId)}`);
      const idDrift = scored.filter((r) => r.byName && r.byId && r.byName.player_id !== r.byId.player_id);
      console.log(`  name lookup lands elsewhere than id lookup (ambiguous or another player): ${idDrift.length}`);
      for (const r of idDrift) {
        console.log(`    ${r.newE.athlete_name}: name→${r.byName!.full_name} (${rosterTeamOf(r.byName)}) id→${r.byId!.full_name} (${rosterTeamOf(r.byId)})`);
      }

      // Does OUR roster (by id) agree with ESPN's group team?
      const rosterAgrees = (r: Row): boolean | null => {
        if (!r.byId || r.byId.confidence === 'ambiguous') return null;
        const c = teamClaimCheck(r.newE.team, r.byId);
        return c === 'match' ? true : c === 'mismatch' ? false : null;
      };
      const agreeCounts = { agree: 0, disagree: 0, unknown: 0 };
      for (const r of scored) {
        const a = rosterAgrees(r);
        agreeCounts[a === true ? 'agree' : a === false ? 'disagree' : 'unknown']++;
      }
      console.log(`  roster team (by id) vs ESPN group team: agree=${agreeCounts.agree} disagree=${agreeCounts.disagree} uncheckable=${agreeCounts.unknown}`);
      // The counterfactual for the field parse() deliberately does NOT read.
      // athlete.team is stale across trades; this is how many rows it would
      // have put in front of the MD for nothing.
      const athleteTeamWrong = scored.filter(
        (r) => r.athleteTeam && r.byId && r.byId.confidence !== 'ambiguous' &&
          teamClaimCheck(r.athleteTeam, r.byId) === 'mismatch' && rosterAgrees(r) === true,
      );
      console.log(`  rows where athlete.team would contradict a roster that AGREES with the group: ${athleteTeamWrong.length}`);
      for (const r of athleteTeamWrong) {
        console.log(`    ${r.newE.athlete_name.padEnd(24)} athlete.team="${r.athleteTeam}"  group/roster="${r.newE.team}"`);
      }

      // ── D. Outcome transitions ─────────────────────────────────────────
      console.log(`\n══ ${sport} — D. VALIDATION OUTCOME, OLD → NEW ══════════════════`);
      const trans = new Map<string, number>();
      for (const r of scored) {
        const k = `${r.before.verdict} → ${r.after.verdict}`;
        trans.set(k, (trans.get(k) ?? 0) + 1);
      }
      for (const [k, n] of [...trans].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);
      const changedCodes = scored.filter((r) => !sameCodes(r.before, r.after));
      console.log(`  rows whose failure codes changed: ${changedCodes.length}`);
      const corrBefore = scored.filter((r) => r.before.teamCorrection).length;
      const corrAfter = scored.filter((r) => r.after.teamCorrection).length;
      console.log(`  rows carrying a roster team correction: old ${corrBefore}, new ${corrAfter}`);

      const newDrops = scored.filter((r) => r.after.verdict === 'DROP' && r.before.verdict !== 'DROP');
      const newReviews = scored.filter((r) => r.after.verdict === 'REVIEW' && r.before.verdict === 'PASS');
      const addedForcing = scored.filter((r) => r.after.forcing.some((c) => !r.before.forcing.includes(c)));
      const newReviewsRosterAgrees = addedForcing.filter((r) => rosterAgrees(r) === true);
      zero.newHardDrops += newDrops.length;
      zero.newReviewsRosterAgrees += newReviewsRosterAgrees.length;

      console.log(`\n  new hard drops:                                      ${newDrops.length}   ← MUST BE 0`);
      console.log(`  new forced reviews (PASS → REVIEW):                  ${newReviews.length}`);
      console.log(`  rows gaining a forcing code (incl. already-REVIEW):  ${addedForcing.length}`);
      console.log(`  …of which roster-by-id AGREES with ESPN's team:      ${newReviewsRosterAgrees.length}   ← MUST BE 0`);

      const detail = (r: Row) =>
        `    ${r.newE.athlete_name.padEnd(24)} ${r.before.verdict}→${r.after.verdict}  ` +
        `+[${r.after.forcing.filter((c) => !r.before.forcing.includes(c)).concat(r.after.hard.filter((c) => !r.before.hard.includes(c))).join(',')}]\n` +
        `      ESPN group="${r.newE.team}"  athlete.team="${r.athleteTeam ?? '-'}"  ` +
        `roster(name)="${rosterTeamOf(r.byName)}"  roster(id ${r.espnId ?? '-'})="${rosterTeamOf(r.byId)}"  ` +
        `status=${r.newE.athlete_status ?? '-'} reported=${r.newE.reported_at.toISOString().slice(0, 10)}`;
      if (newDrops.length) {
        console.log('\n  NEW HARD DROPS:');
        newDrops.forEach((r) => console.log(detail(r)));
      }
      if (addedForcing.length) {
        console.log('\n  ROWS GAINING A FORCING CODE (judge each — roster stale, or ESPN mis-filed?):');
        addedForcing.forEach((r) => console.log(detail(r)));
      }
      const lostForcing = scored.filter((r) => r.before.forcing.some((c) => !r.after.forcing.includes(c)));
      console.log(`\n  rows LOSING a forcing code: ${lostForcing.length}`);
      lostForcing.forEach((r) => console.log(detail(r)));
    }
  } finally {
    await disconnectAll();
  }

  console.log('\n══ MUST-BE-ZERO SUMMARY ══════════════════════════════════════════');
  console.log(`  rows differing in anything other than team        ${zero.otherFieldDiffs}`);
  console.log(`  new hard drops                                    ${zero.newHardDrops}`);
  console.log(`  new forced reviews where roster(id) agrees w/ ESPN ${zero.newReviewsRosterAgrees}`);
  console.log(`  resolve failures (run is not trustworthy if > 0)  ${zero.resolveFailures}`);
  const bad = Object.values(zero).some((n) => n > 0);
  console.log(bad ? '\n  FAIL' : '\n  PASS');
  process.exitCode = bad ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
