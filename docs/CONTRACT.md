# PersonalWallet

A savings wallet held by **exactly three owners**, where **every operation that can move value
needs two of them**. Holds native currency, ERC-20, ERC-721 and ERC-1155, and can move NFTs of
both standards in one batch.

**Not a proxy. Not upgradeable. No `renounceOwnership` anywhere in the ABI.**

---

## The security model in one rule

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

### Why each piece has to be there

- **Owner replacement is timelocked too.** Without it, two compromised keys replace the third,
  honest owner with their own address, hold all three seats, and there is nobody left to veto
  anything. The recipient timelock would be theatre.
- **The veto is single-signature.** If it needed two owners, the two attackers would refuse and
  the veto would be useless. The cost is that one hostile owner can block new recipients and block
  their own removal. That is griefing, and griefing is strictly better than theft: with 2-of-3 on
  transfers the honest pair can still move everything out to an already-allowlisted address.
- **Adding a token is NOT timelocked.** It grants no ability to steal, because the recipient
  allowlist still binds. An attacker may allowlist any token they like and still have nowhere to
  send it.
- **Adding a recipient needs all three.** It cannot freeze the wallet — transfers to existing
  recipients still work on two, recipients can still be removed, owners can still be rotated — so
  unanimity here buys security without a new way to lock yourself out.
- **The delay has a floor AND a ceiling.** The floor (24 h) means the control can never be
  dismantled to nothing. The ceiling (30 days) is the less obvious one: because *lengthening* the
  delay is immediate by design, without a cap a hostile owner could set it to a century and
  permanently prevent any new recipient from ever being added.
- **An owner's address is not automatically an allowed recipient.** If it were, a compromised
  owner would simply send everything to themselves.

###  The operating rule

**Always keep at least one allowlisted recipient that is a cold address you control.** It is the
escape hatch. With it, the worst case under two compromised keys is that the funds get pushed to
your own address — annoying, not theft. Without it, a hostile owner can veto every attempt to add
one and the survivable case stops being survivable.

`scripts/deploy.js` refuses to deploy with `STRICT_RECIPIENTS=true` and no seeded recipient, for
exactly this reason.

### What two compromised keys can and cannot do

Measured end to end, on the devnet and on gembatestnet:

| the attempt | the outcome |
|---|---|
| send straight to their own address | `RecipientNotAllowed` — refused outright |
| allowlist their address | needs all three; two cannot reach the threshold |
| switch the requirement off | timelocked; the honest owner vetoes it |
| shorten the delay | timelocked; vetoed |
| take the honest owner's seat | timelocked; vetoed |
| push the funds to the owner's own cold address | **works** — and lands in the owner's address, which is not theft |

---

## The design decisions, and why each one is the way it is

### No proxy, no upgrade path
The address you fund is the code you audited. There is no admin slot, no implementation pointer
and **no `DELEGATECALL` in the deployed bytecode** — asserted by a test that walks the runtime
opcodes rather than grepping for a byte (a byte-level grep for `0xf4` reports a delegatecall in a
contract that has none, because `f4` also occurs inside `PUSH` immediates and the metadata
trailer; the first version of that test did exactly that and failed).

The price is that a bug cannot be patched in place. For a savings vault that is the right trade,
and it is why the logic here is small and typed rather than a generic "execute arbitrary
calldata" engine.

### No `Ownable`, therefore no `renounceOwnership`
OpenZeppelin's `Ownable` carries a live `renounceOwnership()` that sets the owner to `address(0)`.
On a contract holding funds that is one transaction away from locking everything forever. This
contract uses a custom fixed three-owner model instead, so the function does not exist — a test
asserts the **ABI** contains no `renounceOwnership`, `transferOwnership` or `owner`, which is a
stronger claim than "it reverts".

### Owner rotation is two-sided
Replacing an owner needs two of the three to approve **and** the incoming owner to accept from
their own address. A typo in the new address therefore costs nothing: the unaccepted proposal
expires and the set never moves. The set is always exactly three — nothing can grow or shrink it.

### Confirmations are counted at execution, not accumulated
This is the one design point worth reading twice. A naive multisig stores a counter and
increments it on each approval. If an owner is replaced after confirming, that stale approval
still counts and the removed owner keeps influence over pending proposals.

