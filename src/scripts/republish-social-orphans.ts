// One-off recovery for the Aug 2026 social publish outage: PUBLISHED posts that
// carry neither a farcaster_hash nor a twitter_id, i.e. they reached nobody.
//
// ApprovalSync will not recover these. Its per-type age budgets deliberately
// stop at hours-to-days, because whether a days-old injury report is still
// worth posting is an editorial judgement and not a cron's to make. This script
// is where that judgement gets made, by a human, one post at a time.
//
// Behavior:
//   • Scans PUBLISHED posts in [--since, now] and keeps the ones with no hash.
//   • Applies three gates, in order, and prints the reason for every post:
//       skip_superseded — a NEWER post for the same athlete is already live, so
//                         the injury is covered and re-casting duplicates it.
//       skip_sibling    — an older post about an athlete whose newest post is
//                         also a candidate. At most one post per athlete goes
//                         out, and only the newest carries current facts.
//       skip_stale      — BREAKING past --max-breaking-age (default 48h), or
//                         anything past --max-age-days (default 14). Casting a
//                         "breaking" headline days late is false on its face.
//                         These are flagged into the MD queue instead, with
//                         preserve_status so the live post stays PUBLISHED.
//   • Renders the exact casts and tweets for every candidate WITHOUT publishing,
//     and asserts the OrthoIQ CTA appears on no non-DEEP_DIVE post.
//   • Publishing requires naming the post ids explicitly. The script cannot
//     decide to post something you did not read.
//
// No deletions, no direct DB writes, no hash columns written by hand — the
// publish path writes those back itself, and every action is audited.
//
// MUST RUN INSIDE RAILWAY. FARCASTER_MCP_URL / TWITTER_MCP_URL / WEB_MCP_URL
// are *.railway.internal and unreachable from a laptop:
//
//   railway ssh -s sidelineiq-agents
//
// Usage (inside the container):
//   npx tsx src/scripts/republish-social-orphans.ts                    # dry run
//   npx tsx src/scripts/republish-social-orphans.ts --flag-stale       # no casts; files stale posts for MD review
//   npx tsx src/scripts/republish-social-orphans.ts \
//     --publish --post-ids=<uuid>,<uuid> --confirm                     # live
//
// Flags:
//   --since=<ISO>            scan start (default 2026-08-09T00:00:00Z)
//   --max-breaking-age=<h>   BREAKING staleness in hours (default 48)
//   --max-age-days=<d>       staleness for other types (default 14)
//   --max-publishes=<n>      abort if more ids are named (default 3)
//   --delay-ms=<n>           spacing between publishes (default 60000)
//   --flag-stale             file skip_stale posts into the MD queue. This is a
//                            write and needs no --publish: a review row is not a
//                            public cast. Safe to re-run — already-pending
//                            social_orphan reviews are skipped.
//   --publish --post-ids --confirm   all three required to cast anything
//
// The container filesystem is ephemeral and has no editor, so the CSV and the
// rendered preview are printed to stdout as well as written to disk.

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { initializeMCPClients, callTool, disconnectAll } from '../utils/mcp-client-manager.js';
import { listAllPosts } from '../utils/web-posts.js';
import { reconstructPostContent, describeReconstructFailure, type StoredPostRow } from '../utils/post-content.js';
import { publishApprovedPost } from '../utils/publishing-pipeline.js';
import { formatForFarcaster, formatForTwitter } from '../utils/content-formatter.js';

const ACTOR_ID = 'republish-social-orphans';
const CTA_MARKER = 'orthoiq.com';
const DEFAULT_SINCE = '2026-08-09T00:00:00Z';
/** A row minutes old is mid-publish, not failed. Matches the audit's grace. */
const GRACE_MS = 10 * 60 * 1000;

type Decision =
  | 'publish'
  | 'skip_superseded'
  | 'skip_sibling'
  | 'skip_stale'
  | 'skip_unreconstructable'
  | 'published'
  | 'published_no_hash'
  | 'error';

