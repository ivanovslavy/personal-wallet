# Invariant fuzzing — method, and why the first three campaigns were worthless

Run with **Foundry** (`forge 1.7.1`) alongside the Hardhat suite, not instead of it.

- the 148 Hardhat tests check **scenarios a human thought of**;
- this checks **rules**, against call sequences nobody thought of.

```bash
forge test --match-contract PersonalWalletInvariants -vv          # 256 runs × 200 depth
FOUNDRY_PROFILE=deep forge test --match-contract PersonalWalletInvariants -vv   # 2000 × 250
```

Nothing here touches a live chain. Foundry deploys a fresh wallet into an in-memory EVM: no gas,
no keys, no deploy. That is the point — it tries things you would never try on a chain with money.

## The compiler settings MIRROR production

`foundry.toml` repeats `hardhat.config.js` exactly: solc **0.8.28**, optimizer **on at 200 runs**,
**viaIR**, **cancun**. Fuzzing a differently-compiled contract would be fuzzing a different contract;
viaIR in particular is not a preference here — the legacy pipeline produces 26 573 B and will not fit
EIP-170.

## How the checking is pointed

The handler reads the proposal's state **before** every execute, then makes the call. **If the call
succeeds**, it asserts the pre-state was legal.

That direction matters. We are not re-implementing the contract's rules and comparing answers — that
only tests the copy. We are catching **the contract letting through something it should have
refused**.

## The rules

| # | invariant | what breaking it would mean |
|---|---|---|
| 1 | owners are always 3, distinct, non-zero | the shape of ownership can be changed |
| 2 | nothing executes twice | a replayed execute is a double spend |
| 3 | nothing executes below its confirmation threshold | 2-of-3 is not 2-of-3 (3 for a new recipient) |
| 4 | a timelocked proposal never executes early | the veto window is a fiction |
| 5 | vetoed/cancelled is final | one owner's veto can be walked around |
| 6 | expired never executes | a stale proposal can be revived |
| 7 | **strict mode never pays a non-allowlisted address** | the control that survives two compromised keys |
| 8 | native balance == deposited − sent | value leaks |
| 9 | executed and cancelled are mutually exclusive | the state machine is incoherent |

## 🔴 The part worth reading: three campaigns that proved nothing

Each of the first three runs reported **9 passed** and was **worthless**. Recorded here because a
green invariant suite is the easiest false comfort in this whole project.

**Campaign 1 — 25 600 calls, `executions allowed: 0`.** Not one proposal was ever executed, so every
invariant about double execution, timelocks, vetoes and recipients passed **vacuously**. There was
nothing for them to catch.

**Campaign 2 — the timelocked branch was never driven at all.** `executeAllowRecipient`,
`executeOwnerReplacement` and `executeSetPolicy` were missing from `targetSelector`, so the entire
vetoable half of the state machine — the half that guards against two compromised keys — was never
touched.

**Campaign 3 — three confirmations, still nothing executable.** Diagnosis came from instrumenting
rather than guessing: `max confirmations: 3`, `saw executable: 0`. The cause was the handler's own
`warp`, jumping up to **10 days** at a time, ~5 times per 100-call run — up to **50 days** of elapsed
time. Every proposal expired (max ttl 30 days) and every matured timelock blew past its 7-day
execution window before anyone could act. **Time was running faster than the lifetimes it competed
with.**

### What fixed it

- track created proposal ids and index into them — a random `uint256` bounded over `proposalCount`
  practically never lands twice on the same proposal, so no id ever reached quorum;
- `confirmAll` — confirm with all three owners, which is literally what `scripts/allowlist.js` does;
- `executeAnything` — sweep every known id and try **every** execute entry point, the way an operator
  executes what is ready rather than guessing an id;
- `warp` bounded to 1 min–2 h, plus one deliberate `warpPastTimelock` just over 72 h, so the
  timelocked branch is reachable without expiring everything;
- proposal ttl raised to 20–30 days so proposals outlive the sequences acting on them.

### The lesson, stated plainly

**A passing invariant suite means nothing until you have proved it reaches the states it claims to
guard.** Always print how many executions the campaign actually performed. `executions allowed: 0`
and `executions allowed: 1280` produce the same green output and have opposite worth.

