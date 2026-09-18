/**
 * The facts every script and the signer page share. Verified 2026-09-17.
 *
 * CUSTODY vs the connected wallet — read this before touching anything here.
 *
 * The fname registry accepts a signature from the fid's CUSTODY address and
 * nothing else: validateTransfer -> getAndValidateVerifierAddress calls
 * IdRegistry.idOf(owner) and requires it to equal the fid.
 *
 *   custody  0x9a508f43698e14525a23323f35927bd9dbe77acb  idOf = 3125237  <- signs
 *   verified 0x2d237E78EAd28f963FB63e70abAE964cA515804B  idOf = 0        <- does NOT
 *
 * The second is the account's verified "primary" wallet (Farcaster's own API
 * lists it under extras.ethWallets, labelled primary + warpcast). Both belong to
 * the founder, both show on the profile, and signing with the wrong one fails
 * with an opaque 400 `INVALID_FID_OWNER`. That is why sign.html refuses to
 * proceed unless the connected account matches CUSTODY_ADDRESS exactly.
 */
export const FID = 3125237;
export const CUSTODY_ADDRESS = '0x9a508f43698e14525a23323f35927bd9dbe77acb';
/** Named only so the signer page can say "that's the wrong one, and here's why". */
export const VERIFIED_WALLET_NOT_CUSTODY = '0x2d237E78EAd28f963FB63e70abAE964cA515804B';

export const CURRENT_NAME = 'sidelineiq';
export const TARGET_NAME = 'paratros';

export const REGISTRY = 'https://fnames.farcaster.xyz';

/**
 * EIP-712, copied from the registry's own src/signature.ts (`hub_domain`, which
 * is the domain verifySignature uses). chainId is 1 and the verifyingContract is
 * a mainnet address even though the fid lives on OP — that is the registry's
 * choice, not a mistake; do not "correct" it to 10.
 */
export const EIP712_DOMAIN = {
  name: 'Farcaster name verification',
  version: '1',
  chainId: 1,
  verifyingContract: '0xe3be01d99baa8db9905b33a3ca391238234b79d1',
};

export const EIP712_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  UserNameProof: [
    { name: 'name', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'owner', type: 'address' },
  ],
};

/**
 * TIMESTAMP_TOLERANCE in the registry is 10 * 60. Its source comment says
 * "5 minute" and is wrong — trust the constant. A signature is valid for ten
 * minutes either side of the timestamp it embeds.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 600;