/**
 * Extends StoredPostRow so the RTP columns are declared in exactly one place.
 *
 * This used to declare no RTP fields at all and lean on the index signature,
 * which is precisely why TypeScript never noticed that the names
 * reconstructPostContent read did not exist on injury_posts.
 */
export interface OrphanRow extends StoredPostRow {
  id?: string;
  post_id?: string;
  status?: string;
  /** Narrowed from StoredPostRow's `unknown` — the orphan gates read these as strings. */
  content_type?: string;
  athlete_name?: string;
  sport?: string;
  injury_type?: string;
  headline?: string;
  slug?: string;
  created_at?: string;
  parent_post_id?: string;
  farcaster_hash?: string | null;
  twitter_id?: string | null;
  [key: string]: unknown;
}

interface ReportRow {
  post_id: string;
  created_at: string;
  age_days: string;
  athlete_name: string;
  sport: string;
  content_type: string;
  injury_type: string;
  group_key: string;
  headline: string;
  decision: Decision;
  reason: string;
  newer_live_post_id: string;
  n_casts: string;
  n_tweets: string;
  contains_orthoiq_cta: string;
  farcaster_hash_after: string;
  twitter_id_after: string;
}

interface Options {
  since: number;
  maxBreakingAgeMs: number;
  maxAgeMs: number;
  maxPublishes: number;
  delayMs: number;
  flagStale: boolean;
  publish: boolean;
  postIds: Set<string>;
  confirm: boolean;
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function parseOptions(): Options {
  const sinceRaw = argValue('since') ?? DEFAULT_SINCE;
  const since = Date.parse(sinceRaw);
  if (Number.isNaN(since)) throw new Error(`--since is not a valid date: "${sinceRaw}"`);

  const num = (name: string, fallback: number): number => {
    const raw = argValue(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} is not a number: "${raw}"`);
    return n;
  };

  const ids = (argValue('post-ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    since,
    maxBreakingAgeMs: num('max-breaking-age', 48) * 60 * 60 * 1000,
    maxAgeMs: num('max-age-days', 14) * 24 * 60 * 60 * 1000,
    maxPublishes: num('max-publishes', 3),
    delayMs: num('delay-ms', 60_000),
    flagStale: process.argv.includes('--flag-stale'),
    publish: process.argv.includes('--publish'),
    postIds: new Set(ids),
    confirm: process.argv.includes('--confirm'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function postId(row: OrphanRow): string {
  return String(row.post_id ?? row.id ?? '');
}

/**
 * Group key for the near-duplicate gate: athlete + sport, NOT the post thread.
 *
 * The first dry run proved why. Coby Bryant had three hashless CONFLICT_FLAGs
 * on one knee — Aug 11, 13, 15 — but only the last two shared a parent_post_id.
 * Grouping by `parent_post_id ?? id` therefore let the Aug 11 post through as
 * its own thread, and two posts about the same injury would have gone out, the
 * older one claiming a team timeline of 26 weeks that the newer had revised to
 * 24. injury_type is no help either: the three rows spell the same fracture
 * three different ways. One post per athlete, newest, is the rule that holds.
 */
export function groupKey(row: OrphanRow): string {
  return `${String(row.athlete_name ?? '').trim().toLowerCase()}|${String(row.sport ?? '').trim().toUpperCase()}`;
}

function createdMs(row: OrphanRow): number {
  return new Date(row.created_at ?? 0).getTime();
}

function ageDays(row: OrphanRow, now: number): number {
  return (now - createdMs(row)) / 86_400_000;
}

export interface OrphanPolicy {
  now: number;
  maxBreakingAgeMs: number;
  maxAgeMs: number;
}

export interface OrphanVerdict {
  post_id: string;
  decision: Extract<Decision, 'publish' | 'skip_superseded' | 'skip_sibling' | 'skip_stale'>;
  reason: string;
  newer_live_post_id: string;
  group_key: string;
}

/**
 * Decides what happens to each orphan. Pure and exported because it is the
 * highest-consequence logic here — the same reason selectPostsToRepublish is.
 * The one piece of I/O it needs, "is a newer post for this athlete already
 * live", is resolved by the caller and passed in.
 */
export function classifyOrphans(
  orphans: OrphanRow[],
  policy: OrphanPolicy,
  newerLiveById: ReadonlyMap<string, string>,
): OrphanVerdict[] {
  // Newest surviving post per athlete. Computed over the posts that pass the
  // superseded gate, so a skipped one never suppresses a live candidate.
  const eligible = orphans.filter((row) => !newerLiveById.get(postId(row)));
  const newestPerAthlete = new Map<string, OrphanRow>();
  for (const row of eligible) {
    const key = groupKey(row);
    const current = newestPerAthlete.get(key);
    if (!current || createdMs(row) > createdMs(current)) newestPerAthlete.set(key, row);
  }

  return orphans.map((row) => {
    const id = postId(row);
    const key = groupKey(row);
    const contentType = String(row.content_type ?? '').toUpperCase();
    const base = { post_id: id, newer_live_post_id: '', group_key: key };

    // Gate 1 — the injury is already covered by a live post.
    const newerLive = newerLiveById.get(id);
    if (newerLive) {
      return {
        ...base,
        decision: 'skip_superseded' as const,
        reason: 'a newer post for this athlete is already live on socials',
        newer_live_post_id: newerLive,
      };
    }

    // Gate 2 — an older post about an athlete we are already handling.
    const newest = newestPerAthlete.get(key);
    if (newest && postId(newest) !== id) {
      return {
        ...base,
        decision: 'skip_sibling' as const,
        reason: `superseded by ${postId(newest)} — same athlete, newer post`,
      };
    }

    // Gate 3 — too old to still be true as written.
    const maxAge = contentType === 'BREAKING' ? policy.maxBreakingAgeMs : policy.maxAgeMs;
    const age = ageDays(row, policy.now);
    if (policy.now - createdMs(row) > maxAge) {
      return {
        ...base,
        decision: 'skip_stale' as const,
        reason: `${contentType} is ${age.toFixed(1)}d old, past the ${(maxAge / 86_400_000).toFixed(1)}d budget`,
      };
    }

    return { ...base, decision: 'publish' as const, reason: 'eligible' };
  });
}

/** Unwraps the MCP text envelope for the single-object tools. */
function unwrap<T>(raw: unknown): T | null {
  const wrapped = raw as { content?: Array<{ text?: string }>; isError?: boolean };
  if (!wrapped || wrapped.isError) return null;
  const text = wrapped.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Is this athlete's injury already covered by a live post?
 *
 * Answers the question a human would ask before re-casting week-old news: has
 * the account already said this? A NEWER post for the same athlete carrying a
 * hash means yes — re-casting the older one duplicates coverage and lands the
 * timeline out of order.
 *
 * Deliberately NOT status-filtered, and safe without one: the check requires a
 * farcaster_hash or twitter_id, and a REJECTED or SUPERSEDED row can never have
 * either. rejectPost and supersedePosts both guard on status='PENDING_REVIEW',
 * so a retired row never published. If that guard is ever loosened, this
 * function needs an explicit exclusion.
 */
async function findNewerLivePost(row: OrphanRow): Promise<string | null> {
  const raw = await callTool('web', 'web_list_posts', {
    athlete_name: String(row.athlete_name ?? ''),
    ...(row.sport ? { sport: String(row.sport) } : {}),
    limit: 50,
  });
  const page = unwrap<{ posts?: OrphanRow[] }>(raw);
  const posts = page?.posts ?? [];

  const mine = createdMs(row);
  const newer = posts.find(
    (p) =>
      postId(p) !== postId(row) &&
      (p.farcaster_hash || p.twitter_id) &&
      createdMs(p) > mine,
  );
  return newer ? postId(newer) : null;
}

function csvEscape(value: string): string {
  return JSON.stringify(value ?? '');
}

function toCsv(rows: ReportRow[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]) as Array<keyof ReportRow>;
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(String(row[h] ?? ''))).join(','));
  }
  return lines.join('\n');
}

async function run(): Promise<void> {
  const opts = parseOptions();
  const now = Date.now();
  const live = opts.publish;

  console.log(
    live
      ? `[republish] LIVE RUN — will cast up to ${opts.postIds.size} named post(s)`
      : '[republish] DRY RUN — nothing will be cast. Add --publish --post-ids=… --confirm to post.',
  );

  if (live && !opts.confirm) {
    throw new Error('--publish requires --confirm. Read the dry-run report first.');
  }
  if (live && opts.postIds.size === 0) {
    throw new Error('--publish requires --post-ids=<uuid>,<uuid> naming exactly what to cast.');
  }
  if (live && opts.postIds.size > opts.maxPublishes) {
    throw new Error(
      `--post-ids names ${opts.postIds.size} posts but --max-publishes is ${opts.maxPublishes}. ` +
        'Raise it deliberately or cast fewer.',
    );
  }
  if (live && process.env.LAUNCH_ANNOUNCEMENT === 'true') {
    throw new Error(
      'LAUNCH_ANNOUNCEMENT=true — the publish path would re-announce the product on every ' +
        'republished post. Unset it before a live run.',
    );
  }

  // Full paged scan. Unpaged this would see only the newest 20 rows and quietly
  // under-report the backlog — the same truncation that hid the outage.
  const { posts, truncated } = await listAllPosts<OrphanRow>(
    { status: 'PUBLISHED' },
    { stopWhenOlderThan: opts.since },
  );
  if (truncated) {
    throw new Error('The scan was truncated by the page cap — the candidate list is incomplete.');
  }

  const orphans = posts
    .filter((p) => !p.farcaster_hash && !p.twitter_id)
    .filter((p) => p.created_at && now - createdMs(p) > GRACE_MS)
    .sort((a, b) => createdMs(a) - createdMs(b));

  console.log(
    `[republish] scanned ${posts.length} PUBLISHED post(s) since ${new Date(opts.since).toISOString()} — ` +
      `${orphans.length} reached no social platform`,
  );

  // Resolve the one piece of I/O the gates need, then decide purely.
  const newerLiveById = new Map<string, string>();
  for (const row of orphans) {
    try {
      const newer = await findNewerLivePost(row);
      if (newer) newerLiveById.set(postId(row), newer);
    } catch (err) {
      // A failed lookup must not suppress: skipping on error would silently
      // shrink the candidate list, which is the failure mode this whole change
      // is about. Fall through and let the operator judge from the preview.
      console.warn(`[republish] superseded check failed for ${postId(row)}: ${String(err)}`);
    }
  }

  const verdicts = classifyOrphans(
    orphans,
    { now, maxBreakingAgeMs: opts.maxBreakingAgeMs, maxAgeMs: opts.maxAgeMs },
    newerLiveById,
  );
  const verdictById = new Map(verdicts.map((v) => [v.post_id, v]));

  const report: ReportRow[] = [];
  const previews: string[] = [];
  const candidates: OrphanRow[] = [];
  let ctaViolations = 0;

  for (const row of orphans) {
    const id = postId(row);
    const verdict = verdictById.get(id)!;

    const base: ReportRow = {
      post_id: id,
      created_at: String(row.created_at ?? ''),
      age_days: ageDays(row, now).toFixed(1),
      athlete_name: String(row.athlete_name ?? ''),
      sport: String(row.sport ?? ''),
      content_type: String(row.content_type ?? '').toUpperCase(),
      injury_type: String(row.injury_type ?? ''),
      group_key: verdict.group_key,
      headline: String(row.headline ?? ''),
      decision: verdict.decision,
      reason: verdict.reason,
      newer_live_post_id: verdict.newer_live_post_id,
      n_casts: '',
      n_tweets: '',
      contains_orthoiq_cta: '',
      farcaster_hash_after: '',
      twitter_id_after: '',
    };

    if (verdict.decision !== 'publish') {
      report.push(base);
      continue;
    }

    const { content, reason } = reconstructPostContent(row);
    if (!content) {
      report.push({
        ...base,
        decision: 'skip_unreconstructable',
        reason: describeReconstructFailure(reason),
      });
      continue;
    }

    const siteUrl = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');
    const slug = String(row.slug ?? '');
    const postUrl = slug ? `${siteUrl}/post/${slug}` : '';

    // Render without publishing — the strongest thing a dry run can offer.
    const casts = formatForFarcaster(content, postUrl);
    const tweets = formatForTwitter(content, postUrl);
    const hasCta = [...casts, ...tweets].join('\n').toLowerCase().includes(CTA_MARKER);
    if (hasCta && content.content_type !== 'DEEP_DIVE') ctaViolations++;

    previews.push(
      [
        `───────── ${id} — ${content.athlete_name} (${content.content_type}, ${ageDays(row, now).toFixed(1)}d old)`,
        `FARCASTER (${casts.length} cast${casts.length === 1 ? '' : 's'}):`,
        casts.map((c, i) => `  [${i + 1}] ${c}`).join('\n\n'),
        `X (${tweets.length} post${tweets.length === 1 ? '' : 's'}):`,
        tweets.map((t, i) => `  [${i + 1}] ${t}`).join('\n\n'),
      ].join('\n'),
    );

    candidates.push(row);
    report.push({
      ...base,
      reason: opts.postIds.has(id) ? 'named on the command line' : 'eligible — not named for this run',
      n_casts: String(casts.length),
      n_tweets: String(tweets.length),
      contains_orthoiq_cta: String(hasCta),
    });
  }

  // File the stale ones so a human owns the call rather than losing it.
  //
  // Deliberately NOT gated behind --publish: adding a row to the internal review
  // queue is not a public cast, and holding it hostage to the publish flag would
  // mean the only way to file a stale post is to also be casting something.
  if (opts.flagStale) {
    // web_flag_for_md_review is explicitly not idempotent — it appends a new
    // PENDING row every call — so a second run would pile up duplicates.
    const alreadyFlagged = new Set<string>();
    try {
      const pending = unwrap<{ reviews?: Array<{ post_id?: string; reason?: string }> }>(
        await callTool('web', 'web_list_md_reviews', { status: 'PENDING' }),
      );
      for (const r of pending?.reviews ?? []) {
        if (String(r.reason ?? '').startsWith('social_orphan:')) {
          alreadyFlagged.add(String(r.post_id ?? ''));
        }
      }
    } catch (err) {
      throw new Error(
        `could not read the pending review queue, so flagging would risk duplicate rows: ${String(err)}`,
      );
    }

    for (const entry of report.filter((r) => r.decision === 'skip_stale')) {
      if (alreadyFlagged.has(entry.post_id)) {
        console.log(`[republish] ${entry.post_id} (${entry.athlete_name}) already has a pending social_orphan review — skipping`);
        continue;
      }
      try {
        // preserve_status so a retrospective flag does not pull a live post out
        // of PUBLISHED and out of every "published" filter downstream.
        await callTool('web', 'web_flag_for_md_review', {
          post_id: entry.post_id,
          reason: `social_orphan:stale_${entry.content_type.toLowerCase()}`,
          confidence_score: 1,
          flagged_by: ACTOR_ID,
          preserve_status: true,
        });
        await callTool('web', 'web_audit_append', {
          actor: 'automation',
          actor_id: ACTOR_ID,
          entity_type: 'injury_post',
          entity_id: entry.post_id,
          action: 'social_orphan_flagged',
          payload: { reason: entry.reason, age_days: entry.age_days, content_type: entry.content_type },
        });
        console.log(`[republish] flagged ${entry.post_id} (${entry.athlete_name}, ${entry.age_days}d) for MD review`);
      } catch (err) {
        console.error(`[republish] flag failed for ${entry.post_id}: ${String(err)}`);
      }
    }
  }

  // ── Publish ────────────────────────────────────────────────────────────
  if (live) {
    const named = candidates.filter((row) => opts.postIds.has(postId(row)));
    const unknown = [...opts.postIds].filter((id) => !named.some((row) => postId(row) === id));
    if (unknown.length > 0) {
      throw new Error(
        `These --post-ids are not eligible candidates (they were skipped by a gate, or are not orphans): ${unknown.join(', ')}`,
      );
    }

    for (const [index, row] of named.entries()) {
      const id = postId(row);
      const entry = report.find((r) => r.post_id === id)!;
      const { content, reason } = reconstructPostContent(row);
      if (!content) {
        // Reachable if the row changed between the dry-run scan and here.
        // Never skip a named --post-id silently: the operator asked for it.
        console.warn(`[Republish] Skipping ${id} — ${describeReconstructFailure(reason)}`);
        entry.decision = 'skip_unreconstructable';
        entry.reason = describeReconstructFailure(reason);
        continue;
      }

      const siteUrl = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');
      const slug = String(row.slug ?? '');
      const postUrl = slug ? `${siteUrl}/post/${slug}` : '';

      if (index > 0) {
        console.log(`[republish] waiting ${opts.delayMs}ms before the next publish`);
        await sleep(opts.delayMs);
      }

      console.log(`[republish] publishing ${id} — ${content.athlete_name} (${content.content_type})`);
      try {
        await publishApprovedPost(content, postUrl, id);

        // publishApprovedPost writes the hashes back itself. Read the row to
        // confirm they landed: a cast that published but whose hash could not be
        // parsed is live with no DB link, and a naive rerun would double-cast it.
        const fresh = unwrap<OrphanRow>(await callTool('web', 'web_get_post', { post_id: id }));
        const fHash = String(fresh?.farcaster_hash ?? '');
        const tId = String(fresh?.twitter_id ?? '');
        entry.farcaster_hash_after = fHash;
        entry.twitter_id_after = tId;
        entry.decision = fHash || tId ? 'published' : 'published_no_hash';
        if (entry.decision === 'published_no_hash') {
          entry.reason = 'PUBLISHED but no hash landed — check the cast manually before any rerun';
          console.error(`[republish] ${id}: no hash written back. Do NOT rerun this post blind.`);
        }

        await callTool('web', 'web_audit_append', {
          actor: 'automation',
          actor_id: ACTOR_ID,
          entity_type: 'injury_post',
          entity_id: id,
          action: 'social_republish',
          before: { farcaster_hash: null, twitter_id: null },
          after: { farcaster_hash: fHash || null, twitter_id: tId || null },
          payload: {
            reason: 'Aug 2026 social publish outage backfill',
            content_type: content.content_type,
            age_days: entry.age_days,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry.decision = 'error';
        entry.reason = message;
        console.error(`[republish] publish failed for ${id}: ${message}`);
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────
  const csv = toCsv(report);
  const previewText = previews.join('\n\n');
  await writeFile('./republish-orphans-report.csv', csv);
  await writeFile('./republish-orphans-preview.txt', previewText);

  console.log('\n===== RENDERED PREVIEW (nothing above was published unless a publish line says so) =====');
  console.log(previewText || '(no candidates survived the gates)');
  console.log('\n===== REPORT CSV =====');
  console.log(csv || '(no orphans found)');

  const tally = report.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\n[republish] live=${live} total=${report.length} ` +
      Object.entries(tally)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );

  if (ctaViolations > 0) {
    // Should be unreachable — reconstructPostContent carries the real type and
    // only the DEEP_DIVE builders emit the CTA. If it fires, stop.
    console.error(
      `\n[republish] ✗ ${ctaViolations} non-DEEP_DIVE candidate(s) rendered an OrthoIQ referral link. ` +
        'Do not publish. Investigate content-formatter dispatch.',
    );
    process.exitCode = 1;
  }

  if (!live) {
    console.log(
      '\n[republish] Next: read the preview above. Is each claim still true today? ' +
        'Then rerun with --publish --post-ids=<the ids you approved> --confirm.',
    );
  }
}

async function main(): Promise<void> {
  await initializeMCPClients();
  try {
    await run();
  } finally {
    await disconnectAll();
  }
}

// Only when run directly. The gate logic below is unit-tested, and importing
// this module must never connect to MCP servers or publish anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[republish] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
