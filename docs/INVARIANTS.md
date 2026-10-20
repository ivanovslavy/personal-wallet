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
