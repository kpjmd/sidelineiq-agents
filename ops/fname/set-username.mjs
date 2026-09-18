#!/usr/bin/env node
/**
 * Tell the hub about the new fname.
 *
 *   railway run --service sidelineiq-mcp-servers node ops/fname/set-username.mjs --check
 *   railway run --service sidelineiq-mcp-servers node ops/fname/set-username.mjs
 *
 * WHY A SECOND STEP AT ALL: the fname registry records who owns a name. What a
 * client DISPLAYS comes from a UserDataAdd(USER_DATA_TYPE_USERNAME) message on
 * the hub, which a hub merges only if a valid UserNameProof exists for the fid's
 * current custody address. So the registry transfer is the permission and this is
 * the act. Do them in that order or the hub rejects the message.
 *
 * It goes through Neynar because the Farcaster server already publishes casts
 * with a Neynar managed signer (src/servers/farcaster/client.ts) — so the
 * capability is bought and approved, and this needs no hub client and no new
 * dependency. It is one PATCH.
 *
 * NEYNAR_API_KEY and NEYNAR_SIGNER_UUID live only in the Railway mcp service, not
 * in any local .env — hence `railway run`. This script deliberately reads them
 * from the environment and never prints them.
 */
import { FID, TARGET_NAME, REGISTRY } from './config.mjs';

const NEYNAR = 'https://api.neynar.com/v2/farcaster';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}.`);
    console.error('Run this through the mcp service env:');
    console.error('  railway run --service sidelineiq-mcp-servers node ops/fname/set-username.mjs');
    process.exit(1);
  }
  return v;
}

async function readUsername(apiKey) {
  const res = await fetch(`${NEYNAR}/user/bulk?fids=${FID}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Neynar /user/bulk -> ${res.status} ${await res.text()}`);
  const data = await res.json();
  const user = data.users?.find((u) => u.fid === FID);
  if (!user) throw new Error(`Neynar returned no user for fid ${FID}`);
  return user.username ?? null;
}

async function registryName() {
  const res = await fetch(`${REGISTRY}/transfers/current?fid=${FID}`);
  if (res.status === 404) return null;
  const data = await res.json();
  return data?.transfer?.username ?? null;
}

const apiKey = requireEnv('NEYNAR_API_KEY');
const check = process.argv.includes('--check');

const [onRegistry, onHub] = await Promise.all([registryName(), readUsername(apiKey)]);
console.log(`  registry says: ${onRegistry ?? '(no name)'}`);
console.log(`  hub says:      ${onHub ?? '(no name)'}`);

if (onRegistry !== TARGET_NAME) {
  // Order matters and getting it wrong wastes a signer call for nothing: the hub
  // validates the proof against the registry, so this cannot succeed first.
  console.error(`\nThe registry does not yet hold "${TARGET_NAME}" for this FID.`);
  console.error('Run the transfers first: node ops/fname/submit.mjs <release.json> then <claim.json>.');
  process.exit(1);
}
if (onHub === TARGET_NAME) {
  console.log(`\nAlready done — the hub reports "${TARGET_NAME}".`);
  process.exit(0);
}
if (check) {
  console.log(`\nWould PATCH ${NEYNAR}/user with username="${TARGET_NAME}". Nothing sent.`);
  process.exit(0);
}

const signerUuid = requireEnv('NEYNAR_SIGNER_UUID');
const res = await fetch(`${NEYNAR}/user`, {
  method: 'PATCH',
  headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
  body: JSON.stringify({ signer_uuid: signerUuid, username: TARGET_NAME }),
});
const text = await res.text();

// Neynar answers 207 for a PARTIAL success, which is not a failure and not a
// success — print the body either way rather than deciding from the status alone.
console.log(`\nHTTP ${res.status}: ${text}`);
if (!res.ok) process.exit(1);

const after = await readUsername(apiKey);
console.log(`  hub now says:  ${after ?? '(no name)'}`);
if (after !== TARGET_NAME) {
  console.log('\n  Not yet reflected. Hub propagation is not instant; re-run --check in a minute.');
}
