const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { loadFixture, deployFixture, Kind, HOUR, DAY, DELAY, eth, u6, ctorArgs } = require("./helpers");
const { executableOpcodes } = require("./opcodes");

describe("PersonalWallet — construction and invariants", () => {
  it("holds exactly three distinct owners and a threshold of two", async () => {
    const { wallet, o1, o2, o3 } = await loadFixture(deployFixture);
    expect(await wallet.OWNER_COUNT()).to.equal(3n);
    expect(await wallet.THRESHOLD()).to.equal(2n);
    expect(await wallet.owners()).to.deep.equal([o1.address, o2.address, o3.address]);
    for (const o of [o1, o2, o3]) expect(await wallet.isOwner(o.address)).to.equal(true);
  });

  it("refuses a zero address, a duplicate, or itself as an owner", async () => {
    const W = await ethers.getContractFactory("PersonalWallet");
    const [, a, b] = await ethers.getSigners();
    await expect(W.deploy(...ctorArgs([ethers.ZeroAddress, a.address, b.address])))
      .to.be.revertedWithCustomError(W, "ZeroAddress");
    await expect(W.deploy(...ctorArgs([a.address, a.address, b.address])))
      .to.be.revertedWithCustomError(W, "DuplicateOwner");
  });

  it("has NO renounce or transfer-ownership entry point at all", async () => {
    const { wallet } = await loadFixture(deployFixture);
    // Not "it reverts" — the function must not exist in the ABI, so no caller can reach it and
    // no future wiring can accidentally expose it.
    const names = wallet.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const forbidden of ["renounceOwnership", "transferOwnership", "owner", "addOwner", "removeOwner"]) {
      expect(names, `ABI must not expose ${forbidden}`).to.not.include(forbidden);
    }
  });

  it("is not a proxy: no DELEGATECALL, no SELFDESTRUCT, no implementation slot", async () => {
    const { addr } = await loadFixture(deployFixture);
    const ops = executableOpcodes(await ethers.provider.getCode(addr));
    // Walked as opcodes, not grepped as bytes — see test/opcodes.js for why that matters.
    expect(ops.has(0xf4), "runtime bytecode executes DELEGATECALL").to.equal(false);
    expect(ops.has(0xff), "runtime bytecode executes SELFDESTRUCT").to.equal(false);
    // Control: the walker does find the opcodes this contract genuinely uses, so a false
    // negative above would have shown up here.
    expect(ops.has(0xf1), "runtime bytecode should use CALL for native sends").to.equal(true);
    // ERC-1967 implementation slot must be empty.
    const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    expect(await ethers.provider.getStorage(addr, slot)).to.equal(ethers.ZeroHash);
  });

  it("advertises the ERC-721 and ERC-1155 receiver interfaces", async () => {
    const { wallet } = await loadFixture(deployFixture);
    expect(await wallet.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC165
    expect(await wallet.supportsInterface("0x4e2312e0")).to.equal(true); // IERC1155Receiver
    expect(await wallet.supportsInterface("0xffffffff")).to.equal(false);
  });
});

describe("PersonalWallet — taking money in", () => {
  it("accepts a plain native transfer and logs it", async () => {
    const { wallet, addr, outsider } = await loadFixture(deployFixture);
    await expect(outsider.sendTransaction({ to: addr, value: eth(1) }))
      .to.emit(wallet, "Deposited").withArgs(outsider.address, eth(1), false);
    expect(await wallet.nativeBalance()).to.equal(eth(101));
  });

  it("accepts a native transfer that carries calldata (fallback), instead of rejecting it", async () => {
    const { wallet, addr, outsider } = await loadFixture(deployFixture);
    await expect(outsider.sendTransaction({ to: addr, value: eth(2), data: "0xdeadbeef" }))
      .to.emit(wallet, "Deposited").withArgs(outsider.address, eth(2), true);
    expect(await wallet.nativeBalance()).to.equal(eth(102));
  });

  it("accepts NFTs pushed in with safeTransferFrom", async () => {
    const { wallet, addr, nft, multi, outsider } = await loadFixture(deployFixture);
    await nft.safeMint(outsider.address, 900);
    await nft.connect(outsider).safeTransferFrom(outsider.address, addr, 900);
    expect(await wallet.erc721Owned(await nft.getAddress(), 900)).to.equal(true);

    await multi.mint(outsider.address, 7, 5);
    await multi.connect(outsider).safeTransferFrom(outsider.address, addr, 7, 5, "0x");
    expect(await wallet.erc1155Balance(await multi.getAddress(), 7)).to.equal(5n);
  });

  it("reports balances it actually holds", async () => {
    const { wallet, usdt, usdc, eurc, multi, nft } = await loadFixture(deployFixture);
    expect(await wallet.erc20Balance(await usdt.getAddress())).to.equal(u6(1000));
    expect(await wallet.erc20Balance(await usdc.getAddress())).to.equal(u6(1000));
    expect(await wallet.erc20Balance(await eurc.getAddress())).to.equal(u6(1000));
    expect(await wallet.erc1155Balance(await multi.getAddress(), 1)).to.equal(100n);
    expect(await wallet.erc721Owned(await nft.getAddress(), 3)).to.equal(true);
  });
});