## Results

### Deep campaign — 2026-10-20

`FOUNDRY_PROFILE=deep` · **runs 2000 × depth 250** · **9 passed, 0 failed** ·
585 s wall, **3 834 s CPU** · no `forge-cache/invariant/failures` written.

Each invariant drove **≈500 000 calls**; nine invariants ≈ **4.5 million calls** in total. The
per-selector table shows the campaign reached the parts that matter, which is the only reason the
green result means anything:

| selector | calls | reverts |
|---|---|---|
| `executeAnything` (sweeps every id, every entry point) | 22 942 | 664 |
| `executeAllowRecipient` (3-of-3 + timelocked) | 22 718 | 529 |
| `executeOwnerReplacement` | 22 796 | 467 |
| `acceptOwnerReplacement` | 22 819 | 499 |
| `executeNative` · `executeERC20` | 22 650 · 22 682 | 526 · 528 |
| `warpPastTimelock` (the only way past the 72 h delay) | 22 610 | 0 |
| `veto` · `cancel` · `revokeConfirmation` | 22 882 · 22 746 · 22 879 | 0 |

Observed per 250-call run: ~54 proposals created, ~3 proposals reaching an executable state and
being executed — so roughly **6 000 audited executions per invariant** across the campaign. Every
one of those was checked, at the moment the contract allowed it, against all six illegal
preconditions plus the strict-recipient rule.

### Standard campaign — same day

`runs 256 × depth 200` · 9 passed · 59 s wall, 408 s CPU · ≈51 200 calls per invariant.

### What this does and does not say

It says: across millions of randomly ordered legal call sequences, **no ordering was found** that
executes twice, executes under the threshold, skips a timelock, revives a veto, executes something
expired, pays a non-allowlisted address in strict mode, leaks native value, or changes the shape of
ownership.

It does not say the contract is correct. A fuzzer explores; it does not prove. Execution density is
~3 per 250-call run — real coverage, not enormous. The honest statement is **"no counterexample
found in 4.5 million calls"**, which is worth more than 148 hand-written scenarios and less than a
proof. Symbolic checking (Halmos) over the same properties is the next step up.


## FINDING 1 — the exit was not symmetric with the entrance. Found, fixed, redeployed.

Found by the evil-token campaign on 2026-10-20, shrunk by the fuzzer to three calls.

### What it was

```
depositERC20   measured balanceBefore/After, computed `received`, reverted on zero,
               and emitted WHAT ARRIVED
executeERC20   called safeTransfer and emitted p.value — the INTENDED amount —
               without ever checking that anything moved
```

The counterexample: propose 33 485 of a token the wallet holds **zero** of, confirm, execute. The
token returned `true` and moved nothing. The wallet marked the proposal **executed** and emitted
`ERC20Sent(33 485)`.

### Why it mattered beyond a hostile token

A fee-on-transfer token needs no malice to produce the same overstatement, and **USDT has exactly
that parameter**. It is allowlisted on both live wallets. The event would claim the full amount
while the recipient received less.

This project's entire alerting story is built on those events: the listeners read them and mail
`alerts@gembamail.com`. A lying event is not cosmetic here — it is the thing you would be reading.

🔑 **`executeNative` was already correct** — it checks `address(this).balance` and reverts if the
send fails. The gap existed only where the contract trusted a token to tell the truth. That is what
made it a real finding rather than a theoretical one: the same file contained both the right
pattern and the wrong one.

### The fix

```solidity
uint256 before = IERC20(p.token).balanceOf(address(this));
IERC20(p.token).safeTransfer(p.to, p.value);
uint256 sent = before - IERC20(p.token).balanceOf(address(this));
if (sent == 0) revert ZeroAmount();
emit ERC20Sent(id, p.token, p.to, sent);
```

Measure what actually left, refuse a no-op, report the truth. Runtime size went from 21 801 B to
**22 030 B** — 2 546 B still free under EIP-170.

Pinned by `Finding1_ExitIsNowSymmetric` in `test-foundry/HappyPath.t.sol`: the lying token can no
longer consume a proposal, and the native path is tested alongside it to show the gap was specific,
not systemic.

## 🔴 The second thing the campaign caught was MY test, not the contract

