const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, deployFixture, deployWallet, Std, HOUR, eth, u6 } = require("./helpers");

/**
 * The deposit functions. Deliberately SINGLE-SIGNATURE and open to anyone: a deposit increases
 * the wallet's assets, so a 2-of-3 gate would protect nothing while costing three transactions
 * and adding a way for a legitimate delivery to be refused.
 *
 * What they buy over a plain `token.transfer(wallet, x)` is an event naming WHO deposited.
 * What they do not buy is exclusivity — see the last block in this file.
 */
describe("Deposits — native", () => {
  it("accepts a deposit through the explicit function and logs it", async () => {
    const { wallet, outsider } = await loadFixture(deployFixture);
    await expect(wallet.connect(outsider).depositNative({ value: eth(5) }))
      .to.emit(wallet, "Deposited").withArgs(outsider.address, eth(5), false);
    expect(await wallet.nativeBalance()).to.equal(eth(105));
  });

  it("refuses a zero-value deposit rather than emitting a meaningless event", async () => {
    const { wallet, outsider } = await loadFixture(deployFixture);
    await expect(wallet.connect(outsider).depositNative({ value: 0 }))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
  });
});

describe("Deposits — ERC-20", () => {
  it("pulls an approved balance and records WHO sent it", async () => {
    const { wallet, addr, outsider, usdc } = await loadFixture(deployFixture);
    const t = await usdc.getAddress();
    await usdc.mint(outsider.address, u6(500));
    await usdc.connect(outsider).approve(addr, u6(500));

    await expect(wallet.connect(outsider).depositERC20(t, u6(300)))
      .to.emit(wallet, "DepositedERC20").withArgs(t, outsider.address, u6(300));
    expect(await wallet.erc20Balance(t)).to.equal(u6(1300));
    expect(await usdc.balanceOf(outsider.address)).to.equal(u6(200));
  });

  it("works with USDT, whose transferFrom returns nothing", async () => {
    const { wallet, addr, outsider, usdt } = await loadFixture(deployFixture);
    const t = await usdt.getAddress();
    await usdt.mint(outsider.address, u6(100));
    await usdt.connect(outsider).approve(addr, u6(100));
    await expect(wallet.connect(outsider).depositERC20(t, u6(100)))
      .to.emit(wallet, "DepositedERC20").withArgs(t, outsider.address, u6(100));
    expect(await wallet.erc20Balance(t)).to.equal(u6(1100));
  });

  it("fails loudly without an approval instead of silently doing nothing", async () => {
    const { wallet, outsider, usdc } = await loadFixture(deployFixture);
    await usdc.mint(outsider.address, u6(10));
    await expect(wallet.connect(outsider).depositERC20(await usdc.getAddress(), u6(10))).to.be.reverted;
  });

  it("refuses a zero token and a zero amount", async () => {
    const { wallet, outsider, usdc } = await loadFixture(deployFixture);
    await expect(wallet.connect(outsider).depositERC20(ethers.ZeroAddress, u6(1)))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(outsider).depositERC20(await usdc.getAddress(), 0))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
  });
});