Here `_confirmations()` walks the **current** owner array every time, so rotating an owner
instantly invalidates their pending votes. Three tests cover it, including the race where two
proposals try to remove the same owner and the one where an address would end up in two seats.

### Every proposal expires
Without an expiry, something approved today can execute in a year under circumstances nobody who
approved it foresaw. The window is chosen per proposal and bounded by `MIN_TTL` (10 min) and
`MAX_TTL` (30 days).

### Typed operations, not arbitrary calls
There is no `exec(target, data)`. Each movement is its own function with its own parameters, so
what two owners approve is legible on-chain and cannot be re-interpreted at execution. The NFT
batch stores its items **with the proposal**, so nothing is re-supplied when it executes.

### `SafeERC20`, not `require(token.transfer(...))`
USDT's `transfer` returns **nothing**. A contract that decodes a bool reverts against it and the
balance is stuck forever. The test token `MockUSDT` reproduces that exactly — no return value,
plus Tether's basis-point fee knobs — so this is proved, not assumed.

### Deposit functions, single-signature on purpose

`depositNative`, `depositERC20`, `depositERC721`, `depositERC1155` and `depositNFTBatch` pull with
`safeTransferFrom` and emit an event naming **who** deposited — something a raw `token.transfer`
can never give you, because the wallet's code does not run at all during one.

They are deliberately **not** behind the multisig. A deposit increases the wallet's assets;
multisig exists to stop value leaving. A 2-of-3 gate would cost three transactions plus an
`approve` per deposit, would still be bypassable with a plain `transfer`, and would add a way for
a legitimate delivery to be refused.

`depositERC20` reports **what actually arrived**, measured from the balance, not what was
requested — with a fee-on-transfer token those differ, and an event reporting the request would
misstate the balance change, defeating the only reason the function exists. A token that absorbs
the whole amount is refused rather than logged as a deposit.

**What these do NOT buy is exclusivity.** An ERC-20 can always be pushed to any address: ERC-20 has
no receive hook, so nothing of ours runs and there is nothing to revert. See
`docs/DESIGN-NOTES.md` — and a test asserts this limit out loud rather than leaving it in prose.

### Both `receive()` and `fallback()` are payable
A wallet with only `receive()` reverts when a sender attaches calldata, and some relayers,
bridges and contract-to-contract sends do. Both are accepted and both emit, so funds are never
rejected for the shape of the call. No calldata is ever interpreted.

### The native balance is never cached
`address(this).balance` is read directly. Ether can be forced in with `SELFDESTRUCT` with no
event at all, which would desynchronise any `totalDeposited` variable. A test forces ether in
that way and then spends it.

---

## What is in the box

```
contracts/
  PersonalWallet.sol            the wallet
  mocks/TestTokens.sol          MockUSDT, MockUSDC, MockEURC, MockERC721, MockERC1155
  mocks/Attackers.sol           the hostile contracts the test suite points at it
scripts/
  deploy.js                     deploys, reads the state back, records
  verify.js                     source verification, both explorer families
  live-gembatestnet.js          the real end-to-end run against the live chain
  lib/record.js                 the deployed/ record writer
test/
  00-surface.js                 the surface-coverage gate (see Evidence)
  01-core.js   02-assets.js   03-owners.js   04-attacks.js
  05-guards.js 06-registry.js 07-deposits.js 08-surface-gaps.js
docs/DESIGN-NOTES.md            the analysis that justified v2, kept as written
deployed/                       one JSON per deployment, named by network + date + time
v1/                             the complete pre-v2 project, with checksums — see v1/RESTORE.md
```

`v1/` is a frozen copy of everything as it stood before the registries and the timelock: contract,
mocks, tests, scripts, config, deployment records, **and the compiled `build-info`**. That last
one matters: once the source changes, the standard-json input that produced the already-deployed
v1 bytecode is gone, and without it those live contracts could never be verified again.

### The test tokens imitate the real ones

