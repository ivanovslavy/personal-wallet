const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { loadFixture, deployFixture, Std, HOUR, DAY, DELAY, EXEC_WINDOW, eth, u6 } = require("./helpers");

/**
 * Adversarial suite. Each block names the defence it is attacking, so a pass is evidence about
 * that defence rather than a general absence of explosions.
 */

/**
 * Hand a contract one of the three seats, the way a real rotation would — including waiting out
 * the 72 h timelock, since a seat change is a power-expanding operation.
 */
async function seatContract(f, contractAddr, outgoing, acceptCall) {
  const { wallet, o1, o2, o3 } = f;
  const proposer = outgoing.address === o1.address ? o2 : o1;
  const seconder = [o1, o2, o3].find((s) => s.address !== outgoing.address && s.address !== proposer.address);
  await wallet.connect(proposer).proposeOwnerReplacement(outgoing.address, contractAddr);
  const id = await wallet.proposalCount();
  await wallet.connect(seconder).confirm(id);
  await acceptCall(id);
  await time.increase(DELAY + 1);
  await wallet.connect(proposer).executeOwnerReplacement(id);
  return { proposer, seconder };
}

describe("ATTACK — re-entrancy", () => {
  it("a malicious OWNER cannot drain twice on one approval (native)", async () => {
    // The hardest realistic case: the attacker is not merely the recipient, it holds a seat, so
    // `onlyOwners` does not stop it. What stops it is nonReentrant plus setting `executed`
    // before the external call.
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, o3 } = f;

    const atk = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
    const atkAddr = await atk.getAddress();
    await atk.setWallet(addr);
    await seatContract(f, atkAddr, o3, (id) => atk.callAccept(id));

    // Two owners approve sending 10 to the attacker contract.
    await wallet.connect(o1).proposeNative(atkAddr, eth(10), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await atk.arm(id);
    const before = await wallet.nativeBalance();
    await wallet.connect(o1).executeNative(id);

    expect(await atk.reentryAttempts(), "the attacker did try").to.be.greaterThan(0n);
    expect(await atk.lastReentryReverted(), "the re-entry must have been refused").to.equal(true);
    // Exactly 10 left the wallet. Not 20.
    expect(before - (await wallet.nativeBalance())).to.equal(eth(10));
    expect(await ethers.provider.getBalance(atkAddr)).to.equal(eth(10));
  });

  it("a malicious owner cannot re-enter an NFT batch through onERC721Received", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, o3, nft, multi } = f;

    const atk = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
    const atkAddr = await atk.getAddress();
    await atk.setWallet(addr);
    await seatContract(f, atkAddr, o3, (id) => atk.callAccept(id));

    const items = [
      { token: await nft.getAddress(), standard: Std.ERC721, id: 1, amount: 0 },
      { token: await nft.getAddress(), standard: Std.ERC721, id: 2, amount: 0 },
      { token: await multi.getAddress(), standard: Std.ERC1155, id: 1, amount: 5 },
    ];
    await wallet.connect(o1).proposeNFTBatch(atkAddr, items, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await atk.arm(id);
    await wallet.connect(o1).executeNFTBatch(id);

    expect(await atk.reentryAttempts()).to.be.greaterThan(0n);
    expect(await atk.lastReentryReverted()).to.equal(true);
    // Delivered exactly once each.
    expect(await nft.ownerOf(1)).to.equal(atkAddr);
    expect(await nft.ownerOf(2)).to.equal(atkAddr);
    expect(await multi.balanceOf(atkAddr, 1)).to.equal(5n);
    expect(await wallet.erc1155Balance(await multi.getAddress(), 1)).to.equal(95n);
  });

  it("a token with a transfer hook cannot re-enter the ERC-20 path", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, recipient } = f;
    const bad = await (await ethers.getContractFactory("ReenteringERC20")).deploy();
    await bad.mint(addr, eth(100));

    await wallet.connect(o1).proposeERC20(await bad.getAddress(), recipient.address, eth(10), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await bad.arm(addr, id);

    await wallet.connect(o1).executeERC20(id);
    expect(await bad.reentryAttempts()).to.be.greaterThan(0n);
    expect(await bad.lastReentryReverted()).to.equal(true);
    expect(await bad.balanceOf(recipient.address)).to.equal(eth(10)); // once, not twice
    expect(await bad.balanceOf(addr)).to.equal(eth(90));
  });
});