describe("Deposits — NFTs", () => {
  it("pulls one ERC-721 and one ERC-1155 position", async () => {
    const { wallet, addr, outsider, nft, multi } = await loadFixture(deployFixture);
    const a = await nft.getAddress(), m = await multi.getAddress();

    await nft.mint(outsider.address, 500);
    await nft.connect(outsider).approve(addr, 500);
    await expect(wallet.connect(outsider).depositERC721(a, 500))
      .to.emit(wallet, "DepositedERC721").withArgs(a, outsider.address, 500);
    expect(await nft.ownerOf(500)).to.equal(addr);

    await multi.mint(outsider.address, 9, 40);
    await multi.connect(outsider).setApprovalForAll(addr, true);
    await expect(wallet.connect(outsider).depositERC1155(m, 9, 25))
      .to.emit(wallet, "DepositedERC1155").withArgs(m, outsider.address, 9, 25);
    expect(await wallet.erc1155Balance(m, 9)).to.equal(25n);
    expect(await multi.balanceOf(outsider.address, 9)).to.equal(15n);
  });

  it("pulls a mixed batch of both standards across collections in one transaction", async () => {
    const { wallet, addr, outsider, nft, nft2, multi } = await loadFixture(deployFixture);
    const a = await nft.getAddress(), b = await nft2.getAddress(), m = await multi.getAddress();

    for (const id of [601, 602]) await nft.mint(outsider.address, id);
    await nft2.mint(outsider.address, 701);
    await multi.mint(outsider.address, 5, 60);
    await nft.connect(outsider).setApprovalForAll(addr, true);
    await nft2.connect(outsider).setApprovalForAll(addr, true);
    await multi.connect(outsider).setApprovalForAll(addr, true);

    const items = [
      { token: a, standard: Std.ERC721, id: 601, amount: 0 },
      { token: a, standard: Std.ERC721, id: 602, amount: 0 },
      { token: b, standard: Std.ERC721, id: 701, amount: 0 },
      { token: m, standard: Std.ERC1155, id: 5, amount: 30 },
    ];
    await expect(wallet.connect(outsider).depositNFTBatch(items))
      .to.emit(wallet, "DepositedNFTBatch").withArgs(outsider.address, 4);

    expect(await nft.ownerOf(601)).to.equal(addr);
    expect(await nft.ownerOf(602)).to.equal(addr);
    expect(await nft2.ownerOf(701)).to.equal(addr);
    expect(await wallet.erc1155Balance(m, 5)).to.equal(30n);
  });

  it("refuses an empty batch, an oversized one, a zero token and a zero 1155 amount", async () => {
    const { wallet, outsider, nft } = await loadFixture(deployFixture);
    const a = await nft.getAddress();
    await expect(wallet.connect(outsider).depositNFTBatch([]))
      .to.be.revertedWithCustomError(wallet, "EmptyBatch");
    const big = Array.from({ length: 51 }, (_, i) => ({ token: a, standard: Std.ERC721, id: i, amount: 0 }));
    await expect(wallet.connect(outsider).depositNFTBatch(big))
      .to.be.revertedWithCustomError(wallet, "BatchTooLarge").withArgs(51);
    await expect(wallet.connect(outsider).depositNFTBatch([{ token: ethers.ZeroAddress, standard: Std.ERC721, id: 1, amount: 0 }]))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(outsider).depositNFTBatch([{ token: a, standard: Std.ERC1155, id: 1, amount: 0 }]))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
  });
});

describe("Deposits — single signature, on purpose", () => {
  it("anyone can deposit: no owner, no proposal, no confirmation", async () => {
    const { wallet, addr, outsider, recipient, usdc } = await loadFixture(deployFixture);
    const before = await wallet.proposalCount();
    await usdc.mint(recipient.address, u6(50));
    await usdc.connect(recipient).approve(addr, u6(50));

    // `recipient` is not an owner and holds nothing in the multisig.
    expect(await wallet.isOwner(recipient.address)).to.equal(false);
    await wallet.connect(recipient).depositERC20(await usdc.getAddress(), u6(50));
    await wallet.connect(outsider).depositNative({ value: eth(1) });

    // Not a single proposal was created — deposits are not governed.
    expect(await wallet.proposalCount()).to.equal(before);
  });
});

describe("Deposits — the token allowlist binds here too", () => {
  async function strict() {
    const [deployer, o1, o2, o3, outsider] = await ethers.getSigners();
    const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const nft = await (await ethers.getContractFactory("MockERC721")).deploy("Art", "ART");
    const multi = await (await ethers.getContractFactory("MockERC1155")).deploy();
    const wallet = await deployWallet([o1.address, o2.address, o3.address], {
      requireToken: true,
      tokens: [[await usdt.getAddress(), "Tether USD"]],
    });
    return { wallet, addr: await wallet.getAddress(), deployer, o1, o2, o3, outsider, usdt, usdc, nft, multi };
  }

  it("an unlisted token cannot be deposited through the accounted path", async () => {
    const f = await strict();
    const bad = await f.usdc.getAddress();
    await f.usdc.mint(f.outsider.address, u6(10));
    await f.usdc.connect(f.outsider).approve(f.addr, u6(10));
    await expect(f.wallet.connect(f.outsider).depositERC20(bad, u6(10)))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(bad);

    // The listed one goes through.
    await f.usdt.mint(f.outsider.address, u6(10));
    await f.usdt.connect(f.outsider).approve(f.addr, u6(10));
    await expect(f.wallet.connect(f.outsider).depositERC20(await f.usdt.getAddress(), u6(10)))
      .to.emit(f.wallet, "DepositedERC20");
  });

  it("binds on the NFT deposit paths as well, every batch item included", async () => {
    const f = await strict();
    const a = await f.nft.getAddress(), m = await f.multi.getAddress();
    await f.nft.mint(f.outsider.address, 1);
    await f.nft.connect(f.outsider).setApprovalForAll(f.addr, true);
    await expect(f.wallet.connect(f.outsider).depositERC721(a, 1))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(a);
    await expect(f.wallet.connect(f.outsider).depositERC1155(m, 1, 1))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(m);
    await expect(f.wallet.connect(f.outsider).depositNFTBatch([{ token: a, standard: Std.ERC721, id: 1, amount: 0 }]))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(a);
  });

  it(" but a PLAIN transfer still lands — the allowlist cannot stop an ERC-20 arriving", async () => {
    // Stated as a test rather than only in prose, because this is the limit of the whole idea:
    // ERC-20 has no receive hook, so this contract's code does not run during an incoming
    // transfer and there is nothing to revert. The accounted path is additional, never exclusive.
    const f = await strict();
    const bad = await f.usdc.getAddress();
    await f.usdc.mint(f.outsider.address, u6(777));
    await f.usdc.connect(f.outsider).transfer(f.addr, u6(777));

    expect(await f.wallet.erc20Balance(bad)).to.equal(u6(777));
    expect(await f.wallet.isTokenAllowed(bad)).to.equal(false);
    // And because it is not allowlisted, it cannot be sent anywhere either — inert, which is
    // the safe state.
    await expect(f.wallet.connect(f.o1).proposeERC20(bad, f.outsider.address, u6(1), HOUR))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(bad);
  });
});

