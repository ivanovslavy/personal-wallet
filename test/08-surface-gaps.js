const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { loadFixture, deployFixture, deployWallet, Std, HOUR, DAY, DELAY, EXEC_WINDOW, eth } = require("./helpers");

/**
 * The entry points the rest of the suite reaches only indirectly. The surface gate in
 * test/00-surface.js sees top-level JSON-RPC traffic, so a function that only ever runs as an
 * internal message call — the ERC-721/1155 receiver hooks — looks untested even when it is
 * exercised. Calling them directly both closes that blind spot and checks something worth
 * checking: that they return the exact magic values the standards require.
 */
describe("Receiver hooks — called directly, for their return values", () => {
  it("returns the ERC-721 magic value", async () => {
    const { wallet, outsider } = await loadFixture(deployFixture);
    const expected = ethers.id("onERC721Received(address,address,uint256,bytes)").slice(0, 10);
    expect(await wallet.onERC721Received.staticCall(outsider.address, outsider.address, 1, "0x"))
      .to.equal(expected);
    // And as a real transaction, so the gate records it as executed.
    await expect(wallet.connect(outsider).onERC721Received(outsider.address, outsider.address, 1, "0x"))
      .to.not.be.reverted;
  });

  it("returns both ERC-1155 magic values", async () => {
    const { wallet, outsider } = await loadFixture(deployFixture);
    const single = ethers.id("onERC1155Received(address,address,uint256,uint256,bytes)").slice(0, 10);
    const batch = ethers.id("onERC1155BatchReceived(address,address,uint256[],uint256[],bytes)").slice(0, 10);
    expect(await wallet.onERC1155Received.staticCall(outsider.address, outsider.address, 1, 1, "0x"))
      .to.equal(single);
    expect(await wallet.onERC1155BatchReceived.staticCall(outsider.address, outsider.address, [1], [1], "0x"))
      .to.equal(batch);
    await expect(wallet.connect(outsider).onERC1155Received(outsider.address, outsider.address, 1, 1, "0x"))
      .to.not.be.reverted;
    await expect(wallet.connect(outsider).onERC1155BatchReceived(outsider.address, outsider.address, [1], [1], "0x"))
      .to.not.be.reverted;
  });
});

describe("The constants are what the documentation claims", () => {
  it("every bound is readable on chain and matches the stated design", async () => {
    const { wallet } = await loadFixture(deployFixture);
    expect(await wallet.OWNER_COUNT()).to.equal(3n);
    expect(await wallet.THRESHOLD()).to.equal(2n);
    expect(await wallet.UNANIMOUS()).to.equal(3n);
    expect(await wallet.MIN_TTL()).to.equal(BigInt(10 * 60));
    expect(await wallet.MAX_TTL()).to.equal(BigInt(30 * DAY));
    expect(await wallet.MAX_BATCH()).to.equal(50n);
    expect(await wallet.MIN_DELAY()).to.equal(BigInt(24 * HOUR));
    expect(await wallet.MAX_DELAY()).to.equal(BigInt(30 * DAY));
    expect(await wallet.DEFAULT_DELAY()).to.equal(BigInt(72 * HOUR));
    expect(await wallet.EXECUTION_WINDOW()).to.equal(BigInt(EXEC_WINDOW));
    // UNANIMOUS must equal OWNER_COUNT, or "all three" would not mean all three.
    expect(await wallet.UNANIMOUS()).to.equal(await wallet.OWNER_COUNT());
  });
});

describe("The registry reads nobody else touches", () => {
  it("reports an empty recipient registry, then a populated one", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.wallet.registeredRecipientCount()).to.equal(0n);
    let [list, labels] = await f.wallet.allowedRecipients();
    expect(list).to.deep.equal([]);
    expect(labels).to.deep.equal([]);
    expect((await f.wallet.recipientEntry(f.recipient.address)).addedAt).to.equal(0n);

    await f.wallet.connect(f.o1).proposeAllowRecipient(f.recipient.address, "cold wallet");
    const id = await f.wallet.proposalCount();
    expect(await f.wallet.proposalLabel(id)).to.equal("cold wallet");
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o3).confirm(id);
    await time.increase(DELAY + 1);
    await f.wallet.connect(f.o1).executeAllowRecipient(id);

    expect(await f.wallet.registeredRecipientCount()).to.equal(1n);
    [list, labels] = await f.wallet.allowedRecipients();
    expect(list).to.deep.equal([f.recipient.address]);
    expect(labels).to.deep.equal(["cold wallet"]);
    const e = await f.wallet.recipientEntry(f.recipient.address);
    expect(e.label).to.equal("cold wallet");
    expect(e.allowed).to.equal(true);
    expect(e.addedAt).to.be.greaterThan(0n);
  });

  it("a proposal with no label reads back as an empty string", async () => {
    const f = await loadFixture(deployFixture);
    await f.wallet.connect(f.o1).proposeNative(f.recipient.address, eth(1), HOUR);
    expect(await f.wallet.proposalLabel(await f.wallet.proposalCount())).to.equal("");
  });
});

