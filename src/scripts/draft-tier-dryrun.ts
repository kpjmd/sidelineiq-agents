/**
 * READ-ONLY ship gate for the draft-position tier provider.
 *
 * Fetches ESPN's draft rounds and the current rosters over HTTP. Writes
 * nothing, makes no model calls, and does NOT require DRAFT_TIER_ENABLED — it
 * installs its own snapshot in-process, exactly as its two siblings do.
 *
 * Usage:
 *   npx tsx src/scripts/draft-tier-dryrun.ts
 *   npx tsx src/scripts/draft-tier-dryrun.ts --band 45 --seasons 3
 */
import {
  lookupAthleteTier,
  loadSignificanceData,
  _setDraftSnapshotForTesting,
  _setSalarySnapshotForTesting,
  getLoadedDraftBands,
} from '../agents/injury-intelligence/significance.js';
import { runTierDelta } from './tier-dryrun-common.js';
import type { SportKey } from '../types.js';

const NFL_TEAM_IDS = Array.from({ length: 34 }, (_, i) => i + 1);

async function j(url: string): Promise<any> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | null => {
    const i = argv.indexOf(n);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };

  await loadSignificanceData();
  const bands = getLoadedDraftBands();
  const band = bands.NFL;
  if (!band) {
    console.error('[dryrun] no NFL draft band configured — nothing to check.');
    process.exitCode = 1;
    return;
  }
  const maxOverall = Number(flag('--band') ?? band.tier_2_max_overall);
  const seasons = Number(flag('--seasons') ?? band.max_seasons_since_draft);
  const thisYear = new Date().getUTCFullYear();

  // ── Rosters (for salary first-refusal and "still in the league") ──────
  const roster: Array<{ name: string; exp: number | null; salary: number | null }> = [];
  await Promise.all(
    NFL_TEAM_IDS.map(async (id) => {
      try {
        const d = await j(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/roster`);
        for (const g of d.athletes ?? [])
          for (const a of g.items ?? [])
            roster.push({
              name: a.displayName,
              exp: a.experience?.years ?? null,
              salary: a.contract?.salary ?? null,
            });
      } catch { /* a missing team id is expected — ESPN's ids are sparse */ }
    }),
  );
  _setSalarySnapshotForTesting(
    roster
      .filter((r) => r.salary && r.salary > 0 && r.exp !== 0)
      .map((r) => ({ full_name: r.name, sport: 'NFL', salary: r.salary as number })) as never,
  );

  // ── Draft picks ──────────────────────────────────────────────────────
  const years: number[] = [];
  for (let b = 0; b <= seasons + 1; b++) years.push(thisYear - b);
  const picks: Array<{ year: number; round: number; overall: number; ref: string }> = [];
  for (const y of years) {
    const rounds = await j(
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${y}/draft/rounds`,
    );
    for (const r of rounds.items ?? [])
      for (const p of r.picks ?? [])
        if (p.status?.name === 'SELECTION_MADE' && p.athlete?.$ref && p.overall <= maxOverall)
          picks.push({ year: y, round: r.number, overall: p.overall, ref: p.athlete.$ref });
  }
  const named = await pool(picks, 5, async (p) => {
    try {
      const a = await j(p.ref);
      return { ...p, name: (a.fullName ?? a.displayName) as string | null };
    } catch {
      return { ...p, name: null };
    }
  });
  const resolved = named.filter((p) => p.name);
  const lost = named.length - resolved.length;

  _setDraftSnapshotForTesting(
    resolved.map((p) => ({
      full_name: p.name as string,
      sport: 'NFL',
      draft: { year: p.year, round: p.round, overall: p.overall },
    })) as never,
  );

  // ── Section A ────────────────────────────────────────────────────────
  console.log(`\n══ A. DRAFT POPULATION (overall <= ${maxOverall}, ${seasons + 1} classes) ═══`);
  const rosterNames = new Set(roster.map((r) => r.name.toLowerCase()));
  const byClass = new Map<number, { total: number; rostered: number; newT2: number }>();
  let curatedT4InWindow = 0;
  const newlyPromoted: Array<{ name: string; year: number; overall: number }> = [];

  for (const p of resolved) {
    const anchoredOut = thisYear - p.year > seasons;
    const c = byClass.get(p.year) ?? { total: 0, rostered: 0, newT2: 0 };
    c.total++;
    if (rosterNames.has((p.name as string).toLowerCase())) c.rostered++;
    const before = lookupAthleteTier(p.name as string, 'NFL' as SportKey, { allowDraft: false });
    const after = lookupAthleteTier(p.name as string, 'NFL' as SportKey, { allowDraft: true });
    if (before.source === 'lookup' && before.tier === 4 && !anchoredOut) curatedT4InWindow++;
    if (after.source === 'draft' && before.tier === 3) {
      c.newT2++;
      newlyPromoted.push({ name: p.name as string, year: p.year, overall: p.overall });
    }
    byClass.set(p.year, c);
  }
  console.log('  class   picks  rostered  NEW tier-2');
  [...byClass.entries()].sort((a, b) => b[0] - a[0]).forEach(([y, c]) =>
    console.log(`  ${y}     ${String(c.total).padStart(4)}      ${String(c.rostered).padStart(4)}        ${String(c.newT2).padStart(4)}`),
  );
  console.log(`\n  refs lost to non-404 failures: ${lost} (must be 0)`);
  console.log(`  curated tier-4 entries inside the window: ${curatedT4InWindow} (must be 0)`);
  console.log(`  TOTAL new NFL tier-2 promotions: ${newlyPromoted.length}`);
  console.log('\n  highest picks newly promoted:');
  newlyPromoted.sort((a, b) => a.overall - b.overall).slice(0, 12)
    .forEach((p) => console.log(`    #${String(p.overall).padStart(3)}  ${p.year}  ${p.name}`));

  // Stars the draft signal cannot reach — reprinted so the limitation is
  // re-confirmed rather than remembered.
  console.log('\n  curated stars this can NOT reach (by design):');
  for (const n of ['Brock Purdy', 'Patrick Mekari', 'Cameron Jordan']) {
    const t = lookupAthleteTier(n, 'NFL' as SportKey, { allowDraft: true });
    console.log(`    ${n.padEnd(18)} -> tier ${t.tier} (${t.source})`);
  }

  // ── Sections B, C ────────────────────────────────────────────────────
  const posts = resolved.map((p) => ({
    athlete_name: p.name as string,
    sport: 'NFL',
    content_type: 'TRACKING',
  }));
  const r = runTierDelta(posts, {
    before: { allowDraft: false },
    after: { allowDraft: true },
    label: 'draft',
  });

  const fails =
    (lost > 0 ? 1 : 0) +
    (curatedT4InWindow > 0 ? 1 : 0) +
    (r.violations > 0 ? 1 : 0) +
    (r.forbidden > 0 ? 1 : 0);
  console.log(
    fails === 0
      ? '\n[dryrun] ✓ SHIP GATE PASSED'
      : `\n[dryrun] ✗ SHIP GATE FAILED — ${fails} check(s) failed.`,
  );
  if (fails > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
