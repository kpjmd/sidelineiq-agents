#!/usr/bin/env node
/**
 * Submit one signed fname transfer to the registry, or preflight without sending.
 *
 *   node ops/fname/submit.mjs --check          read-only; sends nothing
 *   node ops/fname/submit.mjs release.json     POST a payload from sign.html
 *
 * Zero dependencies. Node 18+ for global fetch.
 *
 * WHY THIS IS NOT A ONE-LINE CURL: the registry reports a rejection as a 400
 * carrying `{error, code}`, and the code is the entire diagnostic surface — a
 * bare status tells you nothing about which of seven things went wrong. It also
 * refuses to send a payload whose embedded timestamp has already expired, which
 * is the failure that otherwise looks identical to a bad signature.
 */
import { readFileSync } from 'node:fs';
import {
  FID, CUSTODY_ADDRESS, CURRENT_NAME, TARGET_NAME, REGISTRY, TIMESTAMP_TOLERANCE_SECONDS,
} from './config.mjs';

/** What each registry error code actually means here. */
const CODE_HELP = {
  TOO_MANY_NAMES:
    `The FID still holds a name. Submit the release of "${CURRENT_NAME}" first — one fname per FID.`,
  USERNAME_TAKEN: 'Someone else registered this name. It is gone; pick another.',
  USERNAME_RESERVED: 'The registry reserves this name for admins. Nothing to do here.',
  INVALID_FID_OWNER:
    `The "owner" in the payload does not own FID ${FID}. It must be the CUSTODY address\n` +
    `  ${CUSTODY_ADDRESS}\n  and NOT the account's verified primary wallet — see config.mjs.`,
  INVALID_SIGNATURE:
    'The signature does not verify against "owner". Usually the wrong wallet was connected,\n' +
    '  or the payload was hand-edited after signing (the name and timestamp are both signed).',
  INVALID_TIMESTAMP:
    `Outside the registry's ±${TIMESTAMP_TOLERANCE_SECONDS}s window. Re-sign and submit promptly.`,
  THROTTLED:
    'A name can only change once every 28 days. This applies per NAME, not per FID.',
  USERNAME_NOT_FOUND: 'Nothing to burn or transfer — this name is not registered.',
  UNAUTHORIZED: '"fid" must equal whichever of "from"/"to" is non-zero.',
};

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* the registry 404s with JSON, but be safe */ }
  return { status: res.status, body, json: parsed };
}

async function check() {
  console.log(`Registry: ${REGISTRY}\n`);

  const time = await getJson(`${REGISTRY}/current-time`);
  const registryNow = time.json?.currentTime;
  const localNow = Math.floor(Date.now() / 1000);
  const skew = registryNow ? localNow - registryNow : null;
  console.log(`  clock            registry ${registryNow}, local ${localNow}` +
    (skew === null ? '' : `, skew ${skew}s${Math.abs(skew) > 60 ? '  <-- LARGE' : ''}`));

  const current = await getJson(`${REGISTRY}/transfers/current?fid=${FID}`);
  const held = current.json?.transfer?.username ?? null;
  const owner = current.json?.transfer?.owner ?? null;
  console.log(`  fid ${FID}      currently holds ${held ? `"${held}"` : '(no name)'}`);
  console.log(`  owner on record  ${owner ?? '(none)'}`);
  if (owner && owner.toLowerCase() !== CUSTODY_ADDRESS.toLowerCase()) {
    console.log(`  !! the registry's owner differs from config.mjs CUSTODY_ADDRESS`);
  }

  const target = await getJson(`${REGISTRY}/transfers/current?name=${TARGET_NAME}`);
  const free = target.status === 404;
  console.log(`  "${TARGET_NAME}"       ${free ? 'AVAILABLE' : `TAKEN by fid ${target.json?.transfer?.to}`}`);

  console.log('\nPlan:');
  if (held === TARGET_NAME) {
    console.log(`  nothing to do — the FID already holds "${TARGET_NAME}".`);
  } else if (!free) {
    console.log(`  BLOCKED — "${TARGET_NAME}" is registered to another FID.`);
  } else if (held) {
    console.log(`  1. release "${held}"   (one-way: after this anyone may claim it)`);
    console.log(`  2. claim  "${TARGET_NAME}"  (retryable as often as needed)`);
  } else {
    console.log(`  1. (already released)`);
    console.log(`  2. claim  "${TARGET_NAME}"`);
  }
  console.log('\nNothing was sent.');
}

async function submit(path) {
  const payload = JSON.parse(readFileSync(path, 'utf8'));

  for (const key of ['name', 'from', 'to', 'fid', 'owner', 'timestamp', 'signature']) {
    if (payload[key] === undefined) throw new Error(`payload is missing "${key}"`);
  }
  if (payload.fid !== FID) throw new Error(`payload fid ${payload.fid} != ${FID}`);
  if (payload.owner.toLowerCase() !== CUSTODY_ADDRESS.toLowerCase()) {
    throw new Error(`payload owner ${payload.owner} is not the custody address`);
  }

  // Check the window BEFORE sending: an expired signature and a bad one both come
  // back as a 400, and only one of them is worth re-signing for.
  const { json } = await getJson(`${REGISTRY}/current-time`);
  const age = (json?.currentTime ?? Math.floor(Date.now() / 1000)) - payload.timestamp;
  if (Math.abs(age) > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new Error(
      `signature is ${age}s old; the registry accepts ±${TIMESTAMP_TOLERANCE_SECONDS}s. Re-sign in sign.html.`);
  }

  const action = payload.to === 0 ? `RELEASE "${payload.name}"` : `CLAIM "${payload.name}"`;
  console.log(`${action}  (${Math.abs(age)}s into a ${TIMESTAMP_TOLERANCE_SECONDS}s window)`);

  const res = await fetch(`${REGISTRY}/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();

  if (!res.ok) {
    let code = null;
    try { code = JSON.parse(text).code ?? null; } catch { /* keep the raw body */ }
    console.error(`\nFAILED  HTTP ${res.status}`);
    console.error(`  ${text}`);
    if (code && CODE_HELP[code]) console.error(`\n  ${code}: ${CODE_HELP[code]}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nOK  ${text}`);
  const after = await getJson(`${REGISTRY}/transfers/current?fid=${FID}`);
  console.log(`  fid ${FID} now holds: ${after.json?.transfer?.username ?? '(no name)'}`);
  if (payload.to === 0) {
    console.log('\n  The account has NO fname until the claim lands. Submit it now.');
  } else {
    console.log('\n  Registry done. The hub still shows the old name until a UserDataAdd is');
    console.log('  submitted — run set-username.mjs next (see README.md).');
  }
}

const arg = process.argv[2];
try {
  if (!arg || arg === '--check') {
    await check();
  } else {
    await submit(arg);
  }
} catch (err) {
  // A stack trace buries the one line that matters. Every throw in this file is
  // a precondition the operator can act on, so print it as an instruction.
  console.error(`\nREFUSED  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
