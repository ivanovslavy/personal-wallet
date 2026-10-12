# Mythril — full report and triage

Run on **2026-10-12** with **Mythril 0.24.8** (Python 3.12.3, solc 0.8.28), in its own virtualenv
at `~/.venvs/mythril` so it cannot disturb the system Python or Slither's environment.

Two runs, deliberately different:

| run | input | transactions | budget | findings |
|---|---|---|---|---|
| **source** | `contracts/PersonalWallet.sol` with the real compiler settings | `-t 3` | 59 min | **0** |
| **bytecode** | the deployed runtime bytecode, no compiler context | `-t 3` | 40 min | **52** |

The gap between those two numbers is the whole story, and it is measured below rather than
asserted.

---

## What Mythril was actually looking for

Unlike a linter, Mythril executes the contract symbolically. Its 17 detection modules are the
definition of what "no findings" means here:

```
AccidentallyKillable   ArbitraryJump        ArbitraryStorage      ArbitraryDelegateCall
EtherThief             Exceptions           ExternalCalls         IntegerArithmetics
MultipleSends          PredictableVariables RequirementsViolation StateChangeAfterCall
TransactionOrderDependence  TxOrigin        UncheckedRetval       UnexpectedEther
UserAssertions
```

`EtherThief` — "any sender can withdraw ETH from the contract account" — is the one that matters
most for a wallet. It found nothing.

## The limit that has to be stated: transaction depth

Mythril explores a bounded number of transactions. The default is **two**. This wallet needs
**three** before a single wei can move:

| path | transactions needed | within reach at `-t 3` |
|---|---|---|
| deposits, `receive`, `fallback`, every view | 1 | yes |
| every `propose*` guard | 1 | yes |
| native / ERC-20 / ERC-721 / ERC-1155 / batch transfer | **3** (propose → confirm → execute) | at the edge |
| owner replacement | **4** + 72 h of timelock | no |
| allowlisting a recipient (3-of-3) | **4** + 72 h | no |

So "no findings" is a meaningful statement about the single-transaction surface — the deposit
functions, the proposal guards, the fallback paths — and a weak one about the multi-transaction
governance paths. Those are covered instead by the 148 local tests and the 245-check live run,
where the timelock can be fast-forwarded and a real transaction can be mined with `status=0`.

Running the default `-t 2` would have reported a clean contract without ever reaching a single
`execute*` function. That is worth knowing before anyone quotes a Mythril result on a multisig.

---

## The bytecode run's 52 findings

### 38 × HIGH `SWC-101` "the arithmetic operator can overflow" — over-reporting, proved

The source run found zero of these. The bytecode run found 38. The difference is compiler
context: `--bin-runtime` hands Mythril raw bytecode with no pragma, so it cannot know the code was
built by solc **0.8.28**, where every arithmetic operation is compiled with an overflow check that
reverts with `Panic(0x11)`.

Two measurements settle it.

**1 · The contract has no `unchecked` block at all.** `grep -n unchecked contracts/PersonalWallet.sol`
returns nothing. Every arithmetic operation in it is therefore compiler-checked, by construction —
independent of what any analyser believes.

**2 · A control contract, compiled with the same settings.** `checkedAdd` and `uncheckedAdd`, one
of each:

```solidity
function checkedAdd(uint256 a, uint256 b) external pure returns (uint256) { return a + b; }
function uncheckedAdd(uint256 a, uint256 b) external pure returns (uint256) {
    unchecked { return a + b; }
}
```

At `2²⁵⁶-1 + 1`, `checkedAdd` **reverts with a panic**; `uncheckedAdd` silently returns `0`. Then
the same contract through both Mythril modes:

| mode | what it reported |
|---|---|
| **source** | one finding, naming **`uncheckedAdd(uint256,uint256)`** — the function that genuinely overflows |
| **bytecode** | **three** overflow findings, in a 196-byte contract containing exactly **one** real overflow |

Bytecode mode over-reports on a контрол whose contents are known exactly. That is the explanation
for the 38, demonstrated rather than argued. Note also that source mode rates SWC-101 **Low**
while bytecode mode rates the same class **High** — the severity is a property of the run, not of
the code.

### 7 × MEDIUM `SWC-107` "read/write of persistent state following an external call"

Real pattern, and intended. Three places do it:

- **`depositERC20`** reads `balanceOf` *after* `safeTransferFrom`, on purpose — that is how it
  reports the amount that actually arrived rather than the amount requested, which is the only
  reason the function exists over a plain `transfer`.
- **`executeNFTBatch`** and **`depositNFTBatch`** loop, so each iteration touches storage
  (`_requireAllowedToken`, the next `BatchItem`) after the previous iteration's external call.

All of them sit inside `nonReentrant`, and `p.executed = true` is set before any external call, so
the checks-effects-interactions order holds. Mythril's own advice on these findings reads
"alternatively, a reentrancy lock can be used" — which is exactly what is there; from bytecode
alone it cannot see the modifier as a lock.

This is not taken on faith. A test seats a hostile token as one of the three owners so its
transfer hook can re-enter `executeERC20` without a `try/catch`, and asserts that the caller
receives **`ReentrancyGuardReentrantCall`** — the guard's own error, propagated out of the whole
transaction, with nothing moved.

### 5 × LOW `SWC-107` "a call to a user-supplied address is executed"

The transfers. A wallet whose entire purpose is sending assets to an address its owners choose
cannot avoid this. The recipient is fixed in the proposal that two owners approved, re-checked
against the allowlist at execution, and the call happens after `executed` is set, under the guard.

### 3 × LOW `SWC-113` "multiple calls executed in the same transaction"

The NFT batch — the same finding Slither reports as `calls-loop`, and the same deliberate
all-or-nothing semantics. Bounded at `MAX_BATCH = 50`, measured at **2 199 452 gas** for a full
batch, about 44 k per item, so it cannot become un-executable through gas. Reasoning and the
rejected `try/catch` alternative are in `docs/SLITHER.md`.

---

## Verdict

**No defect.** The source run — the one with compiler context, which is the mode that can reason
about Solidity 0.8 semantics — reported nothing across all 17 modules, including `EtherThief`. The
bytecode run's 38 HIGH findings are over-reporting from missing compiler context, proved on a
control contract. Its 15 remaining findings are the external calls a wallet must make and the
loop the batch feature is, each guarded and each tested.

The honest caveat is depth, not severity: symbolic execution reached the one-transaction surface
thoroughly and the three-transaction transfer paths at the edge of its budget. It did not reach
owner rotation or recipient allowlisting, which need four transactions and a 72-hour timelock —
those are proved by test and by live transaction instead.
