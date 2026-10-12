const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, deployFixture, Std, HOUR, eth, u6 } = require("./helpers");

describe("PersonalWallet — native currency", () => {
  it("sends the exact amount to the exact recipient and logs both events", async () => {
    const { wallet, o1, o2, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(5), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    // The recipient is not the sender, so its delta is the transfer with no gas noise in it.
    const before = await ethers.provider.getBalance(recipient.address);
    await expect(wallet.connect(o2).executeNative(id))
      .to.emit(wallet, "NativeSent").withArgs(id, recipient.address, eth(5))
      .and.to.emit(wallet, "Executed").withArgs(id, 0, o2.address);
    expect(await ethers.provider.getBalance(recipient.address) - before).to.equal(eth(5));
    expect(await wallet.nativeBalance()).to.equal(eth(95));
  });

  it("refuses to send more than it holds, and says what it holds", async () => {
    const { wallet, o1, o2, recipient } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeNative(recipient.address, eth(1000), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await expect(wallet.connect(o1).executeNative(id))
      .to.be.revertedWithCustomError(wallet, "InsufficientBalance").withArgs(eth(100), eth(1000));
  });

  it("can be emptied to the last wei", async () => {
    const { wallet, o1, o2, recipient } = await loadFixture(deployFixture);
    const all = await wallet.nativeBalance();
    await wallet.connect(o1).proposeNative(recipient.address, all, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await wallet.connect(o1).executeNative(id);
    expect(await wallet.nativeBalance()).to.equal(0n);
  });
});

describe("PersonalWallet — ERC-20, against tokens that behave like the real ones", () => {
  const send = async (f, token, amount) => {
    const t = await token.getAddress();
    await f.wallet.connect(f.o1).proposeERC20(t, f.recipient.address, amount, HOUR);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    return { id, t };
  };

  it("USDT — moves a token whose transfer returns NOTHING (the SafeERC20 case)", async () => {
    const f = await loadFixture(deployFixture);
    // A wallet doing `require(token.transfer(...))` would revert here and strand the balance.
    const { id, t } = await send(f, f.usdt, u6(250));
    await expect(f.wallet.connect(f.o1).executeERC20(id))
      .to.emit(f.wallet, "ERC20Sent").withArgs(id, t, f.recipient.address, u6(250));
    expect(await f.usdt.balanceOf(f.recipient.address)).to.equal(u6(250));
    expect(await f.wallet.erc20Balance(t)).to.equal(u6(750));
  });

  it("USDT — survives the fee-on-transfer mode: the wallet is debited in full, the recipient nets less", async () => {
    const f = await loadFixture(deployFixture);
    await f.usdt.setParams(10, u6(5)); // 10 bp, capped at 5 USDT — Tether's own knobs
    const { id, t } = await send(f, f.usdt, u6(1000));
    await f.wallet.connect(f.o1).executeERC20(id);
    // 10 bp of 1000 = 1 USDT fee. The event records what was SENT, which is the honest number.
    expect(await f.usdt.balanceOf(f.recipient.address)).to.equal(u6(999));
    expect(await f.wallet.erc20Balance(t)).to.equal(0n);
  });

  it("USDC — a blocklisted recipient reverts the transfer and does NOT burn the proposal", async () => {
    const f = await loadFixture(deployFixture);
    await f.usdc.setBlocked(f.recipient.address, true);
    const { id } = await send(f, f.usdc, u6(100));

    await expect(f.wallet.connect(f.o1).executeERC20(id))
      .to.be.revertedWithCustomError(f.usdc, "Blocked").withArgs(f.recipient.address);

    // The whole transaction reverted, so `executed` was rolled back with it. This matters:
    // a failed send must not consume the two owners' approval.
    expect((await f.wallet.getProposal(id)).executed).to.equal(false);
    expect(await f.wallet.isExecutable(id)).to.equal(true);

    await f.usdc.setBlocked(f.recipient.address, false);
    await expect(f.wallet.connect(f.o1).executeERC20(id)).to.emit(f.wallet, "ERC20Sent");
    expect(await f.usdc.balanceOf(f.recipient.address)).to.equal(u6(100));
  });

  it("EURC — a paused token blocks the send, and the same approval still works once unpaused", async () => {
    const f = await loadFixture(deployFixture);
    await f.eurc.setPaused(true);
    const { id } = await send(f, f.eurc, u6(400));
    await expect(f.wallet.connect(f.o1).executeERC20(id))
      .to.be.revertedWithCustomError(f.eurc, "TokenPaused");
    expect((await f.wallet.getProposal(id)).executed).to.equal(false);

    await f.eurc.setPaused(false);
    await f.wallet.connect(f.o1).executeERC20(id);
    expect(await f.eurc.balanceOf(f.recipient.address)).to.equal(u6(400));
  });

  it("refuses to send more of a token than it holds", async () => {
    const f = await loadFixture(deployFixture);
    const { id } = await send(f, f.usdc, u6(5000));
    await expect(f.wallet.connect(f.o1).executeERC20(id)).to.be.reverted;
  });
});

describe("PersonalWallet — ERC-721, one at a time", () => {
  it("transfers a token it owns and logs it", async () => {
    const { wallet, o1, o2, recipient, nft } = await loadFixture(deployFixture);
    const t = await nft.getAddress();
    await wallet.connect(o1).proposeERC721(t, recipient.address, 3, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await expect(wallet.connect(o1).executeERC721(id))
      .to.emit(wallet, "ERC721Sent").withArgs(id, t, recipient.address, 3);
    expect(await nft.ownerOf(3)).to.equal(recipient.address);
    expect(await wallet.erc721Owned(t, 3)).to.equal(false);
  });

  it("cannot transfer a token it does not own", async () => {
    const { wallet, o1, o2, recipient, nft } = await loadFixture(deployFixture);
    const t = await nft.getAddress();
    await wallet.connect(o1).proposeERC721(t, recipient.address, 777, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await expect(wallet.connect(o1).executeERC721(id)).to.be.reverted;
  });
});

describe("PersonalWallet — ERC-1155, one id at a time", () => {
  it("transfers part of a balance and leaves the rest", async () => {
    const { wallet, o1, o2, recipient, multi } = await loadFixture(deployFixture);
    const t = await multi.getAddress();
    await wallet.connect(o1).proposeERC1155(t, recipient.address, 1, 40, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await expect(wallet.connect(o1).executeERC1155(id))
      .to.emit(wallet, "ERC1155Sent").withArgs(id, t, recipient.address, 1, 40);
    expect(await multi.balanceOf(recipient.address, 1)).to.equal(40n);
    expect(await wallet.erc1155Balance(t, 1)).to.equal(60n);
  });

  it("cannot transfer more of an id than it holds", async () => {
    const { wallet, o1, o2, recipient, multi } = await loadFixture(deployFixture);
    const t = await multi.getAddress();
    await wallet.connect(o1).proposeERC1155(t, recipient.address, 2, 999, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await expect(wallet.connect(o1).executeERC1155(id)).to.be.reverted;
  });
});

describe("PersonalWallet — the NFT batch", () => {
  it("moves ERC-721 and ERC-1155, across two collections, in ONE execution", async () => {
    const { wallet, o1, o2, recipient, nft, nft2, multi } = await loadFixture(deployFixture);
    const a = await nft.getAddress(), b = await nft2.getAddress(), m = await multi.getAddress();

    const items = [
      { token: a, standard: Std.ERC721, id: 1, amount: 0 },
      { token: a, standard: Std.ERC721, id: 2, amount: 0 },
      { token: b, standard: Std.ERC721, id: 11, amount: 0 },
      { token: m, standard: Std.ERC1155, id: 1, amount: 25 },
      { token: m, standard: Std.ERC1155, id: 2, amount: 10 },
    ];
    await wallet.connect(o1).proposeNFTBatch(recipient.address, items, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    // What the second owner approved is stored on-chain, not re-supplied at execution.
    expect((await wallet.getBatch(id)).length).to.equal(5);

    const tx = await wallet.connect(o2).executeNFTBatch(id);
    await expect(tx).to.emit(wallet, "NFTBatchSent").withArgs(id, recipient.address, 5);

    expect(await nft.ownerOf(1)).to.equal(recipient.address);
    expect(await nft.ownerOf(2)).to.equal(recipient.address);
    expect(await nft2.ownerOf(11)).to.equal(recipient.address);
    expect(await multi.balanceOf(recipient.address, 1)).to.equal(25n);
    expect(await multi.balanceOf(recipient.address, 2)).to.equal(10n);
    // Untouched.
    expect(await nft.ownerOf(3)).to.equal(await wallet.getAddress());
  });

  it("is all-or-nothing: one bad item reverts the whole batch and moves nothing", async () => {
    const { wallet, addr, o1, o2, recipient, nft, multi } = await loadFixture(deployFixture);
    const a = await nft.getAddress(), m = await multi.getAddress();
    const items = [
      { token: a, standard: Std.ERC721, id: 1, amount: 0 },
      { token: m, standard: Std.ERC1155, id: 1, amount: 99999 }, // more than it holds
    ];
    await wallet.connect(o1).proposeNFTBatch(recipient.address, items, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);

    await expect(wallet.connect(o1).executeNFTBatch(id)).to.be.reverted;
    expect(await nft.ownerOf(1)).to.equal(addr); // the first item did NOT slip through
    expect((await wallet.getProposal(id)).executed).to.equal(false);
  });

  it("refuses an empty batch, an oversized one, and a zero token address", async () => {
    const { wallet, o1, recipient, nft } = await loadFixture(deployFixture);
    const a = await nft.getAddress();
    await expect(wallet.connect(o1).proposeNFTBatch(recipient.address, [], HOUR))
      .to.be.revertedWithCustomError(wallet, "EmptyBatch");

    const big = Array.from({ length: 51 }, (_, i) => ({ token: a, standard: Std.ERC721, id: i + 1, amount: 0 }));
    await expect(wallet.connect(o1).proposeNFTBatch(recipient.address, big, HOUR))
      .to.be.revertedWithCustomError(wallet, "BatchTooLarge").withArgs(51);

    await expect(wallet.connect(o1).proposeNFTBatch(recipient.address,
      [{ token: ethers.ZeroAddress, standard: Std.ERC721, id: 1, amount: 0 }], HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");

    await expect(wallet.connect(o1).proposeNFTBatch(recipient.address,
      [{ token: a, standard: Std.ERC1155, id: 1, amount: 0 }], HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
  });

  it("executes a full MAX_BATCH of 50 inside a normal block gas limit", async () => {
    const { wallet, o1, o2, recipient, multi } = await loadFixture(deployFixture);
    const m = await multi.getAddress();
    for (let i = 100; i < 150; i++) await multi.mint(await wallet.getAddress(), i, 2);
    const items = Array.from({ length: 50 }, (_, i) => ({ token: m, standard: Std.ERC1155, id: 100 + i, amount: 1 }));

    await wallet.connect(o1).proposeNFTBatch(recipient.address, items, HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    const rc = await (await wallet.connect(o1).executeNFTBatch(id)).wait();

    // MAX_BATCH is only a real bound if the biggest allowed batch actually fits in a block.
    expect(rc.gasUsed).to.be.lessThan(30_000_000n);
    expect(await multi.balanceOf(recipient.address, 149)).to.equal(1n);
  });
});
