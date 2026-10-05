/**
 * Record `tests/fixtures/ledger-copy.json` from `src/ledger/copy.ts`, so the
 * frontend's byte-identical twin is pinned to the same strings.
 *
 *   npx tsx src/scripts/ledger-copy-fixture.ts --emit-fixture
 *
 * Without the flag it exits non-zero if the fixture on disk differs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LEDGER_COPY,
  LEDGER_COPY_VERSION,
  PHYSICIAN_CREDENTIAL,
  LEDGER_BRAND,
  PUBLISHER_OF_RECORD,
  LEDGER_URL_DISPLAY,
  LEDGER_PATH,
  AEQUOS_LINK,
  FORBIDDEN_PUBLIC_WORDS,
} from '../ledger/copy.js';

const FIXTURE = resolve(process.cwd(), 'tests/fixtures/ledger-copy.json');

const fixture = {
  copy_version: LEDGER_COPY_VERSION,
  _recorded_from: 'src/scripts/ledger-copy-fixture.ts --emit-fixture (recorded from src/ledger/copy.ts, never typed)',
  _recorded_at: new Date().toISOString().slice(0, 10),
  _note:
    'Shared by sidelineiq-agents (src/ledger/copy.ts) and sidelineiq-frontend (lib/ledger-copy.ts). The two modules are byte-identical and this file is what stops them drifting: copy it to both repos together. copy_version must equal LEDGER_COPY_VERSION in both. Counsel edits land in copy.ts, then re-record.',
  constants: {
    PHYSICIAN_CREDENTIAL,
    LEDGER_BRAND,
    PUBLISHER_OF_RECORD,
    LEDGER_URL_DISPLAY,
    LEDGER_PATH,
    AEQUOS_LINK,
  },
  copy: LEDGER_COPY,
  forbidden_public_words: FORBIDDEN_PUBLIC_WORDS,
};

const text = JSON.stringify(fixture, null, 2) + '\n';
if (process.argv.includes('--emit-fixture')) {
  writeFileSync(FIXTURE, text);
  console.log(`wrote ${FIXTURE} (copy_version ${LEDGER_COPY_VERSION})`);
} else {
  let onDisk = '';
  try {
    onDisk = readFileSync(FIXTURE, 'utf8');
  } catch {
    console.error(`no fixture at ${FIXTURE}; run with --emit-fixture`);
    process.exit(2);
  }
  const stripDate = (s: string) => s.replace(/"_recorded_at": "[^"]+"/, '');
  const same = stripDate(onDisk) === stripDate(text);
  console.log(same ? 'OK   fixture matches copy.ts' : 'DIFF fixture differs from copy.ts');
  process.exit(same ? 0 : 1);
}