describe("ATTACK — the guard's own revert, propagated instead of swallowed", () => {
  it("the native path MASKS the inner error — the wallet reports its own failure instead", async () => {
    // Worth asserting, because it explains why the guard's error cannot be observed here: the
    // low-level `call{value:}` only returns false, so the recipient's revert data is lost and the
    // wallet raises NativeTransferFailed. The protection is identical; only the message differs.
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, o3 } = f;
    const atk = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
    const atkAddr = await atk.getAddress();
    await atk.setWallet(addr);

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, atkAddr);
    const swap = await wallet.proposalCount();
    await wallet.connect(o2).confirm(swap);
    await atk.callAccept(swap);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(swap);

    await wallet.connect(o1).proposeNative(atkAddr, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await atk.armStrict(id);

    await expect(wallet.connect(o1).executeNative(id))
      .to.be.revertedWithCustomError(wallet, "NativeTransferFailed").withArgs(atkAddr, eth(1));
    expect(await wallet.nativeBalance()).to.equal(eth(100));
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });

  it(" ReentrancyGuardReentrantCall reaches the caller through the ERC-20 path", async () => {
    // Elsewhere the attacker wraps its re-entry in try/catch so the test can inspect both sides.
    // Here it does not, so OpenZeppelin's guard error propagates out of the whole transaction —
    // which is what a real attacker would actually experience.
    // Two things have to be true for the guard's own error to be visible:
    //  · SafeERC20 bubbles the revert data up unchanged (the native path's low-level call does not);
    //  · the re-entrant caller must pass `onlyOwners`, which is the OUTER modifier — so the token
    //  itself has to hold a seat. Contrived on purpose: it shows the guard is defence-in-depth
    //  behind onlyOwners, never the first line.
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, o3, recipient } = f;

    const bad = await (await ethers.getContractFactory("ReenteringERC20")).deploy();
    const t = await bad.getAddress();
    await bad.mint(addr, eth(100));
    await bad.setWallet(addr);

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, t);
    const swap = await wallet.proposalCount();
    await wallet.connect(o2).confirm(swap);
    await bad.callAccept(swap);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(swap);
    expect(await wallet.isOwner(t)).to.equal(true);

    await wallet.connect(o1).proposeERC20(t, recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await bad.armStrict(addr, id);

    await expect(wallet.connect(o1).executeERC20(id))
      .to.be.revertedWithCustomError(wallet, "ReentrancyGuardReentrantCall");

    // The whole transaction died, so nothing moved at all.
    expect(await bad.balanceOf(addr)).to.equal(eth(100));
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });
});

/**
 * NothingMoved — the error added 2026-10-20 after invariant fuzzing found the exit was not
 * symmetric with the entrance. depositERC20 always measured what arrived; the execute paths took
 * the asset contract at its word and emitted the INTENDED amount. A contract that reports success
 * without transferring therefore consumed the proposal and emitted a Sent event for value that
 * never left — and every off-chain consumer of those events was told a lie.
 *
 * All four exits now measure. These tests make the refusal observable, which is also what keeps the
 * surface gate honest: an error nobody ever triggers is an error nobody has tested.
 */
describe("NothingMoved — an exit that did not actually move the asset", () => {
  it("refuses an ERC-20 transfer that the token silently swallowed", async () => {
    const [, o1, o2, o3, dest] = await ethers.getSigners();
    const Hole = await ethers.getContractFactory("BlackHoleERC20");
    const hole = await Hole.deploy();
    await hole.waitForDeployment();
    const token = await hole.getAddress();

    const wallet = await deployWallet([o1.address, o2.address, o3.address], {
      requireRecipient: true,
      requireToken: true,
      recipients: [[dest.address, "dest"]],
      tokens: [[token, "HOLE"]],
    });

    // The wallet holds none of it — a conforming token would revert; this one returns true.
    await wallet.connect(o1).proposeERC20(token, dest.address, 33485n, 20 * DAY);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await expect(wallet.connect(o1).executeERC20(id))
      .to.be.revertedWithCustomError(wallet, "NothingMoved")
      .withArgs(token);

    // The proposal survives for a later, honest attempt instead of being consumed by a lie.
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });

  it("the native path refuses what it cannot pay, which is why the gap was token-specific", async () => {
    const [, o1, o2, o3, dest] = await ethers.getSigners();
    const wallet = await deployWallet([o1.address, o2.address, o3.address], {
      requireRecipient: true,
      recipients: [[dest.address, "dest"]],
    });
    await wallet.connect(o1).proposeNative(dest.address, eth("5"), 20 * DAY);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await expect(wallet.connect(o1).executeNative(id))
      .to.be.revertedWithCustomError(wallet, "InsufficientBalance");
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });
});