`invariant_registriesStayCoherent` asserted `allowedRecipients().length == registeredRecipientCount()`
and failed in the deep run: revoke the only recipient and the list is 0 while the count is 1.

That is not a defect. The contract's own NatSpec says `allowedRecipients()` is "every destination
**currently allowed**" and `registeredRecipientCount()` is "everything **ever registered**, allowed
or since revoked". Two different sets, on purpose — the registry keeps the label and the history of
something that was revoked.

The invariant was rewritten to assert containment (`allowed <= ever registered`) plus agreement with
`isAllowed` for every listed entry. **Recorded because a failing test is not evidence of a bug until
you have read the code it accuses.**


## Round 2 — 2026-10-20 evening: five more lines of attack

### Task 2 — the NFT exits had the same asymmetry. Closed.

`executeERC721`, `executeERC1155` and every item inside `executeNFTBatch` trusted the asset
contract exactly as `executeERC20` had. Now all four measure: ownership must have changed hands,
or the 1155 balance must have fallen, or the call reverts with the new `NothingMoved(address)`.
Runtime 22 030 B -> **22 716 B**, 1 860 B still free.

### Task 3 — MAX_BATCH = 50 measured against real block limits. No change needed.

| | propose 50 items | execute 50 items |
|---|---|---|
| gas | 2 555 384 | 507 784 |
| gembatestnet (100 M block) | **2.56 %** | 0.51 % |
| Sepolia (199.4 M block) | **1.28 %** | 0.25 % |

About 39x headroom on gemba. The per-item verification added ~1 000 gas per item. The worry was
reasonable and is now measured rather than assumed: **the cap stays at 50**.

### Task 4 — one compromised owner, as a fuzz participant

`owners[2]` is driven as hostile: it vetoes everything it can reach, floods the queue with junk,
and tries to pay itself alone. Two new invariants:

- `invariant_oneHostileOwnerCanNeverPayAlone` — **0 solo executions**, ever.
- `invariant_twoHonestOwnersKeepControlOfTheMoney` — with 7-8 vetoes per run, honest payments still
  land (2 per run). Transfers are 2-of-3 and not timelocked, so there is nothing for the hostile
  seat to veto.

🔴 **The asymmetry is the design, and it is worth stating plainly:** a hostile seat CAN deadlock
governance forever, including its own replacement, because owner replacement is timelocked and
therefore vetoable. What it cannot do is stop two honest owners from moving the money out to an
allow-listed address. Losing a key is survivable; the recovery is evacuation, not eviction.

### Task 5 — Gnosis Safe diff abandoned on purpose; replaced with a reference model

Installing `safe-contracts` pins ethers 5.4, and `--legacy-peer-deps` pruned hardhat-toolbox and
broke the project (reverted with `npm ci`, 150 tests green again). More importantly the models are
not comparable: Safe signs off-chain with EIP-712 and a nonce, this wallet keeps proposals
on-chain. There is no shared call sequence, so every divergence would be expected-by-design —
noise dressed as rigour.

Instead `ReferenceMultisig` re-implements the k-of-n core a second time, deliberately naively, and
the fuzzer applies **identical operations to both**, asserting they agree on `isExecutable`.

🔑 **It paid for itself in seven calls.** The first reference let any owner cancel anything; the
campaign found the divergence immediately. The real contract is **stricter**: only the proposer may
cancel, and not once the threshold is reached — otherwise one owner could pull a decision two
owners had already agreed. The naive model was wrong and the wallet was right. After mirroring the
real rules: **585 comparisons, 0 disagreements.**

### Task 6 — symbolic proof of the confirmation recount

`_confirmations` loops the CURRENT owner array, so a replaced owner's stored vote stops counting.
Fuzzing rarely assembles "two confirm, one is replaced, then execute"; symbolically it is just a
property. Added `check_confirmationsNeverExceedOwnerCount` and
`check_replacedOwnersVoteStopsCounting`. **8 Halmos checks, all passing.**

### Where this leaves the suite

| layer | result |
|---|---|
| Hardhat scenarios | **150 passing** · 72/72 functions · 36/36 custom errors |
| Foundry invariants | **24 tests** across five campaigns, 0 failures |
| Halmos symbolic | **8 checks**, 0 failures |
| Slither / Mythril | 11 findings / 0 High · 0 on source |