| mock | what it reproduces | why it matters |
|---|---|---|
| `MockUSDT` | 6 decimals, `transfer`/`transferFrom` return **nothing**, basis-point fee | the reason `SafeERC20` exists; the fee mode proves the wallet copes with fee-on-transfer |
| `MockUSDC` | 6 decimals, **blocklist** | a blocked recipient reverts the transfer — and must not burn the two owners' approval |
| `MockEURC` | 6 decimals, **pausable** | same: the approval survives the pause and works after it |
| `LyingERC20` | `transfer` returns `false` **without reverting** | the silent-failure class; `SafeERC20` must turn it into a revert |
| `ReenteringERC20` | a transfer hook that calls back in | the ERC-777 / callback-token attack |
| `ReentrancyAttacker` | re-enters from `receive`, `onERC721Received`, `onERC1155Received` | the worst realistic case: **the attacker holds one of the three seats** |
| `RejectingReceiver` | refuses native currency | `NativeTransferFailed`, and the approval staying alive |
| `GasGriefingReceiver` | burns all gas | the transaction must fail outright, never fake success |
| `BadERC721Receiver` | returns the wrong magic value | an NFT must not be sendable into a contract that would strand it |
| `OutsiderProber` | a non-owner contract trying everything | `onlyOwners` on every entry point |
| `SelfDestructPusher` | forces ether in with no event | why no balance is cached |

---

## Running it

```bash
npm install
npm run build                 # hardhat compile
npm test                      # 87 tests
npm run coverage
```

### Deploying

```bash
cp .env.example .env          # then fill in the keys; .env is gitignored
npm run deploy:gemba          # or deploy:sepolia / deploy:bsc / deploy:polygon / deploy:mainnet
```

Owners come from `OWNER_1/2/3` if set, otherwise from the addresses behind
`PRIVATE_KEY_OWNER1/2/3`. The script **reads the owner set back off the chain** and fails if it
does not match, rather than trusting the constructor call.

Every deployment writes two files:

```
deployed/gembatestnet_2026-10-12_00-32-30.json     never overwritten
deployed/gembatestnet-latest.json                  always the most recent run
```

The record carries what verification actually needs — the fully-qualified contract name, the
constructor arguments, and the exact compiler settings. An address alone cannot be verified later,
and reconstructing arguments from memory is how people verify the wrong thing.

### Verifying the source

```bash
npm run verify:gemba                                       # everything in the latest record
ADDRESS=0x… npx hardhat run scripts/verify.js --network sepolia
RECORD=deployed/gembatestnet_2026-10-12_00-32-30.json npm run verify:gemba
```

**Two backends, because one does not cover both families.** Established by testing on 2026-10-12,
not assumed:

- **gembascan is Blockscout v9.0.2.** `hardhat verify` fails against it with an *empty* error
  message. What works is Blockscout's own v2 endpoint,
  `POST /api/v2/smart-contracts/{address}/verification/via/standard-input`, with the standard-json
  file in a field named **`files[0]`** — plain `files` is rejected with
  `{"message":"JSON files not found"}`. No API key needed.
- **Ethereum, Sepolia, BSC, Polygon** are the Etherscan family, where `hardhat-verify` 2.1.3's
  **Etherscan API V2** support works with a single `ETHERSCAN_API_KEY` for all of them.

`sourcify` is **disabled on purpose** in `hardhat.config.js`: this plugin version speaks Sourcify
API **v1**, which upstream removed — every call returns `404 API v1 is removed`. Leaving it on
only prints a guaranteed error next to each successful verification.

Note on Blockscout: it serves source by **bytecode match**, so a second deployment of identical
code shows as already verified without an upload. That is correct behaviour, but it means a
verification test must be run against a contract whose bytecode has never been verified — ours was.

###  `viaIR` is required, not a preference

With the legacy pipeline this contract compiles to **26 573 B** and is undeployable — EIP-170 caps
runtime code at 24 576 B. Measured 2026-10-12:

| pipeline | `runs` | runtime size | |
|---|---|---|---|
| legacy | 200 | 26 573 B | over the limit |
| legacy | 20 | 25 908 B | over the limit |
| legacy | 1 | 25 934 B | over, and worse runtime gas |
| **viaIR** | **200** | **21 806 B** | **fits, with 2 770 B to spare** |

So `viaIR: true` for the size and `runs: 200` for the runtime gas. Lowering `runs` barely helps
and costs gas on every call. Nothing was removed from the contract to make it fit.

### `hardhat.config.js` — the "V2"