describe("PersonalWallet — the 2-of-3 rule on every critical function", () => {
  // One table, every value-moving entry point. If a function is ever added without an approval
  // gate, this is the test that should fail.
  const cases = [
    { name: "native", propose: (w, s, f) => w.connect(s).proposeNative(f.recipient.address, eth(1), HOUR), exec: "executeNative" },
    { name: "ERC-20", propose: (w, s, f) => w.connect(s).proposeERC20(f.usdtAddr, f.recipient.address, u6(10), HOUR), exec: "executeERC20" },
    { name: "ERC-721", propose: (w, s, f) => w.connect(s).proposeERC721(f.nftAddr, f.recipient.address, 1, HOUR), exec: "executeERC721" },
    { name: "ERC-1155", propose: (w, s, f) => w.connect(s).proposeERC1155(f.multiAddr, f.recipient.address, 1, 5, HOUR), exec: "executeERC1155" },
    { name: "NFT batch", propose: (w, s, f) => w.connect(s).proposeNFTBatch(f.recipient.address, [{ token: f.nftAddr, standard: 0, id: 2, amount: 0 }], HOUR), exec: "executeNFTBatch" },
  ];

  for (const c of cases) {
    it(`${c.name}: ONE owner cannot execute, TWO can`, async () => {
      const f = await loadFixture(deployFixture);
      f.usdtAddr = await f.usdt.getAddress();
      f.nftAddr = await f.nft.getAddress();
      f.multiAddr = await f.multi.getAddress();
      const { wallet, o1, o2 } = f;

      await c.propose(wallet, o1, f);
      const id = await wallet.proposalCount();

      expect(await wallet.confirmations(id)).to.equal(1n);
      expect(await wallet.isExecutable(id)).to.equal(false);
      await expect(wallet.connect(o1)[c.exec](id))
        .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations").withArgs(id, 1n, 2n);

      await wallet.connect(o2).confirm(id);
      expect(await wallet.confirmations(id)).to.equal(2n);
      expect(await wallet.isExecutable(id)).to.equal(true);
      await expect(wallet.connect(o1)[c.exec](id)).to.emit(wallet, "Executed");
    });

    it(`${c.name}: a non-owner can neither propose nor execute`, async () => {
      const f = await loadFixture(deployFixture);
      f.usdtAddr = await f.usdt.getAddress();
      f.nftAddr = await f.nft.getAddress();
      f.multiAddr = await f.multi.getAddress();
      const { wallet, o1, o2, outsider } = f;

      await expect(c.propose(wallet, outsider, f))
        .to.be.revertedWithCustomError(wallet, "NotOwner").withArgs(outsider.address);

      await c.propose(wallet, o1, f);
      const id = await wallet.proposalCount();
      await wallet.connect(o2).confirm(id);
      // Approved by two — but the caller still has to be an owner.
      await expect(wallet.connect(outsider)[c.exec](id))
        .to.be.revertedWithCustomError(wallet, "NotOwner").withArgs(outsider.address);
    });
  }

  it("owner replacement also needs two of three", async () => {
    const { wallet, o1, o3, spare } = await loadFixture(deployFixture);
    await wallet.connect(o1).proposeOwnerReplacement(o3.address, spare.address);
    const id = await wallet.proposalCount();
    // Acceptance itself is gated on the threshold — one approval is not enough to even accept.
    await expect(wallet.connect(spare).acceptOwnerReplacement(id))
      .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations").withArgs(id, 1n, 2n);
  });
});

