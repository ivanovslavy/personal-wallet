# Design notes — the analysis behind v2

Written 2026-10-12 as an answer to two questions, **before** any code was written. Kept as-is,
because the reasoning is what justifies the design.

> **STATUS: IMPLEMENTED on 2026-10-12.** Everything recommended below is now in
> `contracts/PersonalWallet.sol`, with one addition that this note did not foresee — **owner
> replacement had to be timelocked and vetoable too**, or two compromised keys simply take the
> third seat and there is nobody left to veto anything. See the security-model section of
> `README.md`. The pre-v2 contract, its tests and its deployment records are preserved under
> `v1/` with checksums.
>
> What was **not** built, on purpose: a 2-of-3 gate on deposits, and any attempt to refuse direct
> incoming transfers. The reasoning for both is below and has not changed.

Two things were asked:

1. Can the wallet accept ERC-20 / ERC-721 / ERC-1155 **only from pre-approved token contracts** —
   a registry of contract address + name, read functions for it, and a revert on an incoming
   transfer from anything not on the list?
2. Can there be **deposit functions** (multisig, for native / ERC-20 / ERC-721 / ERC-1155 / NFT
   batch) with **direct transfers to the contract refused**? And would all this make every function
   much heavier and much more expensive?

---

## 1 · Refusing an incoming transfer: what is actually enforceable

This is not a matter of writing the check well. For one of the four asset types it is
**impossible**, and the asymmetry decides the whole design.

| asset | can the wallet refuse an incoming transfer? | how | how it is bypassed |
|---|---|---|---|
| **native** | yes, in practice | make `receive()` / `fallback()` revert | `SELFDESTRUCT` still transfers the balance (EIP-6780 removed the account deletion, not the transfer), and a block reward / `coinbase` payment runs no code at all. No contract can block either. |
| **ERC-20** | **no. never.** | — there is no mechanism — | nothing to bypass: `token.transfer(wallet, x)` only writes balances **inside the token contract**. The wallet's code never executes. There is no hook, no callback, nothing to revert. |
| **ERC-721** | partially | revert inside `onERC721Received` | the hook only runs on `safeTransferFrom`. Plain `transferFrom` has no receiver check at all, so a sender who wants to push an NFT in simply uses it. |
| **ERC-1155** | **yes, fully** | revert inside `onERC1155Received` / `onERC1155BatchReceived` | none. ERC-1155 has no unsafe variant — the standard requires the hook on every transfer. |

### What follows from that table

The restriction is unenforceable **exactly where it would matter most**. Scam tokens, dust attacks
and unwanted airdrops are overwhelmingly ERC-20, and ERC-20 is the one row that cannot be blocked
under any circumstances. So an inbound allowlist cannot deliver the property "this wallet only ever
contains approved assets" — the wallet would still need a way to deal with unapproved tokens
arriving, which is the thing the restriction was supposed to remove.

Meanwhile the two rows that *can* be enforced (native and ERC-1155) are rows where reverting has a
real cost: a legitimate delivery — marketplace sale proceeds, a bridge payout, a game item you
actually want — fails on the sender's side. Depending on their contract that value can be stranded
with them.

### The control that does work: an allowlist on the way OUT

Outbound is 100 % enforceable, because every outbound movement goes through the wallet's own code.
A registry checked in `propose*` / `execute*` means:

- the wallet can never send a token that is not on the list — including by mistake or under a
  confused approval;
- junk that arrives unasked is simply inert: it sits in the balance and nothing can be done with
  it, which is already the safe state;
- and nothing legitimate can ever be rejected on arrival.

A plausible shape, if this is wanted:

```solidity
struct TokenInfo { string label; Standard standard; bool allowed; uint64 addedAt; }
mapping(address => TokenInfo) private _registry;
address[] private _registryList;          // for enumeration

// 2-of-3, through the same propose/confirm/execute machinery as everything else
function proposeAllowToken(address token, string calldata label, Standard std, uint64 ttl) …
function proposeRevokeToken(address token, uint64 ttl) …

// reads
function isAllowed(address token) external view returns (bool);
function tokenInfo(address token) external view returns (TokenInfo memory);
function allowedTokens() external view returns (address[] memory);
```

Two details that matter more than they look:

- **The label must be supplied by the owner, never read from the token.** Calling `name()` on an
  untrusted contract is an external call into hostile code in the middle of the wallet's logic, and
  a scam token can return whatever name it likes — including one that imitates USDT. The owner's own
  label is the only trustworthy one.
- **Adding or revoking a token must itself be 2-of-3.** A registry one owner can edit is not a
  control, it is a single point of failure dressed as one.

---

## 2 · Deposit functions, and refusing direct transfers