describe("ATTACK — silent transfer failure", () => {
  it("a token whose transfer returns FALSE cannot produce a success event", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, recipient } = f;
    const lie = await (await ethers.getContractFactory("LyingERC20")).deploy();
    await lie.mint(addr, eth(100));

    await wallet.connect(o1).proposeERC20(await lie.getAddress(), recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    // SafeERC20 turns the lie into a revert. A naive `token.transfer(...)` without checking the
    // return value would have emitted ERC20Sent for a transfer that never happened.
    await expect(wallet.connect(o1).executeERC20(id)).to.be.reverted;
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });
});

describe("ATTACK — hostile recipients", () => {
  it("a recipient that refuses native currency fails the send and keeps the approval alive", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2 } = f;
    const rej = await (await ethers.getContractFactory("RejectingReceiver")).deploy();
    const rejAddr = await rej.getAddress();

    await wallet.connect(o1).proposeNative(rejAddr, eth(3), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await expect(wallet.connect(o1).executeNative(id))
      .to.be.revertedWithCustomError(wallet, "NativeTransferFailed").withArgs(rejAddr, eth(3));
    expect(await wallet.nativeBalance()).to.equal(eth(100)); // nothing left
    expect((await wallet.getProposal(id)).executed).to.equal(false);

    await rej.setAccepting(true);
    await wallet.connect(o1).executeNative(id);
    expect(await ethers.provider.getBalance(rejAddr)).to.equal(eth(3));
  });

  it("a recipient that burns all the gas fails the transaction instead of faking success", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2 } = f;
    const grief = await (await ethers.getContractFactory("GasGriefingReceiver")).deploy();

    await wallet.connect(o1).proposeNative(await grief.getAddress(), eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    // The whole transaction must die. The dangerous alternative — a capped-gas send that fails
    // quietly and is reported as done — is what this wallet deliberately does not do.
    await expect(wallet.connect(o1).executeNative(id, { gasLimit: 1_000_000 })).to.be.reverted;
    expect(await wallet.nativeBalance()).to.equal(eth(100));
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });

  it("an NFT cannot be sent to a contract that would strand it", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, nft, multi } = f;
    const bad = await (await ethers.getContractFactory("BadERC721Receiver")).deploy();
    const badAddr = await bad.getAddress();

    await wallet.connect(o1).proposeERC721(await nft.getAddress(), badAddr, 1, HOUR);
    const id1 = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id1);
    await expect(wallet.connect(o1).executeERC721(id1)).to.be.reverted;
    expect(await nft.ownerOf(1)).to.equal(addr);

    await wallet.connect(o1).proposeERC1155(await multi.getAddress(), badAddr, 1, 1, HOUR);
    const id2 = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id2);
    await expect(wallet.connect(o1).executeERC1155(id2)).to.be.reverted;
    expect(await wallet.erc1155Balance(await multi.getAddress(), 1)).to.equal(100n);
  });
});

describe("ATTACK — an outsider contract probing every entry point", () => {
  it("is refused everywhere, including on proposals that already have two approvals", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, o3, recipient, spare } = f;
    const prober = await (await ethers.getContractFactory("OutsiderProber")).deploy();

    await expect(prober.tryPropose(addr, recipient.address)).to.be.revertedWithCustomError(wallet, "NotOwner");
    await expect(prober.tryReplaceOwner(addr, o3.address, spare.address)).to.be.revertedWithCustomError(wallet, "NotOwner");

    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    expect(await wallet.isExecutable(id)).to.equal(true);

    await expect(prober.tryConfirm(addr, id)).to.be.revertedWithCustomError(wallet, "NotOwner");
    await expect(prober.tryExecuteNative(addr, id)).to.be.revertedWithCustomError(wallet, "NotOwner");
    await expect(prober.tryExecuteOwnerReplacement(addr, id)).to.be.revertedWithCustomError(wallet, "NotOwner");
  });
});