**Still open, deliberately:** an independent human audit (nothing here was reviewed by anyone who
did not write it) and a cap on registry growth. Both are listed, neither is done.


## Deployment, 2026-10-20 evening — the NFT fixes are live

| chain | address | runtime |
|---|---|---|
| gembatestnet | `0x586CfE0D34D812F53FbefD78F9Ad0243f79A685D` | 22 716 B |
| sepolia | `0x992877042cB4f33222218f503361D4d957a749f5` | 22 716 B |

Both verified, funded to match the previous generation, strict on both registries.

**Two older generations hold assets** and each has the new wallet allowlisted as a recipient,
3-of-3, maturing **2026-10-23 ~20:26 UTC**:

| generation | gemba | sepolia |
|---|---|---|
| 2026-10-12 | `0x3F6357a7…` proposal 6 | `0x628b6A26…` proposal 5 |
| 2026-10-20 am | `0x0b59725c…` proposal 1 | `0x3eC14206…` proposal 1 |

Until the sweep completes the listeners watch **three addresses per chain**. Drop the older two
from `<NET>_WATCH` once they are empty.

---

## Task 10 — the sweep rehearsed on a fork before it is attempted for real

On **2026-10-23 after ~20:27 UTC** four wallets holding real assets get emptied into two. The
72-hour timelock on those recipient approvals cannot be re-run: if the plan is missing a step, the
cost is three days, not a retry. So the whole sweep was executed against a **local fork of each
live chain** first — `scripts/migration-rehearsal.js`, which forks, impersonates the owners, warps
past the timelock, executes the pending approval, moves every asset, and then **verifies each old
wallet is empty, item by item**.

### Results — both chains clean

| | gemba `0x3F63…` | gemba `0x0b59…` | sepolia `0x628b…` | sepolia `0x3eC1…` |
|---|---|---|---|---|
| ERC-20 | 6 | 6 | 3 | 3 |
| NFT positions | 5 | 3 | 5 | 0 |
| native | 1.85 GMB | 1.85 GMB | 0.02 ETH | 0.02 ETH |
| proposals needed | 8 | 8 | 5 | 4 |
| empty afterwards | ✓ | ✓ | ✓ | ✓ |

**gemba: 16 proposals, 50 transactions, 4 737 378 gas. sepolia: 9 proposals, 29 transactions,
2 780 787 gas. Zero reverts, zero leftovers.** One `proposeNFTBatch` took all five NFT positions
in a single proposal (623 987 gas for five, 473 387 for three) — the 50-item batch limit is nowhere
near binding.

### 🔴 What the rehearsal actually caught — the inventory, not the contract

The first rehearsal reported **"1 NFT to move"** where there were five, and three "failures" that
were my script treating NFT contracts as ERC-20s. Nothing was wrong with the wallet. Everything was
wrong with how assets were being discovered, and every one of these would have left assets stranded
in a contract whose recipient approval had already been spent:

1. **ERC-165 lies.** `Kotkata by GembaPay` answers `supportsInterface(0x01ffc9a7)` with **true** and
   `supportsInterface(0x80ac58cd)` — ERC-721 — with **false**, while `ownerOf`, `name`, `symbol` and
   `totalSupply` all work and the indexer lists it as ERC-721. Classifying by advertised interface
   files it as a fungible token, the sweep calls `transfer(address,uint256)` on it, and the proposal
   reverts. Classification must be **behavioural**: `decimals()` answers → ERC-20; `ownerOf(id)`
   answers → ERC-721; `balanceOf(addr,id)` answers → ERC-1155.
2. **A token-id walk finds nothing.** The mocks mint at **9001+** with `totalSupply` of 4, so
   walking `0..totalSupply` misses every one of them — and on a fork that proxies each unknown slot
   to the live node it also costs one round trip per index, which is why the first run hung past ten
   minutes.
