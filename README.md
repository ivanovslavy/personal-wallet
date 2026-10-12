# PersonalWallet

A self-custody savings wallet for EVM chains, held by **exactly three owners**, where **every
operation that can move value needs two of them** — and widening the wallet's reach needs all
three plus a timelock that any single owner can veto.

Holds native currency, ERC-20, ERC-721 and ERC-1155, and moves NFTs of both standards in one
batch. **Not a proxy. Not upgradeable. No `renounceOwnership` anywhere in the ABI.**

Ships with two event listeners that watch the deployed wallets and email on every event.

```
contracts/      the wallet and the test tokens it is exercised against
test/           148 tests, including an adversarial suite
scripts/        deploy · verify · live end-to-end run · secret scan
listeners/      two chain watchers + their systemd units
docs/           the contract reference, the design notes, the Slither triage
deployed/       one JSON record per deployment: address, constructor args, compiler settings
```

---

## What is deployed right now

| chain | chainId | PersonalWallet | verified |
|---|---|---|---|
| GembaChain testnet | 821207 | [`0x3F6357a74Bec93F6281aA1FC705133eC71a1BaE2`](https://gembascan.io/address/0x3F6357a74Bec93F6281aA1FC705133eC71a1BaE2#code) | yes |
| Sepolia | 11155111 | [`0x628b6A266fFb4acED394D3eb7879B880B7eccF56`](https://sepolia.etherscan.io/address/0x628b6A266fFb4acED394D3eb7879B880B7eccF56#code) | yes |

Both are configured the same way: three owners, threshold two, the **token allowlist enforced**,
the recipient allowlist available but switched off, and a 72-hour timelock on anything that widens
the wallet's reach.

Full records — constructor arguments, compiler settings, transaction hashes — are in `deployed/`.

---

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
npm test                    # 148 tests
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
npm test                      # 148 tests + the surface-coverage gate
npm run slither               # static analysis of the deployed contract
npm run deploy:gemba          # deploy (also :sepolia :bsc :polygon :mainnet)
npm run verify:gemba          # source verification (also :sepolia :bsc :polygon :mainnet)
npm run live:gemba            # 245-check end-to-end run against the live chain
npm run check:secrets         # refuse to publish a credential
npm run hooks:install         # wire the secret scan as a git hook
```

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

Two systemd services watch the deployed wallets and email every event they see.

| unit | watches | poll | confirmations |
|---|---|---|---|
| `personal-wallet-listener-gembatestnet` | 821207 | 20 s | 3 |
| `personal-wallet-listener-sepolia` | 11155111 | 60 s | 4 |

```bash
node listeners/probe.js            # which endpoints are usable right now
node listeners/run.js sepolia      # run one in the foreground
```

Install on a Linux box (tested on a Raspberry Pi 5, Ubuntu 24.04, Node 20, 26 MB of dependencies):

```bash
rsync -a --exclude node_modules --exclude artifacts --exclude cache \
      ./ user@host:/home/user/personal_wallet/
ssh user@host 'cd personal_wallet && npm install --omit=dev'
ssh user@host 'sudo cp listeners/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload'
ssh user@host 'sudo systemctl enable --now personal-wallet-listener-gembatestnet personal-wallet-listener-sepolia'
```

The listeners need only `ethers`, `nodemailer` and `dotenv` — no Hardhat, no solc download. The
ABI is a committed artefact (`listeners/abi/PersonalWallet.json`, regenerated with
`npm run export:abi`), stamped with the bytecode hash it came from so a stale copy is detectable.

### Why it polls instead of subscribing

A `provider.on("logs", …)` subscription dies quietly: the socket closes, nothing throws, and the
service looks healthy while seeing nothing. Polling `eth_getLogs` over an explicit range either
returns a range or raises — and the position is saved to disk per chunk, so a crash resumes
instead of skipping. Logs are read to `head - confirmations`, never to the head, so a reorg cannot
produce an alert for an event that later never happened.

### RPC fallback

Endpoints are tried in order, **free before keyed**, so a quota-bearing endpoint is only reached
when the free ones have failed. Classification is derived from the URL rather than trusted from
configuration order. A failing endpoint is parked for an escalating cooldown instead of being
hammered. `eth_getLogs` ranges are halved on refusal until accepted, because every provider caps
the span differently and none of them advertise it.

Any API key inside a URL is redacted in every log line and every email.

### The email

One message per poll cycle listing every event found — a 50-item batch transfer must not arrive as
50 emails. Each event is reported with its contract, block, transaction hash, explorer link and
decoded arguments. The listener verifies SMTP at startup and refuses to run without a working mail
path, because a listener that cannot alert is worse than no listener: it looks fine. Sustained RPC
failure raises its own alert once, and a recovery notice when it clears.

---

## Testing and analysis

```
npm test        148 passing
                external functions invoked : 72/72  (100.0%)
                custom errors returned     : 35/35  (100.0%)
npm run live:gemba   245 checks, 0 failures against the live chain
npm run slither      11 findings, 0 High — every one triaged in docs/SLITHER.md
```

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
