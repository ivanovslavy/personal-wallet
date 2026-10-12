const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const HOUR = 3600;
const DAY = 86400;
// Mirrors the contract's constants.
const DELAY = 72 * HOUR;        // DEFAULT_DELAY
const MIN_DELAY = 24 * HOUR;
const MAX_DELAY = 30 * DAY;
const EXEC_WINDOW = 7 * DAY;    // EXECUTION_WINDOW

// Proposal.kind — must match the enum order in PersonalWallet.sol
const Kind = {
  NATIVE: 0n,
  ERC20: 1n,
  ERC721: 2n,
  ERC1155: 3n,
  NFT_BATCH: 4n,
  OWNER_REPLACE: 5n,
  ALLOW_TOKEN: 6n,
  REVOKE_TOKEN: 7n,
  ALLOW_RECIPIENT: 8n,
  REVOKE_RECIPIENT: 9n,
  SET_POLICY: 10n,
};

// BatchItem.standard
const Std = { ERC721: 0, ERC1155: 1 };

const u6 = (n) => ethers.parseUnits(String(n), 6);
const eth = (n) => ethers.parseEther(String(n));

/**
 * The world every test starts from: a funded wallet with three owners, a fourth account that is
 * NOT an owner, all three stablecoin mocks, an NFT collection and a multi-token collection.
 */
async function deployFixture() {
  const [deployer, o1, o2, o3, outsider, recipient, spare] = await ethers.getSigners();

  const Wallet = await ethers.getContractFactory("PersonalWallet");
  // Both allowlists OFF in the default fixture, so the asset and multisig suites measure the
  // wallet's own behaviour. The registry suite switches them on explicitly.
  const wallet = await Wallet.deploy(...ctorArgs([o1.address, o2.address, o3.address]));
  await wallet.waitForDeployment();

  const usdt = await (await ethers.getContractFactory("MockUSDT")).deploy();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const eurc = await (await ethers.getContractFactory("MockEURC")).deploy();
  const nft = await (await ethers.getContractFactory("MockERC721")).deploy("Gemba Art", "GART");
  const nft2 = await (await ethers.getContractFactory("MockERC721")).deploy("Second Set", "SET2");
  const multi = await (await ethers.getContractFactory("MockERC1155")).deploy();

  const addr = await wallet.getAddress();

  // Fund the wallet: native, 1 000 of each stablecoin, NFTs #1–#5, and 1155 ids 1 and 2.
  await deployer.sendTransaction({ to: addr, value: eth(100) });
  await usdt.mint(addr, u6(1000));
  await usdc.mint(addr, u6(1000));
  await eurc.mint(addr, u6(1000));
  for (let i = 1; i <= 5; i++) await nft.mint(addr, i);
  for (let i = 11; i <= 13; i++) await nft2.mint(addr, i);
  await multi.mint(addr, 1, 100);
  await multi.mint(addr, 2, 50);

  return {
    wallet, addr, deployer, o1, o2, o3, outsider, recipient, spare,
    usdt, usdc, eurc, nft, nft2, multi,
  };
}

/** Confirm a proposal with a second owner, so it crosses the 2-of-3 threshold. */
async function second(wallet, signer, id) {
  await wallet.connect(signer).confirm(id);
}

/** The id returned by a propose* call — read from the receipt, not guessed. */
async function proposalIdFrom(tx) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const p = (await ethers.getContractFactory("PersonalWallet")).interface.parseLog(log);
      if (p && p.name === "Proposed") return p.args[0];
    } catch { /* not ours */ }
  }
  throw new Error("no Proposed event in receipt");
}

/**
 * The seven constructor arguments, spread-ready. Defaults: both allowlists off, nothing seeded.
 * @param owners three addresses
 * @param o {requireRecipient, requireToken, recipients:[[addr,label]], tokens:[[addr,label]]}
 */
function ctorArgs(owners, o = {}) {
  const r = o.recipients || [];
  const t = o.tokens || [];
  return [
    owners,
    Boolean(o.requireRecipient),
    Boolean(o.requireToken),
    r.map((x) => x[0]), r.map((x) => x[1]),
    t.map((x) => x[0]), t.map((x) => x[1]),
  ];
}

/** Deploy a wallet with explicit registry options. */
async function deployWallet(owners, opts) {
  const W = await ethers.getContractFactory("PersonalWallet");
  const w = await W.deploy(...ctorArgs(owners, opts));
  await w.waitForDeployment();
  return w;
}

/**
 * The full owner-replacement dance, including waiting out the timelock:
 * propose  second confirms  the newcomer accepts  72 h pass  execute.
 */
async function rotateOwner(wallet, { proposer, seconder, outgoing, incoming }) {
  await wallet.connect(proposer).proposeOwnerReplacement(outgoing.address, incoming.address);
  const id = await wallet.proposalCount();
  await wallet.connect(seconder).confirm(id);
  await (incoming.callAccept
    ? incoming.callAccept(id)                       // a contract owner
    : wallet.connect(incoming).acceptOwnerReplacement(id));
  await time.increase(DELAY + 1);
  await wallet.connect(proposer).executeOwnerReplacement(id);
  return id;
}

module.exports = {
  HOUR, DAY, DELAY, MIN_DELAY, MAX_DELAY, EXEC_WINDOW,
  Kind, Std, u6, eth, deployFixture, second, proposalIdFrom, loadFixture,
  ctorArgs, deployWallet, rotateOwner,
};
