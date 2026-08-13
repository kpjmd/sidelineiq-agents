// Audits data/athlete-tiers.json against live ESPN rosters and, for every
// curated athlete who is genuinely gone, asks ESPN where they actually are.
//
// READ-ONLY. Fetches ESPN, reads the players table through MCP, writes nothing.
//
// Why this exists as a script and not a one-off query: the interesting number
// is not "how many curated names are missing from the roster feed" — a plain
// lowercase/strip comparison answers that and answers it WRONG, because
// "Anthony Richardson Sr." and "Anthony Richardson" are the same person and the
// real lookup already knows it. This reuses isSameAthleteName, the exported
// face of looseNameKey, so the count it reports is the count the tier lookup
// would actually experience.
//
// Sections:
//   A  Naive vs. loose absence. Prints the phantoms the naive count invents.
//   B  Where each genuinely-absent athlete actually is, per ESPN's athlete
//      endpoint: FREE_AGENT / RETIRED / MOVED_IN_COVERAGE / MOVED_OUT_OF_
//      COVERAGE / UNKNOWN. Absence from a roster feed is evidence of none of
//      these on its own — that is the migration 018 lesson — so anything we
//      cannot positively confirm is reported UNKNOWN and stays UNKNOWN.
//   C  The cost of deleting each absent entry: the tier they would land on if
//      the entry were removed, computed by actually removing it and re-running
//      the real lookup against the live salary snapshot.
//   D  Curated tier vs. current contract, for entries whose athlete IS still
//      rostered. Only the suppressing direction is a defect — see the section.
//   E  Cross-sport salary attribution, the check that caught the Braden Smith
//      bug fixed in PR #18. Expected to stay at zero.
//
// Usage:
//   npx tsx src/scripts/tier-file-audit.ts
//   npx tsx src/scripts/tier-file-audit.ts --json out.json
//   npx tsx src/scripts/tier-file-audit.ts --no-espn-lookup   # skip section B

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import {
  loadSignificanceData,
  lookupAthleteTier,
  isSameAthleteName,
  setSalarySnapshot,
  salarySnapshotSize,
  tierFromSalary,
  _setTiersForTesting,
} from '../agents/injury-intelligence/significance.js';
import { ESPN_ROSTERED_SOURCES } from '../monitoring/roster-sync.js';
import type { SportKey, AthleteTier } from '../types.js';

const SPORTS: Array<'NFL' | 'NBA'> = ['NFL', 'NBA'];

// Below these, the feed is broken rather than the file being wrong, and every
// conclusion this script draws would be inverted. fetchTeams returns [] on any
// failure; a partial fetch is the same class of lie, just quieter.
const MIN_PLAUSIBLE_ROSTER: Record<string, number> = { NFL: 2000, NBA: 400 };

