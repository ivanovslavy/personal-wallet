# v3 — amount-tiered delays

**Status: DESIGNED, NOT IMPLEMENTED.** Agreed 2026-10-12. Nothing in this document is in the
deployed contract. It is written down so the reasoning does not have to be rediscovered, and so
the open parameters are visible as decisions still to be made rather than defaults nobody chose.

## The problem it addresses

v2 has exactly two states for a transfer: two owners agree and it moves immediately, or it does
not move. There is nothing in between, and in particular the third owner has **no brake on an
individual withdrawal** — `veto()` reaches only power-expanding proposals (a new recipient, an
owner replacement, a loosening of policy), never a transfer.

That is deliberate and it stays: if one owner could veto a transfer, one owner could block every
decision the other two made. It would turn 2-of-3 into a de-facto 3-of-3 and hand a single
compromised key the power to freeze the vault — lowering the cost of a successful attack from two
keys to one.

What is missing is not a veto on transfers. It is **graduation by risk**: a large withdrawal
should be slower and stoppable, a small one should not be.

## The shape

```
amount >  threshold  ->  long delay  (72 h by default) + veto that KILLS the proposal
amount <= threshold  ->  short delay              + veto that only DELAYS it
```

A veto on a small transfer pushing the execution out by the long delay — rather than cancelling it
— is what keeps this from reintroducing the freeze. One hostile owner can slow things down; the
other two wait and proceed. A veto that killed small transfers would let one key block everything
for ever: propose, veto, propose, veto.

## The hard part: "amount" means nothing outside native currency

This is the substance of the design, not a detail.

| asset | what "the amount" is | comparable across assets |
|---|---|---|
| native | wei, 18 decimals | yes |
| USDT / USDC / EURC | units, **6 decimals** | **no** — 1 000 000 units is 1 USDT, or dust at 18 decimals |
| ERC-721 | one item, quantity 1 | **no** — an NFT worth 100 ETH and a worthless one are both "1" |
| ERC-1155 | a quantity of an id | **no**, same reason |
| a batch | many assets at once | **no** |

So a single global threshold is meaningless. Three honest ways out, and the two that were chosen:

1. **A threshold per token, stored in the registry.** The `Entry` struct already holds a label and
   a timestamp; it gains a `threshold`. Paid once when the token is allowlisted, never per
   transfer. **Chosen.**
2. **NFTs always take the long path.** Quantity says nothing about value, and NFTs are moved
   rarely. **Chosen.**
3. A price oracle. **Rejected** — a new trusted dependency and a new attack surface in a contract
   that deliberately has neither.

The control therefore applies to ERC-20, ERC-721 and ERC-1155 exactly as much as to native
currency. (This was a point of genuine confusion: the per-token threshold exists *because* ERC-20
can be controlled, not because it cannot.)

## Changing the parameters: two functions, 3-of-3

```solidity
proposeSetThreshold(address asset, uint256 threshold)   // address(0) means native
proposeSetDelays(uint64 shortDelay, uint64 longDelay)
```

One threshold function for every asset rather than one per standard, and one delays function for
both values.

**Both require all three owners.** And at 3-of-3 **a separate veto is redundant** — withholding a
signature *is* the veto. That is a stronger protection than timelock-plus-veto, for a reason worth
stating plainly:

| | what it needs from the honest owner |
|---|---|
| timelock + veto | **vigilance** — notice in time and act |
| 3-of-3 | **a signature** — doing nothing is enough |

Two compromised keys cannot reach three. Three compromised keys mean nothing in the contract
helps.

The tightening/loosening asymmetry still applies:

| direction | when it takes effect |
|---|---|
| **tightening** — lower threshold, longer delay | at once |
| **loosening** — higher threshold, shorter delay | after the current long delay |

Not because anyone would veto it, but because **three owners can be unanimously wrong**, and a
cooling-off period is the guard against that. With all three keys held by one person, "unanimous"
does not require three people — it requires one attacker with access.

Losing one key does not brick this: transfers stay 2-of-3, the lost owner can be rotated out on
2-of-3 (and cannot veto their own removal, because nobody holds the key), and 3-of-3 works again
afterwards.

## Two parameters still open

1. **What does a threshold of 0 mean?** Proposed: **zero means "everything is a large amount"** —
   maximum caution, so a token with no threshold set takes the long path. Safe by default, but it
   means switching the tiers on without having set thresholds would put a 72-hour delay on every
   transfer. Hence a `tiersEnabled` flag, **off at deployment**, so nothing changes until the
   thresholds are in place.
2. **A floor on the short delay?** Allowing `shortDelay = 0` means small transfers stay instant as
   they are today — convenient, but then the lower tier buys nothing. A floor of ten minutes means
   there is always a window. Worth choosing deliberately rather than inheriting.

Still needed from the owner: the thresholds for native GMB and for USDT / USDC / EURC (6 decimals,
so "above 1 000 USDT" is `1000000000`), and the short-delay decision.

## What v3 does NOT solve

Stated plainly, because it would be easy to mistake this for a replacement for the recipient
allowlist.

Against **two compromised keys**, tiering buys **time and nothing else**. The honest owner cannot
move anything alone — that needs two signatures — so he can only delay. An attacker drains in
small amounts and he watches it happen.

The recipient allowlist wins **structurally**: two keys can only send to addresses that are
already the owner's, and adding one needs all three owners, 72 hours, and survives any single
veto. No race, no vigilance required.

> **Tiering by amount defends against a MISTAKE. The recipient allowlist defends against THEFT.**
> They cover different threats and neither substitutes for the other.

## Cost

Zero extra gas on `propose`/`execute` beyond **one cold `SLOAD`** for the threshold (~2 100 gas,
under 1 % of a ~100 000-gas execute), because the threshold lives in the registry and the delay is
computed at proposal time into `_effectiveAt`, which already exists.

The real constraint is size. v2 is **21 801 B of the 24 576 B** EIP-170 limit, leaving 2 775 B.
Four new functions plus the threshold field will be tight. **This will be measured, not promised.**
If it does not fit, the thing that is dropped is the **token** allowlist — which is
defence-in-depth — and never the **recipient** allowlist, which is the control that stops theft.

## The key-management model this assumes

A hardware wallet as the third owner, kept offline and used only when 3-of-3 is required. The two
working keys on separate USB sticks, used through a script when a transaction is needed. A third,
separate address as the allowlisted recipient — **never an owner address**, since an owner address
as an allowed destination is exactly a compromised owner's shortest path.

Two consequences worth planning for:

- **Rotate an owner once as a rehearsal, before it is needed.** With a hardware wallet in a drawer
  and 3-of-3 on new recipients, a broken USB stick is discovered at the worst possible moment. The
  rotation path takes 72 hours and a veto window in which somebody must be paying attention.
- **Add the new recipient before removing the old one.** Otherwise there is a window where the only
  allowed destination is an address no longer in use, and adding the replacement takes 72 hours.
  The order is: add the new recipient (3-of-3 + delay) → confirm it is active → remove the old one
  (2-of-3, immediate).
