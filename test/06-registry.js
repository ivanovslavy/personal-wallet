const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  loadFixture, deployFixture, deployWallet, ctorArgs,
  Std, HOUR, DAY, DELAY, MIN_DELAY, MAX_DELAY, EXEC_WINDOW, eth, u6,
} = require("./helpers");

/**
 * The outbound registries, the timelock and the veto. The rule under test throughout:
 *  EXPANDING what the wallet can do is slow and any ONE owner can stop it.
 *  SHRINKING what the wallet can do is immediate and nobody can stop it.
 */

describe("Registry — allowlisting a TOKEN (two owners, immediate)", () => {
  const add = async (f, token, label) => {
    await f.wallet.connect(f.o1).proposeAllowToken(token, label);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o1).executeAllowToken(id);
    return id;
  };

  it("takes two owners and takes effect at once — no timelock", async () => {
    const f = await loadFixture(deployFixture);
    const t = await f.usdt.getAddress();

    await f.wallet.connect(f.o1).proposeAllowToken(t, "Tether USD");
    const id = await f.wallet.proposalCount();
    // Not timelocked: allowlisting a token grants no ability to steal, because the recipient
    // allowlist still binds.
    expect(await f.wallet.effectiveAt(id)).to.equal(0n);
    expect(await f.wallet.requiredConfirmations(id)).to.equal(2n);

    await expect(f.wallet.connect(f.o1).executeAllowToken(id))
      .to.be.revertedWithCustomError(f.wallet, "NotEnoughConfirmations").withArgs(id, 1n, 2n);

    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeAllowToken(id))
      .to.emit(f.wallet, "TokenAllowed").withArgs(t, "Tether USD");

    expect(await f.wallet.isTokenAllowed(t)).to.equal(true);
    const e = await f.wallet.tokenEntry(t);
    expect(e.label).to.equal("Tether USD");
    expect(e.allowed).to.equal(true);
    expect(e.addedAt).to.be.greaterThan(0n);
  });

  it("is NOT vetoable — a single owner cannot block it", async () => {
    const f = await loadFixture(deployFixture);
    await f.wallet.connect(f.o1).proposeAllowToken(await f.usdt.getAddress(), "USDT");
    const id = await f.wallet.proposalCount();
    await expect(f.wallet.connect(f.o3).veto(id))
      .to.be.revertedWithCustomError(f.wallet, "NotTimelocked").withArgs(id);
  });

  it("lists what is allowed, with the labels, and drops what was revoked", async () => {
    const f = await loadFixture(deployFixture);
    const [a, b, c] = [await f.usdt.getAddress(), await f.usdc.getAddress(), await f.nft.getAddress()];
    await add(f, a, "Tether USD");
    await add(f, b, "USD Coin");
    await add(f, c, "Gemba Art");

    let [list, labels] = await f.wallet.allowedTokens();
    expect(list).to.deep.equal([a, b, c]);
    expect(labels).to.deep.equal(["Tether USD", "USD Coin", "Gemba Art"]);
    expect(await f.wallet.registeredTokenCount()).to.equal(3n);

    await f.wallet.connect(f.o1).proposeRevokeToken(b);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeRevokeToken(id))
      .to.emit(f.wallet, "TokenRevoked").withArgs(b);

    [list, labels] = await f.wallet.allowedTokens();
    expect(list).to.deep.equal([a, c]);
    expect(labels).to.deep.equal(["Tether USD", "Gemba Art"]);
    // The revoked entry stays in the registry's history, it just stops being allowed.
    expect(await f.wallet.registeredTokenCount()).to.equal(3n);
    expect(await f.wallet.isTokenAllowed(b)).to.equal(false);
  });

  it("refuses to add twice, to revoke what is not allowed, or to allowlist itself", async () => {
    const f = await loadFixture(deployFixture);
    const t = await f.usdt.getAddress();
    await add(f, t, "USDT");
    await expect(f.wallet.connect(f.o1).proposeAllowToken(t, "again"))
      .to.be.revertedWithCustomError(f.wallet, "AlreadyAllowed").withArgs(t);
    await expect(f.wallet.connect(f.o1).proposeRevokeToken(await f.usdc.getAddress()))
      .to.be.revertedWithCustomError(f.wallet, "NotAllowed");
    await expect(f.wallet.connect(f.o1).proposeAllowToken(ethers.ZeroAddress, "x"))
      .to.be.revertedWithCustomError(f.wallet, "ZeroAddress");
    await expect(f.wallet.connect(f.o1).proposeAllowToken(f.addr, "x"))
      .to.be.revertedWithCustomError(f.wallet, "SelfRecipient");
  });

  it("a re-added token keeps its place in the list and gets the new label", async () => {
    const f = await loadFixture(deployFixture);
    const t = await f.usdt.getAddress();
    await add(f, t, "first label");
    await f.wallet.connect(f.o1).proposeRevokeToken(t);
    let id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o1).executeRevokeToken(id);

    await add(f, t, "second label");
    expect((await f.wallet.tokenEntry(t)).label).to.equal("second label");
    expect(await f.wallet.registeredTokenCount()).to.equal(1n); // not duplicated
  });
});

