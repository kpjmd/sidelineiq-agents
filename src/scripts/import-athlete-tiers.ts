// One-shot migration: read data/athlete-tiers.json and write each entry to
// the players table as a prominence_tier override.
//
// Run order:
//   1. Apply mcp migrations 007 + 008
//   2. POST /admin/roster-sync (or wait for the 6h cycle) so ESPN-roster
//      players exist first
//   3. tsx src/scripts/import-athlete-tiers.ts
//
// For each athlete in the JSON:
//   • If web_resolve_player returns a unique match → web_set_player_prominence
//     on that row (source='override'). This keeps the ESPN id linkage.
//   • If no match → web_upsert_player without an ESPN id, with
//     prominence_source='override'. These are athletes ESPN's roster API
//     doesn't surface (UFC fighters, some Premier League listings).
//   • Ambiguous matches are logged and skipped — they need manual resolution.

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import type { SportKey } from '../types.js';

interface AthleteTierEntry {
  name: string;
  team?: string;
  sport: string;
  tier: number;
}

interface AthleteTiersFile {
  version: number;
  updated_at: string;
  athletes: AthleteTierEntry[];
}

interface ResolveResponse {
  resolved: boolean;
  player: {
    player_id: string;
    full_name: string;
    confidence: 'exact' | 'normalized' | 'ambiguous' | 'miss';
    match_count: number;
  } | null;
}

interface MCPResult {
  content?: Array<{ text?: string }>;
}

function unwrap<T>(res: unknown): T {
  const text = (res as MCPResult)?.content?.[0]?.text;
  if (!text) throw new Error('MCP returned empty content');
  return JSON.parse(text) as T;
}

function normalizeSport(raw: string): SportKey | null {
  const s = raw.toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_');
  const known: SportKey[] = ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'];
  return (known as string[]).includes(s) ? (s as SportKey) : null;
}

async function importTiers(filePath: string): Promise<void> {
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as AthleteTiersFile;

  let matched = 0;
  let created = 0;
  let ambiguous = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of data.athletes) {
    const sport = normalizeSport(entry.sport);
    if (!sport) {
      console.warn(`[import] unknown sport "${entry.sport}" for ${entry.name} — skipped`);
      skipped++;
      continue;
    }

    try {
      const resolved = unwrap<ResolveResponse>(
        await callTool('web', 'web_resolve_player', { name: entry.name, sport }),
      );

      if (resolved.resolved && resolved.player) {
        if (resolved.player.confidence === 'ambiguous') {
          console.warn(
            `[import] ambiguous match for ${entry.name} (${sport}) — ${resolved.player.match_count} hits, skipped`,
          );
          ambiguous++;
          continue;
        }
        await callTool('web', 'web_set_player_prominence', {
          player_id: resolved.player.player_id,
          tier: entry.tier,
          source: 'override',
        });
        matched++;
      } else {
        await callTool('web', 'web_upsert_player', {
          sport,
          full_name: entry.name,
          prominence_tier: entry.tier,
          prominence_source: 'override',
        });
        created++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[import] ${entry.name} (${sport}): ${message}`);
      errors++;
    }
  }

  console.log(
    `[import] done — matched=${matched} created=${created} ambiguous=${ambiguous} skipped=${skipped} errors=${errors} total=${data.athletes.length}`,
  );
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(here, '..', '..', 'data', 'athlete-tiers.json');
  console.log(`[import] reading ${filePath}`);

  await initializeMCPClients();
  try {
    await importTiers(filePath);
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[import] fatal:', err);
  process.exit(1);
});
