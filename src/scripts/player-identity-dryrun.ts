// Player identity dry run: ESPN athlete id on the injuries feed, and the
// ambiguous-player entity guard. READ-ONLY: it resolves players and lists
// threads, and writes nothing to the database.
//
// Live 2026-10-03: eleven ACTIVE "Justin Jefferson" ankle threads, ten on a
// Browns LB, one per poll cycle. The injuries feed dropped ESPN's athlete id,
// so a shared name resolved 'ambiguous' carrying an arbitrary row, dedup
// declined to match on it, and resolveThreadAndDates minted a thread anyway.
//
// A. Feed resolution, old vs new. Every row the poller would see this cycle,
//    resolved by name alone (old) and id-first (new, what resolvePlayer does
//    with espn_athlete_id). MUST BE ZERO:
//      A1  a row whose name resolved to one player and whose id resolves to a
//          DIFFERENT player (an identity flip, i.e. a new false positive)
//      A2  a row whose id resolves to a player whose name does not match the
//          row's name (the id pointing at someone else)
//    Expected non-zero: ambiguous → exact, which is the fix.
// B. Live ACTIVE threads on a name the roster holds more than once, and
//    duplicate clusters (same athlete + body part + side). Each thread on an
//    ambiguous name that no id-bearing source could have produced is one the
//    guard would not have minted.
// C. A VOID manifest for the threads anchored on the wrong same-named athlete:
//    the ones whose player is NOT the athlete the live feed lists with that
//    injury. Proposed only. This script applies nothing.
//
// Usage:
//   npx tsx src/scripts/player-identity-dryrun.ts [--all-rows] [--manifest=<path>]
//
// --all-rows ignores MAX_EVENT_AGE_DAYS so all ~800 feed rows are checked, not
// only the ones inside this cycle's window.

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { isMCPError, extractMCPErrorMessage } from '../utils/publishing-pipeline.js';
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';
import { looseNameKey } from '../agents/injury-intelligence/significance.js';
import type { ResolvedPlayerInfo } from '../agents/injury-intelligence/fact-validator.js';
import type { RawInjuryEvent, SportKey } from '../types.js';

interface MCPResult {
  content?: Array<{ text?: string }>;
}
function unwrap<T>(res: unknown): T | null {
  if (isMCPError(res)) throw new Error(extractMCPErrorMessage(res));
  const text = (res as MCPResult)?.content?.[0]?.text;
  return text ? (JSON.parse(text) as T) : null;
}

