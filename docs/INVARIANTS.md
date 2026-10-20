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
