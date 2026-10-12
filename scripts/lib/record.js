/**
 * Every deployment is written to `deployed/` as a file named by NETWORK, DATE and TIME, so a
 * record is never overwritten and the history is readable from the filenames alone:
 *
 *  deployed/gembatestnet_2026-10-12_09-41-23.json
 *  deployed/gembatestnet-latest.json       always the most recent run on that network
 *
 * The record carries what verification actually needs — the fully-qualified contract name, the
 * constructor arguments, and the exact compiler settings — because an address alone cannot be
 * verified later, and reconstructing the arguments from memory is how people verify the wrong
 * thing.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DIR = path.join(ROOT, "deployed");

/** Local wall-clock stamp, filename-safe: 2026-10-12_09-41-23 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Local time with the offset spelled out, so a record read in another timezone is unambiguous. */
function localIso(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(off / 60 | 0)}:${p(off % 60)}`;
}

const EXPLORERS = {
  gembatestnet: "https://gembascan.io",
  sepolia: "https://sepolia.etherscan.io",
  mainnet: "https://etherscan.io",
  bsc: "https://bscscan.com",
  polygon: "https://polygonscan.com",
};

class DeployRecord {
  /**
   * @param {string} network hardhat network name
   * @param {number|bigint} chainId
   * @param {string} deployer address paying for the deployments
   * @param {object} [meta] anything extra worth keeping with the run
   */
  constructor(network, chainId, deployer, meta = {}) {
    this.when = new Date();
    this.data = {
      network,
      chainId: Number(chainId),
      deployedAt: this.when.toISOString(),
      localTime: localIso(this.when),
      deployer,
      explorer: EXPLORERS[network] || null,
      ...meta,
      contracts: [],
    };
  }

  /**
   * @param {object} c
   * @param {string} c.name contract name, e.g. "PersonalWallet"
   * @param {string} c.sourceName path of the .sol file, e.g. "contracts/PersonalWallet.sol"
   * @param {string} c.address
   * @param {object} [c.receipt] the deployment receipt
   * @param {any[]} [c.constructorArgs]
   * @param {object} [c.compiler] { version, optimizer, evmVersion }
   */
  add(c) {
    const base = this.data.explorer;
    this.data.contracts.push({
      name: c.name,
      fullyQualifiedName: c.sourceName ? `${c.sourceName}:${c.name}` : c.name,
      address: c.address,
      constructorArgs: c.constructorArgs ?? [],
      txHash: c.receipt?.hash ?? null,
      block: c.receipt?.blockNumber ?? null,
      gasUsed: c.receipt?.gasUsed != null ? c.receipt.gasUsed.toString() : null,
      compiler: c.compiler ?? null,
      explorer: base ? `${base}/address/${c.address}` : null,
      verified: null, // filled in by scripts/verify.js
    });
    return this;
  }

  set(key, value) {
    this.data[key] = value;
    return this;
  }

  /** Writes the timestamped record plus the `-latest` pointer. Returns both paths. */
  write() {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${this.data.network}_${stamp(this.when)}.json`);
    const latest = path.join(DIR, `${this.data.network}-latest.json`);
    const json = JSON.stringify(this.data, null, 2) + "\n";
    fs.writeFileSync(file, json);
    fs.writeFileSync(latest, json);
    return { file, latest };
  }
}

/** Reads a record: an explicit path, else the newest timestamped file for the network. */
function readRecord(network, explicitPath) {
  if (explicitPath) return { path: explicitPath, data: JSON.parse(fs.readFileSync(explicitPath, "utf8")) };
  const latest = path.join(DIR, `${network}-latest.json`);
  if (fs.existsSync(latest)) return { path: latest, data: JSON.parse(fs.readFileSync(latest, "utf8")) };
  if (!fs.existsSync(DIR)) throw new Error(`no deployed/ directory yet — deploy first`);
  const files = fs.readdirSync(DIR)
    .filter((f) => f.startsWith(`${network}_`) && f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no deployment record for network "${network}" in ${DIR}`);
  const p = path.join(DIR, files[files.length - 1]);
  return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
}

/** Writes a verification outcome back into an existing record. */
function markVerified(recordPath, address, outcome) {
  const data = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  for (const c of data.contracts || []) {
    if (c.address.toLowerCase() === address.toLowerCase()) c.verified = outcome;
  }
  fs.writeFileSync(recordPath, JSON.stringify(data, null, 2) + "\n");
}

module.exports = { DeployRecord, readRecord, markVerified, stamp, localIso, DIR, EXPLORERS };
