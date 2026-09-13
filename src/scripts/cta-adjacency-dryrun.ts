/**
 * Read-only ship gate for the CTA adjacency rule (monetization plan, Phase 0.2).
 *
 * The rule: the commercial AequOs CTA appears ONLY on a DEEP_DIVE that is about
 * an injury TYPE — `content_type = 'DEEP_DIVE' AND subject_kind = 'INJURY_TYPE'`
 * (mcp migration 023). Before it, social put the CTA on every DEEP_DIVE, and the
 * web page put "Get Clinical Guidance →" on every post of every type.
 *
 * Every stored post is reconstructed and rendered through the REAL formatters —
 * Farcaster, 280-char X and long-form X, each with a post URL, which is how the
 * approval republish casts them. What the render did is then judged against the
 * RAW row, never through carriesReferralCta, so this cannot agree with a broken
 * predicate.
 *
 *   A — subject_kind census, and whether migration 023 is visible at all.
 *   B — every DEEP_DIVE row: the hand backfill list (ids to tag).
 *   C — SHIP GATE.
 *   D — old vs new: what stops carrying the CTA.
 *
 * Numbers that must be ZERO (section C):
 *   Z1  renders containing the CTA whose row is not DEEP_DIVE + INJURY_TYPE
 *   Z2  injury-type-led DEEP_DIVEs whose post 1 FRAMING block — the headline and
 *       subject line, before the body — reads "Name (Team)". Not the whole post:
 *       long-form X puts the entire clinical_summary in post 1, and a type-led
 *       summary names its athletes as context ("Four ACL tears … — Teddye
 *       Buchanan (Baltimore Ravens), Mykel Williams …"), which the rule allows.
 *       The first post-backfill run failed Z2 on exactly that, on both rows.
 *   Z3  injury-type-led DEEP_DIVEs that rendered NO CTA — the rule over-suppressing
 *   Z4  rows whose subject_kind is outside {NULL, INJURY_TYPE, ATHLETE}
 *   Z5  INJURY_TYPE on a non-DEEP_DIVE row — only the DEEP_DIVE scheduler writes it
 * Must be NON-ZERO with --after-backfill: injury-type-led DEEP_DIVEs carrying the
 * CTA. Before the backfill that number is legitimately 0 — every stored row
 * predates the column — so the flag is what separates "not tagged yet" from
 * "the CTA is gone".
 *
 * Retired rows are rendered too (they are what an erroneous republish would
 * cast), and counted separately in D.
 *
 * Usage:
 *   npx tsx src/scripts/cta-adjacency-dryrun.ts [--after-backfill]
 */
import 'dotenv/config';
import { initializeMCPClients, disconnectAll } from '../utils/mcp-client-manager.js';
import { isRetiredPostStatus, listAllPosts } from '../utils/web-posts.js';
import {
  describeReconstructFailure,
  reconstructPostContent,
  type StoredPostRow,
} from '../utils/post-content.js';
import {
  formatForFarcaster,
  formatForTwitter,
  REFERRAL_CTA_MARKER,
} from '../utils/content-formatter.js';
import type { InjuryPostContent } from '../types.js';

interface Row extends StoredPostRow {
  id?: string;
  slug?: string | null;
  status?: string;
  created_at?: string;
}

const SITE_URL = (process.env.SITE_URL ?? 'https://sidelineiq.vercel.app').replace(/\/$/, '');
const KNOWN_KINDS = new Set(['INJURY_TYPE', 'ATHLETE']);

function typeLedRaw(row: Row): boolean {
  return String(row.content_type ?? '').toUpperCase() === 'DEEP_DIVE' && row.subject_kind === 'INJURY_TYPE';
}

/** Headline block + subject line: everything before the body starts. */
function framingBlock(post: string): string {
  return post.split('\n\n').slice(0, 2).join('\n\n');
}

/** Farcaster, 280-char X and long-form X — the three live render paths. */
function renderAll(content: InjuryPostContent, postUrl: string): { text: string; firstPosts: string[] } {
  const saved = process.env.TWITTER_CHAR_LIMIT;
  try {
    const fc = formatForFarcaster(content, postUrl);
    process.env.TWITTER_CHAR_LIMIT = '280';
    const xShort = formatForTwitter(content, postUrl);
    process.env.TWITTER_CHAR_LIMIT = '25000';
    const xLong = formatForTwitter(content, postUrl);
    return {
      text: [...fc, ...xShort, ...xLong].join('\n').toLowerCase(),
      firstPosts: [fc[0] ?? '', xShort[0] ?? '', xLong[0] ?? ''].map(framingBlock),
    };
  } finally {
    if (saved === undefined) delete process.env.TWITTER_CHAR_LIMIT;
    else process.env.TWITTER_CHAR_LIMIT = saved;
  }
}

