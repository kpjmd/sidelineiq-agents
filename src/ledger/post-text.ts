/**
 * The text of a ledger entry's posts, rendered ONLY from a stored, published row
 * (spec "Card content spec" items 1–5 and "Forecast block, always this order";
 * "Provenance": "The card image and post text carry the entry ID, version and
 * the first 8 characters of row_hash"; "Channel scope": reply-first on X, the
 * ledger link in a self-reply, Farcaster as a timestamped mirror).
 *
 * Every builder takes a PublishedLedgerRow, which only assertPublishable can
 * produce, so a draft cannot be rendered by construction. Every string a reader
 * sees that is not the row's own content comes from copy.ts. The autonomous
 * injury posts' signature constant (brand.ts) is deliberately not imported
 * here: that line belongs to posts no physician reviews (tests grep for it).
 *
 * Budgets: X is the premium 25000-character limit, so the card text is complete.
 * Farcaster's protocol limit is 320 BYTES (Neynar's zod counts characters), so
 * the mirror is compact, uses ASCII separators, and is measured in UTF-8 bytes.
 * The entry URL rides as an EMBED there, outside the 320, and unfurls the card
 * image that carries the disclaimer strip and the AI line.
 */
import { siteOrigin } from '../config/brand.js';
import { LEDGER_COPY, LEDGER_PATH, findForbiddenWords } from './copy.js';
import { normalizeDate, normalizeProbability, shortHash } from './row-hash.js';
import type { PublishedLedgerRow } from './publishable.js';

export const FARCASTER_MAX_BYTES = 320;
export const X_MAX_CHARS = 25000;

export function entryUrl(row: Pick<PublishedLedgerRow, 'entry_id'>): string {
  return `${siteOrigin()}${LEDGER_PATH}/${row.entry_id}`;
}

export function ledgerIndexUrl(): string {
  return `${siteOrigin()}${LEDGER_PATH}`;
}

/** Whole-number percentage, as the spec prints every probability. */
export function pct(p: number | string): string {
  return `${Math.round(Number(normalizeProbability('probability', p)) * 100)}%`;
}

