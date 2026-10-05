/**
 * Render what a ledger publish WOULD send — the X card text, the self-reply, the
 * Farcaster mirror with its byte count, the commit path/message/body — and
 * check the vocabulary rule. Posts nothing, commits nothing, writes nothing.
 *
 *   npx tsx src/scripts/ledger-publish-dryrun.ts --fixture
 *     renders the synthetic row built from tests/fixtures/ledger-hash-cases.json
 *
 *   WEB_MCP_URL=https://… MCP_AUTH_SECRET=… \
 *     npx tsx src/scripts/ledger-publish-dryrun.ts --forecast-id <uuid>
 *     reads the STORED published row through web_get_ledger_forecast and renders it
 *
 * The live form is the pre-flight for the first real entry (plan S2-4): confirm
 * the row in /admin/ledger, run this against its id, read the three texts, then
 * decide whether the real run may go.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertPublishable, type LedgerForecastRow } from '../ledger/publishable.js';
import { renderLedgerTexts } from '../ledger/post-text.js';
import { buildForecastFile } from '../ledger/github-commit.js';
import { ledgerRowHash } from '../ledger/row-hash.js';

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : null;
};

async function loadRow(): Promise<LedgerForecastRow> {
  if (args.includes('--fixture')) {
    const fx = JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures/ledger-hash-cases.json'), 'utf8')) as { cases: Array<{ input: Record<string, unknown> }> };
    const row = {
      id: '00000000-0000-4000-8000-000000000000',
      status: 'published',
      ...fx.cases[0].input,
      row_hash: null,
      confirmed_by: '00000000-0000-4000-8000-000000000001',
      confirmed_at: fx.cases[0].input.published_at,
      commit_sha: null,
      commit_url: null,
      x_post_id: null,
      x_self_reply_id: null,
      farcaster_hash: null,
      reply_to_url: 'https://x.com/example/status/1',
    } as unknown as LedgerForecastRow;
    row.row_hash = ledgerRowHash(row);
    return row;
  }
  const id = flag('--forecast-id');
  if (!id) {
    console.error('usage: --fixture | --forecast-id <uuid>');
    process.exit(2);
  }
  const { initializeMCPClients, callTool, disconnectAll } = await import('../utils/mcp-client-manager.js');
  await initializeMCPClients();
  try {
    const raw = (await callTool('web', 'web_get_ledger_forecast', { forecast_id: id })) as { isError?: boolean; content: Array<{ text: string }> };
    if (raw.isError) throw new Error(raw.content[0]?.text ?? 'unknown MCP error');
    return (JSON.parse(raw.content[0].text) as { forecast: LedgerForecastRow }).forecast;
  } finally {
    await disconnectAll();
  }
}

async function main(): Promise<void> {
  const row = await loadRow();
  try {
    assertPublishable(row);
  } catch (err) {
    console.error(`NOT PUBLISHABLE: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const texts = renderLedgerTexts(row, row.commit_url);
  const file = buildForecastFile(row);
  const rule = (title: string) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);

  rule(`X card reply (${texts.x_card.length} chars, reply_to_url=${row.reply_to_url ?? 'none'})`);
  console.log(texts.x_card);
  rule(`X self-reply (${texts.x_self_reply.length} chars)`);
  console.log(texts.x_self_reply);
  rule(`Farcaster mirror (${texts.farcaster_bytes} bytes of 320; embed ${texts.entry_url})`);
  console.log(texts.farcaster);
  rule(`Commit ${file.path} — "${file.message}"`);
  console.log(file.body);
  rule('Checks');
  console.log(`forbidden words: ${texts.forbidden.length === 0 ? 'none' : texts.forbidden.join(', ')}`);
  console.log(`farcaster within 320 bytes: ${texts.farcaster_bytes <= 320}`);
  console.log(`hash8 on card/post/commit: ${row.row_hash.slice(0, 8)} (row_hash re-derives: ${ledgerRowHash(row) === row.row_hash})`);
  console.log('\nNothing was posted or committed.');
  process.exit(texts.forbidden.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