describe("Registry — the token requirement actually binds", () => {
  async function strictTokens() {
    const [deployer, o1, o2, o3, outsider, recipient, spare] = await ethers.getSigners();
    const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const nft = await (await ethers.getContractFactory("MockERC721")).deploy("Art", "ART");
    const multi = await (await ethers.getContractFactory("MockERC1155")).deploy();
    const wallet = await deployWallet([o1.address, o2.address, o3.address], {
      requireToken: true,
      tokens: [[await usdt.getAddress(), "Tether USD"], [await nft.getAddress(), "Art"]],
    });
    const addr = await wallet.getAddress();
    await deployer.sendTransaction({ to: addr, value: eth(10) });
    await usdt.mint(addr, u6(1000));
    await usdc.mint(addr, u6(1000));
    for (let i = 1; i <= 3; i++) await nft.mint(addr, i);
    await multi.mint(addr, 1, 100);
    return { wallet, addr, deployer, o1, o2, o3, outsider, recipient, spare, usdt, usdc, nft, multi };
  }

  it("the constructor seeds take effect immediately", async () => {
    const f = await strictTokens();
    expect(await f.wallet.requireAllowedToken()).to.equal(true);
    expect(await f.wallet.isTokenAllowed(await f.usdt.getAddress())).to.equal(true);
    expect(await f.wallet.isTokenAllowed(await f.usdc.getAddress())).to.equal(false);
    const [list, labels] = await f.wallet.allowedTokens();
    expect(list.length).to.equal(2);
    expect(labels[0]).to.equal("Tether USD");
  });

  it("blocks a proposal for an unlisted token, and allows a listed one", async () => {
    const f = await strictTokens();
    const bad = await f.usdc.getAddress();
    await expect(f.wallet.connect(f.o1).proposeERC20(bad, f.recipient.address, u6(1), HOUR))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(bad);

    await f.wallet.connect(f.o1).proposeERC20(await f.usdt.getAddress(), f.recipient.address, u6(10), HOUR);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeERC20(id)).to.emit(f.wallet, "ERC20Sent");
  });

  it(" revoking a token blocks a transfer that was ALREADY approved", async () => {
    // The check is recomputed at execution, like the confirmation count. Shrinking the wallet's
    // reach must stop what is in flight, not merely prevent new proposals.
    const f = await strictTokens();
    const t = await f.usdt.getAddress();
    await f.wallet.connect(f.o1).proposeERC20(t, f.recipient.address, u6(10), 10 * DAY);
    const transfer = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(transfer);
    expect(await f.wallet.isExecutable(transfer)).to.equal(true);

    await f.wallet.connect(f.o1).proposeRevokeToken(t);
    const rev = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(rev);
    await f.wallet.connect(f.o1).executeRevokeToken(rev);

    await expect(f.wallet.connect(f.o1).executeERC20(transfer))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(t);
    expect(await f.usdt.balanceOf(f.recipient.address)).to.equal(0n);
  });

  it("binds on ERC-721 and ERC-1155 too", async () => {
    const f = await strictTokens();
    const m = await f.multi.getAddress();
    await expect(f.wallet.connect(f.o1).proposeERC1155(m, f.recipient.address, 1, 1, HOUR))
      .to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(m);
    await f.wallet.connect(f.o1).proposeERC721(await f.nft.getAddress(), f.recipient.address, 1, HOUR);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeERC721(id)).to.emit(f.wallet, "ERC721Sent");
  });

  it("checks EVERY item of a batch, not just the first", async () => {
    const f = await strictTokens();
    const a = await f.nft.getAddress(), m = await f.multi.getAddress();
    await expect(f.wallet.connect(f.o1).proposeNFTBatch(f.recipient.address, [
      { token: a, standard: Std.ERC721, id: 1, amount: 0 },
      { token: m, standard: Std.ERC1155, id: 1, amount: 5 }, // not listed
    ], HOUR)).to.be.revertedWithCustomError(f.wallet, "TokenNotAllowed").withArgs(m);
  });

  it("does NOT apply to native currency — there is no contract address to check", async () => {
    const f = await strictTokens();
    await f.wallet.connect(f.o1).proposeNative(f.recipient.address, eth(1), HOUR);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeNative(id)).to.emit(f.wallet, "NativeSent");
  });
});