Etherscan API **V2**: one `ETHERSCAN_API_KEY` covers Ethereum, BSC and Polygon, with gembatestnet
added through `customChains`. Networks: `hardhat`, `gembatestnet` (821207), `sepolia`, `mainnet`,
`bsc`, `polygon`. Each RPC can be overridden with `<NETWORK>_RPC_URL`; public endpoints are the
fallbacks.

`evmVersion` is pinned to **`cancun`** rather than left to the compiler default, after confirming
that gembatestnet actually executes `MCOPY` (0x5e) and `TLOAD` (0x5c) — probed with
`eth_call` against raw init code. Ethereum, Sepolia, BSC (Pascal) and Polygon (Ahmedabad) are all
at or past Cancun. If a future target is older, lower this to `paris` rather than hoping.

---

## Evidence

### Local suite — 150 tests, and a surface gate instead of line coverage

```
npm test      150 passing
               external functions invoked : 72/72  (100.0%)
               custom errors returned     : 36/36  (100.0%)
               receive() / fallback()     : yes / yes
```

**`solidity-coverage` cannot run on this contract, and no configuration fixes it.** Measured
2026-10-12: the instrumented artefact is **81 783 B**, and **64 307 B** with the Yul optimizer
forced on (the tool disables the optimizer by default), against the **49 152 B** initcode cap that
Cancun enforces through EIP-3860. `allowUnlimitedContractSize` does not lift that — it only
touches the EIP-170 *runtime* cap — and the build cannot target a pre-Shanghai EVM either, because
OpenZeppelin 5.6 emits `mcopy` directly. The `measureXxx` flags changed nothing. The contract was
not shrunk to satisfy a coverage tool.

So `test/00-surface.js` measures something different and, for a contract that is mostly guards,
arguably more useful: it wraps the JSON-RPC provider (through `extendProvider` in
`hardhat.config.js` — patching `hre.network.provider.request` from a test does **not** intercept,
measured at 0 of 72 calls) and records what the suite actually did:

- every selector sent to a PersonalWallet instance — proving the function **ran**;
- every custom-error selector returned by a revert — proving each guard **fired**.

It is a gate, not a report: an entry point nobody calls, or a revert nobody triggers, fails the
suite. It says less than line coverage about branches inside a function, and more about whether
each guard is real.

Three findings came out of building it, all recorded as tests:

- **`onlyOwners` is the outer modifier**, so a hostile token is stopped by `NotOwner` and never
  reaches the reentrancy guard. To observe `ReentrancyGuardReentrantCall` at all, the token has to
  hold a seat — contrived on purpose, and it shows the guard is defence-in-depth, never the first
  line.
- **The native path masks the inner error**: `call{value:}` only returns false, so a recipient's
  revert data is lost and the wallet raises its own `NativeTransferFailed`. Identical protection,
  different message. The ERC-20 path bubbles the real error, because SafeERC20 passes revert data
  through.
- **A short-lived transfer proposal does not survive an owner rotation** — a rotation takes at
  least 24 h, so a proposal with a shorter ttl expires while it matures. Not a bug; something to
  know when choosing a ttl.

One **unreachable branch was found and deleted** during this work: `oldOwner == newOwner` in
`proposeOwnerReplacement` can never be hit, because `oldOwner` has already passed the `isOwner`
test, so the `DuplicateOwner` line one above catches it. Dead code in a vault is a liability, not
a belt.

### Live run on gembatestnet — 245 checks, 0 failures

```
npm run live:gemba      245 passed · 0 failed
                         41 173 734 gas total  ≈ 0.2316 GMB at 5.625 gwei
```

`npm run live:gemba` is not a simulation. Every step is a broadcast transaction with a hash, and
**every refusal is a transaction that actually reverted on chain with `status=0`** — because a
`staticCall` proves what the contract would say, while a mined failure proves what the chain
accepts. Each refusal is therefore done twice: statically to read the reason, then for real to
record it.

What the live run proves, in order:

1. contracts deployed, then the owner set, the policy, the registries, the constants and the ABI
   all read back **off the chain** rather than trusted from the constructor call
2. both deposit paths (`receive` and `fallback`) counted
3. **one owner alone cannot execute** on native, ERC-20, ERC-721, ERC-1155 or the batch — five real
   reverted transactions — and two owners can