describe("Deposits — hostile tokens", () => {
  it("a token with a transfer hook cannot re-enter through a deposit", async () => {
    const f = await loadFixture(deployFixture);
    const { wallet, addr, o1, o2, recipient, outsider } = f;

    // An approved outgoing transfer sits ready; the hostile token will try to trigger it.
    const bad = await (await ethers.getContractFactory("ReenteringERC20")).deploy();
    await bad.mint(addr, eth(50));
    await wallet.connect(o1).proposeERC20(await bad.getAddress(), recipient.address, eth(1), HOUR);
    const id = await wallet.proposalCount();
    await wallet.connect(o2).confirm(id);
    await bad.arm(addr, id);

    // The deposit's own pull triggers the hook, which tries to execute the pending transfer.
    await bad.mint(outsider.address, eth(10));
    await bad.connect(outsider).approve(addr, eth(10));
    await wallet.connect(outsider).depositERC20(await bad.getAddress(), eth(10));

    expect(await bad.reentryAttempts()).to.equal(0n); // the hook only fires on `transfer`
    // And the pending proposal is untouched by the deposit.
    expect((await wallet.getProposal(id)).executed).to.equal(false);
    expect(await wallet.erc20Balance(await bad.getAddress())).to.equal(eth(60));
  });

  it("a lying token cannot fake a deposit", async () => {
    const f = await loadFixture(deployFixture);
    const lie = await (await ethers.getContractFactory("LyingERC20")).deploy();
    await lie.mint(f.outsider.address, eth(10));
    // transferFrom returns false without reverting; SafeERC20 must turn that into a revert.
    await expect(f.wallet.connect(f.outsider).depositERC20(await lie.getAddress(), eth(10)))
      .to.be.reverted;
    expect(await f.wallet.erc20Balance(await lie.getAddress())).to.equal(0n);
  });
});

describe("Deposits — fee-on-transfer honesty", () => {
  it(" the event reports what ARRIVED, not what was asked for", async () => {
    // Raised by an external review of v2: with a fee-charging token the requested amount and the
    // received amount differ, and an event reporting the request would misstate the balance
    // change — defeating the only reason this function exists over a plain `transfer`.
    const { wallet, addr, outsider, usdt } = await loadFixture(deployFixture);
    const t = await usdt.getAddress();
    await usdt.setParams(10, u6(5)); // 10 bp, capped at 5 — Tether's own knobs
    await usdt.mint(outsider.address, u6(1000));
    await usdt.connect(outsider).approve(addr, u6(1000));

    const before = await wallet.erc20Balance(t);
    // 10 bp of 1000 = 1 USDT fee, so 999 actually arrives.
    await expect(wallet.connect(outsider).depositERC20(t, u6(1000)))
      .to.emit(wallet, "DepositedERC20").withArgs(t, outsider.address, u6(999));
    expect(await wallet.erc20Balance(t) - before).to.equal(u6(999));
  });

  it("a token that absorbs the whole amount is refused, not logged as a deposit", async () => {
    // A realistic fee-charging token cannot take 100 % — Tether's own setParams caps the rate,
    // and so does the mock. A malicious one can, and then the wallet must not emit a deposit
    // event for something that never arrived.
    const { wallet, addr, outsider } = await loadFixture(deployFixture);
    const hole = await (await ethers.getContractFactory("BlackHoleERC20")).deploy();
    await hole.mint(outsider.address, eth(10));
    await hole.connect(outsider).approve(addr, eth(10));
    await expect(wallet.connect(outsider).depositERC20(await hole.getAddress(), eth(10)))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
  });
});