// The athlete endpoint needs the LEAGUE segment for NFL/NBA. The sport-only
// form used for soccer in reconcile-coverage-scope.ts returns HTTP 400 here —
// soccer is the exception, not the rule, because its leagues share an athlete
// namespace.
const ATHLETE_LEAGUE_PATH: Record<string, string> = {
  NFL: 'football/nfl',
  NBA: 'basketball/nba',
};
const ATHLETE_ENDPOINT = 'https://site.web.api.espn.com/apis/common/v3/sports';
const SEARCH_ENDPOINT = 'https://site.web.api.espn.com/apis/search/v2';
const REQUEST_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJSON<T>(url: string): Promise<T | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      // 400/404 are ANSWERS ("no such athlete"), not failures.
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === 3) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[audit]   fetch failed after 3 attempts: ${url} — ${message}`);
        return null;
      }
      await sleep(REQUEST_DELAY_MS * attempt * 2);
    }
  }
  return null;
}

// ── Data shapes ──────────────────────────────────────────────────────────────

interface TierEntry {
  name: string;
  sport: string;
  tier: AthleteTier;
}
interface TiersFile {
  version: number;
  updated_at: string;
  notes?: string;
  athletes: TierEntry[];
}

interface Rostered {
  name: string;
  espn_athlete_id: string;
  sport: SportKey;
  team: string;
  salary?: number;
}

/**
 * What ESPN can actually tell us. Note what is NOT in this list: RETIRED.
 *
 * ESPN has no retired status. Tom Brady (id 2330), four years retired, reports
 * `active: false`, `status.type: "inactive"` and `team: Tampa Bay Buccaneers` —
 * character for character what an unsigned 26-year-old reports. Retirement is a
 * strict subset of INACTIVE that this endpoint does not expose, so the audit
 * reports INACTIVE and refuses to guess which of them hung it up.
 *
 * `active` is not the discriminator either: it is false for every NBA free
 * agent and true for every NFL one. Only `status.type` is consistent.
 */
type Verdict =
  | 'FREE_AGENT'
  | 'INACTIVE'
  | 'MOVED_IN_COVERAGE'
  | 'MOVED_OUT_OF_COVERAGE'
  | 'RENAMED'
  | 'UNKNOWN';

interface AbsentFinding {
  name: string;
  sport: SportKey;
  curated_tier: AthleteTier;
  espn_athlete_id: string | null;
  espn_display_name?: string;
  espn_status?: string;
  espn_team?: string;
  verdict: Verdict;
  /** Tier this athlete would receive if the entry were deleted. */
  tier_if_removed: AthleteTier;
  tier_if_removed_source: 'lookup' | 'salary' | 'default';
}

interface MCPResult {
  content?: Array<{ text?: string }>;
}
function unwrap<T>(res: unknown): T | null {
  try {
    const text = (res as MCPResult)?.content?.[0]?.text;
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

// ── Sourcing ─────────────────────────────────────────────────────────────────

async function fetchRosters(): Promise<Rostered[]> {
  const out: Rostered[] = [];
  for (const sport of SPORTS) {
    const source = ESPN_ROSTERED_SOURCES[sport];
    const teams = await source.fetchTeams();
    for (const team of teams) {
      const athletes = await source.fetchRoster(team.espn_team_id);
      for (const a of athletes) {
        out.push({
          name: a.full_name,
          espn_athlete_id: a.espn_athlete_id,
          sport,
          team: team.display_name ?? team.name,
          salary: a.salary,
        });
      }
    }
    const n = out.filter((r) => r.sport === sport).length;
    console.log(`  ${sport}: ${teams.length} teams, ${n} rostered athletes`);
    if (n < MIN_PLAUSIBLE_ROSTER[sport]) {
      throw new Error(
        `${sport} roster fetch returned ${n} athletes (< ${MIN_PLAUSIBLE_ROSTER[sport]}). ` +
          `Refusing to draw conclusions from a feed this thin — every "missing" athlete ` +
          `below would be an artifact of the fetch, not the file.`,
      );
    }
  }
  return out;
}

interface DbPlayer {
  espn_athlete_id: string | null;
  full_name: string;
  sport: string;
  retired_at: string | null;
}

async function fetchDbPlayers(): Promise<DbPlayer[]> {
  const out: DbPlayer[] = [];
  for (const sport of SPORTS) {
    let offset = 0;
    for (;;) {
      const res = await callTool('web', 'web_list_players', {
        sport,
        coverage: 'all',
        limit: 200,
        offset,
      });
      const page = unwrap<{ players?: DbPlayer[]; has_more?: boolean; next_offset?: number }>(res);
      if (!page?.players?.length) break;
      out.push(...page.players);
      if (!page.has_more) break;
      offset = page.next_offset ?? offset + 200;
    }
  }
  return out;
}

// ── ESPN identity resolution ─────────────────────────────────────────────────

interface SearchResponse {
  results?: Array<{
    type?: string;
    contents?: Array<{ uid?: string; displayName?: string; defaultLeagueSlug?: string }>;
  }>;
}

/** ESPN athlete id for a name, via the site search, scoped to the league. */
async function searchAthleteId(name: string, sport: SportKey): Promise<string | null> {
  const slug = sport.toLowerCase();
  const body = await getJSON<SearchResponse>(
    `${SEARCH_ENDPOINT}?query=${encodeURIComponent(name)}&limit=10`,
  );
  const players = body?.results?.find((r) => r.type === 'player')?.contents ?? [];
  const hits = players.filter(
    (p) => p.defaultLeagueSlug === slug && p.displayName && isSameAthleteName(p.displayName, name),
  );
  // Ambiguity is not resolved by guessing. Two same-named players in one league
  // is exactly the case the salary index refuses to answer, for the same reason.
  if (hits.length !== 1) return null;
  const uid = hits[0].uid ?? '';
  const m = /a:(\d+)/.exec(uid);
  return m ? m[1] : null;
}

interface AthleteResponse {
  athlete?: {
    displayName?: string;
    fullName?: string;
    active?: boolean;
    status?: { name?: string; type?: string };
    team?: { displayName?: string; name?: string } | null;
  };
}

async function fetchAthlete(id: string, sport: SportKey): Promise<AthleteResponse['athlete'] | null> {
  const path = ATHLETE_LEAGUE_PATH[sport];
  if (!path) return null;
  const body = await getJSON<AthleteResponse>(`${ATHLETE_ENDPOINT}/${path}/athletes/${id}`);
  return body?.athlete ?? null;
}

function classify(
  athlete: NonNullable<AthleteResponse['athlete']>,
  curatedName: string,
  coveredTeams: Set<string>,
): Verdict {
  const statusType = (athlete.status?.type ?? '').toLowerCase();
  const teamName = athlete.team?.displayName ?? athlete.team?.name ?? '';

  // Status first, and status ONLY. `team` on a free agent or an inactive
  // athlete is their LAST club, not a current one, so a team-first classifier
  // reports every unsigned veteran as still rostered.
  if (statusType === 'free-agent') return 'FREE_AGENT';
  if (statusType === 'inactive') return 'INACTIVE';

  if (statusType !== 'active') return 'UNKNOWN';

  const espnName = athlete.fullName ?? athlete.displayName ?? '';
  if (espnName && !isSameAthleteName(espnName, curatedName) && teamName && coveredTeams.has(teamName)) {
    return 'RENAMED';
  }
  if (teamName && coveredTeams.has(teamName)) return 'MOVED_IN_COVERAGE';
  if (teamName) return 'MOVED_OUT_OF_COVERAGE';
  return 'UNKNOWN';
}

// ── main ─────────────────────────────────────────────────────────────────────

function naiveKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonArg = args.indexOf('--json');
  const skipEspn = args.includes('--no-espn-lookup');

  const here = dirname(fileURLToPath(import.meta.url));
  const tiersPath = resolve(here, '..', '..', 'data', 'athlete-tiers.json');
  const tiers = JSON.parse(await readFile(tiersPath, 'utf-8')) as TiersFile;

  await initializeMCPClients();
  await loadSignificanceData();

  console.log('[audit] fetching ESPN rosters...');
  const rostered = await fetchRosters();
  setSalarySnapshot(
    rostered
      .filter((r) => typeof r.salary === 'number' && r.salary > 0)
      .map((r) => ({ full_name: r.name, sport: r.sport, salary: r.salary as number })),
  );
  console.log(`[audit] ${salarySnapshotSize()} salaried athletes indexed`);

  const coveredTeams = new Set(rostered.map((r) => r.team));

  // ── A. naive vs loose ──
  console.log('\n══ A. ABSENCE, MEASURED TWO WAYS ══════════════════════════════════');
  const naiveRostered = new Set(rostered.map((r) => `${r.sport}|${naiveKey(r.name)}`));
  const curated = tiers.athletes.filter((a) => SPORTS.includes(a.sport as 'NFL' | 'NBA'));

  const naiveMissing: TierEntry[] = [];
  const looseMissing: TierEntry[] = [];
  const matchedRoster = new Map<TierEntry, Rostered>();
  const ambiguous: Array<{ entry: TierEntry; hits: Rostered[] }> = [];

  for (const entry of curated) {
    const sport = entry.sport as SportKey;
    const pool = rostered.filter((r) => r.sport === sport);
    if (!naiveRostered.has(`${sport}|${naiveKey(entry.name)}`)) naiveMissing.push(entry);
    // All matches, not the first: two same-named athletes on different rosters
    // is common enough in the NFL that .find() would silently pick one and
    // report the other's club as a stale `team` in section D.
    const hits = pool.filter((r) => isSameAthleteName(r.name, entry.name));
    if (hits.length === 1) matchedRoster.set(entry, hits[0]);
    else if (hits.length > 1) ambiguous.push({ entry, hits });
    else looseMissing.push(entry);
  }

  for (const sport of SPORTS) {
    const n = curated.filter((e) => e.sport === sport).length;
    const naive = naiveMissing.filter((e) => e.sport === sport).length;
    const loose = looseMissing.filter((e) => e.sport === sport).length;
    console.log(`  ${sport}: ${n} curated — naive says ${naive} missing, looseNameKey says ${loose}`);
  }

  if (ambiguous.length > 0) {
    console.log(`\n  ${ambiguous.length} curated name(s) match MORE than one rostered athlete:`);
    for (const a of ambiguous) {
      console.log(
        `    ${a.entry.sport.padEnd(4)} "${a.entry.name}" → ${a.hits.map((h) => `${h.name} (${h.team})`).join(', ')}`,
      );
    }
    console.log('  Neither present nor absent — the tier lookup refuses these too. Reported, not guessed.');
  }

  const phantoms = naiveMissing.filter((e) => !looseMissing.includes(e));
  console.log(`\n  ${phantoms.length} phantom(s) — naive-missing but resolved by the real lookup:`);
  for (const p of phantoms) {
    const hit = matchedRoster.get(p);
    console.log(`    ${p.sport.padEnd(4)} "${p.name}" ↔ ESPN "${hit?.name}" (${hit?.team})`);
  }
  console.log('  Editing these would be "fixing" entries that were never broken.');

  // ── B + C ──
  console.log('\n══ B. WHERE THE GENUINELY-ABSENT ATHLETES ACTUALLY ARE ════════════');
  const dbPlayers = skipEspn ? [] : await fetchDbPlayers();
  const findings: AbsentFinding[] = [];

  for (const entry of looseMissing) {
    const sport = entry.sport as SportKey;

    // C: what deleting THIS entry costs. Computed by removing exactly this one
    // and re-running the real lookup — not by reasoning about the salary table,
    // which would miss that removing an entry can also change how a loose
    // sibling resolves.
    _setTiersForTesting({ ...tiers, athletes: tiers.athletes.filter((a) => a !== entry) } as never);
    const removed = lookupAthleteTier(entry.name, sport, { allowSalary: true });
    _setTiersForTesting(tiers as never);

    let espnId: string | null = null;
    let verdict: Verdict = 'UNKNOWN';
    let athlete: AthleteResponse['athlete'] | null = null;

    if (!skipEspn) {
      const dbHit = dbPlayers.find(
        (p) => p.sport === sport && p.espn_athlete_id && isSameAthleteName(p.full_name, entry.name),
      );
      espnId = dbHit?.espn_athlete_id ?? (await searchAthleteId(entry.name, sport));
      await sleep(REQUEST_DELAY_MS);
      if (espnId) {
        athlete = await fetchAthlete(espnId, sport);
        await sleep(REQUEST_DELAY_MS);
        if (athlete) verdict = classify(athlete, entry.name, coveredTeams);
      }
    }

    findings.push({
      name: entry.name,
      sport,
      curated_tier: entry.tier,
      espn_athlete_id: espnId,
      espn_display_name: athlete?.fullName ?? athlete?.displayName,
      espn_status: athlete?.status?.name,
      espn_team: athlete?.team?.displayName ?? athlete?.team?.name ?? undefined,
      verdict,
      tier_if_removed: removed.tier,
      tier_if_removed_source: removed.source,
    });
  }

  for (const sport of SPORTS) {
    const mine = findings.filter((f) => f.sport === sport);
    if (mine.length === 0) continue;
    console.log(`\n  ${sport} — ${mine.length} absent`);
    console.log(
      `    ${'athlete'.padEnd(24)} ${'t'.padEnd(2)} ${'verdict'.padEnd(22)} ${'ESPN status/team'.padEnd(34)} if removed`,
    );
    for (const f of mine.sort((a, b) => a.curated_tier - b.curated_tier || a.name.localeCompare(b.name))) {
      const where = `${f.espn_status ?? '?'} / ${f.espn_team ?? '-'}`;
      console.log(
        `    ${f.name.padEnd(24)} ${String(f.curated_tier).padEnd(2)} ${f.verdict.padEnd(22)} ` +
          `${where.slice(0, 34).padEnd(34)} t${f.tier_if_removed} (${f.tier_if_removed_source})`,
      );
    }
  }

  console.log('\n  verdict totals:');
  const byVerdict = new Map<string, number>();
  for (const f of findings) byVerdict.set(f.verdict, (byVerdict.get(f.verdict) ?? 0) + 1);
  for (const [v, n] of [...byVerdict.entries()].sort()) console.log(`    ${v.padEnd(24)} ${n}`);

  console.log('\n══ C. COST OF DELETION ════════════════════════════════════════════');
  const collapse = findings.filter((f) => f.tier_if_removed > f.curated_tier);
  const held = findings.filter((f) => f.tier_if_removed <= f.curated_tier);
  console.log(
    `  ${held.length} of ${findings.length} would keep their tier (or better) from salary alone — ` +
      `deleting those entries changes nothing.`,
  );
  console.log(`  ${collapse.length} would LOSE tier if deleted:`);
  for (const f of collapse.sort((a, b) => a.curated_tier - b.curated_tier)) {
    console.log(
      `    ${f.sport.padEnd(4)} ${f.name.padEnd(24)} t${f.curated_tier} → t${f.tier_if_removed} ` +
        `(${f.tier_if_removed_source})  [${f.verdict}]`,
    );
  }

  // ── D. curated tier vs. what the athlete is now paid ──
  //
  // The check that found the actual staleness. Absence from a roster turned out
  // to be the wrong thing to hunt: every absent entry was doing useful work.
  // What was wrong were entries on athletes still playing, whose tier had not
  // followed their contract.
  //
  // Only the SUPPRESSING direction is a defect. The file is consulted before
  // salary, so an entry set BELOW what an athlete is paid caps them there —
  // curation acting as a penalty. The opposite direction (a curated tier 1 or 2
  // whose salary bands to nothing) is the file doing exactly its job: rookie
  // deals and restructured veteran contracts are why it is authoritative.
  console.log('\n══ D. CURATED TIER vs. SALARY ═════════════════════════════════════');
  const suppressed: Array<{ entry: TierEntry; salary: number; tier: AthleteTier }> = [];
  let corrections = 0;
  for (const [entry, hit] of matchedRoster) {
    if (!(typeof hit.salary === 'number' && hit.salary > 0)) continue;
    const salaryTier = tierFromSalary(hit.salary, entry.sport as SportKey);
    if (salaryTier === null) {
      if (entry.tier <= 2) corrections++;
      continue;
    }
    if (salaryTier < entry.tier) suppressed.push({ entry, salary: hit.salary, tier: salaryTier });
  }
  suppressed.sort((a, b) => b.salary - a.salary);
  console.log(`  ${suppressed.length} curated entr(ies) sit BELOW what salary would give them:`);
  for (const s of suppressed) {
    console.log(
      `    ${s.entry.sport.padEnd(4)} ${s.entry.name.padEnd(24)} curated=t${s.entry.tier} ` +
        `salary=t${s.tier}  $${(s.salary / 1_000_000).toFixed(2)}M`,
    );
  }
  console.log(
    `  ${corrections} curated t1/t2 athletes have a salary that bands to nothing — ` +
      `those are corrections, not staleness, and need no action.`,
  );

  // ── E. cross-sport salary attribution ──
  //
  // Prompted by the audit itself: the NBA's Tyler Smith is not rostered and has
  // no NBA salary, yet section C reported he would land on tier 2 "from salary"
  // if his entry were deleted. The salary index's any-sport fallback had handed
  // him the Dallas COWBOYS guard's contract.
  //
  // The fallback exists because sources mislabel the league more often than the
  // person. That reasoning holds for a name that is salaried in one league and
  // unknown in the other; it does not hold when the two names are two people.
  // This section counts how wide the exposure is rather than assuming it is one
  // athlete.
  console.log('\n══ E. CROSS-SPORT SALARY ATTRIBUTION ══════════════════════════════');
  const salariedBySport = new Map<string, Set<string>>();
  for (const r of rostered) {
    if (!(typeof r.salary === 'number' && r.salary > 0)) continue;
    const set = salariedBySport.get(r.sport) ?? new Set<string>();
    set.add(r.name.toLowerCase());
    salariedBySport.set(r.sport, set);
  }
  const crossSport: Array<{ name: string; sport: SportKey; tier: AthleteTier }> = [];
  for (const sport of SPORTS) {
    const other = SPORTS.find((s) => s !== sport) as SportKey;
    const mySalaried = salariedBySport.get(sport) ?? new Set();
    const theirSalaried = salariedBySport.get(other) ?? new Set();
    // Rostered in THIS league, unsalaried here, salaried under the same name in
    // the other. Any tier such an athlete receives is the other person's.
    for (const r of rostered.filter((x) => x.sport === sport)) {
      if (mySalaried.has(r.name.toLowerCase())) continue;
      if (!theirSalaried.has(r.name.toLowerCase())) continue;
      _setTiersForTesting({ ...tiers, athletes: [] } as never);
      const t = lookupAthleteTier(r.name, sport, { allowSalary: true });
      _setTiersForTesting(tiers as never);
      if (t.source === 'salary') crossSport.push({ name: r.name, sport, tier: t.tier });
    }
  }
  console.log(
    `  ${crossSport.length} rostered athlete(s) would be tiered from a same-named athlete's ` +
      `salary in the OTHER league:`,
  );
  for (const c of crossSport) console.log(`    ${c.sport.padEnd(4)} ${c.name.padEnd(24)} → t${c.tier}`);
  if (crossSport.length === 0) {
    console.log('    (none among currently-rostered athletes — the exposure is latent, not live)');
  }

  if (jsonArg >= 0) {
    const path = args[jsonArg + 1] ?? 'tier-file-audit.json';
    await writeFile(
      path,
      JSON.stringify({ generated_from: 'espn', findings, phantoms, suppressed }, null, 2),
    );
    console.log(`\n[audit] wrote ${path}`);
  }
  console.log('\n[audit] No writes were made.');
}

main()
  .catch((err) => {
    console.error('[audit] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll();
  });
