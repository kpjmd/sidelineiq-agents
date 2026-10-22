/**
 * coverage-scope dry run — would the out_of_coverage drop ever take a real pro?
 *
 * Read-only. Writes nothing; `web_resolve_player` is a read.
 *   export WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp
 *   npx tsx src/scripts/coverage-scope-dryrun.ts [--no-live]
 * (--live needs NEWSAPI_KEY and spends one NewsAPI request.)
 *
 * A. Every stored NFL/NBA post, re-resolved today, scored by both layers
 *    exactly as the pipeline consults them (unresolved athletes only).
 * B. The live NewsAPI NFL feed, through the real source parser, scored by the
 *    pre-OTM section layer.
 *
 * The numbers that must be zero:
 *   1  drops of an athlete who resolves to a rostered player (structural —
 *      the callers never consult the checks for one)
 *   2  drops of a known real pro that once failed to resolve
 *      (AJ Brown, Shaedon Sharpe, Jalon Walker, Richie Saunders, Jaylon Hutchings)
 * Reported, not gated: how often each signal fires on a RESOLVED athlete. That
 * is the false-drop count the resolved-only guard is there to absorb.
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll, callTool } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { outOfCoverageSection, postTeamOutOfCoverage } from '../monitoring/coverage-scope.js';
import { NewsAPINFLSource } from '../monitoring/sports/newsapi-nfl.js';
import type { ResolvedPlayerInfo } from '../agents/injury-intelligence/fact-validator.js';
import type { SportKey } from '../types.js';

const KNOWN_REAL_PROS = new Set(
  ['AJ Brown', 'Shaedon Sharpe', 'Jalon Walker', 'Richie Saunders', 'Jaylon Hutchings'].map((n) =>
    n.toLowerCase(),
  ),
);

interface PostRow {
  id: string;
  athlete_name: string | null;
  sport: string;
  team: string | null;
  source_url: string | null;
  status: string | null;
  created_at: string;
}

const failures: string[] = [];
function mustBeZero(label: string, examples: string[]): void {
  const ok = examples.length === 0;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${examples.length}`);
  for (const e of examples.slice(0, 10)) console.log(`          ${e}`);
  if (!ok) failures.push(`${label} = ${examples.length}`);
}
function report(label: string, examples: string[]): void {
  console.log(`  ---   ${label}: ${examples.length}`);
  for (const e of examples.slice(0, 10)) console.log(`          ${e}`);
}

// Same call shape as poller.resolvePlayer, minus its catch: a failure there
// degrades to "unresolved", which here would be scored as a drop.
const cache = new Map<string, ResolvedPlayerInfo | null>();
async function resolve(name: string, sport: SportKey): Promise<ResolvedPlayerInfo | null> {
  const key = `${sport}|${name.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key)!;
  const res = await callTool('web', 'web_resolve_player', { name, sport });
  if (isMCPError(res)) throw new Error(`resolve ${name}: ${extractMCPErrorMessage(res)}`);
  const text = (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (!text) throw new Error(`resolve ${name}: empty response`);
  const parsed = JSON.parse(text) as { resolved: boolean; player: ResolvedPlayerInfo | null };
  const player = parsed.resolved ? parsed.player : null;
  cache.set(key, player);
  return player;
}

async function sectionA(): Promise<void> {
  console.log('\nA. Stored NFL/NBA posts, both layers');
  const { posts, truncated } = await listAllPosts<PostRow>({}, { maxPages: 80 });
  if (truncated) throw new Error('post scan truncated — refusing to report a partial answer');
  const scoped = posts.filter((p) => (p.sport === 'NFL' || p.sport === 'NBA') && p.athlete_name);
  console.log(`  scanned ${posts.length} posts, ${scoped.length} NFL/NBA`);

  const drops: string[] = [];
  const dropsResolved: string[] = [];
  const dropsKnownPro: string[] = [];
  const firesOnResolved: string[] = [];
  let unresolved = 0;
  for (const p of scoped) {
    const sport = p.sport as SportKey;
    const player = await resolve(p.athlete_name!, sport);
    const section = outOfCoverageSection({ source_url: p.source_url ?? '', source_name: undefined });
    const team = postTeamOutOfCoverage(p.team, sport);
    const signal = section ? `section=${section}` : team ? `team="${team}"` : null;
    const line = `${p.id.slice(0, 8)} ${p.created_at.slice(0, 10)} ${sport} ${p.status} ${p.athlete_name} (${p.team}) ${signal}`;
    if (player && player.confidence !== 'miss') {
      if (signal) firesOnResolved.push(line);
      continue;
    }
    unresolved++;
    if (!signal) continue;
    drops.push(line);
    if (player) dropsResolved.push(line);
    if (KNOWN_REAL_PROS.has(p.athlete_name!.toLowerCase())) dropsKnownPro.push(line);
  }
  console.log(`  ${unresolved} post(s) whose athlete resolves to no player today`);
  report('would drop', drops);
  mustBeZero('drops of a rostered athlete', dropsResolved);
  mustBeZero('drops of a known real pro', dropsKnownPro);
  report('signal fires on a RESOLVED athlete (absorbed by the guard)', firesOnResolved);
}

async function sectionB(): Promise<void> {
  console.log('\nB. Live NewsAPI NFL feed, section layer');
  if (!process.env.NEWSAPI_KEY) {
    console.log('  skipped — NEWSAPI_KEY not set');
    return;
  }
  const source = new NewsAPINFLSource();
  const events = await source.fetchLatestEvents();
  const status = source.lastFetchReport();
  if (status.status === 'error') throw new Error(`NewsAPI fetch failed: ${status.detail}`);
  console.log(`  ${events.length} event(s) after the source's own filtering`);

  const drops: string[] = [];
  const firesOnResolved: string[] = [];
  for (const e of events) {
    const section = outOfCoverageSection(e);
    if (!section) continue;
    const player = await resolve(e.athlete_name, e.sport);
    const line = `${e.athlete_name} section=${section} ${e.source_url}`;
    if (player && player.confidence !== 'miss') firesOnResolved.push(`${line} → ${player.full_name} (${player.current_team_name})`);
    else drops.push(line);
  }
  report('would drop', drops);
  report('section fires on a RESOLVED athlete (absorbed by the guard)', firesOnResolved);
}

async function main(): Promise<void> {
  await initializeMCPClients();
  try {
    await sectionA();
    if (!process.argv.includes('--no-live')) await sectionB();
  } finally {
    await disconnectAll();
  }
  console.log(failures.length === 0 ? '\nPASS' : `\nFAIL: ${failures.join('; ')}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
