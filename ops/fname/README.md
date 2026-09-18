# Changing the Farcaster fname to `paratros`

FID **3125237**, currently `sidelineiq`. The Farcaster app's Edit profile →
Username does nothing for this account, so the change goes through the fname
registry API directly, signed by the account's custody wallet.

**You hold the key and do the signing.** Nothing here asks for, reads, stores or
transmits a private key or seed phrase. `sign.html` asks your wallet extension to
sign; only the resulting signature comes back to the page.

Zero dependencies — Node 18+ (for global `fetch`) and a browser wallet.

---

## The two addresses, and why this is the first thing on the page

    custody   0x9a508f43698e14525a23323f35927bd9dbe77acb   idOf = 3125237   <- signs
    verified  0x2d237E78EAd28f963FB63e70abAE964cA515804B   idOf = 0         <- does NOT

Both are the founder's and both appear on the profile — the second is the
account's *verified primary* wallet (Farcaster's API lists it under
`extras.ethWallets`, labelled `primary` + `warpcast`). The registry checks
`IdRegistry.idOf(owner) === fid`, so a signature from the verified wallet is
rejected with a bare 400 `INVALID_FID_OWNER` that explains nothing.

`sign.html` refuses to sign anything unless the connected account is the custody
address, and says so by name if the verified one is connected.

## Why it is two transfers, not one

One fname per FID. `validateTransfer` calls `getCurrentUsername(to)` and throws
`TOO_MANY_NAMES` if the destination already holds a name, so `paratros` cannot be
claimed while the FID still holds `sidelineiq`:

1. **release** — `{name: sidelineiq, from: 3125237, to: 0}`
2. **claim** — `{name: paratros, from: 0, to: 3125237}`

The signed claim embeds `name`, so these are different messages and need **two
signatures**.

**Asymmetric risk, so get the order and the timing right.** The release is
one-way: afterwards anyone may take `sidelineiq`, and re-taking it yourself is
throttled for 28 days. The claim is **not** throttled (`paratros` has no prior
transfer) and can be retried as often as needed. So the only real exposure is the
gap between the two — **sign both before submitting either**, and the account is
nameless for seconds.

## Run it

```bash
# 1. Preflight. Read-only; sends nothing.
node ops/fname/submit.mjs --check

# 2. Serve the signer page. Extensions do not inject window.ethereum into
#    file:// pages, so it must be http://localhost.
cd ops/fname && python3 -m http.server 8731 --bind 127.0.0.1
```

Open <http://127.0.0.1:8731/sign.html>, connect the **custody** account, and press
both Sign buttons. Save each JSON block to a file.

**Your wallet must be on Ethereum Mainnet while it signs.** If it is on Base, OP
or anything else you get:

    Provided chainId "1" must match the active chainId "8453"

That is the wallet's guard, not the registry's: `eth_signTypedData_v4` refuses
when `domain.chainId` differs from the active network. The page detects this,
names the network you are on, and offers a button that switches for you.

**Nothing is sent on-chain and no gas is spent** — the network only sets the
signing context. Do **not** edit the domain to match your wallet: the registry
verifies against chainId 1, so a signature made under any other domain recovers
to a different address and comes back `INVALID_SIGNATURE`. (chainId 1 is not
where the FID lives either — the ID Registry is on OP Mainnet. The domain is
just a namespace.)

```bash
# 3. Submit, release first, promptly — a signature is valid for ±600s.
node ops/fname/submit.mjs release.json
node ops/fname/submit.mjs claim.json

# 4. Tell the hub. The registry records ownership; what clients DISPLAY comes
#    from a UserDataAdd the hub merges only against a valid proof, so this must
#    come after step 3. Uses the Neynar managed signer the Farcaster MCP server
#    already publishes casts with, so no new credential and no new dependency.
railway run --service sidelineiq-mcp-servers node ops/fname/set-username.mjs --check
railway run --service sidelineiq-mcp-servers node ops/fname/set-username.mjs
```

`NEYNAR_API_KEY` / `NEYNAR_SIGNER_UUID` live only in the Railway mcp service —
hence `railway run`.

## Verify

```bash
curl -s "https://fnames.farcaster.xyz/transfers/current?fid=3125237" | python3 -m json.tool
```

`username` must read `paratros`. Then `set-username.mjs --check` should report the
hub agreeing. Hub propagation is not instant; re-run after a minute.

Afterwards, confirm the next daily metrics snapshot still writes
`farcaster_followers`. It should: nothing is keyed on the handle — the snapshot
reads the numeric FID, and `metric_snapshots.detail.username` is informational
and simply changes value. The series stays continuous.

## No repo change is needed for any of this

No code keys on the handle. The only `sidelineiq_` strings are recorded test
fixtures (`tests/fixtures/neynar-user-bulk.json`, `x-users-me.json`) — **leave
them**, they are recordings of a past response, not configuration.

## What the page refuses to sign

A connected account that is not the custody address (naming the verified wallet
explicitly if that is the one connected), and a wallet pointed at any network
other than Ethereum Mainnet. Both are checked independently and re-checked when
you change account or network in the extension — switching does not reload the
page, and a stale "confirmed" would hand the registry a signature from the wrong
address.

## What `submit.mjs` refuses before sending

A wrong owner, a wrong FID, a missing field, and — the one that otherwise looks
exactly like a bad signature — a timestamp outside the registry's ±600s window.
On a real rejection it prints the registry's `code` and what that code means
here, because the code is the entire diagnostic surface.

## Also still open on this profile

- The connected X account still reads `sidelineiq_`. The X handle is now
  `@Paratrosinjury`, so that link is stale; re-verify it in the app. Not
  something a script can do.
- `sidelineiq` on Farcaster is genuinely lost after the release — one fname per
  FID is a hard registry limit, so it cannot be held as a placeholder the way an
  X handle could.
