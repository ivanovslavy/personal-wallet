/**
 * Puts assets into a deployed wallet through the accounted deposit path.
 *
 *   WALLET=0x… npx hardhat run scripts/fund-and-deposit.js --network gembatestnet
 *
 * For each token on the wallet's own allowlist it works out what it can do:
 *   · a mock with a public `mint` — mints what is needed, then deposits
 *   · a faucet token — tries the GembaChain faucet (0.1 GMB + 10 000 per asset, 24 h cooldown)
 *   · anything else — deposits whatever the deployer already holds
 *
 * Reading the allowlist off the chain rather than taking a list on the command line: the wallet
 * is the authority on what it will accept, and a hand-typed list is how the wrong token address
 * gets funded.
 */
const { ethers, network } = require("hardhat");

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];
const ERC721 = [
  "function ownerOf(uint256) view returns (address)",
  "function mint(address,uint256)",
  "function setApprovalForAll(address,bool)",
];
const ERC1155 = [
  "function balanceOf(address,uint256) view returns (uint256)",
  "function mint(address,uint256,uint256)",
  "function setApprovalForAll(address,bool)",
];
const FAUCET_ABI = [
  "function claimToken(address token)",
  "function lastTokenClaim(address,address) view returns (uint256)",
];
const GEMBA_FAUCET = "0x0147581e2351dD182edD651DFEfD955CB353f8aA";

async function main() {
  const addr = process.env.WALLET;
  if (!addr) throw new Error("WALLET is not set");
  const [dep] = await ethers.getSigners();
  const w = await ethers.getContractAt("PersonalWallet", addr, dep);
  const [list, labels] = await w.allowedTokens();

  console.log(`network : ${network.name}`);
  console.log(`wallet  : ${addr}`);
  console.log(`deployer: ${dep.address}`);
  console.log(`allowlisted tokens: ${list.length}\n`);

  for (let i = 0; i < list.length; i++) {
    const t = list[i], label = labels[i];
    // Which standard is it? Asked by behaviour, not guessed from the label.
    let kind = "erc20";
    try { await new ethers.Contract(t, ERC20, dep).decimals(); }
    catch {
      try { await new ethers.Contract(t, ERC1155, dep).balanceOf(dep.address, 1); kind = "erc1155"; }
      catch { kind = "erc721"; }
    }

    try {
      if (kind === "erc20") await doErc20(w, t, label, dep);
      else if (kind === "erc721") await doErc721(w, t, label, dep);
      else await doErc1155(w, t, label, dep);
    } catch (e) {
      console.log(`  ${label.padEnd(26)} FAILED: ${(e.shortMessage || e.message || "").slice(0, 90)}`);
    }
  }

  console.log(`\nwallet now holds ${ethers.formatEther(await w.nativeBalance())} native`);
}

async function doErc20(w, t, label, dep) {
  const c = new ethers.Contract(t, ERC20, dep);
  const [sym, dec] = await Promise.all([c.symbol(), c.decimals()]);
  const want = ethers.parseUnits("1000", dec);
  let bal = await c.balanceOf(dep.address);

  if (bal < want) {
    // A mock with an open mint?
    try {
      await (await c.mint(dep.address, want - bal)).wait();
      bal = await c.balanceOf(dep.address);
      console.log(`  ${label.padEnd(26)} minted to ${ethers.formatUnits(bal, dec)} ${sym}`);
    } catch {
      // Not mintable — try the GembaChain faucet.
      if (network.name === "gembatestnet") {
        try {
          const f = new ethers.Contract(GEMBA_FAUCET, FAUCET_ABI, dep);
          await (await f.claimToken(t)).wait();
          bal = await c.balanceOf(dep.address);
          console.log(`  ${label.padEnd(26)} claimed from the faucet: ${ethers.formatUnits(bal, dec)} ${sym}`);
        } catch (e) {
          const last = await new ethers.Contract(GEMBA_FAUCET, FAUCET_ABI, dep).lastTokenClaim(dep.address, t).catch(() => 0n);
          const why = last > 0n ? `cooldown until ${new Date(Number(last) * 1000 + 86400000).toISOString()}` : (e.shortMessage || "refused");
          console.log(`  ${label.padEnd(26)} no balance and the faucet said no (${String(why).slice(0, 70)})`);
          return;
        }
      }
    }
  }
  if (bal === 0n) { console.log(`  ${label.padEnd(26)} nothing to deposit`); return; }

  const amount = bal < want ? bal : want;
  await (await c.approve(await w.getAddress(), amount)).wait();
  const rc = await (await w.depositERC20(t, amount)).wait();
  const inW = await w.erc20Balance(t);
  console.log(`  ${label.padEnd(26)} deposited ${ethers.formatUnits(amount, dec)} ${sym} -> wallet holds ${ethers.formatUnits(inW, dec)}  tx ${rc.hash.slice(0, 12)}…`);
}

async function doErc721(w, t, label, dep) {
  const c = new ethers.Contract(t, ERC721, dep);
  const W = await w.getAddress();
  const ids = [];
  // Find two free ids to mint, starting high so nothing already minted is hit.
  for (let id = 9001; ids.length < 2 && id < 9100; id++) {
    try { await c.ownerOf(id); } catch { ids.push(id); }
  }
  for (const id of ids) await (await c.mint(dep.address, id)).wait();
  await (await c.setApprovalForAll(W, true)).wait();
  for (const id of ids) {
    const rc = await (await w.depositERC721(t, id)).wait();
    console.log(`  ${label.padEnd(26)} deposited NFT #${id}  tx ${rc.hash.slice(0, 12)}…`);
  }
}

async function doErc1155(w, t, label, dep) {
  const c = new ethers.Contract(t, ERC1155, dep);
  const W = await w.getAddress();
  const id = 9001n, amount = 50n;
  await (await c.mint(dep.address, id, amount)).wait();
  await (await c.setApprovalForAll(W, true)).wait();
  const rc = await (await w.depositERC1155(t, id, amount)).wait();
  console.log(`  ${label.padEnd(26)} deposited ${amount} of id ${id} -> wallet holds ${await w.erc1155Balance(t, id)}  tx ${rc.hash.slice(0, 12)}…`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