3. **`eth_getLogs` fails differently on every free RPC, and one of them fails SILENTLY.**
   `rpc1.gembascan.io` rejects the call outright. `publicnode` answers `pruned history unavailable`
   (code 4444) — it keeps only ~10k blocks of logs, so no chunk size helps. `1rpc` caps at 50
   blocks. Infura and dRPC serve full history at 10 000 blocks per call. Worst of all, a **Hardhat
   fork answers historical ranges with an empty list instead of an error** — which reads as "no
   NFTs" and gets believed. ethers reports every one of these as `could not coalesce error`; the
   real reason is in `error.error.message`.
4. **Etherscan V2 has no free NFT inventory.** `addresstokennftinventory` answers
   `Missing Or invalid Action name`. My first version returned `[]` on that — silently reporting an
   empty wallet. A refusing indexer must **throw**.
5. **A fork reports Hardhat's own chain id (31337)**, so indexer selection keyed on chain id
   silently fell through to a method the node could not serve. The chain id has to come from the
   live node.

`scripts/lib/holdings.js` now does discovery for both the rehearsal and the live sweep: indexer
first (Blockscout on gemba), chunked log scan second (Infura on Sepolia, chunk size halving on
refusal, lower bound from `getcontractcreation`), and **every row re-read from the chain** before
it is believed — an indexer one block behind would otherwise hand us an id the wallet no longer
owns. Assets found outside the wallet's own registry are reported separately as `stranded`,
because moving them needs a new registration first, which is its own timelock.

### The live sweep, from the rehearsal

| step | gemba ×2 | sepolia ×2 |
|---|---|---|
| execute the matured approval | 1 tx each | 1 tx each |
| ERC-20s, one proposal each | 6 × 3 tx | 3 × 3 tx |
| all NFTs in one batch | 1 × 3 tx | 1 × 3 tx (only `0x628b…`) |
| native, LAST | 1 × 3 tx | 1 × 3 tx |
| **total** | **50 tx, ~4.74 M gas** | **29 tx, ~2.78 M gas** |

Native goes last on purpose: the earlier steps are paid by the owners, not the wallet, so emptying
native first would not help and emptying it last leaves nothing behind.

---

## Task 8 — a second fuzzer, and the fourth vacuous campaign it had to survive

**Medusa 1.5.1** (`medusa.json`, `test-foundry/medusa/MedusaProps.sol`) — chosen over Echidna
because it is the maintained successor and because its search strategy genuinely differs: 8 parallel
workers, coverage-guided mutation of whole call **sequences**, and a corpus that persists across
runs. Foundry restarts from a clean slate every time.

The harness is written **independently** of the Foundry one, on purpose. The Foundry campaign only
ever shows the wallet inputs that have already passed through my assumptions; if one of those
assumptions is wrong, that campaign is blind in exactly that direction and still reports green. So
this harness bounds **nothing** in its main surface — unbounded `uint256` amounts, ttls of zero,
ids that do not exist, the wallet's own address as a destination, garbage token addresses — and
explores ARGUMENTS where Foundry explores ORDERINGS.

### 🐤 Two canaries, two vacuous campaigns caught in 90 seconds each

| version | result reported | what was actually happening |
|---|---|---|
| properties only | **10/10 PASSED**, 1.9 M calls, 0 failures | `targetContracts` is medusa's whole world — it does **not** fuzz dynamically deployed contracts. It called `w()` and `usdc()` for 400 000 calls and never touched the wallet. |
| + unbounded actions | all PASSED | 1 proposal in 400 000 calls, **zero executions** — a random `uint256` id never lands on a live proposal twice, so every property about executed proposals was quantified over an empty set. |
| + bounded reachability | PASSED, both canaries FAIL | proposals are made, confirmed, warped past and executed — but see the coverage measurement below, which showed this was still only half true. |

The canaries are two properties that are **false the instant anything real happens** —
`proposalCount() == 0` and "nothing was ever executed". Both must **FAIL**. They are kept commented
in the harness as the proof-of-life procedure: *no green fuzzing result means anything until a
deliberately-false property has been shown to fail.* This is the same trap that voided three
Foundry campaigns earlier in this document, hit twice more by a different tool.

### What medusa covers, and what it deliberately does not

Medusa evaluates `property_*` after every call, so it can only express rules that are true of
**storage at rest**. Transition rules — "it was not early *at the moment* it executed" — need a
ghost recorded during the call, which is Foundry's job. The two suites are complements, and the
harness says so in its own header rather than implying coverage it does not have:

- **covered by medusa** — owner set integrity; executed ⇒ sufficiently confirmed; executed and
  cancelled mutually exclusive; registry coherence and containment; native and token balances never
  overstated; the wallet and the zero address are never allowed recipients.
- **Foundry only** — timelock-at-execution, expiry-at-execution, double execution, strict mode at
  execution, hostile-owner outcomes, the differential against the reference model, and the entire
  **ERC-721 / ERC-1155 surface**: the medusa harness deploys one fungible token and nothing else,
  so the NFT batch paths are not fuzzed by it at all. Said plainly rather than left for someone to
  discover — a second tool is worth having only if its blind spots are written down.

---

## Task 9 — the symbolic suite was too easy, and the deeper one found something

`HalmosBoundaries` proved eight properties in **4.9 seconds over 1–5 paths each**. That is not a
compliment. It means almost nothing in those checks was symbolic: the `setUp` builds one concrete
wallet, the proposal is one concrete kind with concrete arguments, and the only symbol reaching the
solver is a time jump. Such a check proves a property of ONE state for all times — useful, and a
long way from "for all states".

`test-foundry/HalmosDeep.t.sol` widens the symbols rather than adding more checks of the same
shape: the chain's **current** time is symbolic (not just the jump), amounts and TTLs are symbolic
so the accept/reject boundary is proven instead of sampled, the proposal **id** is symbolic so the
guards are proven for ids that do not exist as well as the one exactly at `proposalCount`, and
every "if and only if" is checked in both directions — a guard that is merely sufficient, refusing
legitimate work, fails here too.

| | baseline suite | deep suite |
|---|---|---|
| checks | 8 | 8 |
| paths explored | 30 | **61** |
| solver time | 4.9 s | **27.0 s** |
| deepest single check | 5 paths | **17 paths / 12.0 s** |

**16 symbolic checks, 91 paths, 0 counterexamples** — after one was fixed.

### 🔴 The counterexample, and what it was really about

`check_delayBoundsAreExact` asserted the obvious: a policy proposal is accepted exactly when the
delay is inside `[MIN_DELAY, MAX_DELAY]`. Halmos answered with

```
Counterexample: p_nd_uint64 = 0x3f480        // 259 200 = 72 hours
```

a value squarely inside the range that the contract nevertheless **refuses**. The contract is
right and the assertion was wrong: 72 hours with both registries required *is* the current policy,
and `NoPolicyChange()` rejects a proposal that changes nothing. The solver found the one value in
the entire `uint64` space where my rule and the contract's rule disagree — a fuzzer would have had
to guess exactly `DEFAULT_DELAY`, with both booleans matching, to see it.

That is the third time in this document that a tool found **my** mistake rather than the
contract's, and it is the reason this file records the corrections as prominently as the findings:
a suite whose failures are never investigated converges on testing its author's assumptions.

The behaviour itself is worth stating as a finished thought, because it has an operational
consequence: **a no-op policy proposal is refused at proposal time, not at execution.** It cannot
be parked in the queue looking harmless.

### What the deep suite now proves that nothing else did

- `effectiveAt` never wraps, **at any chain time** — including timestamps near the `uint64`
  ceiling, where `uint64(block.timestamp) + delay` is checked arithmetic. Either the proposal is
  refused or `effectiveAt` is strictly in the future; a wrapped deadline would be a timelock
  defeated by arithmetic rather than by waiting. No fuzzer generates a timestamp near 2⁶⁴.
- `expiresAt` likewise, for **every** accepted TTL at **every** chain time, with the refusal
  reasons proven exhaustive: out of range, or the sum not fitting.
- `isExecutable` is **exactly** the conjunction it documents, for symbolic ids including
  non-existent ones — proven as an equivalence, so an over-strict guard fails too.
- **Two** confirmations are never enough for governance, at any time, for either pair of owners.
  The baseline only proved that one is not enough; two is the boundary that stops a pair from
  rewriting the policy behind the third owner's back.
- A veto survives confirmations arriving **after** it, not merely the passage of time.
- A native transfer never exceeds the balance, for any symbolic amount, with no fourth outcome
  between "refused" and "balance covered it" — in particular no partial send.

