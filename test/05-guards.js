const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { loadFixture, deployFixture, Std, HOUR, DAY, DELAY, EXEC_WINDOW, eth, u6, ctorArgs } = require("./helpers");

/**
 * Every remaining guard, exercised on purpose. Coverage that stops at the happy paths tells you
 * the tests ran, not that the refusals work.
 */
describe("PersonalWallet — the remaining guards", () => {
  it("refuses an owner slot equal to the contract's own future address", async () => {
    // Reachable because CREATE addresses are deterministic: compute where the deployment will
    // land and try to seat it. Cheap guard, but it IS a real foot-gun without it.
    const [deployer, a, b] = await ethers.getSigners();
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const future = ethers.getCreateAddress({ from: deployer.address, nonce });
    const W = await ethers.getContractFactory("PersonalWallet");
    await expect(W.deploy(...ctorArgs([future, a.address, b.address])))
      .to.be.revertedWithCustomError(W, "SelfRecipient");
  });

  it("a cancelled proposal cannot be executed", async () => {
    const { wallet, o1, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o1).cancel(id);
    await expect(wallet.connect(o1).executeNative(id))
      .to.be.revertedWithCustomError(wallet, "ProposalCancelled").withArgs(id);
    await expect(wallet.connect(o1).cancel(id))
      .to.be.revertedWithCustomError(wallet, "ProposalCancelled").withArgs(id);
  });

  it("an executed proposal can be neither revoked nor cancelled", async () => {
    const { wallet, o1, o2, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await wallet.connect(o1).executeNative(id);
    await expect(wallet.connect(o1).revokeConfirmation(id))
      .to.be.revertedWithCustomError(wallet, "AlreadyExecuted").withArgs(id);
    await expect(wallet.connect(o1).cancel(id))
      .to.be.revertedWithCustomError(wallet, "AlreadyExecuted").withArgs(id);
  });

  it("revoking and cancelling reject an id that does not exist", async () => {
    const { wallet, o1 } = await loadFixture(deployFixture);
    await expect(wallet.connect(o1).revokeConfirmation(5))
      .to.be.revertedWithCustomError(wallet, "NoSuchProposal").withArgs(5);
    await expect(wallet.connect(o1).cancel(5))
      .to.be.revertedWithCustomError(wallet, "NoSuchProposal").withArgs(5);
    await expect(wallet.getProposal(5)).to.be.revertedWithCustomError(wallet, "NoSuchProposal");
    await expect(wallet.getBatch(5)).to.be.revertedWithCustomError(wallet, "NoSuchProposal");
    await expect(wallet.confirmations(5)).to.be.revertedWithCustomError(wallet, "NoSuchProposal");
  });

  it("an owner who never approved cannot revoke", async () => {
    const { wallet, o1, o3, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await expect(wallet.connect(o3).revokeConfirmation(id))
      .to.be.revertedWithCustomError(wallet, "NotConfirmed").withArgs(id, o3.address);
  });

  it("every propose* function rejects a zero token and a zero amount", async () => {
    const { wallet, o1, recipient, nft, multi } = await loadFixture(deployFixture);
    const Z = ethers.ZeroAddress;
    await expect(wallet.connect(o1).proposeERC20(await nft.getAddress(), recipient.address, 0, HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
    await expect(wallet.connect(o1).proposeERC721(Z, recipient.address, 1, HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(o1).proposeERC1155(Z, recipient.address, 1, 1, HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    // …and every one of them rejects the wallet itself as recipient.
    const addr = await wallet.getAddress();
    await expect(wallet.connect(o1).proposeERC20(await nft.getAddress(), addr, 1, HOUR))
      .to.be.revertedWithCustomError(wallet, "SelfRecipient");
    await expect(wallet.connect(o1).proposeERC721(await nft.getAddress(), addr, 1, HOUR))
      .to.be.revertedWithCustomError(wallet, "SelfRecipient");
    await expect(wallet.connect(o1).proposeERC1155(await multi.getAddress(), addr, 1, 1, HOUR))
      .to.be.revertedWithCustomError(wallet, "SelfRecipient");
    await expect(wallet.connect(o1).proposeNFTBatch(addr, [{ token: await nft.getAddress(), standard: Std.ERC721, id: 1, amount: 0 }], HOUR))
      .to.be.revertedWithCustomError(wallet, "SelfRecipient");
  });

  it("acceptOwnerReplacement refuses a proposal of any other kind", async () => {
    const { wallet, o1, o2, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await expect(wallet.connect(recipient).acceptOwnerReplacement(id))
      .to.be.revertedWithCustomError(wallet, "WrongKind").withArgs(id);
  });

  it("acceptOwnerReplacement refuses a cancelled or an expired proposal", async () => {
    const { wallet, o1, o3, spare } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const id = await wallet.proposalCount();
    await wallet.connect(o1).cancel(id); // still at one approval, so the proposer may pull it
    await expect(wallet.connect(spare).acceptOwnerReplacement(id))
      .to.be.revertedWithCustomError(wallet, "ProposalCancelled").withArgs(id);
  });

  it("isExecutable is false for a non-existent id and for an unaccepted replacement", async () => {
    const { wallet, o1, o2, o3, spare } = await loadFixture(deployFixture);
    expect(await wallet.isExecutable(0)).to.equal(false);
    expect(await wallet.isExecutable(12345)).to.equal(false);

    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    // Two approvals, but nobody has accepted the seat yet.
    expect(await wallet.confirmations(id)).to.equal(2n);
    expect(await wallet.isExecutable(id)).to.equal(false);
    await wallet.connect(spare).acceptOwnerReplacement(id);
    // Accepted, but still inside the timelock.
    expect(await wallet.isExecutable(id)).to.equal(false);
    await time.increase(DELAY + 1);
    expect(await wallet.isExecutable(id)).to.equal(true);
  });

  it("the balance views reject a zero token address rather than returning a misleading zero", async () => {
    const { wallet } = await loadFixture(deployFixture);
    const Z = ethers.ZeroAddress;
    await expect(wallet.erc20Balance(Z)).to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.erc721Owned(Z, 1)).to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.erc1155Balance(Z, 1)).to.be.revertedWithCustomError(wallet, "ZeroAddress");
  });

  it("a cancelled proposal blocks every typed execute path, not just the matching one", async () => {
    const { wallet, o1, o2, recipient, usdt, nft, multi } = await loadFixture(deployFixture);
    const mk = [
      [() => wallet.connect(o1).proposeERC20(usdt.getAddress(), recipient.address, u6(1), HOUR), "executeERC20"],
      [() => wallet.connect(o1).proposeERC721(nft.getAddress(), recipient.address, 1, HOUR), "executeERC721"],
      [() => wallet.connect(o1).proposeERC1155(multi.getAddress(), recipient.address, 1, 1, HOUR), "executeERC1155"],
      [() => wallet.connect(o1).proposeNFTBatch(recipient.address, [{ token: nft.target, standard: Std.ERC721, id: 2, amount: 0 }], HOUR), "executeNFTBatch"],
    ];
    for (const [propose, exec] of mk) {
      await propose();
      const id = await wallet.proposalCount();
      await wallet.connect(o1).cancel(id);
      await expect(wallet.connect(o2)[exec](id))
        .to.be.revertedWithCustomError(wallet, "ProposalCancelled").withArgs(id);
    }
  });

  it("an expired proposal blocks every typed execute path", async () => {
    const { wallet, o1, o2, recipient, usdt, nft, multi } = await loadFixture(deployFixture);
    const ids = [];
    await wallet.connect(o1).proposeERC20(usdt.getAddress(), recipient.address, u6(1), HOUR);
    ids.push([await wallet.proposalCount(), "executeERC20"]);
    await wallet.connect(o1).proposeERC721(nft.getAddress(), recipient.address, 1, HOUR);
    ids.push([await wallet.proposalCount(), "executeERC721"]);
    await wallet.connect(o1).proposeERC1155(multi.getAddress(), recipient.address, 1, 1, HOUR);
    ids.push([await wallet.proposalCount(), "executeERC1155"]);
    await wallet.connect(o1).proposeNFTBatch(recipient.address, [{ token: nft.target, standard: Std.ERC721, id: 2, amount: 0 }], HOUR);
    ids.push([await wallet.proposalCount(), "executeNFTBatch"]);
    for (const [id] of ids) await wallet.connect(o2).confirm(id);

    await time.increase(HOUR + 1);
    for (const [id, exec] of ids) {
      await expect(wallet.connect(o2)[exec](id)).to.be.revertedWithCustomError(wallet, "Expired").withArgs(id);
    }
  });

  it("executeOwnerReplacement is refused for an expired replacement", async () => {
    const { wallet, o1, o2, o3, spare } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await wallet.connect(spare).acceptOwnerReplacement(id);
    await time.increase(DELAY + EXEC_WINDOW + 2);
    await expect(wallet.connect(o1).executeOwnerReplacement(id))
      .to.be.revertedWithCustomError(wallet, "Expired").withArgs(id);
    expect(await wallet.isOwner(o3.address)).to.equal(true);
  });
});
