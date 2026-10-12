const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { loadFixture, deployFixture, HOUR, DAY, DELAY, EXEC_WINDOW, eth, u6 } = require("./helpers");

describe("PersonalWallet — replacing an owner", () => {
  /** Two owners approve a swap. Returns the proposal id; the clock has NOT been moved. */
  const agreed = async (f, oldOwner, newOwner) => {
    await f.wallet.connect(f.o1).proposeOwnerReplacement(oldOwner.address, newOwner.address);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    return id;
  };

  it("needs acceptance AND the timelock before it can be executed", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);

    // Two owners agreed. That alone seats nobody. The timelock is checked in the modifier,
    // before the body looks at acceptance, so this is the error that surfaces first.
    await expect(f.wallet.connect(f.o1).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "TimelockNotElapsed");

    // Acceptance is allowed DURING the timelock — consent is not a vote.
    await expect(f.wallet.connect(f.spare).acceptOwnerReplacement(id))
      .to.emit(f.wallet, "OwnerReplacementAccepted").withArgs(id, f.spare.address);

    // Still not enough: the delay has to run.
    await expect(f.wallet.connect(f.o1).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "TimelockNotElapsed");
    expect(await f.wallet.isExecutable(id)).to.equal(false);

    await time.increase(DELAY + 1);
    expect(await f.wallet.isExecutable(id)).to.equal(true);

    await expect(f.wallet.connect(f.o1).executeOwnerReplacement(id))
      .to.emit(f.wallet, "OwnerReplaced").withArgs(id, f.o3.address, f.spare.address);

    expect(await f.wallet.owners()).to.deep.equal([f.o1.address, f.o2.address, f.spare.address]);
    expect(await f.wallet.isOwner(f.o3.address)).to.equal(false);
    expect(await f.wallet.isOwner(f.spare.address)).to.equal(true);
  });

  it("a matured replacement that nobody accepted is still refused", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    await time.increase(DELAY + 1);
    // The delay has run and two owners approved — acceptance is the remaining gate.
    await expect(f.wallet.connect(f.o1).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "NotAccepted").withArgs(id);
    expect(await f.wallet.isExecutable(id)).to.equal(false);
  });

  it(" a short-lived transfer proposal does NOT survive a rotation — pick the ttl accordingly", async () => {
    // A real operational consequence, not a bug: a rotation takes at least MIN_DELAY (24 h), so
    // any pending transfer with a shorter lifetime dies while the rotation matures.
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare, recipient } = f;

    await wallet.connect(o3).proposeNative(recipient.address, eth(1), HOUR);
    const shortLived = await wallet.proposalCount();

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const swapId = await wallet.proposalCount();
    await wallet.connect(o2).confirm(swapId);
    await wallet.connect(spare).acceptOwnerReplacement(swapId);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(swapId);

    await expect(wallet.connect(o1).confirm(shortLived))
      .to.be.revertedWithCustomError(wallet, "Expired").withArgs(shortLived);
  });

  it("is scheduled at propose time, with the delay recorded on chain", async () => {
    const f = await loadFixture(deployFixture);
    const tx = await f.wallet.connect(f.o1).proposeOwnerReplacement(f.o3.address, f.spare.address);
    const id = await f.wallet.proposalCount();
    const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);

    await expect(tx).to.emit(f.wallet, "Scheduled").withArgs(id, block.timestamp + DELAY, DELAY);
    expect(await f.wallet.effectiveAt(id)).to.equal(BigInt(block.timestamp + DELAY));
    // It lives for the delay plus the execution window, not for a caller-chosen ttl.
    expect((await f.wallet.getProposal(id)).expiresAt)
      .to.equal(BigInt(block.timestamp + DELAY + EXEC_WINDOW));
  });

  it(" ANY ONE owner can veto it during the timelock", async () => {
    // This is the whole defence against two compromised keys: they can approve a hostile
    // replacement, but the third owner kills it alone.
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    await f.wallet.connect(f.spare).acceptOwnerReplacement(id);

    await expect(f.wallet.connect(f.o3).veto(id))
      .to.emit(f.wallet, "Vetoed").withArgs(id, f.o3.address);

    await time.increase(DELAY + 1);
    await expect(f.wallet.connect(f.o1).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "ProposalCancelled").withArgs(id);
    expect(await f.wallet.owners()).to.deep.equal([f.o1.address, f.o2.address, f.o3.address]);
  });

  it("the veto still works AFTER the timelock matures, up until execution", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    await f.wallet.connect(f.spare).acceptOwnerReplacement(id);
    await time.increase(DELAY + 1);
    expect(await f.wallet.isExecutable(id)).to.equal(true);

    await f.wallet.connect(f.o3).veto(id);
    expect(await f.wallet.isExecutable(id)).to.equal(false);
  });

  it("a non-owner cannot veto, and a plain transfer cannot be vetoed at all", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    await expect(f.wallet.connect(f.outsider).veto(id))
      .to.be.revertedWithCustomError(f.wallet, "NotOwner").withArgs(f.outsider.address);

    // The veto deliberately does NOT reach value transfers — otherwise one owner could block
    // a decision the other two have made.
    await f.wallet.connect(f.o1).proposeNative(f.recipient.address, eth(1), HOUR);
    const t = await f.wallet.proposalCount();
    await expect(f.wallet.connect(f.o3).veto(t))
      .to.be.revertedWithCustomError(f.wallet, "NotTimelocked").withArgs(t);
  });

  it("only the named incoming address can accept — nobody can accept on its behalf", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    for (const who of [f.o1, f.o2, f.o3, f.outsider]) {
      await expect(f.wallet.connect(who).acceptOwnerReplacement(id))
        .to.be.revertedWithCustomError(f.wallet, "NotIncomingOwner").withArgs(id, who.address);
    }
    await expect(f.wallet.connect(f.spare).acceptOwnerReplacement(id)).to.not.be.reverted;
    await expect(f.wallet.connect(f.spare).acceptOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "AlreadyAccepted").withArgs(id);
  });

  it("the newcomer cannot accept on one approval", async () => {
    const f = await loadFixture(deployFixture);
    await f.wallet.connect(f.o1).proposeOwnerReplacement(f.o3.address, f.spare.address);
    const id = await f.wallet.proposalCount();
    await expect(f.wallet.connect(f.spare).acceptOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "NotEnoughConfirmations").withArgs(id, 1n, 2n);
  });

  it("a mistyped incoming address costs nothing: the proposal just expires", async () => {
    const f = await loadFixture(deployFixture);
    const typo = ethers.Wallet.createRandom().address; // nobody holds this key
    const id = await agreed(f, f.o3, { address: typo });

    await time.increase(DELAY + EXEC_WINDOW + 2);
    await expect(f.wallet.connect(f.o1).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(f.wallet, "Expired").withArgs(id);
    expect(await f.wallet.owners()).to.deep.equal([f.o1.address, f.o2.address, f.o3.address]);
  });

  it("keeps exactly three owners, with the flags consistent, through repeated rotation", async () => {
    const f = await loadFixture(deployFixture);
    const signers = await ethers.getSigners();
    let current = [f.o1, f.o2, f.o3];

    for (let round = 0; round < 3; round++) {
      const incoming = signers[7 + round];
      const outgoing = current[round];
      const proposer = current.find((s) => s.address !== outgoing.address);
      const seconder = current.find((s) => s.address !== outgoing.address && s.address !== proposer.address);

      await f.wallet.connect(proposer).proposeOwnerReplacement(outgoing.address, incoming.address);
      const id = await f.wallet.proposalCount();
      await f.wallet.connect(seconder).confirm(id);
      await f.wallet.connect(incoming).acceptOwnerReplacement(id);
      await time.increase(DELAY + 1);
      await f.wallet.connect(proposer).executeOwnerReplacement(id);

      current = current.map((s) => (s.address === outgoing.address ? incoming : s));

      const list = await f.wallet.owners();
      expect(list.length).to.equal(3);
      expect(new Set(list).size, "owners must stay distinct").to.equal(3);
      expect(list).to.deep.equal(current.map((s) => s.address));
      for (const a of list) expect(await f.wallet.isOwner(a)).to.equal(true);
      expect(await f.wallet.isOwner(outgoing.address)).to.equal(false);
    }
  });

  it("refuses to replace a non-owner, to duplicate an owner, or to seat the wallet itself", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, o3, outsider, spare } = f;
    await expect(wallet.connect(o1).proposeOwnerReplacement(outsider.address, spare.address))
      .to.be.revertedWithCustomError(wallet, "SubjectNotOwner").withArgs(outsider.address);
    await expect(wallet.connect(o1).proposeOwnerReplacement(o3.address, o2.address))
      .to.be.revertedWithCustomError(wallet, "DuplicateOwner").withArgs(o2.address);
    await expect(wallet.connect(o1).proposeOwnerReplacement(o3.address, o3.address))
      .to.be.revertedWithCustomError(wallet, "DuplicateOwner").withArgs(o3.address);
    await expect(wallet.connect(o1).proposeOwnerReplacement(o3.address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(o1).proposeOwnerReplacement(o3.address, addr))
      .to.be.revertedWithCustomError(wallet, "SelfRecipient");
  });

  it("a replaced owner loses every power immediately", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    await f.wallet.connect(f.spare).acceptOwnerReplacement(id);
    await time.increase(DELAY + 1);
    await f.wallet.connect(f.o1).executeOwnerReplacement(id);

    const gone = f.o3;
    await expect(f.wallet.connect(gone).proposeNative(f.recipient.address, eth(1), HOUR))
      .to.be.revertedWithCustomError(f.wallet, "NotOwner").withArgs(gone.address);
    await f.wallet.connect(f.o1).proposeNative(f.recipient.address, eth(1), HOUR);
    const n = await f.wallet.proposalCount();
    await expect(f.wallet.connect(gone).confirm(n))
      .to.be.revertedWithCustomError(f.wallet, "NotOwner").withArgs(gone.address);
    await expect(f.wallet.connect(gone).executeNative(n))
      .to.be.revertedWithCustomError(f.wallet, "NotOwner").withArgs(gone.address);
    await expect(f.wallet.connect(gone).veto(id))
      .to.be.revertedWithCustomError(f.wallet, "NotOwner").withArgs(gone.address);
  });

  it(" a replaced owner's PENDING approval stops counting the moment the seat changes", async () => {
    // The defect a counter-based multisig has and this one does not.
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare, recipient } = f;

    // 10 days, deliberately: the rotation below takes 72 h to mature, and a proposal with a
    // shorter ttl would expire in the meantime rather than demonstrating the stale-vote rule.
    await wallet.connect(o3).proposeNative(recipient.address, eth(10), 10 * DAY);
    const transferId = await wallet.proposalCount();
    expect(await wallet.confirmations(transferId)).to.equal(1n);

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const swapId = await wallet.proposalCount();
    await wallet.connect(o2).confirm(swapId);
    await wallet.connect(spare).acceptOwnerReplacement(swapId);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(swapId);

    // o3's stored vote is still in the mapping…
    expect(await wallet.hasConfirmed(transferId, o3.address)).to.equal(true);
    // …but it is no longer counted, because the count walks the CURRENT owners.
    expect(await wallet.confirmations(transferId)).to.equal(0n);
    expect(await wallet.isExecutable(transferId)).to.equal(false);

    await wallet.connect(o1).confirm(transferId);
    await expect(wallet.connect(o1).executeNative(transferId))
      .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations").withArgs(transferId, 1n, 2n);

    await wallet.connect(spare).confirm(transferId);
    await expect(wallet.connect(spare).executeNative(transferId)).to.emit(wallet, "NativeSent");
  });

  it(" two racing proposals cannot remove the same owner twice", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare } = f;
    const other = (await ethers.getSigners())[7];

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const idA = await wallet.proposalCount();
    await wallet.connect(o2).confirm(idA);
    await wallet.connect(spare).acceptOwnerReplacement(idA);

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, other.address);
    const idB = await wallet.proposalCount();
    await wallet.connect(o2).confirm(idB);
    await wallet.connect(other).acceptOwnerReplacement(idB);

    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(idA);
    expect(await wallet.owners()).to.deep.equal([o1.address, o2.address, spare.address]);

    await expect(wallet.connect(o1).executeOwnerReplacement(idB))
      .to.be.revertedWithCustomError(wallet, "SubjectNotOwner").withArgs(o3.address);
    expect(await wallet.owners()).to.deep.equal([o1.address, o2.address, spare.address]);
    expect(await wallet.isOwner(other.address)).to.equal(false);
  });

  it(" cannot seat an address that became an owner after the proposal was made", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare } = f;

    // Approved by o1 and o3 — the two who will still be seated later — so the stale proposal
    // keeps its two approvals and the DuplicateOwner guard is what is actually under test.
    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const idA = await wallet.proposalCount();
    await wallet.connect(o3).confirm(idA);
    await wallet.connect(spare).acceptOwnerReplacement(idA);

    await wallet.connect(o1).proposeOwnerReplacement(o2.address, spare.address);
    const idB = await wallet.proposalCount();
    await wallet.connect(o3).confirm(idB);
    await wallet.connect(spare).acceptOwnerReplacement(idB);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(idB);
    expect(await wallet.owners()).to.deep.equal([o1.address, spare.address, o3.address]);

    expect(await wallet.confirmations(idA)).to.equal(2n);
    await expect(wallet.connect(o1).executeOwnerReplacement(idA))
      .to.be.revertedWithCustomError(wallet, "DuplicateOwner").withArgs(spare.address);
    expect(new Set(await wallet.owners()).size).to.equal(3);
  });

  it(" a rotation also invalidates a pending OWNER_REPLACE approved by the owner it removed", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare } = f;
    const other = (await ethers.getSigners())[7];

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, other.address);
    const idA = await wallet.proposalCount();
    await wallet.connect(o2).confirm(idA);
    await wallet.connect(other).acceptOwnerReplacement(idA);
    expect(await wallet.confirmations(idA)).to.equal(2n);

    await wallet.connect(o1).proposeOwnerReplacement(o2.address, spare.address);
    const idB = await wallet.proposalCount();
    await wallet.connect(o3).confirm(idB);
    await wallet.connect(spare).acceptOwnerReplacement(idB);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(idB);

    // o2's vote on idA went with the seat: 2  1.
    expect(await wallet.confirmations(idA)).to.equal(1n);
    await expect(wallet.connect(o1).executeOwnerReplacement(idA))
      .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations").withArgs(idA, 1n, 2n);

    // The acceptance survives — it is consent, not a vote — so the current owners can carry it.
    await wallet.connect(spare).confirm(idA);
    await expect(wallet.connect(o1).executeOwnerReplacement(idA))
      .to.emit(wallet, "OwnerReplaced").withArgs(idA, o3.address, other.address);
    expect(await wallet.owners()).to.deep.equal([o1.address, spare.address, other.address]);
  });

  it("the wallet keeps working normally after a rotation", async () => {
    const f = await loadFixture(deployFixture);
    const id = await agreed(f, f.o3, f.spare);
    await f.wallet.connect(f.spare).acceptOwnerReplacement(id);
    await time.increase(DELAY + 1);
    await f.wallet.connect(f.o1).executeOwnerReplacement(id);

    const t = await f.usdc.getAddress();
    await f.wallet.connect(f.spare).proposeERC20(t, f.recipient.address, u6(77), HOUR);
    const n = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(n);
    await expect(f.wallet.connect(f.spare).executeERC20(n)).to.emit(f.wallet, "ERC20Sent");
    expect(await f.usdc.balanceOf(f.recipient.address)).to.equal(u6(77));
  });
});
