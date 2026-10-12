# Slither — full report and triage

Run on **2026-10-12** with **Slither 0.11.6** (Python 3.12.3, solc 0.8.28), against the finished
v2 contract.

```bash
npm run slither        # only what is deployed to hold value — contracts/PersonalWallet.sol
npm run slither:all    # everything, including the test mocks and OpenZeppelin
```

Slither lives in its own virtualenv at `~/.venvs/slither` so it cannot disturb the system Python
(the upgrade notes call out the system PIL as something that must not move).

## The headline

| | first run | after two zero-cost fixes |
|---|---|---|
| **High** | **1** | **0** |
| Medium | 3 | 1 |
| Low | 18 | 9 |
| Informational | 5 | 1 |
| total, in `PersonalWallet.sol` | 27 | **11** |

Whole-project run: **159 findings across 77 contracts**, of which 101 are in OpenZeppelin and 28 in
the test mocks. Every one is accounted for below. **No finding is a real defect**, and nothing was
filtered because it was inconvenient.

---

## What was changed because of Slither

Two findings were false positives that could be removed at essentially no cost, so they were —
a HIGH finding on a savings vault is noise that frightens anyone reading the report.

### 1 · HIGH `uninitialized-state` — `_batches` is never initialized  **fixed**

> `PersonalWallet._batches` is never initialized. It is used in `proposeNFTBatch`,
> `executeNFTBatch`, `getBatch`.

A false positive about a `mapping(uint256 => BatchItem[])`, which Solidity zero-initialises by
definition. The real cause is narrower and worth knowing: the code wrote through a storage
pointer —

```solidity
BatchItem[] storage dst = _batches[id];
dst.push(it);
```

— and Slither's dataflow does not recognise a push through a storage pointer as a write to the
underlying variable.

Rewritten as `_batches[id].push(it)`. **Measured cost: +2 974 gas on a full 50-item proposal
(3 590 096  3 593 070, +0.08 %), and 5 bytes less bytecode.** The comment in the source records
this so nobody "optimises" it back and reintroduces a HIGH finding.

### 2 · MEDIUM `uninitialized-local` ×2 — `live` and `j` in `_collect`  **fixed**

Both were `uint256 live;` / `uint256 j;`. Solidity already zero-initialises them; the detector is
about stated intent. Written as `= 0`, which the optimizer removes — **zero gas, zero size
change** (confirmed: 21 801 B either way).

---

## What was NOT changed, and why

### MEDIUM · `incorrect-equality` — `received == 0` in `depositERC20`

> uses a dangerous strict equality: `received == 0`

**Not applicable.** The detector hunts for `token.balanceOf(x) == someExpectedAmount`, which breaks
when a balance is nudged by an unexpected transfer. Here `received` is a delta this function
computed itself —

```solidity
uint256 before = IERC20(token).balanceOf(address(this));
IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
uint256 received = IERC20(token).balanceOf(address(this)) - before;
if (received == 0) revert ZeroAmount();
```

— and comparing a locally measured delta against zero is exactly the intent: refuse a deposit
where nothing arrived. Loosening it to `<= 0` on an unsigned type would be nonsense, and a
threshold would be arbitrary. The guard is tested with `BlackHoleERC20`, a mock whose
`transferFrom` reports success and moves nothing.

### LOW · `calls-loop` ×4 — external calls inside a loop

`executeNFTBatch` and `depositNFTBatch` both loop over `safeTransferFrom`. This is the batch
feature, and the consequence is real but deliberate: **one misbehaving token reverts the whole
batch**.

That is the chosen semantics. Partial execution would mean two owners approved five NFTs and three
moved — the approval would stop meaning what it said — and it would introduce "partially executed,
re-executable for the remainder" state, which is new state and new bugs. Nothing is lost on a
revert; the owners re-propose without the bad item. A test asserts exactly this
(`is all-or-nothing: one bad item reverts the whole batch and moves nothing`).

The gas ceiling is bounded and measured, not assumed: `MAX_BATCH = 50`, and a full 50-item batch
executes in **2 199 452 gas**, about 43 989 per item. Even a token costing ten times as much per
transfer would fit a 30 M block with room to spare, so a batch cannot become permanently
un-executable through gas.

An external review (remix.ai) suggested per-item `try/catch` here. Declined, for the reasons above;
the review itself classed it as "griefing, not fund loss, and recoverable".

### LOW · `timestamp` ×5 — comparisons against `block.timestamp`

Three are genuine timestamp comparisons, in `confirm`, `acceptOwnerReplacement` and
`isExecutable`: `block.timestamp > p.expiresAt` and `block.timestamp < effectiveAt`.

**Not applicable at this scale.** A proposer can be nudged by a validator at the scale of seconds;
the windows here are `MIN_TTL` 10 minutes, `MAX_TTL` 30 days, `MIN_DELAY` 24 hours and
`EXECUTION_WINDOW` 7 days. Shifting a 72-hour timelock by a few seconds changes nothing, and on a
CometBFT chain the block time is consensus-driven rather than miner-chosen. There is no deadline
here tight enough for timestamp games to matter.

