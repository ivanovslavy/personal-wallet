/**
 * Deploys the test tokens to a testnet, so the wallet can be exercised with assets that can be
 * minted freely — alongside the real faucet tokens, which cannot.
 *
 *   npx hardhat run scripts/deploy-mocks.js --network gembatestnet
 *
 * Testnets only. The guard below refuses mainnet, Ethereum, BSC and Polygon outright: these are
 * deliberately broken tokens (one of them reports success and moves nothing) and nothing good
 * comes of them existing on a chain where someone might mistake them for the real thing.
 */
const { ethers, network, artifacts } = require("hardhat");
const { DeployRecord } = require("./lib/record");

const MOCKS = [
  ["MockUSDT", [], "Tether USD (mock, 6 dec, returns no bool)"],
  ["MockUSDC", [], "USD Coin (mock, 6 dec, blocklist)"],
  ["MockEURC", [], "Euro Coin (mock, 6 dec, pausable)"],
  ["MockERC721", ["Gemba Wallet Test NFT", "GWTEST"], "test NFT collection"],
  ["MockERC1155", [], "test multi-token collection"],
];

const MAINNETS = new Set(["mainnet", "bsc", "polygon"]);

async function main() {
  if (MAINNETS.has(network.name)) {
    throw new Error(`refusing to deploy mock tokens to ${network.name} — these are deliberately broken test tokens`);
  }
  const [dep] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(dep.address);
  console.log(`network : ${network.name} (chainId ${net.chainId})`);
  console.log(`deployer: ${dep.address}  ${ethers.formatEther(bal)}`);
  if (bal === 0n) throw new Error("the deployer has no balance");

  const sol = require("../hardhat.config.js").solidity;
  const compiler = {
    version: sol.version, optimizer: sol.settings.optimizer,
    evmVersion: sol.settings.evmVersion, viaIR: sol.settings.viaIR,
  };
  const rec = new DeployRecord(network.name, net.chainId, dep.address, { run: "mock-tokens" });

  const out = {};
  for (const [name, args, note] of MOCKS) {
    const ct = await (await ethers.getContractFactory(name)).deploy(...args);
    await ct.waitForDeployment();
    const rc = await ct.deploymentTransaction().wait();
    const addr = await ct.getAddress();
    const art = await artifacts.readArtifact(name);
    rec.add({ name, sourceName: art.sourceName, address: addr, receipt: rc, constructorArgs: args, compiler });
    out[name] = addr;
    console.log(`  ${name.padEnd(12)} ${addr}  gas ${rc.gasUsed}   ${note}`);
  }

  const { file } = rec.write();
  console.log(`\nrecord: ${file}`);
  // Printed in the shape the wallet deployment wants, so the two steps chain without retyping.
  const list = Object.entries(out).map(([n, a]) => `${a}:${n} (mock)`).join(",");
  console.log(`\nTOKENS="${list}"`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
