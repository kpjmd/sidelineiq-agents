/**
 * Record `tests/fixtures/ledger-hash-cases.json`: the canonical inputs and the
 * hash THIS implementation produces for each, so the mcp and frontend copies of
 * the row-hash algorithm are pinned to the same answers.
 *
 * The CASES below are the inputs; the hashes are never typed by hand. Each case
 * is chosen to exercise one normalisation rule (string vs number probability,
 * Date vs string timestamp, microsecond truncation, omitted vs null trigger,
 * key order), and the file records both the normalised input and the hash so a
 * failing twin can see which step diverged.
 *
 *   npx tsx src/scripts/ledger-hash-fixture.ts --emit-fixture
 *
 * Without the flag it prints the cases and exits non-zero if the fixture on
 * disk disagrees with the current implementation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LEDGER_HASH_VERSION,
  ledgerHashInput,
  ledgerRowHash,
  type HashableForecastRow,
} from '../ledger/row-hash.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ledger-hash-cases.json');

const BASE: HashableForecastRow = {
  entry_id: 'PT-2026-001',
  version: 1,
  published_at: '2026-10-06T18:04:05.123Z',
  trigger: null,
  player: 'Example Player',
  team: 'BUF',
  position: 'WR',
  injury_date: '2026-10-04',
  reported_injury: 'Grade 2 hamstring strain',
  source_tier: 'B',
  source_urls: ['https://x.com/example/status/1', 'https://www.example.com/report'],
  mechanism: 'Non-contact. Acceleration out of a cut, right leg. Q3 2:14.',
  base_rate_row: 'hamstring_strain',
  base_rate_strength: 'moderate',
  f1_ir: 0.18,
  f2_next: 0.12,
  f3_4wk: 0.61,
  f4_point: 3,
  f4_low: 2,
  f4_high: 5,
  f5_reinjury: 0.22,
  season_ending: false,
  what_moves_this: 'An IR designation, or a limited practice by Thursday.',
  tier: 1,
};

interface Case {
  name: string;
  /** What each twin must reproduce. */
  rule: string;
  input: Record<string, unknown>;
  /** A second input that must hash IDENTICALLY to `input` (normalisation equivalence), if any. */
  equivalent?: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: 'v1 baseline',
    rule: 'spec field list + published_at, hash_version inside the input',
    input: { ...BASE },
  },
  {
    name: 'probabilities as driver strings equal numbers',
    rule: 'NUMERIC comes back from the Neon driver as a string; "0.18" and 0.18 are one value, rendered as 4 decimals',
    input: { ...BASE },
    equivalent: { ...BASE, f1_ir: '0.18', f2_next: '0.1200', f3_4wk: '0.61', f5_reinjury: '0.22', f4_point: '3', f4_low: '2', f4_high: '5', tier: '1', version: '1' },
  },
  {
    name: 'published_at as Date, microseconds truncated',
    rule: 'a timestamptz arrives as a Date (ms) or an ISO string; both normalise to the ms ISO UTC string',
    input: { ...BASE },
    equivalent: { ...BASE, published_at: new Date('2026-10-06T18:04:05.123Z'), injury_date: new Date('2026-10-04T00:00:00.000Z') },
  },
  {
    name: 'omitted trigger equals null trigger on v1',
    rule: 'absent optional values are null',
    input: { ...BASE },
    equivalent: (() => {
      const { trigger: _t, ...rest } = BASE;
      return rest;
    })(),
  },
  {
    name: 'key order does not matter',
    rule: 'canonical JSON sorts keys recursively',
    input: { ...BASE },
    equivalent: Object.fromEntries(Object.entries(BASE).reverse()),
  },
  {
    name: 'v2 revision with trigger',
    rule: 'a revision is a different row with a different hash; trigger is inside the hash',
    input: {
      ...BASE,
      version: 2,
      published_at: '2026-10-08T14:30:00.000Z',
      trigger: 'Placed on injured reserve (ESPN transactions, 2026-10-07)',
      f1_ir: 1,
      f2_next: 0,
      f3_4wk: 0.05,
      f4_point: 5,
      f4_low: 4,
      f4_high: 8,
    },
  },
  {
    name: 'concussion entry: F5 null, season_ending true',
    rule: 'f5_reinjury may be null (void by rule for concussion); booleans accept driver t/f',
    input: {
      ...BASE,
      entry_id: 'PT-2026-002',
      reported_injury: 'Concussion',
      base_rate_row: 'concussion',
      f5_reinjury: null,
      season_ending: true,
      tier: 2,
    },
    equivalent: {
      ...BASE,
      entry_id: 'PT-2026-002',
      reported_injury: 'Concussion',
      base_rate_row: 'concussion',
      f5_reinjury: undefined,
      season_ending: 't',
      tier: 2,
    },
  },
  {
    name: 'a one-cent change is a different hash',
    rule: 'any forecast field moves the hash',
    input: { ...BASE, f2_next: 0.13 },
  },
];

function serializeInput(input: Record<string, unknown>): Record<string, unknown> {
  // JSON cannot carry a Date; record it the way it would arrive over the wire.
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, v instanceof Date ? { $date: v.toISOString() } : v === undefined ? { $undefined: true } : v]),
  );
}

function build() {
  return {
    hash_version: LEDGER_HASH_VERSION,
    _recorded_from: 'src/scripts/ledger-hash-fixture.ts --emit-fixture (hashes computed, never typed)',
    _recorded_at: new Date().toISOString().slice(0, 10),
    _note:
      'Shared by sidelineiq-agents (src/ledger/row-hash.ts), sidelineiq-mcp-servers (src/servers/web/ledger-hash.ts) and sidelineiq-frontend (lib/ledger-row-hash.ts). All three implementations are byte-identical and this file is what stops them drifting: copy it to all three repos together. hash_version must equal LEDGER_HASH_VERSION in each. {"$date": iso} marks a value that arrives as a Date; {"$undefined": true} marks an omitted key.',
    cases: CASES.map((c) => {
      const row = c.input as unknown as HashableForecastRow;
      const hash = ledgerRowHash(row);
      if (c.equivalent) {
        const other = ledgerRowHash(c.equivalent as unknown as HashableForecastRow);
        if (other !== hash) throw new Error(`case "${c.name}": equivalent input hashed differently`);
      }
      return {
        name: c.name,
        rule: c.rule,
        input: serializeInput(c.input),
        equivalent: c.equivalent ? serializeInput(c.equivalent) : undefined,
        normalized: ledgerHashInput(row),
        row_hash: hash,
      };
    }),
  };
}

const fixture = build();
if (process.argv.includes('--emit-fixture')) {
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${FIXTURE} (${fixture.cases.length} cases, hash_version ${fixture.hash_version})`);
} else {
  let onDisk: { cases: { name: string; row_hash: string }[] } | null = null;
  try {
    onDisk = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  } catch {
    console.error(`no fixture at ${FIXTURE}; run with --emit-fixture`);
    process.exit(2);
  }
  let drift = 0;
  for (const c of fixture.cases) {
    const stored = onDisk!.cases.find((s) => s.name === c.name);
    const ok = stored?.row_hash === c.row_hash;
    if (!ok) drift++;
    console.log(`${ok ? 'OK  ' : 'DIFF'} ${c.row_hash.slice(0, 8)} ${c.name}`);
  }
  process.exit(drift === 0 ? 0 : 1);
}