4. a non-owner contract refused at every entry point, including on proposals that already hold two
   approvals
5. `SafeERC20FailedOperation` against the lying token; nothing left the wallet and the approval
   survived
6. `NativeTransferFailed` against a refusing recipient, then the **same approval** working once it
   started accepting
7. USDC blocklist and EURC pause both reverting, then the same approvals going through
8. USDT fee-on-transfer on a withdrawal, and on a **deposit** — where the event reports what
   arrived, not what was asked for
9. **re-entrancy with the attacker holding one of the three seats** — paid once, re-entry refused,
   exactly the approved amount left and the rest remained
10. **the seat change is timelocked**: two approvals AND the newcomer's acceptance, and it still
    cannot execute — then one owner vetoes it alone and it is dead for good
11. a plain transfer **cannot** be vetoed, so one owner still cannot block the other two
12. all five deposit functions, from an account that is not an owner and creates no proposal
13. the token registry: two owners, immediate, not vetoable, labels read back, revoked at once
14. the recipient registry: `requiredConfirmations` = 3, timelocked, and vetoed by one owner
15. the policy: tightening instant, **loosening timelocked and vetoed**, both delay bounds refused
16. a wallet deployed in the **strict posture** with a seeded cold address — the escape hatch works
    on two of three, while every other destination and every unlisted token is refused
17. **two compromised keys against the strict wallet**: cannot send to themselves, cannot reach the
    unanimous threshold, and every attempt to allowlist an address, loosen the policy or take the
    honest seat is vetoed by one owner. Nothing was stolen.

One `ALLOW_RECIPIENT` proposal is left **pending on purpose** on the permissive wallet, unvetoed,
so the timelock can be watched maturing on the real chain and executed by hand afterwards. Its id
and maturity timestamp are in the run's record under `deployed/`.

**What the live chain cannot prove**: execution *after* a timelock matures, because that needs 72
hours of real time. Those paths are proven on the devnet, where the clock can be advanced — the
live run proves the refusals, the vetoes and the thresholds that guard them.

### Static analysis — Slither

```bash
npm run slither        # only what is deployed to hold value
npm run slither:all    # everything, mocks and OpenZeppelin included
```

Slither **0.11.6**, run 2026-10-12. **No defect found.** The full triage of every finding —
including the 101 in OpenZeppelin and the 28 in the test mocks — is in `docs/SLITHER.md`.

| | first run | after two zero-cost fixes |
|---|---|---|
| High | **1** | **0** |
| Medium | 3 | 1 |
| Low | 18 | 9 |
| Informational | 5 | 1 |

Two false positives were worth removing, because a HIGH finding on a savings vault frightens
anyone reading the report:

- `_batches` reported as **uninitialized state** — because the code pushed through a
  `BatchItem[] storage` pointer, which Slither's dataflow does not see as a write. Rewritten as
  `_batches[id].push(it)`: **+2 974 gas on a full 50-item proposal (+0.08 %)** and 5 bytes less
  bytecode.
- two **uninitialized locals** in `_collect` — written as `= 0`, which the optimizer removes;
  identical gas and identical size.

The nine that remain are each a deliberate decision with a test behind it: the batch loop
(all-or-nothing by design, bounded at 50 items and measured at 2 199 452 gas for a full one), the
timestamp windows (10 minutes to 30 days — seconds of validator drift are irrelevant), and the
native `call` (the only correct way to send; `transfer()`'s 2 300-gas cap is the trap that broke a
generation of wallets). Two of the five `timestamp` findings point at comparisons that contain no
timestamp at all — Slither taints the whole `Entry` struct because `addedAt` is set from
`block.timestamp`, so reading the unrelated `allowed` bool counts as tainted.

`slither.config.json` scopes the default run to the deployed contract. Every filter has a written
reason in `docs/SLITHER.md`; nothing is silenced for convenience.

### Source verification

Everything deployed is verified on gembascan — **13 of 13 contracts**, confirmed independently by
reading `getsourcecode` back for each address rather than trusting the upload's own reply:
four `PersonalWallet` instances (permissive · attacker-seated · strict · the `deploy.js` one), the
five test tokens, and the four attacker mocks, all reporting `cancun` and the right contract name
per address.

