/**
 * Record the two read responses Return Watch's TRACKING guards depend on, as a
 * test fixture: desk_list_updates and web_list_candidates. Read-only — it calls
 * nothing else. Fixtures are recorded, never hand-written (CLAUDE.md: the
 * defer-queue envelope and RTP-column bugs both survived hand-written fixtures).
 *
 *   railway run --service sidelineiq-mcp-servers -- env \
 *     WEB_MCP_URL=https://sidelineiq-mcp-servers-production.up.railway.app/mcp \
 *     npx tsx src/scripts/record-return-watch-fixture.ts <desk_post_id> tests/fixtures/return-watch-responses.json
 *
 * The repo is public, so free-text values (headlines, bodies, names, slugs) are
 * replaced with "<redacted>". Keys, ids, statuses and timestamps — the shape the
 * code reads — are kept verbatim. MCP_AUTH_SECRET travels only as a header and
 * is never printed.
 */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [deskPostId, outPath] = process.argv.slice(2);
const url = process.env.WEB_MCP_URL;
const secret = process.env.MCP_AUTH_SECRET;
if (!deskPostId || !outPath || !url || !secret) {
  console.error('Usage: WEB_MCP_URL=… MCP_AUTH_SECRET=… npx tsx src/scripts/record-return-watch-fixture.ts <desk_post_id> <out.json>');
  process.exit(2);
}

const FREE_TEXT = new Set(['headline', 'markdown_body', 'athlete_name', 'slug', 'reasons']);
const ROWS_PER_LIST = 2;

function redact(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, FREE_TEXT.has(k) && v !== null ? '<redacted>' : v]),
  );
}

async function main(): Promise<void> {
  const client = new Client({ name: 'record-return-watch-fixture', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url as string), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown[]>> {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    // A rejected call is a VALUE carrying isError, not a throw.
    if (res.isError) throw new Error(`${name} rejected: ${text}`);
    return JSON.parse(text) as Record<string, unknown[]>;
  }
  try {
    const updates = await call('desk_list_updates', { desk_post_id: deskPostId });
    const responses: Record<string, unknown> = {
      desk_list_updates: {
        updates: (updates.updates as Record<string, unknown>[]).slice(0, ROWS_PER_LIST).map(redact),
      },
    };
    for (const status of ['DISMISSED', 'ACCEPTED'] as const) {
      const r = await call('web_list_candidates', { status, limit: ROWS_PER_LIST });
      responses[`web_list_candidates_${status}`] = {
        candidates: (r.candidates as Record<string, unknown>[]).map(redact),
      };
    }
    const fixture = {
      _recorded: {
        at: new Date().toISOString(),
        source: 'src/scripts/record-return-watch-fixture.ts',
        desk_post_id: deskPostId,
        redacted_keys: [...FREE_TEXT],
      },
      ...responses,
    };
    writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`wrote ${outPath}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
