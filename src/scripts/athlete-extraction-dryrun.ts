/**
 * Read-only dry run for the extractAthleteName club-name change.
 *
 * The convention this repo keeps: diff old against new over the REAL corpus
 * before shipping an extraction change, and name the number that must be zero.
 * Here that number is:
 *
 *   Names the OLD extractor got RIGHT that the new one drops or re-points at a
 *   different person.  MUST BE 0.
 *
 * The change can only ever ADD a skip — both new rules `continue` past a match
 * the old code would have returned — so every diff is old→new where old was a
 * club, a city or a position code. That direction is the safe one, but it is
 * not self-evidently harmless: skipping too eagerly would silently stop the
 * source emitting an event at all. So each changed row is printed for review
 * and classified, and a change whose OLD value already looked like a person is
 * counted as a regression.
 *
 * Corpora, all live:
 *   - the five allowlisted X insider timelines (the path that actually broke)
 *   - ESPN soccer/eng.1 news (the other production caller of extractAthleteName)
 *   - ESPN NFL + NBA news, as a wider proxy sweep
 *
 * Usage:
 *   npx tsx src/scripts/athlete-extraction-dryrun.ts
 *   npx tsx src/scripts/athlete-extraction-dryrun.ts --emit-pl-baseline
 *
 * The insider corpus is read from the recorded fixture rather than re-fetched:
 * X API calls are metered, and the fixture IS the live capture. Everything else
 * is fetched fresh. No MCP calls, no model calls, no writes except the explicit
 * --emit-pl-baseline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  INJURY_KEYWORD_RE,
  NAME_RE,
  extractAthleteName,
  type NameFilter,
} from '../monitoring/sports/text-extraction.js';
import { NBA_NAME_FILTER } from '../monitoring/sports/x-insider-nba.js';
import { NFL_NAME_FILTER } from '../monitoring/sports/newsapi-nfl.js';
import { PL_NAME_FILTER } from '../monitoring/sports/espn-premier-league-news.js';

/** extractAthleteName exactly as it stood BEFORE the change, for the diff. */
function legacyExtract(title: string, description: string, filter: NameFilter): string | null {
  for (const text of [title, description]) {
    if (!text) continue;
    for (const match of text.matchAll(NAME_RE)) {
      const first = match[1];
      if (filter.blocklist.has(first)) continue;
      const last = match[2].replace(/'s$/, '');
      if (last.length < 2) continue;
      return `${first} ${last}`;
    }
  }
  return null;
}

/**
 * Did the OLD value already look like a person? If so, changing it is a
 * regression rather than a fix.
 *
 * "Looks like a club" is the only thing we can assert mechanically: at least
 * one half is a team-name token. Anything else gets flagged for hand review
 * rather than silently counted as an improvement.
 */
function looksLikeClub(name: string, filter: NameFilter): boolean {
  const [first, last] = name.split(' ');
  return filter.teamTokens.has(first) || filter.teamTokens.has(last ?? '');
}

interface Corpus {
  label: string;
  filter: NameFilter;
  docs: Array<{ title: string; description: string }>;
}

async function espnNews(url: string): Promise<Array<{ title: string; description: string }>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const body = (await res.json()) as { articles?: Array<{ headline?: string; description?: string }> };
  return (body.articles ?? []).map((a) => ({
    title: a.headline ?? '',
    description: a.description ?? '',
  }));
}

function insiderCorpora(): Corpus[] {
  const fx = JSON.parse(
    readFileSync('tests/fixtures/x-insider-timelines.json', 'utf-8'),
  ) as { insiders: Array<{ handle: string; sport: 'NFL' | 'NBA'; tweets: Array<{ text: string }> }> };

  return fx.insiders
    .filter((i) => i.tweets.length > 0)
    .map((i) => ({
      label: `x-insider:${i.handle}`,
      filter: i.sport === 'NBA' ? NBA_NAME_FILTER : NFL_NAME_FILTER,
      // The source only ever parses tweets that trip the injury keyword; the
      // fixture is already filtered that way, but re-assert it so a future
      // re-record with a wider net does not quietly change what is measured.
      docs: i.tweets
        .filter((t) => INJURY_KEYWORD_RE.test(t.text))
        .map((t) => ({ title: t.text, description: '' })),
    }));
}

async function main(): Promise<void> {
  if (process.argv.includes('--emit-pl-baseline')) {
    const pl = JSON.parse(
      readFileSync('tests/fixtures/espn-pl-news-headlines.json', 'utf-8'),
    ) as { articles: Array<{ headline: string; description: string }> };
    const names = pl.articles.map((a) => legacyExtract(a.headline, a.description, PL_NAME_FILTER));
    writeFileSync(
      'tests/fixtures/pl-names-pre-fix.json',
      JSON.stringify(
        {
          _generated_by: 'npx tsx src/scripts/athlete-extraction-dryrun.ts --emit-pl-baseline',
          _note:
            'What extractAthleteName returned for every article in ' +
            'espn-pl-news-headlines.json BEFORE the club-name-pair and ' +
            'position-abbreviation rules — blocklist.has(first) alone, against the ' +
            'real PL_NAME_FILTER. The PL inertness test compares post-fix output to ' +
            'this, so it cannot pass by comparing new behaviour against itself.',
          names,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`[dryrun] wrote PL baseline: ${names.length} articles, ${names.filter(Boolean).length} non-null`);
    return;
  }

  const corpora: Corpus[] = [
    ...insiderCorpora(),
    { label: 'espn-pl-news', filter: PL_NAME_FILTER, docs: await espnNews('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/news?limit=50') },
    { label: 'espn-nfl-news (proxy)', filter: NFL_NAME_FILTER, docs: await espnNews('https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50') },
    { label: 'espn-nba-news (proxy)', filter: NBA_NAME_FILTER, docs: await espnNews('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=50') },
  ];

  let totalDocs = 0;
  let totalChanged = 0;
  let regressions = 0;

  for (const { label, filter, docs } of corpora) {
    let changed = 0;
    for (const doc of docs) {
      const before = legacyExtract(doc.title, doc.description, filter);
      const after = extractAthleteName(doc.title, doc.description, filter);
      if (before === after) continue;
      changed++;

      // The only safe direction: the old answer must have been club-shaped.
      const regression = before === null || !looksLikeClub(before, filter);
      if (regression) regressions++;
      console.log(
        `  ${regression ? 'REGRESSION' : 'fixed     '} [${label}] ` +
          `${JSON.stringify(before)} -> ${JSON.stringify(after)} | ` +
          `${doc.title.replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
    totalDocs += docs.length;
    totalChanged += changed;
    console.log(`[dryrun] ${label}: docs=${docs.length} changed=${changed}`);
  }

  console.log(
    `[dryrun] TOTAL docs=${totalDocs} changed=${totalChanged} ` +
      `REGRESSIONS=${regressions} (must be 0)`,
  );

  if (regressions > 0) {
    console.error(`[dryrun] FAIL: ${regressions} change(s) replaced a person-shaped name.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
