import type { RawInjuryEvent } from '../types.js';

/**
 * Who PUBLISHED an event, at the granularity at which two reports count as
 * independent confirmation of each other.
 *
 * This is not `source_name` and not the source tier. `source_name` is our
 * fetcher's name for a feed, so `espn-nfl` and `espn-premier-league-news` are
 * two names for one newsroom — and treating them as two sources would mean
 * ESPN corroborating ESPN. The tier is coarser still: `espn.com` and
 * `theathletic.com` are both T1, which says they are both trustworthy, not
 * that they are two witnesses.
 *
 * The rule is one family per PUBLISHER, with two deliberate splits:
 *
 * - Every `espn-*` source collapses to `espn`. The structured injuries table
 *   and an ESPN story are the same organisation; the table is a roster fact
 *   ESPN maintains, not a second report.
 * - An X insider is `x:<handle>`, one family EACH. Schefter and Rapoport
 *   break stories against each other; a tweet is reporting, not a table. Two
 *   insiders on one injury is the strongest corroboration this pipeline can
 *   see. (Identity is still the numeric userId, checked upstream in
 *   x-insider-base before `source_name` is ever set — see x-insiders.ts.)
 * - NewsAPI is one `source_name` covering five outlets (DOMAINS in
 *   newsapi-nfl.ts), so the outlet only exists in `source_url`. Key on the
 *   registrable host: `profootballtalk.nbcsports.com` → `news:nbcsports.com`.
 *
 * Returns null when the publisher cannot be established, and **null never
 * corroborates**. That is the fail-closed direction: a source we cannot
 * identify must not be able to lower a publishing bar.
 *
 * Pure, and imports only types — `multi-source.ts` calls it, and pulling in
 * fact-validator (→ roster-sync → the MCP client) from there would drag the
 * database into the lowest-level fetch path.
 */

/** Hosts whose last two labels are a public suffix, not a registrable name. */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'co.za', 'org.uk', 'net.au',
]);

/** The NewsAPI query endpoint itself — a URL that names no outlet. */
const AGGREGATOR_HOSTS = new Set(['newsapi.org']);

function registrableHost(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  if (host.startsWith('www.')) host = host.slice(4);
  if (AGGREGATOR_HOSTS.has(host)) return null;

  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

export function sourceFamily(
  event: Pick<RawInjuryEvent, 'source_name' | 'source_url'>,
): string | null {
  const name = event.source_name?.trim();
  if (!name) return null;

  if (name.startsWith('X:')) {
    const handle = name.slice(2).trim().toLowerCase();
    return handle ? `x:${handle}` : null;
  }

  if (name.startsWith('espn-') || name === 'espn') return 'espn';

  if (name.startsWith('newsapi')) {
    const host = registrableHost(event.source_url);
    return host ? `news:${host}` : null;
  }

  return name.toLowerCase();
}

/**
 * Every family attached to an event: its own publisher plus any that
 * `deduplicateEvents` merged into it this cycle (see `corroborating_families`
 * in types.ts). Deduplicated, nulls dropped, own family first.
 *
 * The merged ones are stored ALREADY RESOLVED, because a family is not always
 * recoverable from the name alone: `newsapi-nfl` names five outlets and only
 * the loser's own `source_url` says which, and that URL is gone by the time
 * anything reads the survivor.
 */
export function sourceFamilies(event: RawInjuryEvent): string[] {
  const families: string[] = [];
  const own = sourceFamily(event);
  if (own) families.push(own);

  for (const merged of event.corroborating_families ?? []) {
    if (merged && !families.includes(merged)) families.push(merged);
  }
  return families;
}