describe("ATTACK — forced ether and unexpected state", () => {
  it("ether forced in with SELFDESTRUCT is still spendable, because no balance is cached", async () => {
    // Not a vulnerability — but it IS the reason the wallet must read address(this).balance
    // instead of tracking a `totalDeposited` variable, which forced sends would desynchronise.
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, recipient } = f;
    const pusher = await (await ethers.getContractFactory("SelfDestructPusher")).deploy();

    await pusher.push(addr, { value: eth(7) }); // arrives with no event at all
    expect(await wallet.nativeBalance()).to.equal(eth(107));

    await wallet.connect(o1).proposeNative(recipient.address, eth(107), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await wallet.connect(o1).executeNative(id);
    expect(await wallet.nativeBalance()).to.equal(0n);
  });

  it("a payable call with calldata cannot reach any logic — the fallback only accepts money", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, outsider, recipient } = f;

    // Hand-rolled calldata for a selector the wallet does not have, plus value.
    const data = ethers.id("renounceOwnership()").slice(0, 10);
    await expect(outsider.sendTransaction({ to: addr, value: eth(1), data }))
      .to.emit(wallet, "Deposited").withArgs(outsider.address, eth(1), true);

    // Nothing changed except the balance: the owner set is intact and no proposal appeared.
    expect(await wallet.proposalCount()).to.equal(0n);
    expect((await wallet.owners()).length).to.equal(3);
  });
});

describe("ATTACK — griefing the approval process", () => {
  it("one owner alone cannot block a decision the other two have made", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, recipient } = f;

    // o3 is hostile: it proposes rubbish and spams, but o1+o2 proceed regardless.
    for (let i = 0; i < 5; i++) await wallet.connect(o3).proposeNative(o3.address, eth(1), HOUR);

    await wallet.connect(o1).proposeNative(recipient.address, eth(4), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    // o3 can revoke only its own approval, which it never gave here.
    await expect(wallet.connect(o3).revokeConfirmation(id))
      .to.be.revertedWithCustomError(wallet, "NotConfirmed").withArgs(id, o3.address);
    // And it cannot cancel someone else's proposal.
    await expect(wallet.connect(o3).cancel(id)).to.be.revertedWithCustomError(wallet, "NotProposer");

    await expect(wallet.connect(o1).executeNative(id)).to.emit(wallet, "NativeSent");
    // o3's five proposals are still stuck at one approval each.
    for (let i = 1; i <= 5; i++) expect(await wallet.isExecutable(i)).to.equal(false);
  });

  it("one owner alone cannot move anything, on any path, ever", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, recipient, usdt, nft, multi } = f;
    const calls = [
      () => wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR),
      () => wallet.connect(o1).proposeERC20(usdt.getAddress(), recipient.address, u6(1), HOUR),
      () => wallet.connect(o1).proposeERC721(nft.getAddress(), recipient.address, 1, HOUR),
      () => wallet.connect(o1).proposeERC1155(multi.getAddress(), recipient.address, 1, 1, HOUR),
    ];
    const execs = ["executeNative", "executeERC20", "executeERC721", "executeERC1155"];
    for (let i = 0; i < calls.length; i++) {
      await calls[i]();
      const id = await wallet.proposalCount();
      await expect(wallet.connect(o1)[execs[i]](id))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations").withArgs(id, 1n, 2n);
    }
    // Nothing moved at all.
    expect(await wallet.nativeBalance()).to.equal(eth(100));
    expect(await wallet.erc20Balance(await usdt.getAddress())).to.equal(u6(1000));
    expect(await nft.ownerOf(1)).to.equal(await wallet.getAddress());
  });
});