describe("Registry — allowlisting a RECIPIENT (all three, timelocked, vetoable)", () => {
  it("needs ALL THREE owners — two is not enough", async () => {
    const f = await loadFixture(deployFixture);
    await f.wallet.connect(f.o1).proposeAllowRecipient(f.recipient.address, "cold wallet");
    const id = await f.wallet.proposalCount();
    expect(await f.wallet.requiredConfirmations(id)).to.equal(3n);

    await f.wallet.connect(f.o2).confirm(id);
    await time.increase(DELAY + 1);
    await expect(f.wallet.connect(f.o1).executeAllowRecipient(id))
      .to.be.revertedWithCustomError(f.wallet, "NotEnoughConfirmations").withArgs(id, 2n, 3n);

    await f.wallet.connect(f.o3).confirm(id);
    await expect(f.wallet.connect(f.o1).executeAllowRecipient(id))
      .to.emit(f.wallet, "RecipientAllowed").withArgs(f.recipient.address, "cold wallet");
    expect(await f.wallet.isRecipientAllowed(f.recipient.address)).to.equal(true);
  });

  it("is timelocked from the moment it is proposed", async () => {
    const f = await loadFixture(deployFixture);
    const tx = await f.wallet.connect(f.o1).proposeAllowRecipient(f.recipient.address, "cold");
    const id = await f.wallet.proposalCount();
    const ts = (await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp;
    await expect(tx).to.emit(f.wallet, "Scheduled").withArgs(id, ts + DELAY, DELAY);

    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o3).confirm(id);
    expect(await f.wallet.isExecutable(id)).to.equal(false);
    await expect(f.wallet.connect(f.o1).executeAllowRecipient(id))
      .to.be.revertedWithCustomError(f.wallet, "TimelockNotElapsed").withArgs(id, ts + DELAY);

    await time.increase(DELAY + 1);
    expect(await f.wallet.isExecutable(id)).to.equal(true);
    await f.wallet.connect(f.o1).executeAllowRecipient(id);
  });

  it(" ANY ONE owner can veto it — this is the defence against two compromised keys", async () => {
    const f = await loadFixture(deployFixture);
    // Suppose o1 and o2 are compromised and try to allowlist the attacker's address.
    const attacker = f.outsider.address;
    await f.wallet.connect(f.o1).proposeAllowRecipient(attacker, "totally legitimate");
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);

    // They cannot even reach the threshold without the third owner. And if the third were
    // tricked into confirming, the veto is still available right up to execution.
    await f.wallet.connect(f.o3).confirm(id);
    await expect(f.wallet.connect(f.o3).veto(id)).to.emit(f.wallet, "Vetoed").withArgs(id, f.o3.address);

    await time.increase(DELAY + 1);
    await expect(f.wallet.connect(f.o1).executeAllowRecipient(id))
      .to.be.revertedWithCustomError(f.wallet, "ProposalCancelled").withArgs(id);
    expect(await f.wallet.isRecipientAllowed(attacker)).to.equal(false);
  });

  it("removing a recipient is two owners and immediate, and not vetoable", async () => {
    const f = await loadFixture(deployFixture);
    const r = f.recipient.address;
    await f.wallet.connect(f.o1).proposeAllowRecipient(r, "cold");
    let id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o3).confirm(id);
    await time.increase(DELAY + 1);
    await f.wallet.connect(f.o1).executeAllowRecipient(id);

    await f.wallet.connect(f.o1).proposeRevokeRecipient(r);
    id = await f.wallet.proposalCount();
    expect(await f.wallet.effectiveAt(id)).to.equal(0n);
    expect(await f.wallet.requiredConfirmations(id)).to.equal(2n);
    await expect(f.wallet.connect(f.o3).veto(id))
      .to.be.revertedWithCustomError(f.wallet, "NotTimelocked").withArgs(id);

    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeRevokeRecipient(id))
      .to.emit(f.wallet, "RecipientRevoked").withArgs(r);
    expect(await f.wallet.isRecipientAllowed(r)).to.equal(false);
  });

  it("refuses an already-allowed address, zero, and the wallet itself", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.wallet.connect(f.o1).proposeAllowRecipient(ethers.ZeroAddress, "x"))
      .to.be.revertedWithCustomError(f.wallet, "ZeroAddress");
    await expect(f.wallet.connect(f.o1).proposeAllowRecipient(f.addr, "x"))
      .to.be.revertedWithCustomError(f.wallet, "SelfRecipient");
    await expect(f.wallet.connect(f.o1).proposeRevokeRecipient(f.recipient.address))
      .to.be.revertedWithCustomError(f.wallet, "NotAllowed").withArgs(f.recipient.address);
  });
});