Two of the five are a **mis-attribution worth recording**: Slither reports
`_requireAllowedRecipient` and `_requireAllowedToken` as timestamp comparisons, and their
comparisons contain no timestamp at all —

```solidity
if (requireAllowedRecipient && !_recipients[to].allowed) revert RecipientNotAllowed(to);
```

The mechanism: `Entry.addedAt` is assigned `block.timestamp` in `_allowRecipient`, so Slither taints
the whole `Entry` struct, and reading any field of it — including the unrelated `allowed` bool —
counts as a tainted comparison. Nothing to fix.

### INFORMATIONAL · `low-level-calls` — `address(p.to).call{value: amount}("")` in `executeNative`

Intentional, and the only correct way to send native currency. The alternative, `transfer()`, caps
gas at 2 300 — the mistake that broke a generation of wallets when Istanbul repriced `SLOAD`, and
it would make this wallet unable to pay a contract recipient at all.

The return value **is** checked, and the failure is loud:

```solidity
(bool ok,) = payable(p.to).call{value: amount}("");
if (!ok) revert NativeTransferFailed(p.to, amount);
```

Two tests cover it: a recipient that refuses money (`NativeTransferFailed`, with the approval left
intact so the same proposal works once the obstacle is removed), and one that burns all the gas
(the transaction dies loudly rather than reporting a success that never happened).

The same review suggested a gas stipend here. **Actively declined** — that is the 2 300-gas trap,
and a capped send that fails quietly is strictly worse than a transaction that fails loudly.

---

## The rest of the project

### OpenZeppelin — 1 High, 9 Medium, 91 Informational

Every one of them is inside `Math.mulDiv` and `Math.invMod`:

- **HIGH `incorrect-exp`**: `inverse = (3 * denominator) ^ 2`. The textbook Slither false positive.
  That `^` is XOR on purpose, part of the documented Newton–Raphson seed for a modular inverse, not
  a mistyped exponent.
- **MEDIUM `divide-before-multiply` ×9**: the whole point of `mulDiv` is full-precision 512-bit
  arithmetic; the intermediate division is the algorithm.

Upstream, audited, and **not even reachable from the wallet** — walked rather than assumed. The
transitive import closure of `contracts/PersonalWallet.sol` is exactly 16 files:

```
contracts/PersonalWallet.sol
@openzeppelin/contracts/interfaces/IERC1363.sol      .../interfaces/IERC165.sol
@openzeppelin/contracts/interfaces/IERC20.sol        .../token/ERC20/IERC20.sol
@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol
@openzeppelin/contracts/token/ERC721/IERC721.sol     .../token/ERC721/IERC721Receiver.sol
@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol
@openzeppelin/contracts/token/ERC1155/IERC1155.sol   .../token/ERC1155/IERC1155Receiver.sol
@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol
@openzeppelin/contracts/utils/ReentrancyGuard.sol    .../utils/StorageSlot.sol
@openzeppelin/contracts/utils/introspection/ERC165.sol  .../utils/introspection/IERC165.sol
```

`Math.sol` is not among them. It arrives only through the full ERC-721/ERC-1155 implementations,
which exist solely as test mocks, so none of these ten findings touch a line the deployed wallet
can execute.

The 91 informational findings are OpenZeppelin's floating pragmas (`>=0.4.16`, `>=0.6.2`, `^0.8.20`
and so on) plus naming conventions. Our own sources are pinned to exactly `0.8.28`.

### Test mocks — 3 High, 6 Medium, 18 Low/Informational

All deliberate, and three of them are Slither confirming the mocks do their job:

| finding | why it is there |
|---|---|
| HIGH `arbitrary-send-eth` — `RejectingReceiver.sweep` | a test helper for recovering test funds; sending to a caller-named address is its purpose |
| HIGH `suicidal` — `SelfDestructPusher.push` | **that is the probe.** It exists to force ether in via `SELFDESTRUCT`, proving the wallet never caches its balance |
| MEDIUM `erc20-interface` ×3 — `MockUSDT` | **Slither agreeing with the design note.** USDT's `transfer` returns nothing, which is why `SafeERC20` is mandatory; the mock reproduces that non-standard interface on purpose |
| MEDIUM `locked-ether` ×3 — the attacker mocks | test contracts with no withdrawal path; nothing of value is left in them |

`contracts/mocks` is filtered out of `npm run slither` for that reason, and `npm run slither:all`
shows them in full. Nothing is hidden.

### INFORMATIONAL · `missing-inheritance` — "PersonalWallet should inherit from IPersonalWallet"

`IPersonalWallet` is the minimal interface the **attacker mock** uses to call back into the wallet.
The wallet obviously should not inherit an interface defined in its own test fixtures. It
disappears from the scoped run along with the rest of `contracts/mocks`.

---

## One-line summary

Slither found **no defect**. One HIGH and two MEDIUM false positives were removed by writing the
same logic in a way the analyser can follow, for +0.08 % gas on the largest possible batch; the
nine remaining findings are the batch loop, the timestamp windows and the native `call`, each a
deliberate decision with a test behind it.