`ReentrancyAttacker` took three attempts, and the diagnosis is worth recording because the
tempting explanation was wrong. Blockscout answered `"Smart-contract verification started"` and
then silently never completed — twice, on two different addresses, including a freshly deployed
one. It was **not** a source mismatch and **not** a stuck queue entry: the bytecode at the failed
address and at the one that finally verified is **identical byte for byte, metadata hash
included**, so the same submission succeeded and failed against the same code. It was transient on
the explorer's side, and once one instance verified, the other two resolved through Blockscout's
bytecode-twin matching.

That investigation still improved `verify.js`: it now passes `contract_name` explicitly, because
leaving Blockscout to pick a match out of a 37-source standard-json input is guesswork when one
file holds several contracts. Worth doing on its own merits — but, honestly, it was not what fixed
this.

### `hardhat.config.js` — the "V2"

Etherscan API **V2**: one `ETHERSCAN_API_KEY` covers Ethereum, BSC and Polygon, with gembatestnet
added through `customChains`. Networks: `hardhat`, `gembatestnet` (821207), `sepolia`, `mainnet`,
`bsc`, `polygon`. Each RPC can be overridden with `<NETWORK>_RPC_URL`; public endpoints are the
fallbacks.

`evmVersion` is pinned to **`cancun`** rather than left to the compiler default, after confirming
that gembatestnet actually executes `MCOPY` (0x5e) and `TLOAD` (0x5c) — probed with
`eth_call` against raw init code. Ethereum, Sepolia, BSC (Pascal) and Polygon (Ahmedabad) are all
at or past Cancun. If a future target is older, lower this to `paris` rather than hoping.

---

## Evidence

### Local suite — 150 tests, and a surface gate instead of line coverage

```
npm test      150 passing
               external functions invoked : 72/72  (100.0%)
               custom errors returned     : 36/36  (100.0%)
               receive() / fallback()     : yes / yes
```

**`solidity-coverage` cannot run on this contract, and no configuration fixes it.** Measured
2026-10-12: the instrumented artefact is **81 783 B**, and **64 307 B** with the Yul optimizer
forced on (the tool disables the optimizer by default), against the **49 152 B** initcode cap that
Cancun enforces through EIP-3860. `allowUnlimitedContractSize` does not lift that — it only
touches the EIP-170 *runtime* cap — and the build cannot target a pre-Shanghai EVM either, because
OpenZeppelin 5.6 emits `mcopy` directly. The `measureXxx` flags changed nothing. The contract was
not shrunk to satisfy a coverage tool.

So `test/00-surface.js` measures something different and, for a contract that is mostly guards,
arguably more useful: it wraps the JSON-RPC provider (through `extendProvider` in
`hardhat.config.js` — patching `hre.network.provider.request` from a test does **not** intercept,
measured at 0 of 72 calls) and records what the suite actually did:

- every selector sent to a PersonalWallet instance — proving the function **ran**;
- every custom-error selector returned by a revert — proving each guard **fired**.

It is a gate, not a report: an entry point nobody calls, or a revert nobody triggers, fails the
suite. It says less than line coverage about branches inside a function, and more about whether
each guard is real.

Three findings came out of building it, all recorded as tests:

- **`onlyOwners` is the outer modifier**, so a hostile token is stopped by `NotOwner` and never
  reaches the reentrancy guard. To observe `ReentrancyGuardReentrantCall` at all, the token has to
  hold a seat — contrived on purpose, and it shows the guard is defence-in-depth, never the first
  line.
- **The native path masks the inner error**: `call{value:}` only returns false, so a recipient's
  revert data is lost and the wallet raises its own `NativeTransferFailed`. Identical protection,
  different message. The ERC-20 path bubbles the real error, because SafeERC20 passes revert data
  through.
- **A short-lived transfer proposal does not survive an owner rotation** — a rotation takes at
  least 24 h, so a proposal with a shorter ttl expires while it matures. Not a bug; something to
  know when choosing a ttl.

One **unreachable branch was found and deleted** during this work: `oldOwner == newOwner` in
`proposeOwnerReplacement` can never be hit, because `oldOwner` has already passed the `isOwner`
test, so the `DuplicateOwner` line one above catches it. Dead code in a vault is a liability, not
a belt.

### Live run on gembatestnet — 245 checks, 0 failures