describe("Registry — the recipient requirement actually binds", () => {
  /** A wallet in the posture this contract is built for: strict recipients, one cold address. */
  async function strict() {
    const [deployer, o1, o2, o3, outsider, cold, spare] = await ethers.getSigners();
    const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
    const nft = await (await ethers.getContractFactory("MockERC721")).deploy("Art", "ART");
    const multi = await (await ethers.getContractFactory("MockERC1155")).deploy();
    const wallet = await deployWallet([o1.address, o2.address, o3.address], {
      requireRecipient: true,
      recipients: [[cold.address, "my cold wallet"]],
    });
    const addr = await wallet.getAddress();
    await deployer.sendTransaction({ to: addr, value: eth(10) });
    await usdt.mint(addr, u6(1000));
    for (let i = 1; i <= 3; i++) await nft.mint(addr, i);
    await multi.mint(addr, 1, 100);
    return { wallet, addr, deployer, o1, o2, o3, outsider, cold, spare, usdt, nft, multi };
  }

  it("the seeded cold address works from block one — the escape hatch", async () => {
    const f = await strict();
    expect(await f.wallet.isRecipientAllowed(f.cold.address)).to.equal(true);
    const [list, labels] = await f.wallet.allowedRecipients();
    expect(list).to.deep.equal([f.cold.address]);
    expect(labels).to.deep.equal(["my cold wallet"]);

    await f.wallet.connect(f.o1).proposeNative(f.cold.address, eth(1), HOUR);
    const id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeNative(id)).to.emit(f.wallet, "NativeSent");
  });

  it("blocks every outgoing path to an unlisted address, at PROPOSE time", async () => {
    const f = await strict();
    const bad = f.outsider.address;
    const E = "RecipientNotAllowed";
    await expect(f.wallet.connect(f.o1).proposeNative(bad, eth(1), HOUR))
      .to.be.revertedWithCustomError(f.wallet, E).withArgs(bad);
    await expect(f.wallet.connect(f.o1).proposeERC20(await f.usdt.getAddress(), bad, u6(1), HOUR))
      .to.be.revertedWithCustomError(f.wallet, E).withArgs(bad);
    await expect(f.wallet.connect(f.o1).proposeERC721(await f.nft.getAddress(), bad, 1, HOUR))
      .to.be.revertedWithCustomError(f.wallet, E).withArgs(bad);
    await expect(f.wallet.connect(f.o1).proposeERC1155(await f.multi.getAddress(), bad, 1, 1, HOUR))
      .to.be.revertedWithCustomError(f.wallet, E).withArgs(bad);
    await expect(f.wallet.connect(f.o1).proposeNFTBatch(bad,
      [{ token: await f.nft.getAddress(), standard: Std.ERC721, id: 1, amount: 0 }], HOUR))
      .to.be.revertedWithCustomError(f.wallet, E).withArgs(bad);
  });

  it(" revoking a recipient blocks transfers that were ALREADY approved, on every path", async () => {
    const f = await strict();
    const c = f.cold.address;
    const ids = [];
    await f.wallet.connect(f.o1).proposeNative(c, eth(1), 10 * DAY);
    ids.push([await f.wallet.proposalCount(), "executeNative"]);
    await f.wallet.connect(f.o1).proposeERC20(await f.usdt.getAddress(), c, u6(10), 10 * DAY);
    ids.push([await f.wallet.proposalCount(), "executeERC20"]);
    await f.wallet.connect(f.o1).proposeERC721(await f.nft.getAddress(), c, 1, 10 * DAY);
    ids.push([await f.wallet.proposalCount(), "executeERC721"]);
    await f.wallet.connect(f.o1).proposeERC1155(await f.multi.getAddress(), c, 1, 5, 10 * DAY);
    ids.push([await f.wallet.proposalCount(), "executeERC1155"]);
    await f.wallet.connect(f.o1).proposeNFTBatch(c,
      [{ token: await f.nft.getAddress(), standard: Std.ERC721, id: 2, amount: 0 }], 10 * DAY);
    ids.push([await f.wallet.proposalCount(), "executeNFTBatch"]);
    for (const [id] of ids) await f.wallet.connect(f.o2).confirm(id);

    await f.wallet.connect(f.o1).proposeRevokeRecipient(c);
    const rev = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(rev);
    await f.wallet.connect(f.o1).executeRevokeRecipient(rev);

    for (const [id, exec] of ids) {
      await expect(f.wallet.connect(f.o1)[exec](id))
        .to.be.revertedWithCustomError(f.wallet, "RecipientNotAllowed").withArgs(c);
    }
  });

  it(" an owner's own address is NOT an allowed recipient by default", async () => {
    // Deliberate: if an owner address were automatically a valid destination, a compromised
    // owner could simply send everything to themselves and the allowlist would be decoration.
    const f = await strict();
    for (const o of [f.o1, f.o2, f.o3]) {
      expect(await f.wallet.isRecipientAllowed(o.address)).to.equal(false);
      await expect(f.wallet.connect(f.o1).proposeNative(o.address, eth(1), HOUR))
        .to.be.revertedWithCustomError(f.wallet, "RecipientNotAllowed").withArgs(o.address);
    }
  });
});