/** "3 (2–6)" — the spec's F4 shape. `dash` lets the Farcaster text stay ASCII. */
export function f4Label(point: number | string, low: number | string, high: number | string, dash = '–'): string {
  return `${Number(point)} (${Number(low)}${dash}${Number(high)})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 4, 2026" from a DATE column, read as the calendar day it stores. */
export function injuryDateLabel(value: string | Date): string {
  const iso = normalizeDate('injury_date', value);
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** `PT-2026-001 · v1 · a1b2c3d4` */
export function provenanceLine(row: PublishedLedgerRow, sep = ' · '): string {
  return [row.entry_id, `v${row.version}`, shortHash(row.row_hash)].join(sep);
}

function f5Line(row: PublishedLedgerRow): string {
  // null F5 is the concussion rule (spec "Evidence strength": "F5 void by rule").
  return row.f5_reinjury == null
    ? 'F5 re-injury within 6 games of return: not forecast (void by rule for this injury)'
    : `F5 re-injury within 6 games of return: ${pct(row.f5_reinjury)}`;
}

/**
 * The card reply on X. Complete: header, mechanism, the five fields in fixed
 * order, "what would move this", id · version · hash8, credit, publisher, AI
 * line, and the entry URL last so the platform unfurls the card image.
 */
export function buildXCardText(row: PublishedLedgerRow): string {
  const lines: string[] = [];
  lines.push(
    `${row.player} (${row.position}, ${row.team}) — reported: ${row.reported_injury} (tier ${row.source_tier}) · injury ${injuryDateLabel(row.injury_date)}`,
  );
  if (row.version > 1 && row.trigger) lines.push(`Revision v${row.version} — trigger: ${row.trigger}`);
  lines.push(`Mechanism: ${row.mechanism}`);
  lines.push('');
  lines.push(`F1 IR within 7 days: ${pct(row.f1_ir)}`);
  lines.push(`F2 plays next game: ${pct(row.f2_next)}`);
  lines.push(`F3 returns within 4 weeks: ${pct(row.f3_4wk)}`);
  lines.push(`F4 games missed: ${f4Label(row.f4_point, row.f4_low, row.f4_high)}`);
  lines.push(f5Line(row));
  if (row.season_ending === true || row.season_ending === 'true' || row.season_ending === 't') {
    lines.push('Season-ending flag set.');
  }
  lines.push('');
  lines.push(`What would move this: ${row.what_moves_this}`);
  lines.push('');
  lines.push(provenanceLine(row));
  lines.push(LEDGER_COPY.credit);
  lines.push(LEDGER_COPY.publisher);
  lines.push(LEDGER_COPY.ai_disclosure);
  lines.push(entryUrl(row));
  const text = lines.join('\n');
  if (text.length > X_MAX_CHARS) throw new Error(`X card text exceeds ${X_MAX_CHARS} characters (${text.length})`);
  return text;
}

/** Placeholder the dry run prints where the commit URL will go. */
export const COMMIT_URL_PENDING = '<commit url, set after the commit>';

/**
 * The self-reply under the card (S2-1): the ledger index, the row's commit as
 * the proof of when the number went out, and the reliance line.
 *
 * `reportUrl` is set only when the card was posted STANDALONE although the row
 * names a report post: X's API refuses a reply to (or quote of) a post unless
 * the author mentioned us ("You can only reply to or quote posts where you are
 * mentioned or are the author"), so a card under an insider's report is
 * structurally refused and the report is cited here instead. It is never the
 * last line, so X does not render it as a quote card.
 */
export function buildXSelfReplyText(row: PublishedLedgerRow, commitUrl: string | null, reportUrl: string | null = null): string {
  return [
    `Every forecast, scored against public outcomes: ${ledgerIndexUrl()}`,
    `Row ${provenanceLine(row)} committed: ${commitUrl ?? COMMIT_URL_PENDING}`,
    ...(reportUrl ? [`Report: ${citeableReportUrl(reportUrl)}`] : []),
    LEDGER_COPY.reliance,
  ].join('\n');
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

interface FarcasterVariant {
  mechanism: boolean;
  injuryDate: boolean;
  injuryMaxChars: number | null;
}

function farcasterCandidate(row: PublishedLedgerRow, v: FarcasterVariant): string {
  let injury = row.reported_injury;
  if (v.injuryMaxChars !== null && injury.length > v.injuryMaxChars) {
    injury = `${injury.slice(0, Math.max(1, v.injuryMaxChars - 3)).trimEnd()}...`;
  }
  const header = `${row.player} (${row.position}, ${row.team}) - ${injury} (tier ${row.source_tier})${v.injuryDate ? ` - injury ${injuryDateLabel(row.injury_date)}` : ''}`;
  const lines = [header];
  if (v.mechanism) lines.push(row.mechanism);
  const f5 = row.f5_reinjury == null ? 'Re-injury n/a' : `Re-injury ${pct(row.f5_reinjury)}`;
  lines.push(
    `IR ${pct(row.f1_ir)} | Next game ${pct(row.f2_next)} | 4 wk ${pct(row.f3_4wk)} | Games missed ${f4Label(row.f4_point, row.f4_low, row.f4_high, '-')} | ${f5}`,
  );
  if (row.version > 1 && row.trigger) lines.push(`v${row.version} trigger: ${row.trigger}`);
  lines.push(provenanceLine(row, ' '));
  lines.push(LEDGER_COPY.credit);
  return lines.join('\n');
}

/**
 * The Farcaster mirror, within 320 bytes. Drop order when over: the mechanism
 * line, then the injury date, then the reported-injury wording is truncated.
 * The five fields, the id, the version, the hash8 and the physician credit are
 * never shortened (spec: the human signature survives an AI-flagged post). If
 * it still does not fit, throw: a mirror that drops a field is not a mirror.
 */
export function buildFarcasterText(row: PublishedLedgerRow): string {
  const variants: FarcasterVariant[] = [
    { mechanism: true, injuryDate: true, injuryMaxChars: null },
    { mechanism: false, injuryDate: true, injuryMaxChars: null },
    { mechanism: false, injuryDate: false, injuryMaxChars: null },
    { mechanism: false, injuryDate: false, injuryMaxChars: 40 },
    { mechanism: false, injuryDate: false, injuryMaxChars: 20 },
  ];
  for (const v of variants) {
    const text = farcasterCandidate(row, v);
    if (utf8Bytes(text) <= FARCASTER_MAX_BYTES) return text;
  }
  const shortest = farcasterCandidate(row, variants[variants.length - 1]);
  throw new Error(`Farcaster mirror exceeds ${FARCASTER_MAX_BYTES} bytes even at its shortest (${utf8Bytes(shortest)})`);
}

/**
 * The tweet id inside a report URL (`reply_to_url`). Hosts x.com, twitter.com,
 * mobile.twitter.com (with or without www); paths `/{handle}/status/{id}` (a
 * trailing `/photo/1` is fine) and `/i/web/status/{id}`. Anything else is null,
 * never a guess: the publish function decides what a null means.
 */
export function tweetIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(host)) return null;
  const m = /^\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:\/|$)/.exec(u.pathname);
  return m ? m[1] : null;
}

/**
 * The report URL as the self-reply cites it: a tweet URL loses its query and
 * fragment (X's `?s=20` share tracker); anything else is cited verbatim. The
 * stored reply_to_url is frozen and the audit row records it raw.
 */
export function citeableReportUrl(url: string): string {
  if (tweetIdFromUrl(url) === null) return url;
  const u = new URL(url.trim());
  return `${u.origin}${u.pathname}`;
}

export interface RenderedLedgerTexts {
  x_card: string;
  x_self_reply: string;
  farcaster: string;
  farcaster_bytes: number;
  entry_url: string;
  /** Forbidden words found across all three texts, in first-appearance order. Empty = clean. */
  forbidden: string[];
}

/**
 * Render every text at once and run the spec's vocabulary rule over them.
 * `reportUrl`: see buildXSelfReplyText — set only for a standalone card.
 */
export function renderLedgerTexts(row: PublishedLedgerRow, commitUrl: string | null, reportUrl: string | null = null): RenderedLedgerTexts {
  const x_card = buildXCardText(row);
  const x_self_reply = buildXSelfReplyText(row, commitUrl, reportUrl);
  const farcaster = buildFarcasterText(row);
  const forbidden = [...new Set([...findForbiddenWords(x_card), ...findForbiddenWords(x_self_reply), ...findForbiddenWords(farcaster)])];
  return { x_card, x_self_reply, farcaster, farcaster_bytes: utf8Bytes(farcaster), entry_url: entryUrl(row), forbidden };
}