```
npm run live:gemba      245 passed · 0 failed
                         41 173 734 gas total  ≈ 0.2316 GMB at 5.625 gwei
```

`npm run live:gemba` is not a simulation. Every step is a broadcast transaction with a hash, and
**every refusal is a transaction that actually reverted on chain with `status=0`** — because a
`staticCall` proves what the contract would say, while a mined failure proves what the chain
accepts. Each refusal is therefore done twice: statically to read the reason, then for real to
record it.

What the live run proves, in order:

1. contracts deployed, then the owner set, the policy, the registries, the constants and the ABI
   all read back **off the chain** rather than trusted from the constructor call
2. both deposit paths (`receive` and `fallback`) counted
3. **one owner alone cannot execute** on native, ERC-20, ERC-721, ERC-1155 or the batch — five real
   reverted transactions — and two owners can
4. a non-owner contract refused at every entry point, including on proposals that already hold two
   approvals
5. `SafeERC20FailedOperation` against the lying token; nothing left the wallet and the approval
   survived
6. `NativeTransferFailed` against a refusing recipient, then the **same approval** working once it
   started accepting
7. USDC blocklist and EURC pause both reverting, then the same approvals going through
8. USDT fee-on-transfer on a withdrawal, and on a **deposit** — where the event reports what
   arrived, not what was asked for
9. **re-entrancy with the attacker holding one of the three seats** — paid once, re-entry refused,
   exactly the approved amount left and the rest remained
10. **the seat change is timelocked**: two approvals AND the newcomer's acceptance, and it still
    cannot execute — then one owner vetoes it alone and it is dead for good
11. a plain transfer **cannot** be vetoed, so one owner still cannot block the other two
12. all five deposit functions, from an account that is not an owner and creates no proposal
13. the token registry: two owners, immediate, not vetoable, labels read back, revoked at once
14. the recipient registry: `requiredConfirmations` = 3, timelocked, and vetoed by one owner
15. the policy: tightening instant, **loosening timelocked and vetoed**, both delay bounds refused
16. a wallet deployed in the **strict posture** with a seeded cold address — the escape hatch works
    on two of three, while every other destination and every unlisted token is refused
17. **two compromised keys against the strict wallet**: cannot send to themselves, cannot reach the
    unanimous threshold, and every attempt to allowlist an address, loosen the policy or take the
    honest seat is vetoed by one owner. Nothing was stolen.

One `ALLOW_RECIPIENT` proposal is left **pending on purpose** on the permissive wallet, unvetoed,
so the timelock can be watched maturing on the real chain and executed by hand afterwards. Its id
and maturity timestamp are in the run's record under `deployed/`.

**What the live chain cannot prove**: execution *after* a timelock matures, because that needs 72
hours of real time. Those paths are proven on the devnet, where the clock can be advanced — the
live run proves the refusals, the vetoes and the thresholds that guard them.

### Static analysis — Slither

```bash
npm run slither        # only what is deployed to hold value
npm run slither:all    # everything, mocks and OpenZeppelin included
```

Slither **0.11.6**, run 2026-10-12. **No defect found.** The full triage of every finding —
including the 101 in OpenZeppelin and the 28 in the test mocks — is in `docs/SLITHER.md`.

| | first run | after two zero-cost fixes |
|---|---|---|
| High | **1** | **0** |
| Medium | 3 | 1 |
| Low | 18 | 9 |
| Informational | 5 | 1 |

Two false positives were worth removing, because a HIGH finding on a savings vault frightens
anyone reading the report:

- `_batches` reported as **uninitialized state** — because the code pushed through a
  `BatchItem[] storage` pointer, which Slither's dataflow does not see as a write. Rewritten as
  `_batches[id].push(it)`: **+2 974 gas on a full 50-item proposal (+0.08 %)** and 5 bytes less
  bytecode.
- two **uninitialized locals** in `_collect` — written as `= 0`, which the optimizer removes;
  identical gas and identical size.

