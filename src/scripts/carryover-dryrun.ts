/**
 * Read-only dry run for the carryover date-anchor change.
 *
 * Answers the two questions the repo convention says must be answered against
 * LIVE data before shipping an extraction change — unit tests are not enough,
 * as the body-part fix proved when it passed every test and had still lost
 * ESPN's "(back)" parenthetical:
 *
 *   1. How many rows had their `injury_description` change?  MUST BE 0.
 *      That string keys body-part extraction (parts[0] keys entity matching),
 *      the classifier, the significance gate, the dedup fingerprint and the
 *      injury_updates timeline row. The new fields are strictly additive.
 *   2. How many rows would newly route to MD review, and is any of them a
 *      genuinely NEW injury?  False positives MUST BE 0.
 *
 * Usage:
 *   npx tsx src/scripts/carryover-dryrun.ts [--sport NFL|NBA] [--csv out.csv]
 *
 * Touches nothing: no MCP calls, no model calls, no writes.
 */
import { ESPNNFLSource } from '../monitoring/sports/espn-nfl.js';
import { ESPNNBASource } from '../monitoring/sports/espn-nba.js';
import { detectCarryoverSignals, isGatingCarryover } from '../agents/injury-intelligence/carryover.js';
import type { RawInjuryEvent } from '../types.js';
import { writeFileSync } from 'node:fs';

/** buildDescription() exactly as it stood BEFORE the change, for the diff. */
function legacyDescription(record: Record<string, any>): string {
  const parts: string[] = [];
  const d = record.details;
  if (d) {
    const frags = [d.side, d.location, d.type, d.detail].filter(
      (x: unknown): x is string => Boolean(x && String(x).trim()),
    );
    if (frags.length > 0) parts.push(frags.join(' '));
  }
  if (record.type?.description) parts.push(record.type.description);
  if (record.status) parts.push(`Status: ${record.status}`);
  if (record.shortComment) parts.push(record.shortComment);
  else if (record.longComment) parts.push(record.longComment);
  return parts.join(' — ').trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // indexOf returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] —
  // which silently reads the NEXT flag as the value.
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const sportArg = flag('--sport');
  const csvPath = flag('--csv');
  const sports = sportArg ? [sportArg.toUpperCase()] : ['NFL', 'NBA'];

  const rows: string[] = [
    'sport,athlete,designation,desc_changed,carryover_strength,codes,gating,in_window',
  ];
  let totalChanged = 0;

  for (const sport of sports) {
    const source = sport === 'NBA' ? new ESPNNBASource() : new ESPNNFLSource();
    const url = (source as unknown as { url: string }).url;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.error(`[dryrun] ${sport}: HTTP ${res.status} — skipping`);
      continue;
    }
    const feed = (await res.json()) as { injuries?: Array<{ injuries?: Record<string, any>[] }> };

    // Expected pre-change descriptions, keyed by athlete.
    const expected = new Map<string, string>();
    for (const g of feed.injuries ?? []) {
      for (const r of g.injuries ?? []) {
        if (r.athlete?.displayName) expected.set(r.athlete.displayName, legacyDescription(r));
      }
    }

    const parse = (source as unknown as { parse: (f: unknown) => RawInjuryEvent[] }).parse.bind(source);
    // Production window, then everything, so the operational number and the
    // corpus-wide number are both visible.
    process.env.MAX_EVENT_AGE_DAYS = process.env.MAX_EVENT_AGE_DAYS ?? '2';
    const windowed = new Set(parse(feed).map((e) => e.athlete_name));
    const prevAge = process.env.MAX_EVENT_AGE_DAYS;
    process.env.MAX_EVENT_AGE_DAYS = '100000';
    const all = parse(feed);
    process.env.MAX_EVENT_AGE_DAYS = prevAge;

    let changed = 0;
    let gating = 0;
    let gatingInWindow = 0;
    const strengths: Record<string, number> = { none: 0, prose: 0, structured: 0 };

    for (const ev of all) {
      const want = expected.get(ev.athlete_name);
      const descChanged = want !== undefined && want !== ev.injury_description;
      if (descChanged) changed++;
      const c = detectCarryoverSignals(ev);
      strengths[c.strength]++;
      const gates = isGatingCarryover(c, ev);
      if (gates) gating++;
      const inWin = windowed.has(ev.athlete_name);
      if (gates && inWin) gatingInWindow++;
      rows.push(
        [
          sport,
          JSON.stringify(ev.athlete_name),
          ev.roster_designation ?? '',
          descChanged,
          c.strength,
          JSON.stringify(c.codes.join('|')),
          gates,
          inWin,
        ].join(','),
      );
    }

    totalChanged += changed;
    console.log(
      `[dryrun] ${sport}: parsed=${all.length} DESCRIPTION_CHANGED=${changed} ` +
        `(must be 0) | strength none=${strengths.none} prose=${strengths.prose} ` +
        `structured=${strengths.structured} | gating=${gating} ` +
        `gating_in_window=${gatingInWindow} of ${windowed.size} in-window rows`,
    );
  }

  if (csvPath) {
    writeFileSync(csvPath, rows.join('\n') + '\n');
    console.log(`[dryrun] wrote ${rows.length - 1} rows to ${csvPath}`);
    console.log('[dryrun] Hand-review every gating=true row: any that describes a');
    console.log('[dryrun] genuinely NEW injury is a false positive and must be 0.');
  }

  if (totalChanged > 0) {
    console.error(`[dryrun] FAIL: ${totalChanged} row(s) changed injury_description.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[dryrun] failed:', err);
  process.exitCode = 1;
});