async function main(): Promise<void> {
  const afterBackfill = process.argv.includes('--after-backfill');
  await initializeMCPClients();
  let failures = 0;
  const mustBeZero = (label: string, ids: string[]) => {
    const ok = ids.length === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${ids.length}${ids.length ? `  e.g. ${ids.slice(0, 5).join(', ')}` : ''}`);
  };

  try {
    const { posts, truncated, pages } = await listAllPosts<Row>({}, { maxPages: 40 });
    if (truncated) {
      console.error('[cta-dryrun] FAIL: the post scan was truncated — results are not conclusive.');
      process.exitCode = 1;
      return;
    }
    console.log(`[cta-dryrun] ${posts.length} posts across ${pages} page(s), marker "${REFERRAL_CTA_MARKER}"`);

    // ── A. Census ────────────────────────────────────────────────────────
    console.log('\n── A. subject_kind census ──');
    const columnVisible = posts.some((p) => Object.prototype.hasOwnProperty.call(p, 'subject_kind'));
    console.log(
      `  column visible on rows: ${columnVisible ? 'yes' : 'NO — migration 023 is not applied (or rows predate the select)'}`,
    );
    const census = new Map<string, number>();
    for (const p of posts) {
      const k = `${String(p.content_type ?? '?').padEnd(13)} ${String(p.subject_kind ?? 'NULL')}`;
      census.set(k, (census.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...census.entries()].sort()) console.log(`    ${k.padEnd(28)} ${n}`);

    // ── B. DEEP_DIVE list for the hand backfill ─────────────────────────
    console.log('\n── B. Every DEEP_DIVE row (backfill list) ──');
    const deepDives = posts
      .filter((p) => String(p.content_type ?? '').toUpperCase() === 'DEEP_DIVE')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    for (const d of deepDives) {
      console.log(
        `  ${String(d.id)}  ${String(d.created_at ?? '').slice(0, 10)}  ${String(d.status ?? '').padEnd(14)} ` +
          `kind=${String(d.subject_kind ?? 'NULL').padEnd(11)} ${String(d.athlete_name ?? '')} — "${String(d.headline ?? '')}"`,
      );
    }

    // ── C. Ship gate ─────────────────────────────────────────────────────
    const z1: string[] = [];
    const z2: string[] = [];
    const z3: string[] = [];
    const z4: string[] = [];
    const z5: string[] = [];
    const unreconstructable = new Map<string, number>();
    let typeLedWithCta = 0;
    let deepDiveLosesSocialCta = 0;
    let retiredRendered = 0;

    for (const row of posts) {
      const id = String(row.id ?? '?');
      const kind = row.subject_kind;
      const ct = String(row.content_type ?? '').toUpperCase();

      if (kind != null && !KNOWN_KINDS.has(String(kind))) z4.push(id);
      if (kind === 'INJURY_TYPE' && ct !== 'DEEP_DIVE') z5.push(id);

      const { content, reason } = reconstructPostContent(row);
      if (!content) {
        const r = describeReconstructFailure(reason);
        unreconstructable.set(r, (unreconstructable.get(r) ?? 0) + 1);
        continue;
      }
      if (isRetiredPostStatus(row.status)) retiredRendered++;

      const postUrl = `${SITE_URL}/post/${String(row.slug ?? id)}`;
      const { text, firstPosts } = renderAll(content, postUrl);
      const hasCta = text.includes(REFERRAL_CTA_MARKER);
      const typeLed = typeLedRaw(row);

      if (hasCta && !typeLed) z1.push(`${id}(${ct}/${String(kind ?? 'NULL')})`);
      if (typeLed) {
        if (hasCta) typeLedWithCta++;
        else z3.push(id);
        const athleteFrame = `${String(row.athlete_name ?? '')} (${String(row.team ?? '')})`;
        if (row.athlete_name && firstPosts.some((p) => p.includes(athleteFrame))) z2.push(id);
      }
      if (ct === 'DEEP_DIVE' && !typeLed) deepDiveLosesSocialCta++;
    }

    console.log('\n── C. SHIP GATE ──');
    if (unreconstructable.size) {
      console.log(
        `  (not rendered: ${[...unreconstructable.entries()].map(([r, n]) => `${n} ${r}`).join('; ')})`,
      );
    }
    mustBeZero('Z1 CTA rendered on a row that is not DEEP_DIVE + INJURY_TYPE', z1);
    mustBeZero('Z2 injury-type-led DEEP_DIVE whose post 1 framing names "Athlete (Team)"', z2);
    mustBeZero('Z3 injury-type-led DEEP_DIVE that rendered no CTA', z3);
    mustBeZero('Z4 subject_kind outside {NULL, INJURY_TYPE, ATHLETE}', z4);
    mustBeZero('Z5 INJURY_TYPE on a non-DEEP_DIVE row', z5);
    const nonZeroOk = !afterBackfill || typeLedWithCta > 0;
    if (!nonZeroOk) failures++;
    console.log(
      `  ${afterBackfill ? (nonZeroOk ? 'ok  ' : 'FAIL') : 'info'}  injury-type-led DEEP_DIVEs carrying the CTA: ${typeLedWithCta}` +
        (afterBackfill ? ' (must be non-zero)' : ' (0 is expected before the backfill; rerun with --after-backfill)'),
    );

    // ── D. Old vs new ────────────────────────────────────────────────────
    console.log('\n── D. What stops carrying the CTA ──');
    const live = posts.filter((p) => !isRetiredPostStatus(p.status));
    const webKeeps = live.filter(typeLedRaw).length;
    console.log(`  social: ${deepDiveLosesSocialCta} DEEP_DIVE row(s) not marked INJURY_TYPE lose it (was: every DEEP_DIVE)`);
    console.log(`  web:    ${live.length - webKeeps} of ${live.length} non-retired page(s) lose "Get Clinical Guidance" (was: every page)`);
    console.log(`  retired rows rendered through the gate: ${retiredRendered}`);

    console.log(failures === 0 ? '\nSHIP GATE PASSED' : `\nSHIP GATE FAILED (${failures})`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error(`[cta-dryrun] crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