The nine that remain are each a deliberate decision with a test behind it: the batch loop
(all-or-nothing by design, bounded at 50 items and measured at 2 199 452 gas for a full one), the
timestamp windows (10 minutes to 30 days — seconds of validator drift are irrelevant), and the
native `call` (the only correct way to send; `transfer()`'s 2 300-gas cap is the trap that broke a
generation of wallets). Two of the five `timestamp` findings point at comparisons that contain no
timestamp at all — Slither taints the whole `Entry` struct because `addedAt` is set from
`block.timestamp`, so reading the unrelated `allowed` bool counts as tainted.

`slither.config.json` scopes the default run to the deployed contract. Every filter has a written
reason in `docs/SLITHER.md`; nothing is silenced for convenience.

### Source verification

Everything deployed is verified on gembascan, confirmed independently by reading
`getsourcecode` back for each address rather than trusting the upload's own reply:

| | |
|---|---|
| PersonalWallet × 4 (permissive · attacker-seated · strict · the `deploy.js` one) | verified, `cancun` |
| MockUSDT · MockUSDC · MockEURC · MockERC721 · MockERC1155 | verified |
| LyingERC20 · RejectingReceiver · OutsiderProber | verified |
| ReentrancyAttacker | **not verified** — see below |

`ReentrancyAttacker` is the one exception, and it is an explorer-side limitation rather than a
source mismatch. The evidence: its on-chain runtime bytecode matches the local artefact byte for
byte; three sibling contracts from the **same** `Attackers.sol` submission verified; Blockscout
answers `"Smart-contract verification started"` and then never completes; and a **freshly deployed
copy behaves identically**, which rules out a stuck queue entry on the address. It is a test-only
attacker mock with no bearing on the wallet.

That investigation did improve `verify.js`: it now passes `contract_name` explicitly, because
leaving Blockscout to pick a match out of a 37-source standard-json input is unreliable when one
file holds several contracts.

---

## Known limits, stated plainly

- **Three owners, threshold two, both fixed at compile time.** Losing two of the three keys at the
  same time means the funds are unreachable. There is no recovery path and no social-recovery
  module — deliberately, since either would be a way in.
- **The batch is all-or-nothing.** One failing item reverts the whole set. `MAX_BATCH` is 50, and a
  test proves a full 50 fits well inside a block.
- **One hostile owner can create noise** (spam proposals, revoke its own approval, cancel its own
  proposals) but cannot move anything, cannot block a decision the other two have made, and cannot
  cancel their proposals. Tested.
- **No receive-side allowlist, and there cannot be one for ERC-20.** Anyone can send tokens to the
  wallet. ERC-20 has no receive hook, so no code of ours runs during an incoming transfer and there
  is nothing to revert — a test asserts this out loud. Junk that arrives is inert: with the token
  requirement on, it cannot be sent anywhere either, which is the safe state.
- **A single hostile owner can grief, deliberately.** They can veto new recipients, veto their own
  removal, and block policy loosening. They cannot steal, cannot block a transfer the other two
  agreed, and cannot stop you draining to an already-allowlisted address. That asymmetry is the
  design, not an oversight — see the security model above.
- **A rotation takes at least 24 hours**, so a pending transfer proposal with a shorter ttl will
  expire while the rotation matures. Choose the ttl accordingly.
- **The delay is snapshotted when a proposal is made.** Lengthening the delay afterwards does not
  re-schedule proposals already pending; it applies to new ones.

---

## Open design questions — answered, not built

`docs/DESIGN-NOTES.md` answers two questions that came up while this was being built, with
measurements rather than opinions, and **no code was changed for them**:

- **Can incoming tokens be restricted to a pre-approved registry?** For **ERC-20, no — never**:
  ERC-20 has no receive hook, so the wallet's code does not run during an incoming transfer and
  there is nothing to revert. ERC-1155 can be fully blocked, ERC-721 only partially (`transferFrom`
  skips the hook), native nearly fully. Since the one class where junk actually arrives is the one
  that cannot be blocked, the note recommends an **outbound** registry instead — fully enforceable,
  and the control that actually protects.
- **Should there be deposit functions, and would all this get expensive?** Deposit functions yes,
  **single-signature** — multisig on a deposit protects nothing and can lose a legitimate delivery.
  On cost: a 43-function variant was compiled and benchmarked against the real 37-function one.
  Deployment +12.31 % once; `propose` **+0 gas**, `execute` **+0**, `confirm` **+1**, `receive`
  **+29**. Adding functions does not tax the existing ones.
