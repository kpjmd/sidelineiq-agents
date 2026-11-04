/**
 * Scores every stored post's elapsed-time prose with as_of = created_at. Read-only.
 *
 * Must flag: Irving 0b497f54 and Sewell 84a1f2f5, the two confirmed year errors.
 * Every flagged PUBLISHED post is printed for a physician to read, and the script
 * exits 1 when a known year error goes unflagged.
 *
 * Reference: forward-looking windows must not appear in the flagged list. The
 * "unread" section prints elapsed-looking phrases the checker declined to read,
 * so a real claim it misses can be seen rather than assumed away.
 *
 *   railway run --service sidelineiq-agents -- env \
 *     WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp \
 *     FARCASTER_MCP_URL= TWITTER_MCP_URL= npx tsx src/scripts/elapsed-claims-dryrun.ts
 */
import 'dotenv/config';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { checkElapsedClaims, extractElapsedClaims } from '../agents/injury-intelligence/elapsed-claims.js';

const MUST_FLAG = ['0b497f54', '84a1f2f5'];
const LOOSE = /\b\d+(?:\.\d+)?[-\s](?:weeks?|months?)[-\s](?:post[-\s]?(?:op\b|operative|surgery|surgical|injury)|since|removed|out from)[^.]{0,20}/gi;

async function surgeryDatesByAthlete(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const status of ['ACTIVE', 'RESOLVED', 'VOID']) {
    for (let offset = 0; ; offset += 500) {
      const raw = (await callTool('web', 'web_list_threads', { status, limit: 500, offset })) as {
        content?: Array<{ text?: string }>;
      };
      const body = JSON.parse(raw?.content?.[0]?.text ?? '{}');
      const rows: Array<{ athlete_name?: string; surgery_date?: string }> = body.threads ?? [];
      for (const t of rows) {
        if (t.athlete_name && t.surgery_date) {
          out.set(t.athlete_name, [...(out.get(t.athlete_name) ?? []), t.surgery_date]);
        }
      }
      if (rows.length < 500) break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  await initializeMCPClients();
  const surgery = await surgeryDatesByAthlete();
  const { posts } = await listAllPosts<Record<string, string>>({}, { maxPages: 200 });
  const flagged = new Set<string>();
  let read = 0;
  const unread: string[] = [];
  const rows: string[] = [];

  for (const p of posts) {
    const text = `${p.headline ?? ''}. ${p.clinical_summary ?? ''}`;
    const claims = extractElapsedClaims(text);
    read += claims.length;
    for (const m of text.matchAll(LOOSE)) {
      if (!claims.some((c) => c.text.includes(m[0].split(/\s/)[0]))) {
        unread.push(`${p.status} ${p.athlete_name}: ${m[0].trim()}`);
      }
    }
    if (!p.injury_date) continue;
    const anchors = [p.injury_date, ...(surgery.get(p.athlete_name) ?? [])];
    const mismatches = checkElapsedClaims(text, anchors, String(p.created_at).slice(0, 10));
    if (mismatches.length === 0) continue;
    flagged.add(String(p.id).slice(0, 8));
    for (const m of mismatches) {
      rows.push(
        `${String(p.id).slice(0, 8)} ${p.status} ${p.athlete_name} ${String(p.created_at).slice(0, 10)} ` +
          `anchor=${m.anchor} prose="${m.text}" computed=${m.computed_weeks}w`,
      );
    }
  }

  console.log(`posts=${posts.length} claims_read=${read} posts_flagged=${flagged.size}`);
  console.log('\n--- flagged ---');
  rows.forEach((r) => console.log(r));
  console.log(`\n--- elapsed-looking phrases not read as claims (${unread.length}) ---`);
  unread.forEach((r) => console.log(r));

  const missed = MUST_FLAG.filter((id) => !flagged.has(id));
  console.log(`\nmust-flag missed: ${missed.length ? missed.join(', ') : 'none'}`);
  if (missed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectAll());