describe("Policy — tightening is instant, loosening is slow and vetoable", () => {
  it("starts at the documented default", async () => {
    const { wallet } = await loadFixture(deployFixture);
    expect(await wallet.delay()).to.equal(BigInt(DELAY));
    expect(await wallet.MIN_DELAY()).to.equal(BigInt(MIN_DELAY));
    expect(await wallet.MAX_DELAY()).to.equal(BigInt(MAX_DELAY));
    expect(await wallet.DEFAULT_DELAY()).to.equal(BigInt(DELAY));
    expect(await wallet.UNANIMOUS()).to.equal(3n);
  });

  it("switching a requirement ON takes effect at once", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.wallet.requireAllowedRecipient()).to.equal(false);
    await f.wallet.connect(f.o1).proposeSetPolicy(DELAY, true, true);
    const id = await f.wallet.proposalCount();
    expect(await f.wallet.effectiveAt(id)).to.equal(0n); // tightening — not timelocked
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeSetPolicy(id))
      .to.emit(f.wallet, "PolicyChanged").withArgs(DELAY, true, true);
    expect(await f.wallet.requireAllowedRecipient()).to.equal(true);
    expect(await f.wallet.requireAllowedToken()).to.equal(true);
  });

  it("a LONGER delay takes effect at once and is not vetoable", async () => {
    const f = await loadFixture(deployFixture);
    await f.wallet.connect(f.o1).proposeSetPolicy(10 * DAY, false, false);
    const id = await f.wallet.proposalCount();
    expect(await f.wallet.effectiveAt(id)).to.equal(0n);
    await expect(f.wallet.connect(f.o3).veto(id))
      .to.be.revertedWithCustomError(f.wallet, "NotTimelocked").withArgs(id);
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o1).executeSetPolicy(id);
    expect(await f.wallet.delay()).to.equal(BigInt(10 * DAY));
  });

  it(" a SHORTER delay is timelocked by the CURRENT delay, and vetoable", async () => {
    // Otherwise an attacker sets the delay to the minimum and proceeds immediately.
    const f = await loadFixture(deployFixture);
    await f.wallet.connect(f.o1).proposeSetPolicy(MIN_DELAY, false, false);
    const id = await f.wallet.proposalCount();
    expect(await f.wallet.effectiveAt(id)).to.be.greaterThan(0n);
    await f.wallet.connect(f.o2).confirm(id);

    await expect(f.wallet.connect(f.o1).executeSetPolicy(id))
      .to.be.revertedWithCustomError(f.wallet, "TimelockNotElapsed");
    await expect(f.wallet.connect(f.o3).veto(id)).to.emit(f.wallet, "Vetoed");

    await time.increase(DELAY + 1);
    await expect(f.wallet.connect(f.o1).executeSetPolicy(id))
      .to.be.revertedWithCustomError(f.wallet, "ProposalCancelled").withArgs(id);
    expect(await f.wallet.delay()).to.equal(BigInt(DELAY)); // unchanged
  });

  it(" switching a requirement OFF is timelocked and vetoable", async () => {
    const f = await loadFixture(deployFixture);
    // Turn it on first (instant), then try to turn it off.
    await f.wallet.connect(f.o1).proposeSetPolicy(DELAY, true, false);
    let id = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(id);
    await f.wallet.connect(f.o1).executeSetPolicy(id);
    expect(await f.wallet.requireAllowedRecipient()).to.equal(true);

    await f.wallet.connect(f.o1).proposeSetPolicy(DELAY, false, false);
    id = await f.wallet.proposalCount();
    expect(await f.wallet.effectiveAt(id)).to.be.greaterThan(0n);
    await f.wallet.connect(f.o2).confirm(id);
    await expect(f.wallet.connect(f.o1).executeSetPolicy(id))
      .to.be.revertedWithCustomError(f.wallet, "TimelockNotElapsed");

    await time.increase(DELAY + 1);
    await f.wallet.connect(f.o1).executeSetPolicy(id);
    expect(await f.wallet.requireAllowedRecipient()).to.equal(false);
  });

  it("the delay is clamped to its floor and its ceiling, both forever", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.wallet.connect(f.o1).proposeSetPolicy(MIN_DELAY - 1, false, false))
      .to.be.revertedWithCustomError(f.wallet, "BadDelay").withArgs(MIN_DELAY - 1);
    await expect(f.wallet.connect(f.o1).proposeSetPolicy(MAX_DELAY + 1, false, false))
      .to.be.revertedWithCustomError(f.wallet, "BadDelay").withArgs(MAX_DELAY + 1);
    await expect(f.wallet.connect(f.o1).proposeSetPolicy(0, false, false))
      .to.be.revertedWithCustomError(f.wallet, "BadDelay").withArgs(0);
    // Both bounds are compile-time constants, so there is no path to move them.
    await expect(f.wallet.connect(f.o1).proposeSetPolicy(MIN_DELAY, false, false)).to.not.be.reverted;
  });

  it("refuses a proposal that changes nothing", async () => {
    const f = await loadFixture(deployFixture);
    await expect(f.wallet.connect(f.o1).proposeSetPolicy(DELAY, false, false))
      .to.be.revertedWithCustomError(f.wallet, "NoPolicyChange");
  });

  it("a new delay applies to NEW proposals; ones already pending keep their own schedule", async () => {
    const f = await loadFixture(deployFixture);
    // Pending proposal scheduled at the old 72 h.
    await f.wallet.connect(f.o1).proposeAllowRecipient(f.recipient.address, "cold");
    const first = await f.wallet.proposalCount();
    const firstEff = await f.wallet.effectiveAt(first);

    // Lengthen the delay — instant.
    await f.wallet.connect(f.o1).proposeSetPolicy(10 * DAY, false, false);
    const pol = await f.wallet.proposalCount();
    await f.wallet.connect(f.o2).confirm(pol);
    await f.wallet.connect(f.o1).executeSetPolicy(pol);

    expect(await f.wallet.effectiveAt(first)).to.equal(firstEff); // untouched

    // The new proposal is scheduled at the NEW delay, measured from its own block.
    const tx = await f.wallet.connect(f.o1).proposeAllowRecipient(f.spare.address, "second");
    const second = await f.wallet.proposalCount();
    const ts = (await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp;
    expect(await f.wallet.effectiveAt(second)).to.equal(BigInt(ts + 10 * DAY));
    expect(await f.wallet.delay()).to.equal(BigInt(10 * DAY));
  });

  it("the constructor refuses mismatched seed arrays", async () => {
    const [, o1, o2, o3, x] = await ethers.getSigners();
    const W = await ethers.getContractFactory("PersonalWallet");
    await expect(W.deploy([o1.address, o2.address, o3.address], false, false,
      [x.address], [], [], [])).to.be.revertedWithCustomError(W, "LengthMismatch");
    await expect(W.deploy([o1.address, o2.address, o3.address], false, false,
      [], [], [x.address], [])).to.be.revertedWithCustomError(W, "LengthMismatch");
  });
});