### 🔴 And coverage is MEASURED, not assumed — the third vacuum

With both canaries failing the campaign looked honest, so a 20-minute run went in: **739 459 calls,
6 157 sequences, 0 failures, 1 603 branches.** The claim I was about to write was that the
uncovered half of the contract is the NFT paths. The lcov report said otherwise:

```
PersonalWallet.sol   161/324 lines = 49.7 %
executeNative        8 lines, ALL uncovered
executeERC20         9 lines, ALL uncovered
```

**Not one payment ever executed.** The executions the canary detected were all governance ones.
Reaching "executable" needs a propose, two confirmations and an execute to land on the **same id**,
and picking `seed % proposalCount` makes that a 1/n coincidence that has to happen three times in a
row. Exactly the defect that voided the first Foundry campaign, in a different costume.

The fix is the same medicine: `fuzz_confirmAll` and `fuzz_executeAnything` sweep **every live id**
in a bounded window instead of picking one, leaving the fuzzer in charge of when and of everything
that happened before.

| | before | after |
|---|---|---|
| `PersonalWallet.sol` lines | 161/324 = 49.7 % | **193/324 = 59.6 %** |
| `executeNative` | 0/8 | **8/8** |
| `executeERC20` | 0/9 | **9/9** |
| `executeAllowRecipient` / `executeSetPolicy` / `executeOwnerReplacement` | partial | **fully covered** |
| branches | 1 603 | **1 744** |

🔑 **A green campaign with a canary that fails is still not enough.** The canary proves *something*
real happened; only coverage shows *what*. Both are cheap and neither replaces the other.

### 🔴 What the corrected campaign then found — again in my property, not the contract

With payments finally executing, `property_executedWasSufficientlyConfirmed` failed on a five-call
sequence that is worth reading in full because the answer is counter-intuitive:

1. proposal 1 (`ALLOW_RECIPIENT`) is proposed, confirmed by all three owners, and **executed
   legitimately**;
2. proposal 2 (`OWNER_REPLACE`) executes and replaces `0x10000` — one of proposal 1's confirmers;
3. `confirmations(1)` now reads **2** against a `requiredConfirmations(1)` of **3**.

Nothing is wrong. `_confirmations` counts over the **current** owners by design — "Counted over the
current owners on purpose", and `HalmosBoundaries.check_replacedOwnersVoteStopsCounting` proves it:
a departed owner's vote must not keep authorising anything.

The lesson is about the property. **"Executed ⇒ sufficiently confirmed" is a transition rule
wearing a state rule's clothes**, because its right-hand side is re-evaluated against a mutable
set. As a state property it holds only while the owner set is unchanged, and that is now exactly
what the medusa version asserts; the unconditional form stays in Foundry, which records the count
at the moment of the call.

That is the **fourth** time in this document a tool found my mistake rather than the contract's.
It is also why medusa's assertion mode is left enabled on the harness itself: it caught
`(seed + id) % 3` overflowing when the fuzzer passed 2²⁵⁶−1 — a bug in this file, reported as an
arithmetic panic, exactly as it should be.
### What the 59.6 % does and does not mean

Under `viaIR` medusa's lcov attribution is **unreliable for view functions**, and that was measured
rather than assumed: `isExecutable`, `confirmations` and `requiredConfirmations` report zero lines
even though a property calls all three on every evaluation — and so does `owners()`, which is called
from inside `fuzz_executeAnything`, a transaction. The mutating paths (`propose*`, `execute*`,
`deposit*`) are attributed correctly, which is what the before/after comparison above rests on.

So the number is a **floor**, useful comparatively and not as an absolute. What is genuinely
untouched by this campaign is the **ERC-721 / ERC-1155 surface** — `proposeNFTBatch`,
`executeNFTBatch`, `executeERC721`, `executeERC1155`, `depositERC721`, `depositERC1155` — because
the harness deploys one fungible token and nothing else. Those paths are covered by Foundry's
`Assets.invariants.t.sol`, and extending the medusa harness to them is the obvious next step for
this file rather than a gap being hidden.

**Final medusa state: 40 tests, 0 failures, 250 977 calls over 2 087 sequences, 1 739 branches,
corpus 130.**