describe("ATTACK — re-entrancy on the single-asset NFT paths", () => {
  // The batch path is not the only one with a callback: safeTransferFrom calls the recipient on
  // the single ERC-721 and ERC-1155 paths too. Each needs its own proof.
  const setup = async (f) => {
    const atk = await (await ethers.getContractFactory("ReentrancyAttacker")).deploy();
    const atkAddr = await atk.getAddress();
    await atk.setWallet(f.addr);
    await seatContract(f, atkAddr, f.o3, (id) => atk.callAccept(id));
    return { atk, atkAddr };
  };

  it("executeERC721 cannot be re-entered from onERC721Received", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, nft } = f;
    const { atk, atkAddr } = await setup(f);

    await wallet.connect(o1).proposeERC721(await nft.getAddress(), atkAddr, 4, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await atk.armWithMode(id, 1); // SINGLE_721
    await wallet.connect(o1).executeERC721(id);

    expect(await atk.reentryAttempts()).to.equal(1n);
    expect(await atk.lastReentryReverted()).to.equal(true);
    expect(await nft.ownerOf(4)).to.equal(atkAddr);
  });

  it("executeERC1155 cannot be re-entered from onERC1155Received", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, multi } = f;
    const { atk, atkAddr } = await setup(f);
    const m = await multi.getAddress();

    await wallet.connect(o1).proposeERC1155(m, atkAddr, 2, 20, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await atk.armWithMode(id, 2); // SINGLE_1155
    await wallet.connect(o1).executeERC1155(id);

    expect(await atk.reentryAttempts()).to.equal(1n);
    expect(await atk.lastReentryReverted()).to.equal(true);
    expect(await multi.balanceOf(atkAddr, 2)).to.equal(20n); // 20, not 40
    expect(await wallet.erc1155Balance(m, 2)).to.equal(30n);
  });

  it("executeOwnerReplacement cannot be re-entered either", async () => {
    // The seat change has no external call of its own, so this is a guard-presence check:
    // the governance path carries the same nonReentrant protection as the value paths.
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare } = f;
    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await wallet.connect(spare).acceptOwnerReplacement(id);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(id);
    // A second entry is refused as already executed, whichever owner tries it.
    await expect(wallet.connect(spare).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(wallet, "AlreadyExecuted").withArgs(id);
  });
});

describe("ATTACK — non-owners on the vote-management functions", () => {
  it("cannot revoke or cancel anything", async () => {
    const { wallet, o1, outsider, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await expect(wallet.connect(outsider).revokeConfirmation(id))
      .to.be.revertedWithCustomError(wallet, "NotOwner").withArgs(outsider.address);
    await expect(wallet.connect(outsider).cancel(id))
      .to.be.revertedWithCustomError(wallet, "NotOwner").withArgs(outsider.address);
  });
});

describe("PersonalWallet — isExecutable tells the truth in every state", () => {
  it("false once executed, false once cancelled, false once expired", async () => {
    const { wallet, o1, o2, recipient } = await loadFixture(deployFixture);

    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const done = await wallet.proposalCount();
    await wallet.connect(o2).confirm(done);
    await wallet.connect(o1).executeNative(done);
    expect(await wallet.isExecutable(done)).to.equal(false);

    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const killed = await wallet.proposalCount();
    await wallet.connect(o1).cancel(killed);
    expect(await wallet.isExecutable(killed)).to.equal(false);

    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const stale = await wallet.proposalCount();
    await wallet.connect(o2).confirm(stale);
    expect(await wallet.isExecutable(stale)).to.equal(true);
    await time.increase(HOUR + 1);
    expect(await wallet.isExecutable(stale)).to.equal(false);
  });
});

describe("PersonalWallet — acceptOwnerReplacement in dead states", () => {
  it("refuses an already executed replacement and an expired one", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, o1, o2, o3, spare } = f;
    const other = (await ethers.getSigners())[7];

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await wallet.connect(spare).acceptOwnerReplacement(id);
    await time.increase(DELAY + 1);
    await wallet.connect(o1).executeOwnerReplacement(id);
    await expect(wallet.connect(spare).acceptOwnerReplacement(id))
      .to.be.revertedWithCustomError(wallet, "AlreadyExecuted").withArgs(id);

    await wallet.connect(o1).proposeOwnerReplacement(spare.address, other.address);
    const id2 = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id2);
    await time.increase(DELAY + EXEC_WINDOW + 2);
    await expect(wallet.connect(other).acceptOwnerReplacement(id2))
      .to.be.revertedWithCustomError(wallet, "Expired").withArgs(id2);
  });
});
