/**
 * Lists what the returned-precheck would decide over today's ESPN injuries rows,
 * against every thread already holding a usable date. Read-only: it reads the game
 * log and writes nothing, and it ignores RETURNED_PRECHECK_MODE=off.
 *
 * A physician reads this list before the mode goes `on`. SKIP drops the report;
 * INFORM runs the post with the games in the prompt; REVIEW does that and forces
 * review. Only an anchor at least RETURNED_PRECHECK_SKIP_MIN_WEEKS old (default 26)
 * can SKIP, so the short-term cases (hurt Sunday, played Thursday, out again) INFORM.
 *
 * RESOLVED threads stand in for the thread the resolver would mint, so this list
 * overstates what a live cycle sees: the classifier and gate run first in production.
 *
 * Numbers that must be zero (exits 1 otherwise):
 *   - skips whose report has fresh-injury language
 *   - skips with no game in the window
 *   - skips whose anchor is younger than the cutoff
 *   - decisions other than not_applicable under an injected 404 or 503
 *
 *   railway run --service sidelineiq-agents -- env \
 *     WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp \
 *     FARCASTER_MCP_URL= TWITTER_MCP_URL= npx tsx src/scripts/returned-precheck-dryrun.ts
 */
import 'dotenv/config';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';
import { checkReturnedBeforeReport, returnedSkipMinWeeks } from '../monitoring/returned-precheck.js';
import { reportsFreshEvent } from '../agents/injury-intelligence/carryover.js';
import type { RawInjuryEvent } from '../types.js';

interface ThreadRow {
  id: string;
  status: string;
  sport: string;
  espn_athlete_id: string | null;
  body_part: string | null;
  injury_date: string | null;
  injury_date_confidence: 'unknown' | 'possible' | 'probable' | 'confirmed';
}

async function listThreads(): Promise<ThreadRow[]> {
  const out: ThreadRow[] = [];
  for (const status of ['ACTIVE', 'RESOLVED']) {
    for (const sport of ['NFL', 'NBA']) {
      for (let offset = 0; ; offset += 500) {
        const raw = (await callTool('web', 'web_list_threads', { status, sport, limit: 500, offset })) as {
          content?: Array<{ text?: string }>;
        };
        const rows: ThreadRow[] = JSON.parse(raw?.content?.[0]?.text ?? '{}').threads ?? [];
        out.push(...rows);
        if (rows.length < 500) break;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  await initializeMCPClients();
  const threads = await listThreads();
  const events: RawInjuryEvent[] = [
    ...(await new ESPNNFLSource().fetchLatestEvents()),
    ...(await new ESPNNBASource().fetchLatestEvents()),
  ];
  console.log(`threads=${threads.length} feed_rows=${events.length}`);

  const pairs: Array<[RawInjuryEvent, ThreadRow]> = [];
  let otherPart = 0;
  for (const e of events) {
    if (!e.espn_athlete_id) continue;
    const mine = threads.filter((t) => t.espn_athlete_id === e.espn_athlete_id && t.injury_date);
    // Prefer the ACTIVE thread: it is what dedup would match. A RESOLVED one stands
    // in for the thread the resolver would mint, as with Irving's.
    const t = mine.find((x) => x.status === 'ACTIVE') ?? mine[0];
    if (!t) continue;
    // Live, a report about another body part matches no entity and gets its own
    // date, so pairing it with this thread would judge it against the wrong injury.
    // A healthy "active" row names no part and is kept.
    const text = e.injury_description.toLowerCase();
    if (!text.startsWith('active') && t.body_part && !text.includes(t.body_part.toLowerCase())) {
      otherPart++;
      continue;
    }
    pairs.push([e, t]);
  }

  let badFresh = 0;
  let badNoGame = 0;
  let badYoung = 0;
  const cutoffDays = returnedSkipMinWeeks() * 7;
  console.log(`skip cutoff=${cutoffDays}d`);
  const counts: Record<string, number> = {};
  for (const [e, t] of pairs) {
    const d = await checkReturnedBeforeReport(e, t, null);
    counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    if (d.kind === 'skip' || d.kind === 'review' || d.kind === 'inform') {
      if (d.kind === 'skip' && reportsFreshEvent(e)) badFresh++;
      if (d.kind === 'skip' && d.anchor_age_days < cutoffDays) badYoung++;
      if (d.games < 1) badNoGame++;
      console.log(
        `${d.kind.toUpperCase().padEnd(6)} ${e.sport} ${e.athlete_name} [${t.status}] anchor=${d.anchor} ` +
          `(${t.injury_date_confidence}) age=${d.anchor_age_days}d games=${d.games} first=${d.first_game_date} last=${d.last_game_date} ` +
          `report=${d.report_date} :: ${e.injury_description.slice(0, 90)}`,
      );
    }
  }
  console.log('decisions', JSON.stringify(counts), `other_body_part_not_judged=${otherPart}`);

  let injected = 0;
  const realFetch = globalThis.fetch;
  for (const status of [404, 503]) {
    globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch;
    for (const [e, t] of pairs.slice(0, 25)) {
      const d = await checkReturnedBeforeReport(e, t, null);
      if (d.kind !== 'not_applicable') injected++;
    }
  }
  globalThis.fetch = realFetch;

  console.log(`\nmust be zero: skips_with_fresh_language=${badFresh} skips_with_no_game=${badNoGame} skips_under_cutoff=${badYoung} decisions_under_failure=${injected}`);
  if (badFresh || badNoGame || badYoung || injected) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