describe("PersonalWallet — the proposal lifecycle", () => {
  const mk = async (f) => {
    await f.wallet.connect(f.o1).proposeNative(f.recipient.address, eth(1), HOUR);
    return f.wallet.proposalCount();
  };

  it("proposing counts as the proposer's approval, and cannot be doubled", async () => {
    const f = await loadFixture(deployFixture);
    const id = await mk(f);
    expect(await f.wallet.hasConfirmed(id, f.o1.address)).to.equal(true);
    await expect(f.wallet.connect(f.o1).confirm(id))
      .to.be.revertedWithCustomError(f.wallet, "AlreadyConfirmed").withArgs(id, f.o1.address);
  });

  it("an approval can be withdrawn, which drops it back below the threshold", async () => {
    const f = await loadFixture(deployFixture);
    const id = await mk(f);
    await f.wallet.connect(f.o2).confirm(id);
    expect(await f.wallet.isExecutable(id)).to.equal(true);

    await expect(f.wallet.connect(f.o2).revokeConfirmation(id))
      .to.emit(f.wallet, "ConfirmationRevoked").withArgs(id, f.o2.address, 1n);
    expect(await f.wallet.isExecutable(id)).to.equal(false);
    await expect(f.wallet.connect(f.o1).executeNative(id))
      .to.be.revertedWithCustomError(f.wallet, "NotEnoughConfirmations");
  });

  it("only the proposer can cancel, and only while it is still short of the threshold", async () => {
    const f = await loadFixture(deployFixture);
    const id = await mk(f);
    await expect(f.wallet.connect(f.o2).cancel(id))
      .to.be.revertedWithCustomError(f.wallet, "NotProposer").withArgs(id);

    await f.wallet.connect(f.o2).confirm(id);
    // Two owners have agreed — one of them cannot unilaterally pull it any more.
    await expect(f.wallet.connect(f.o1).cancel(id))
      .to.be.revertedWithCustomError(f.wallet, "ConfirmationsLocked").withArgs(id);

    await f.wallet.connect(f.o2).revokeConfirmation(id);
    await expect(f.wallet.connect(f.o1).cancel(id)).to.emit(f.wallet, "Cancelled").withArgs(id, f.o1.address);
    await expect(f.wallet.connect(f.o1).confirm(id))
      .to.be.revertedWithCustomError(f.wallet, "ProposalCancelled").withArgs(id);
  });

  it("expires, and nothing can be done with it afterwards", async () => {
    const f = await loadFixture(deployFixture);
    const id = await mk(f);
    await f.wallet.connect(f.o2).confirm(id);
    expect(await f.wallet.isExecutable(id)).to.equal(true);

    await time.increase(HOUR + 1);
    expect(await f.wallet.isExecutable(id)).to.equal(false);
    await expect(f.wallet.connect(f.o1).executeNative(id))
      .to.be.revertedWithCustomError(f.wallet, "Expired").withArgs(id);
    await expect(f.wallet.connect(f.o3).confirm(id))
      .to.be.revertedWithCustomError(f.wallet, "Expired").withArgs(id);
  });

  it("rejects a lifetime outside MIN_TTL…MAX_TTL", async () => {
    const { wallet, o1, recipient } = await loadFixture(deployFixture);
    await expect(wallet.connect(o1).proposeNative(recipient.address, eth(1), 60))
      .to.be.revertedWithCustomError(wallet, "BadTtl").withArgs(60);
    await expect(wallet.connect(o1).proposeNative(recipient.address, eth(1), 31 * DAY))
      .to.be.revertedWithCustomError(wallet, "BadTtl");
    await expect(wallet.connect(o1).proposeNative(recipient.address, eth(1), 10 * 60)).to.not.be.reverted;
    await expect(wallet.connect(o1).proposeNative(recipient.address, eth(1), 30 * DAY)).to.not.be.reverted;
  });

  it("executes once and only once", async () => {
    const f = await loadFixture(deployFixture);
    const id = await mk(f);
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o1).executeNative(id);
    await expect(f.wallet.connect(f.o2).executeNative(id))
      .to.be.revertedWithCustomError(f.wallet, "AlreadyExecuted").withArgs(id);
    await expect(f.wallet.connect(f.o2).confirm(id))
      .to.be.revertedWithCustomError(f.wallet, "AlreadyExecuted").withArgs(id);
  });

  it("cannot be executed through the wrong typed entry point", async () => {
    const f = await loadFixture(deployFixture);
    const id = await mk(f); // a NATIVE proposal
    await f.wallet.connect(f.o2).confirm(id);
    for (const wrong of ["executeERC20", "executeERC721", "executeERC1155", "executeNFTBatch", "executeOwnerReplacement"]) {
      await expect(f.wallet.connect(f.o1)[wrong](id))
        .to.be.revertedWithCustomError(f.wallet, "WrongKind").withArgs(id);
    }
  });

  it("rejects a proposal id that was never created", async () => {
    const { wallet, o1 } = await loadFixture(deployFixture);
    await expect(wallet.connect(o1).confirm(0)).to.be.revertedWithCustomError(wallet, "NoSuchProposal").withArgs(0);
    await expect(wallet.connect(o1).confirm(99)).to.be.revertedWithCustomError(wallet, "NoSuchProposal").withArgs(99);
    expect(await wallet.isExecutable(99)).to.equal(false);
  });

  it("refuses a zero recipient, a zero amount, and itself as recipient", async () => {
    const { wallet, addr, o1, usdt, recipient } = await loadFixture(deployFixture);
    const t = await usdt.getAddress();
    await expect(wallet.connect(o1).proposeNative(ethers.ZeroAddress, eth(1), HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(o1).proposeNative(recipient.address, 0, HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
    await expect(wallet.connect(o1).proposeNative(addr, eth(1), HOUR))
      .to.be.revertedWithCustomError(wallet, "SelfRecipient");
    await expect(wallet.connect(o1).proposeERC20(ethers.ZeroAddress, recipient.address, u6(1), HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAddress");
    await expect(wallet.connect(o1).proposeERC1155(t, recipient.address, 1, 0, HOUR))
      .to.be.revertedWithCustomError(wallet, "ZeroAmount");
  });
});
