# PersonalWallet

A self-custody savings wallet for EVM chains, held by **exactly three owners**, where **every
operation that can move value needs two of them** — and widening the wallet's reach needs all
three plus a timelock that any single owner can veto.

Holds native currency, ERC-20, ERC-721 and ERC-1155, and moves NFTs of both standards in one
batch. **Not a proxy. Not upgradeable. No `renounceOwnership` anywhere in the ABI.**

Ships with two event listeners that watch the deployed wallets and email on every event.

```
contracts/      the wallet and the test tokens it is exercised against
test/           150 tests, including an adversarial suite
scripts/        deploy · verify · live end-to-end run · secret scan
listeners/      two chain watchers + their systemd units
docs/           the contract reference, the design notes, the Slither triage
deployed/       one JSON record per deployment: address, constructor args, compiler settings
```

---

## What is deployed right now

| chain | chainId | PersonalWallet | verified |
|---|---|---|---|
| GembaChain testnet | 821207 | [`0x586CfE0D34D812F53FbefD78F9Ad0243f79A685D`](https://gembascan.io/address/0x586CfE0D34D812F53FbefD78F9Ad0243f79A685D#code) | yes |
| Sepolia | 11155111 | [`0x992877042cB4f33222218f503361D4d957a749f5`](https://sepolia.etherscan.io/address/0x992877042cB4f33222218f503361D4d957a749f5#code) | yes |

Both are configured the same way: three owners, threshold two, **both allowlists enforced** — the
token registry and the recipient registry — and a 72-hour timelock on anything that widens the
wallet's reach.

🔑 **These two addresses are the only live ones.** The machine-readable source of truth is
`deployed/<network>-latest.json` → `contracts[0].address`; read it rather than copying an address
out of prose. Nothing in this repository is configured to act on an earlier generation: no npm
script, no `.env.example` default, no script default. The four addresses listed below appear only
as history and in the immutable `deployed/<timestamp>.json` records, which exist precisely so that
"what was deployed when" survives — and all four are empty.

### Earlier deployments — retired and emptied on 2026-10-24

Two generations held assets until the recipient approvals matured (3-of-3, 2026-10-23 20:26 UTC).
Everything moved across through the same guarded path as any other transfer — propose, confirm,
execute — with **no privileged escape route**: the old contracts have no sweep function, no owner
withdrawal, nothing that the guardian rules do not also apply to. That is why it took 79
transactions instead of four.

The listeners now watch **one address per chain**. They were narrowed only AFTER each old contract
was proven empty item by item, because an unwatched contract holding value is exactly the gap this
project exists to avoid.

| deployed | chain | address | what it lacked | swept |
|---|---|---|---|---|
| 2026-10-12 | gemba | [`0x3F6357a7…1BaE2`](https://gembascan.io/address/0x3F6357a74Bec93F6281aA1FC705133eC71a1BaE2#code) | both exit fixes | ✅ empty |
| 2026-10-12 | sepolia | [`0x628b6A26…ccF56`](https://sepolia.etherscan.io/address/0x628b6A266fFb4acED394D3eb7879B880B7eccF56#code) | both exit fixes | ✅ empty |
| 2026-10-20 am | gemba | [`0x0b59725c…12A9`](https://gembascan.io/address/0x0b59725cb461a5F81352E239B4Ccf546e10712A9#code) | the NFT exit checks | ✅ empty |
| 2026-10-20 am | sepolia | [`0x3eC14206…1811`](https://sepolia.etherscan.io/address/0x3eC142069f86B874a05448F4EB9Af9db4F7D1811#code) | the NFT exit checks | ✅ empty |

The current gemba wallet now holds the consolidated position: **5.56 GMB**, six ERC-20s at
3,000,000,000 each (three wallets' worth), and **15 NFT positions** — six MockERC721, five Kotkata
and four ERC-1155 — all arriving through `proposeNFTBatch` in one proposal per wallet.

#### The sweep has been rehearsed, not planned

The recipient approvals above take 72 hours and can be spent **once**. A sweep that turns out to be
missing a step is not a retry — it is three more days. So the whole thing was executed against a
**local fork of each live chain** first:

```
npm run rehearse:gemba     # forks, impersonates the owners, warps past the timelock, sweeps,
                           # then verifies each old wallet is EMPTY, item by item
FORK_RPC=<sepolia> LOG_RPC=<archive sepolia> npm run rehearse:sepolia
```

Sepolia needs `LOG_RPC` pointed at a node that keeps full log history — the public one prunes to
~10 000 blocks and would report the five Kotkata NFTs as absent.

Result: gemba **16 proposals / 50 transactions / 4.74 M gas**, sepolia **9 / 29 / 2.78 M**, zero
reverts, zero leftovers, and one `proposeNFTBatch` taking all five NFT positions at once. The live
run is `scripts/migration-sweep.js`, the same plan with a dry-run default — it prints every step and
sends nothing unless `I_MEAN_IT=yes`.

What the rehearsal actually caught was the **inventory**, not the contract: the first pass reported
"1 NFT to move" where there were five. `Kotkata by GembaPay` answers ERC-165 for ERC-721 with
**false** while `ownerOf` works; the mocks mint at id 9001+ so a `0..totalSupply` walk finds
nothing; `eth_getLogs` fails four different ways across free RPC tiers and a Hardhat fork answers
historical ranges with an **empty list instead of an error**. Every one of those would have left
assets stranded in a contract whose one-shot approval had already been spent. Asset discovery now
lives in `scripts/lib/holdings.js`, classifies by **behaviour** rather than advertised interface,
and re-reads every row from the chain before believing it. The full account is in
[`docs/INVARIANTS.md`](docs/INVARIANTS.md).

Why two generations in one day: invariant fuzzing found the ERC-20 exit never checked that the
asset had actually moved, which was fixed and deployed in the morning. The same campaign, extended
to the NFT paths that afternoon, found the identical gap in `executeERC721`, `executeERC1155` and
every item inside `executeNFTBatch`. Rather than leave a known gap live, both were closed and
redeployed. See [`docs/INVARIANTS.md`](docs/INVARIANTS.md).

Full records — constructor arguments, compiler settings, transaction hashes — are in `deployed/`.

---

## 🔴 Mainnet will use fresh keys — all of them

Everything above is a testnet. Nothing here has ever guarded real money, which is why the key
hygiene has been allowed to be as it is: three owner keys and the deployer sit in `.env` in
plaintext, so the 2-of-3 threshold is **1-of-1 in custody** — one file read is three signatures.
That is a known, accepted trade for testnet.

**Mainnet starts from zero keys.** None of the addresses in this repository carries over:

| seat | where the key comes from | notes |
|---|---|---|
| deployer | **newly generated**, offline | signs the deployment only; never an allowlisted recipient |
| owner 1 | **newly generated**, offline | taken offline once the setup transactions are done |
| owner 2 | **newly generated**, offline | same |
| owner 3 | **the Ledger** (Nano X, SE 2.8.0) | hardware signature; `scripts/ledger/` reads and signs with it |

🔑 **The owner private keys never need to touch the deploy machine.** `scripts/deploy.js` accepts
`OWNER_1/2/3` as plain **addresses** and only falls back to deriving them from private keys. So
generate the two cold keys offline, put their addresses in the environment, and the window in which
two of three signing keys exist on a connected disk is **zero** — not "short".

🔑 And the deployer must **not** be allowlisted as a recipient on mainnet. On the testnet wallets it
is, labelled "deployer / escape hatch"; that convenience is what turns a deploy key into a payout
destination. Mainnet gets no escape hatch.

See the `personal-wallet-hardware-keys-plan` note for the ordering and the open questions.

## The security model, in one rule

With 2-of-3, an attacker holding two keys can do anything two owners can. No control that two
owners can switch off is worth anything against that. So:

> **EXPANDING what the wallet can do is slow, and ANY ONE owner can stop it.
> SHRINKING what the wallet can do is immediate, and nobody can stop it.**

| | who | when | vetoable by one owner |
|---|---|---|---|
| allowlist a **recipient** | **all three** | after the timelock | **yes** |
| replace an **owner** | two | after the timelock | **yes** |
| **loosen** the policy — shorter delay, requirement off | two | after the timelock | **yes** |
| remove a recipient · add or remove a token · **tighten** the policy | two | at once | no |
| move native / ERC-20 / ERC-721 / ERC-1155 / a batch | two | at once | **no** — one owner must never block a decision the other two made |
| **deposit** anything | **one**, anyone | at once | n/a |

Why each piece has to be there — including why owner replacement is timelocked too, why the veto
must be single-signature, and why the delay needs a ceiling as well as a floor — is in
[`docs/CONTRACT.md`](docs/CONTRACT.md).

### The operating rule

**Keep at least one allowlisted recipient that is a cold address you control.** It is the escape
hatch: with it, the worst case under two compromised keys is that funds get pushed to your own
address — annoying, not theft. `scripts/deploy.js` refuses to deploy with `STRICT_RECIPIENTS=true`
and no seeded recipient for exactly this reason.

---

## Getting started

Requires **Node 20 or newer**. Node 22 is what this was built on; the listeners run on Node 20 on
a Raspberry Pi.

```bash
git clone https://github.com/ivanovslavy/personal-wallet.git
cd personal-wallet
npm install
cp .env.example .env        # then fill it in — see below
npm run build               # hardhat compile
npm test                    # 150 tests
```

### Filling in `.env`

`.env` is gitignored and must stay that way. `npm run check:secrets` enforces it independently,
and the same scan runs as a pre-commit and pre-push hook once you run `npm run hooks:install`.

```ini
# Keys. Account 0 deploys and pays gas; 1–3 are the three owners.
PRIVATE_KEY_DEPLOYER=
PRIVATE_KEY_OWNER1=
PRIVATE_KEY_OWNER2=
PRIVATE_KEY_OWNER3=

# RPC. Either one endpoint per network…
GEMBATESTNET_RPC_URL=https://rpc1.gembascan.io
SEPOLIA_RPC_URL=
# …or a comma-separated list, which the listeners use with fallback and Hardhat uses the first of.
GEMBA_RPC_URLS=https://rpc1.gembascan.io,https://rpc2.gembascan.io,https://rpc3.gembascan.io
SEPOLIA_RPC_URLS=

# Verification. Etherscan API V2: one key covers Ethereum, BSC and Polygon.
ETHERSCAN_API_KEY=

# The listeners
WATCH_GEMBA=0x…            # PersonalWallet on 821207
WATCH_SEPOLIA=0x…          # PersonalWallet on 11155111
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
MAIL_TO=
```

---

## Networks

### GembaChain testnet — adding it to MetaMask

| field | value |
|---|---|
| Network name | GembaChain Testnet |
| RPC URL | `https://rpc1.gembascan.io` (also `rpc2`, `rpc3`) |
| Chain ID | **821207** |
| Currency symbol | **GMB** |
| Block explorer | `https://gembascan.io` |

In MetaMask: **Settings → Networks → Add a network → Add a network manually**, paste the five
fields above, save, then switch to it. Nothing else is needed — it is a standard EVM JSON-RPC
endpoint.

**Getting test assets:** the faucet at **https://gembachain.io/#faucet** drips `0.1 GMB` plus
`10 000` of each test stablecoin per wallet, with a 24-hour cooldown per asset. Those three tokens
are allowlisted on the deployed wallet:

| token | address | decimals |
|---|---|---|
| USDT (Test) | `0xF61647866ad7be8137230Ad688092D2f3F4A1666` | 6 |
| USDC (Test) | `0xc9af98AD8ae78086620821F9Ceb05842Dd7950CF` | 6 |
| EURC (Test) | `0x7Ff43282d7939418a3f0A308E2d48Dd93536044e` | 6 |

Alongside them, five freely-mintable mocks deployed by this project (`npm run deploy:mocks:gemba`)
are allowlisted too, so the wallet can be exercised without waiting on a faucet cooldown — their
addresses are in `deployed/gembatestnet_*.json`.

### Sepolia

| field | value |
|---|---|
| Chain ID | **11155111** |
| Explorer | `https://sepolia.etherscan.io` |

The deployed wallet allowlists the three stablecoins this project's sibling systems already use on
Sepolia, all 6 decimals:

| token | address |
|---|---|
| USDT | `0x00D75E583DF2998C7582842e69208ad90820Eaa1` |
| USDC | `0xC4De068C028127bdB44670Edb82e6E3Ff4113E49` |
| EURC | `0x2FCb50B9cA1cf336a287C1b9987720FC541260B4` |

> **Note on Sepolia gas.** Sepolia currently runs a non-standard gas schedule: measured
> 2026-10-12, deploying this contract costs **36.4 M gas there against 5.2 M on GembaChain** for
> identical bytecode — a consistent ~7× across contract sizes — and a real plain transfer in a
> Sepolia block was observed using **15 000** gas, below the 21 000 intrinsic minimum. Its block
> limit is 200 M. **Do not size a mainnet deployment from a Sepolia estimate**; re-estimate against
> the target chain.

### Also configured

`mainnet` (1), `bsc` (56) and `polygon` (137) are wired in `hardhat.config.js` with public RPC
fallbacks and Etherscan V2 verification. Nothing is deployed to them, and the mock-token script
refuses to run on any of them.

---

## Working with it

```bash
npm test                      # 150 tests + the surface-coverage gate
npm run slither               # static analysis of the deployed contract
npm run deploy:gemba          # deploy (also :sepolia :bsc :polygon :mainnet)
npm run verify:gemba          # source verification (also :sepolia :bsc :polygon :mainnet)
npm run live:gemba            # 245-check end-to-end run against the live chain
npm run check:secrets         # refuse to publish a credential
npm run hooks:install         # wire the secret scan as a git hook
```

### Reading the hardware wallet

The three owner keys currently live in `.env` as plaintext, which makes the 2-of-3 threshold
**1-of-1 in practice** — one file read is all three signatures. Moving the seats onto a hardware
signer is the fix, and `scripts/ledger/ledger-probe.py` is the groundwork: it talks to a Ledger
over raw USB HID, with **no dependencies at all** — standard library only, including its own
base58, bech32, secp256k1 and BIP-32.

```bash
scripts/ledger/ledger-probe.py selftest   # run this FIRST — proves the derivation against the
                                          # official BIP-84 vector before any address is trusted
scripts/ledger/ledger-probe.py info       # firmware, bootloader, onboarding state, open app
scripts/ledger/ledger-probe.py apps       # what is actually on the chip, with hashes
scripts/ledger/ledger-probe.py eth        # address at 44'/60'/0'/0/0
scripts/ledger/ledger-probe.py sol        # address at 44'/501'/0'
scripts/ledger/ledger-probe.py btc        # xpub at 84'/0'/0' + the first receive address
```

Zero dependencies is the point, not a flourish: the device exists to shrink the trust surface, and
reading it through a transitive dependency tree hands that back. It can neither derive nor request
a private key — only `CKDpub` is implemented, so hardened derivation is impossible by construction
— and it cannot install or remove apps, because official app installation needs a secure channel to
Ledger's HSM. The CLI alternatives sideload unsigned apps and leave the device reporting
"not genuine"; that trade is not worth making.

And signing, which is the part that actually matters:

```bash
TO=0x… AMOUNT=0.5 npx hardhat run scripts/ledger/send-eth.js --network gembatestnet
```

`send-eth.js` builds the transaction with ethers, has the **device** sign it, and broadcasts —
again with no `@ledgerhq/*` packages. The device's `v` is not usable as returned (EIP-155 truncates
it to one byte), so rather than reproducing the app's arithmetic it tries **both parities, recovers
the sender from each, and keeps the one equal to the address the chip reported for that path**. A
transaction that does not recover to the Ledger's own address is never broadcast — which removes a
class of wrong-`v` bugs and proves the signature belongs to the expected account first.

Proven on GembaChain testnet: 0.5 GMB signed on the device and mined in block 4333390, and the ETH
address cross-checked independently — `keccak256` of the public key the chip returned reproduces
the address string the chip reported.

Three things about the protocol that cost real time:

- **`B0` and `E0` are different worlds.** `B0` is answered by the dashboard *and* by every app
  (`B0 01` = what is running, `B0 A7` = quit). `E0` belongs to whoever is in charge — the OS on the
  dashboard, the **app** inside an app. So quitting with `E0 A7` silently does nothing while an app
  is open, and every later command lands in the wrong place.
- **Opening an app needs a button press on the device.** The host asks, the Nano prompts, a human
  answers. An earlier version polled in silence for 15 s and then said "could not open <app> — is
  it installed?", which is false and sends you to reinstall a working app.
- **`5515` means locked** and **`6901` means the device is waiting for a human** — a confirmation
  prompt, or a screen in the middle of locking. Neither is a fault; look at the device.

Opening an app also re-enumerates the USB device, so `/dev/hidrawN` changes underneath you. The
tool re-discovers it instead of caching, which is why a second command in a script does not fail
with ENODEV.

### Deploying

```bash
STRICT_TOKENS=true \
RECIPIENTS="0xYourColdAddress:my cold wallet" \
TOKENS="0xToken:USDT,0xToken2:USDC" \
npm run deploy:gemba
```

Owners come from `OWNER_1/2/3` if set, otherwise from the addresses behind
`PRIVATE_KEY_OWNER1/2/3`. The script reads the owner set, the policy and both registries back
**off the chain** and fails if anything does not match, rather than trusting the constructor call.
Every deployment writes `deployed/<network>_<date>_<time>.json` plus a `-latest.json` pointer,
carrying the constructor arguments and compiler settings — an address alone cannot be verified
later.

### Verifying

Two backends, because one does not cover both families:

- **GembaScan is Blockscout.** `hardhat verify` fails against it with an empty error message. What
  works is Blockscout's own v2 endpoint with the standard-json file in a field named `files[0]`
  (plain `files` is rejected), and `contract_name` passed explicitly. No API key needed.
- **Ethereum, Sepolia, BSC, Polygon** use `hardhat-verify`'s **Etherscan API V2**, where a single
  `ETHERSCAN_API_KEY` covers all of them. Verification retries while the explorer indexes a fresh
  deployment instead of reporting a good contract as unverified.

`sourcify` is disabled on purpose: this plugin version speaks Sourcify API v1, which upstream
removed.

---

## The listeners

Two systemd services watch the deployed wallets and email everything they see. Full detail in
[`listeners/README.md`](listeners/README.md).

| unit | watches | poll | confirmations |
|---|---|---|---|
| `personal-wallet-listener-gembatestnet` | 821207 | 20 s | 3 |
| `personal-wallet-listener-sepolia` | 11155111 | 90 s | 4 |
| `personal-wallet-listener-watchdog.timer` | both, every 5 min | — | — |

```bash
node listeners/probe.js              # which endpoints are usable right now
node listeners/watchdog.js --dry-run # is each listener actually polling
node listeners/run.js sepolia        # run one in the foreground
```

### Nothing is hardcoded

Every value comes from `.env`; `listeners/networks.default.json` supplies defaults **as data
only**. A chain absent from that file can be defined purely from environment variables, so putting
a wallet on a mainnet is env lines plus a systemd unit — never a code change. Verified by defining
Arbitrum from nothing but env vars.

For a network `<net>`: `<NET>_WATCH`, `<NET>_CHAIN_ID`, `<NET>_RPC_URLS`, `<NET>_EXPLORER`,
`<NET>_POLL_MS`, `<NET>_CONFIRMATIONS`, `<NET>_MAX_SPAN`, `<NET>_START_BLOCK`,
`<NET>_WATCH_INCOMING`, `<NET>_WATCH_FAILED`, `<NET>_MAIL_TO`, `<NET>_ANOMALY_MAIL_MS`,
`<NET>_SUMMARY_MS`, `<NET>_MAIL_ON_SWITCH`. Defaults ship for Ethereum (12
confirmations), BSC (15), Polygon (30 — it reorgs routinely), GembaChain mainnet and testnet.

**Alert cadence is env-driven too.** Mail goes out on a real event or a real failure; a change of
the active endpoint is routing, not a fault, and is counted rather than mailed. One heartbeat per
`<NET>_SUMMARY_MS` proves the listener is alive. See `listeners/README.md` for the full table and
the incident that produced the rule — 48 mails in a day saying nothing was wrong.

### Three things each cycle looks for

1. **Events the wallet emits** — `eth_getLogs` filtered to the watched addresses.
2. **Tokens arriving by a plain transfer.** An ERC-20 transfer runs none of the wallet's code, so
   it emits no wallet event; without this the arrival is invisible. Scanned unfiltered by token, so
   tokens nobody allowlisted are seen too, each tagged `allowlisted: true/false` and capped at
   three unknown arrivals per email so dust cannot flood the alerting.
3. **Transactions that REVERTED.** A failed transaction writes no logs, so a log-based listener can
   never show a refused attempt — and "someone tried and was refused" is the most useful thing a
   savings wallet can tell you. Blocks are read with their transactions, those addressed to the
   wallet checked for `status 0`, and the call replayed at that block to **decode the reason**.
   Verified live: `RecipientNotAllowed(0x3A9D…)`, `TokenNotAllowed(0x1111…)`, `BadTtl(60)`.

Measured request cost: GembaChain at a 20 s poll is ~42 calls/min against its own nodes; Sepolia
at 90 s is **8 calls/min** — fewer than the two-call version made at 60 s.

### Why it polls instead of subscribing

A `provider.on("logs", …)` subscription dies quietly: the socket closes, nothing throws, and the
service looks healthy while seeing nothing. Polling `eth_getLogs` either returns a range or raises
— and the position is saved per chunk, so a crash resumes instead of skipping. Logs are read to
`head - confirmations`, never to the head, so a reorg cannot produce an alert for an event that
later never happened.

### Staying alive, and knowing when it is not

- **The endpoint list wraps round three complete times.** The first pass respects each endpoint's
  cooldown; later passes ignore it, which is what makes the list genuinely return to the first
  endpoint instead of stalling once everything is parked.
- **Then it stops, rather than looping.** All three rounds failing means a 15-minute backoff and
  one loud email, not a retry every 20 seconds — which fills the journal and invites rate-limiting
  exactly when the listener needs to come back. The block position is kept throughout.
- **systemd restarts a process that exits.** `Restart=always`.
- **A watchdog restarts one that HANGS** — the case systemd cannot see, because to it a wedged
  process is healthy. The test is "did it poll recently", against the `lastPollAt` each cycle
  writes. Tested for real: a `SIGSTOP`ped listener still read `active` to systemd; the watchdog saw
  a poll 350 s old against a 300 s threshold, restarted it, emailed, and the listener caught up
  from block 4003395 to 4003584 with nothing lost.

Endpoint switching is normal, successful behaviour. It is reported — as a digest, at most every 30
minutes — so a provider that is quietly degrading becomes visible, without a flapping endpoint
turning the alerting into a flood.

### RPC fallback and the two distinctions that matter

Endpoints are tried **free before keyed**, classified from the URL rather than trusted from the
order they were written in, so a quota-bearing endpoint is only reached when the free ones have
failed. `eth_getLogs` ranges are halved on refusal, because every provider caps the span
differently and none advertise it. Any API key inside a URL is redacted in every log line and
every email.

Two corrections the tests forced, both worth knowing if you build something similar:

- **A contract revert is an answer, not an endpoint failure.** Rotating on it both slanders a
  healthy endpoint and destroys the revert payload — which is why a decoded revert reason first
  came back as `(could not decode)`.
- **Capability is not health.** `publicnode` serves `eth_getLogs` with an address filter and
  refuses it without one. Treating that as ill-health was wrong twice over: it pushed every other
  call off a healthy endpoint, and it retried a call that can never work there. Capabilities are
  now recorded per endpoint, and a transient error never counts towards one — after a capable
  endpoint was written off for a blip.

## Testing and analysis

```
npm test              150 passing
                      external functions invoked : 72/72  (100.0%)
                      custom errors returned     : 36/36  (100.0%)
npm run live:gemba    245 checks, 0 failures against the live chain
npm run slither       11 findings, 0 High — every one triaged in docs/SLITHER.md
npm run invariants    19 invariants in 4 suites · 36 weighted selectors · Foundry
                      8 suites, 25 tests, 0 failures, 436 s
npm run medusa        a second fuzzer, different search strategy
npm run halmos        8 symbolic checks, 30 paths
npm run halmos:deep   8 more, 61 paths — symbolic time, amounts, ttls and ids
```

**Four tools, because each is blind where the others see.** `npm test` proves every entry point
and every custom error was actually exercised. Foundry invariant fuzzing explores **orderings** of
legal calls — that is what found the one real defect in this contract (Finding 1 below). Medusa
explores **arguments**: unbounded amounts, ttls of zero, ids that do not exist, with an
independently written harness, because a campaign driven through my own assumptions is blind in
exactly the directions I got wrong. Halmos proves the boundaries neither fuzzer can land on —
timestamps near the `uint64` ceiling, the single value where an accept/reject rule flips.

🔴 **No green fuzzing result means anything until a deliberately-false property has been shown to
fail — and a failing canary is still not enough, because only coverage shows WHAT ran.** Six
campaigns in this project reported "all passed" while exercising far less than they claimed; one of
them had both canaries failing and still had never executed a single payment. The full account, and
the two cheap procedures that catch this, are in [`docs/INVARIANTS.md`](docs/INVARIANTS.md).

`solidity-coverage` cannot instrument a contract this size under Cancun — its instrumented
initcode exceeds the EIP-3860 cap, which no Hardhat setting lifts. Rather than shrink the contract
to please a tool, `test/00-surface.js` measures something stronger for a contract made mostly of
guards: it wraps the JSON-RPC provider and proves from observed traffic that **every external
function actually ran and every custom error was actually returned**. It is a gate, not a report —
an entry point nobody calls fails the suite.

The live run is not a simulation: every refusal in it is a real transaction mined with `status=0`,
because a `staticCall` proves what the contract would say while a mined failure proves what the
chain accepts.

**Mythril** (symbolic execution, 17 modules including `EtherThief`) reports **no findings** on the
source, across a 59-minute run at `-t 3`. Its bytecode-mode run reports 38 HIGH integer overflows
which are over-reporting from missing compiler context — demonstrated on a 196-byte control
contract containing exactly one real overflow, where bytecode mode reported three. The contract
has no `unchecked` block, so solc 0.8.28 reverts on every overflow by construction. Full triage,
including the transaction-depth limit that makes a default `-t 2` Mythril run meaningless on a
multisig, is in [`docs/MYTHRIL.md`](docs/MYTHRIL.md).

Every accepted finding from every tool is reasoned through in [`docs/SLITHER.md`](docs/SLITHER.md),
[`docs/MYTHRIL.md`](docs/MYTHRIL.md) and [`docs/CONTRACT.md`](docs/CONTRACT.md).

---

## Not committed, by design

`.env` and anything resembling a credential. `npm run check:secrets` scans what git would publish
and refuses on: files named `.env`/`*.key`/`*.pem`/`id_rsa*`, values assigned to secret-sounding
names, 32-byte hex next to a key-like identifier, provider URLs carrying an API key, and **real
BIP-39 mnemonics** — validated against the wordlist and the checksum, not guessed from shape,
because twelve ordinary English words match a shape-based regex.

Deployment records **are** committed: addresses, constructor arguments and compiler settings are
what make a deployment verifiable later, and none of it is secret.

Also not committed: `v1/`, a frozen local snapshot of the project before the registries and the
timelock existed, kept so an already-deployed earlier contract can still be re-verified. Its
checksum file covers build artefacts that are themselves ignored, so a published copy could never
verify — it belongs on disk, not in the repository.

## Licence

MIT.