async function resolve(
  name: string,
  sport: SportKey,
  espnAthleteId?: string,
): Promise<ResolvedPlayerInfo | null> {
  const r = unwrap<{ resolved: boolean; player?: ResolvedPlayerInfo }>(
    await callTool('web', 'web_resolve_player', {
      name,
      sport,
      ...(espnAthleteId && { espn_athlete_id: espnAthleteId }),
    }),
  );
  return r?.resolved && r.player ? r.player : null;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Name comparison that tolerates suffixes and punctuation, nothing more. */
function sameName(a: string, b: string): boolean {
  const strip = (s: string) =>
    looseNameKey(s.replace(/\b(jr|sr|ii|iii|iv)\.?$/i, '').trim());
  return strip(a) === strip(b);
}

type Kind = 'none' | 'ambiguous' | 'single';
const kindOf = (p: ResolvedPlayerInfo | null): Kind =>
  !p ? 'none' : p.confidence === 'ambiguous' ? 'ambiguous' : 'single';

interface Thread {
  id: string;
  player_id: string;
  athlete_name: string | null;
  sport: SportKey;
  team_name: string | null;
  espn_athlete_id: string | null;
  body_part: string | null;
  laterality: string | null;
  injury_type: string | null;
  injury_date: string | null;
  canonical_post_id: string | null;
  otm_projection: unknown;
  first_reported_at: string;
}

async function main() {
  const allRows = process.argv.includes('--all-rows');
  const manifestPath =
    process.argv.find((a) => a.startsWith('--manifest='))?.slice('--manifest='.length) ?? null;
  if (allRows) process.env.MAX_EVENT_AGE_DAYS = '100000';

  await initializeMCPClients();

  // ── A. Feed resolution, old vs new ────────────────────────────────────
  console.log('\n=== A. ESPN injuries feed: name-only vs id-first resolution ===');
  const feedEvents: RawInjuryEvent[] = [];
  for (const src of [new ESPNNFLSource(), new ESPNNBASource()]) {
    const url = (src as unknown as { url: string }).url;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const parsed = (src as unknown as { parse: (f: unknown) => RawInjuryEvent[] }).parse(
      await res.json(),
    );
    feedEvents.push(...parsed);
  }
  const noId = feedEvents.filter((e) => !e.espn_athlete_id);
  console.log(`rows: ${feedEvents.length} (window: ${allRows ? 'all' : `MAX_EVENT_AGE_DAYS=${process.env.MAX_EVENT_AGE_DAYS ?? '7 (default)'}`}), rows with no extractable id: ${noId.length}`);

  const rows = await pool(feedEvents, 8, async (e) => ({
    e,
    old: await resolve(e.athlete_name, e.sport),
    neu: await resolve(e.athlete_name, e.sport, e.espn_athlete_id),
  }));

  const transitions = new Map<string, number>();
  const flips: typeof rows = [];
  const nameMismatch: typeof rows = [];
  const fixed: typeof rows = [];
  for (const r of rows) {
    const key = `${kindOf(r.old)} → ${kindOf(r.neu)}${r.old && r.neu && r.old.player_id !== r.neu.player_id ? ' (different player)' : ''}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    if (kindOf(r.old) === 'single' && r.neu && r.neu.player_id !== r.old!.player_id) flips.push(r);
    if (r.neu && !sameName(r.neu.full_name, r.e.athlete_name)) nameMismatch.push(r);
    if (kindOf(r.old) === 'ambiguous' && kindOf(r.neu) === 'single') fixed.push(r);
  }
  for (const [k, v] of [...transitions].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(48)} ${v}`);
  console.log(`\n  ambiguous → single (the fix): ${fixed.length}`);
  for (const r of fixed) {
    console.log(
      `    ${r.e.sport} "${r.e.athlete_name}" espn=${r.e.espn_athlete_id} ` +
        `old=${r.old!.player_id.slice(0, 8)}(${r.old!.current_team_abbreviation}) → ` +
        `new=${r.neu!.player_id.slice(0, 8)}(${r.neu!.current_team_abbreviation})  ` +
        `${r.e.injury_description.slice(0, 60)}`,
    );
  }
  console.log(`\n  MUST BE ZERO  A1 identity flips (single → different player): ${flips.length}`);
  for (const r of flips) console.log(`    ${r.e.sport} "${r.e.athlete_name}" ${r.old!.player_id} → ${r.neu!.player_id}`);
  console.log(`  MUST BE ZERO  A2 id resolves to a differently-named player: ${nameMismatch.length}`);
  for (const r of nameMismatch) console.log(`    ${r.e.sport} row="${r.e.athlete_name}" id=${r.e.espn_athlete_id} → "${r.neu!.full_name}"`);

  // ── B. Live ACTIVE threads ────────────────────────────────────────────
  console.log('\n=== B. Live ACTIVE threads ===');
  const threads: Thread[] = [];
  for (const sport of ['NFL', 'NBA', 'PREMIER_LEAGUE', 'UFC'] as SportKey[]) {
    let offset = 0;
    for (;;) {
      const page = unwrap<{ threads: Thread[]; has_more: boolean; next_offset: number | null }>(
        await callTool('web', 'web_list_threads', { status: 'ACTIVE', sport, limit: 50, offset }),
      );
      if (!page) break;
      threads.push(...page.threads);
      if (!page.has_more || page.next_offset == null || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
  }
  const byId = new Map(threads.map((t) => [t.id, t]));
  console.log(`ACTIVE threads: ${byId.size}`);

  const names = [...new Set([...byId.values()].map((t) => `${t.sport}|${t.athlete_name ?? ''}`))];
  const nameRes = new Map<string, ResolvedPlayerInfo | null>();
  await pool(names, 8, async (k) => {
    const [sport, name] = k.split('|');
    nameRes.set(k, name ? await resolve(name, sport as SportKey) : null);
  });
  const onAmbiguous = [...byId.values()].filter(
    (t) => kindOf(nameRes.get(`${t.sport}|${t.athlete_name ?? ''}`) ?? null) === 'ambiguous',
  );
  console.log(`threads on a name the roster holds more than once: ${onAmbiguous.length}`);

  const clusters = new Map<string, Thread[]>();
  for (const t of byId.values()) {
    const k = `${t.sport}|${looseNameKey(t.athlete_name ?? '')}|${t.body_part}|${t.laterality}`;
    clusters.set(k, [...(clusters.get(k) ?? []), t]);
  }
  const dupClusters = [...clusters].filter(([, v]) => v.length > 1);
  console.log(`duplicate clusters (same athlete name + body part + side): ${dupClusters.length}`);
  for (const [k, v] of dupClusters) {
    const players = new Set(v.map((t) => t.player_id.slice(0, 8)));
    const amb = kindOf(nameRes.get(`${v[0].sport}|${v[0].athlete_name ?? ''}`) ?? null) === 'ambiguous';
    console.log(`  ${k}  threads=${v.length} players=${[...players].join(',')} name_ambiguous=${amb}`);
  }

  // ── C. VOID manifest ──────────────────────────────────────────────────
  // For an ambiguous name, the injured athlete is the one the feed's id says
  // carries an injury on that body part. Threads anchored on the OTHER player
  // are wrong-athlete threads.
  console.log('\n=== C. Proposed VOID manifest (nothing is applied) ===');
  // Keyed on body part too: both same-named athletes can be in the feed at
  // once (the Browns LB's row says "Coach's Decision"), and only the one whose
  // row names the thread's body part is the injured one.
  const injuredByName = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.neu || kindOf(r.old) !== 'ambiguous') continue;
    const text = `${r.e.injury_description} ${r.e.injury_details?.location ?? ''} ${r.e.injury_details?.type ?? ''}`.toLowerCase();
    for (const t of onAmbiguous) {
      if (!t.body_part || !text.includes(t.body_part.toLowerCase())) continue;
      if (looseNameKey(t.athlete_name ?? '') !== looseNameKey(r.e.athlete_name)) continue;
      const k = `${t.sport}|${looseNameKey(r.e.athlete_name)}|${t.body_part}`;
      injuredByName.set(k, new Set([...(injuredByName.get(k) ?? []), r.neu.player_id]));
    }
  }
  const manifest: Array<Record<string, unknown>> = [];
  for (const t of onAmbiguous) {
    const k = `${t.sport}|${looseNameKey(t.athlete_name ?? '')}|${t.body_part}`;
    const injured = injuredByName.get(k);
    // Only propose when the feed names exactly ONE same-named athlete as
    // injured; otherwise we would be choosing between them by guess.
    if (!injured || injured.size !== 1 || injured.has(t.player_id)) continue;
    const g = unwrap<{ entity: Record<string, unknown>; updates: Array<Record<string, unknown>> }>(
      await callTool('web', 'web_thread_get', { entity_id: t.id }),
    );
    const updates = g?.updates ?? [];
    const postIds = [...new Set(updates.map((u) => u.post_id).filter(Boolean))] as string[];
    if (t.canonical_post_id) postIds.push(t.canonical_post_id);
    const posts = [];
    for (const pid of new Set(postIds)) {
      const p = unwrap<{ post?: Record<string, unknown> } & Record<string, unknown>>(
        await callTool('web', 'web_get_post', { post_id: pid }),
      );
      const row = (p?.post ?? p) as Record<string, unknown> | null;
      posts.push({ post_id: pid, status: row?.status ?? null, content_type: row?.content_type ?? null });
    }
    manifest.push({
      entity_id: t.id,
      athlete_name: t.athlete_name,
      sport: t.sport,
      anchored_player_id: t.player_id,
      anchored_team: t.team_name,
      anchored_espn_athlete_id: t.espn_athlete_id,
      injured_player_id: [...injured][0],
      body_part: t.body_part,
      laterality: t.laterality,
      injury_type: t.injury_type,
      injury_date: t.injury_date,
      first_reported_at: t.first_reported_at,
      updates: updates.map((u) => ({ kind: u.update_kind, post_id: u.post_id ?? null })),
      posts,
      has_projection: Boolean(t.otm_projection),
      proposed: {
        tool: 'web_thread_close',
        args: {
          entity_id: t.id,
          outcome: 'VOID',
          closed_by: 'system',
          void_reason:
            `Anchored on the wrong same-named athlete: "${t.athlete_name}" resolved ambiguous and the ` +
            `thread was minted on ${t.team_name ?? 'an arbitrary'} player ${t.player_id}; the injured ` +
            `athlete is ${[...injured][0]}. Minted once per poll cycle by resolveThreadAndDates.`,
        },
      },
    });
  }
  manifest.sort((a, b) => String(a.first_reported_at).localeCompare(String(b.first_reported_at)));
  for (const m of manifest) {
    console.log(
      `  ${m.entity_id}  ${m.athlete_name} (${m.anchored_team}) ${m.body_part} ${m.laterality} ` +
        `first=${String(m.first_reported_at).slice(0, 16)} updates=${(m.updates as unknown[]).length} ` +
        `posts=${(m.posts as Array<{ status: unknown }>).map((p) => p.status).join(',') || '-'} ` +
        `projection=${m.has_projection ? 'y' : 'n'}`,
    );
  }
  console.log(`  ${manifest.length} thread(s) proposed for VOID`);
  if (manifestPath) {
    writeFileSync(manifestPath, JSON.stringify({ generated_at: new Date().toISOString(), manifest }, null, 2));
    console.log(`  manifest written to ${manifestPath}`);
  }

  await disconnectAll();
  const failed = flips.length + nameMismatch.length;
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: must-be-zero total = ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll().catch(() => {});
  process.exit(2);
});