### Deposit functions: yes, worth having — but **not** behind multisig

Multisig exists to stop value leaving against the owners' will. A deposit **increases** the
wallet's assets; nothing is at risk when value arrives. Putting a 2-of-3 gate on deposits would:

- cost three transactions plus an ERC-20 `approve` for every single deposit;
- still not be enforceable for ERC-20, since a plain `transfer` bypasses the whole thing;
- and add a failure mode that does not exist today — a deposit that should have landed gets
  refused.

So the right shape is **single-signature** deposit functions that pull with `safeTransferFrom`
(which needs the depositor's `approve` first) and emit a proper event naming the depositor:

```solidity
function depositNative() external payable;
function depositERC20(address token, uint256 amount) external;
function depositERC721(address token, uint256 tokenId) external;
function depositERC1155(address token, uint256 id, uint256 amount) external;
function depositNFTBatch(BatchItem[] calldata items) external;   // many at once
```

What this buys: a clean, accounted path with an event that records **who** deposited, which a raw
`token.transfer` can never give you (the ERC-20 `Transfer` event names the sender, but the wallet
emits nothing and has no record). What it does **not** buy: exclusivity. It is an additional path,
never the only one.

### Refusing direct transfers: recommended against

Per the table above, the invariant cannot be achieved. Making `receive()` revert and the NFT hooks
revert would block native and ERC-1155 and most ERC-721 — while ERC-20, the one that matters,
stays wide open. The result is a wallet that rejects legitimate deliveries and still cannot promise
a clean balance sheet.

---

## 3 · The cost — measured, not estimated

A variant of the contract with the six deposit functions added (43 external functions instead of
37) was compiled and benchmarked against the real one on the local devnet:

| | 37 functions | 43 functions | difference |
|---|---|---|---|
| **deployment** | 3 178 757 | 3 570 035 | **+391 278 (+12.31 %)** — one-off |
| `proposeNative` | 147 085 | 147 085 | **+0** |
| `confirm` | 64 322 | 64 323 | **+1** |
| `executeNative` | 67 424 | 67 424 | **+0** |
| `receive()` | 22 765 | 22 794 | +29 (+0.13 %) |
| runtime bytecode | 13 681 B | 15 490 B | +1 809 B (EIP-170 limit is 24 576 B — 9 086 B still free) |

**Adding functions does not tax the existing ones.** Solidity's dispatcher is a binary search over
function selectors, so six more entries add at most one comparison — single-digit gas, lost in the
noise. The whole cost is paid once, at deployment.

### What *would* actually cost something

- **Another storage slot per proposal**: 20 000 gas on every `propose*`, every time. This is the
  one to be careful about.
- **A registry check on every execute**: one cold `SLOAD` = 2 100 gas, i.e. about **+2 %** of a
  ~100 000-gas execute. Trivial.
- **Storing a label string**: ~20 000–40 000 gas per token added. Paid once per token, not per use.

### And in money

A complete 2-of-3 native transfer today is three transactions:
`propose 147 085 + confirm 64 322 + execute 92 424 ≈ **303 831 gas**`.

| chain | at | a full 2-of-3 transfer |
|---|---|---|
| gembatestnet | 5.625 gwei | ≈ 0.0017 GMB |
| BSC / Polygon | 1–3 gwei | fractions of a cent |
| Ethereum mainnet | 10 gwei | ≈ 0.003 ETH |

The multisig's three transactions dominate the bill, not the contract's size. Nothing proposed in
this document changes that — the deposit functions are free at call time, and the registry check is
a 2 % rounding error.

---

## Postscript — what an external review added

An independent review of the finished v2 (remix.ai) returned no vulnerability and made one
substantive point this note had missed: **`depositERC20` emitted the amount requested, not the
amount received.** With a fee-on-transfer token those differ, so the event misstated the balance
change — defeating the only reason the function exists over a plain `transfer`. Fixed rather than
documented: the function now measures the balance before and after and emits what actually
arrived, and refuses a deposit where nothing arrived at all.

Its other two suggestions were declined with reasons: `oldOwner != newOwner` is genuinely
unreachable (the review agreed), and a token cannot be revoked mid-batch because a batch is one
atomic transaction.

## Recommendation, in one paragraph

Add the **outbound** token registry (address + owner-supplied label, 2-of-3 to add or revoke, with
read functions) — it is fully enforceable and it is the control that actually protects. Add the
deposit functions **single-signature**, for the accounting and the depositor event. Do **not** gate
deposits with 2-of-3, and do **not** try to refuse direct transfers: the one asset class where it
matters cannot be blocked, so the restriction costs legitimate deliveries and buys no real
guarantee. Cost is not a reason to hesitate about any of it — the measurements above are the
evidence.
