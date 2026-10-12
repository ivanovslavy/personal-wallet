/**
 * Writes the wallet's ABI and event signatures to listeners/abi/ as a committed artefact.
 *
 *   npx hardhat run scripts/export-abi.js
 *
 * Why: the listeners need the ABI to decode logs, but `artifacts/` is build output — gitignored,
 * and reproducing it on the Raspberry Pi would mean installing Hardhat and a solc download for a
 * service whose only real dependencies are ethers and nodemailer. Exporting the ABI keeps the Pi
 * install to three packages and keeps the repo self-contained.
 *
 * The file records the compiler settings and the bytecode hash it came from, so a stale ABI is
 * detectable rather than silently wrong.
 */
const { artifacts, ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const art = await artifacts.readArtifact("PersonalWallet");
  const sol = require("../hardhat.config.js").solidity;
  const iface = new ethers.Interface(art.abi);

  const events = art.abi.filter((f) => f.type === "event").map((f) => {
    const sig = `${f.name}(${f.inputs.map((i) => i.type).join(",")})`;
    return { name: f.name, signature: sig, topic0: ethers.id(sig) };
  });

  const out = {
    contract: "PersonalWallet",
    sourceName: art.sourceName,
    exportedAt: new Date().toISOString(),
    compiler: {
      version: sol.version,
      optimizer: sol.settings.optimizer,
      evmVersion: sol.settings.evmVersion,
      viaIR: sol.settings.viaIR,
    },
    // Lets a listener notice it is decoding with an ABI from different bytecode.
    deployedBytecodeKeccak: ethers.keccak256(art.deployedBytecode),
    deployedBytecodeSize: (art.deployedBytecode.length - 2) / 2,
    eventCount: events.length,
    events,
    abi: art.abi,
  };

  const dir = path.join(__dirname, "..", "listeners", "abi");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "PersonalWallet.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");

  console.log(`wrote ${file}`);
  console.log(`  ${art.abi.length} ABI entries · ${events.length} events`);
  console.log(`  runtime ${out.deployedBytecodeSize} B · keccak ${out.deployedBytecodeKeccak.slice(0, 18)}…`);
  console.log(`  events: ${events.map((e) => e.name).join(", ")}`);
  void iface;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