describe(" THE SCENARIO THIS VERSION EXISTS FOR — two compromised keys", () => {
  it("cannot steal: every path is refused, and the funds can only reach the owner's own cold address", async () => {
    const [deployer, o1, o2, o3, attacker, cold] = await ethers.getSigners();
    // Strict posture, with one cold address seeded — the escape hatch.
    const wallet = await deployWallet([o1.address, o2.address, o3.address], {
      requireRecipient: true,
      recipients: [[cold.address, "my cold wallet"]],
    });
    const addr = await wallet.getAddress();
    await deployer.sendTransaction({ to: addr, value: eth(100) });

    // o1 and o2 are compromised. o3 is honest and watching.
    // 1 · send straight to the attacker — refused outright.
    await expect(wallet.connect(o1).proposeNative(attacker.address, eth(100), HOUR))
      .to.be.revertedWithCustomError(wallet, "RecipientNotAllowed").withArgs(attacker.address);

    // 2 · allowlist the attacker's address — needs all three; two cannot get there.
    await wallet.connect(o1).proposeAllowRecipient(attacker.address, "payroll");
    const allow = await wallet.proposalCount();
    await wallet.connect(o2).confirm(allow);
    await time.increase(DELAY + 1);
    await expect(wallet.connect(o1).executeAllowRecipient(allow))
      .to.be.revertedWithCustomError(wallet, "NotEnoughConfirmations").withArgs(allow, 2n, 3n);

    // 3 · switch the requirement off — timelocked, and o3 vetoes it.
    await wallet.connect(o1).proposeSetPolicy(DELAY, false, false);
    const pol = await wallet.proposalCount();
    await wallet.connect(o2).confirm(pol);
    await wallet.connect(o3).veto(pol);
    await time.increase(DELAY + 1);
    await expect(wallet.connect(o1).executeSetPolicy(pol))
      .to.be.revertedWithCustomError(wallet, "ProposalCancelled").withArgs(pol);

    // 4 · remove the honest owner to get all three seats — timelocked, and o3 vetoes.
    await wallet.connect(o1).proposeOwnerReplacement(o3.address, attacker.address);
    const swap = await wallet.proposalCount();
    await wallet.connect(o2).confirm(swap);
    await wallet.connect(attacker).acceptOwnerReplacement(swap);
    await wallet.connect(o3).veto(swap);
    await time.increase(DELAY + 1);
    await expect(wallet.connect(o1).executeOwnerReplacement(swap))
      .to.be.revertedWithCustomError(wallet, "ProposalCancelled").withArgs(swap);
    expect(await wallet.isOwner(o3.address)).to.equal(true);
    expect(await wallet.isOwner(attacker.address)).to.equal(false);

    // Nothing moved, and the attacker holds nothing.
    expect(await wallet.nativeBalance()).to.equal(eth(100));

    // 5 · what two keys CAN still do: push the money to the owner's own cold address.
    //  Annoying, but it is not theft — which is the whole point of the design.
    const before = await ethers.provider.getBalance(cold.address);
    await wallet.connect(o1).proposeNative(cold.address, eth(100), HOUR);
    const out = await wallet.proposalCount();
    await wallet.connect(o2).confirm(out);
    await wallet.connect(o1).executeNative(out);
    expect(await ethers.provider.getBalance(cold.address) - before).to.equal(eth(100));
    expect(await wallet.nativeBalance()).to.equal(0n);
  });
});
