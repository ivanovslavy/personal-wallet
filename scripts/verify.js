/**
 * Source verification for every network this project targets.
 *
 *  npx hardhat run scripts/verify.js --network gembatestnet          # the whole latest record
 *  ADDRESS=0x… npx hardhat run scripts/verify.js --network sepolia    # just one contract
 *  RECORD=deployed/gembatestnet_2026-10-12_09-41-23.json npx hardhat run scripts/verify.js --network gembatestnet
 *
 * It reads `deployed/<network>-latest.json` (or RECORD) so the constructor arguments come from
 * what was actually deployed instead of being retyped — a wrong argument is the usual reason a
 * verification "mysteriously" fails.
 *
 * TWO BACKENDS, because one does not cover both families — established empirically on
 * 2026-10-12, not assumed:
 *
 *  • gembascan is **Blockscout v9.0.2**. `hardhat verify` fails against it with an empty error
 *  message. What works is Blockscout's own v2 endpoint,
 *  POST /api/v2/smart-contracts/{address}/verification/via/standard-input,
 *  with the standard-json file sent in a field named `files[0]` — plain `files` is rejected
 *  with {"message":"JSON files not found"}. No API key is needed.
 *  • Ethereum, Sepolia, BSC and Polygon are the Etherscan family, where hardhat-verify's
 *  Etherscan **V2** support works with the single ETHERSCAN_API_KEY.
 *
 * Sourcify is deliberately disabled in hardhat.config.js: this plugin version speaks Sourcify
 * API v1, which upstream removed (every call 404s).
 */
const { ethers, network, run, config } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { readRecord, markVerified } = require("./lib/record");

const BLOCKSCOUT = { gembatestnet: "https://gembascan.io" };

const c = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (s, e = "") => console.log(`  ${c.g}${c.x} ${s} ${c.d}${e}${c.x}`);
const warn = (s, e = "") => console.log(`  ${c.y}!${c.x} ${s} ${c.d}${e}${c.x}`);
const bad = (s, e = "") => console.log(`  ${c.r}${c.x} ${s}\n      ${c.r}${e}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Finds the build-info that compiled a given source file, and returns its standard JSON input. */
function standardInputFor(sourceName) {
  const dir = path.join(__dirname, "..", "artifacts", "build-info");
  if (!fs.existsSync(dir)) throw new Error("no artifacts/build-info — run `npx hardhat compile` first");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (j.input?.sources?.[sourceName]) {
      return { input: j.input, solcLongVersion: j.solcLongVersion, file: f };
    }
  }
  throw new Error(`no build-info contains ${sourceName}`);
}

/** Is this address already verified? Asked through the Etherscan-compatible read endpoint. */
async function alreadyVerified(base, address) {
  try {
    const r = await fetch(`${base}/api?module=contract&action=getsourcecode&address=${address}`);
    const j = await r.json();
    const row = j?.result?.[0];
    return Boolean(row?.SourceCode) ? { name: row.ContractName, bytes: row.SourceCode.length } : null;
  } catch {
    return null;
  }
}

/** Blockscout v2: upload the standard JSON input and poll until the explorer confirms. */
async function verifyBlockscout(base, contract) {
  const existing = await alreadyVerified(base, contract.address);
  if (existing) { ok(`${contract.name} already verified`, `${existing.name} · ${existing.bytes} bytes of source`); return "already"; }

  const sourceName = contract.fullyQualifiedName.split(":")[0];
  const { input, solcLongVersion } = standardInputFor(sourceName);

  // Encode the constructor arguments from the contract's own ABI, so the encoding cannot drift
  // from the deployed bytecode.
  const artifact = await require("hardhat").artifacts.readArtifact(contract.fullyQualifiedName);
  const ctor = artifact.abi.find((f) => f.type === "constructor");
  let encoded = "";
  if (ctor && ctor.inputs.length > 0) {
    encoded = ethers.AbiCoder.defaultAbiCoder()
      .encode(ctor.inputs.map((i) => i.type), contract.constructorArgs).slice(2);
  }

  const fd = new FormData();
  fd.append("compiler_version", `v${solcLongVersion}`);
  fd.append("autodetect_constructor_args", "false");
  if (encoded) fd.append("constructor_args", encoded);
  fd.append("license_type", "mit");
  // Name the contract explicitly. Without it, Blockscout's verifier has to pick a match out of a
  // whole standard-json input, and when one .sol file holds several contracts it can fail to
  // settle on one — observed 2026-10-12: ReentrancyAttacker stayed unverified while three other
  // contracts from the SAME file verified, and its on-chain code matched the artefact byte for
  // byte. Passing the fully-qualified name removes the guesswork.
  fd.append("contract_name", contract.fullyQualifiedName);
  // The field name MUST be files[0]. `files` returns {"message":"JSON files not found"}.
  fd.append("files[0]", new Blob([JSON.stringify(input)], { type: "application/json" }), `${contract.name}.json`);

  const url = `${base}/api/v2/smart-contracts/${contract.address}/verification/via/standard-input`;
  const res = await fetch(url, { method: "POST", body: fd });
  const body = await res.text();
  if (!res.ok) { bad(`${contract.name} — the explorer refused the request`, `HTTP ${res.status} ${body.slice(0, 200)}`); return false; }

  // "started" is not "verified". Poll for the source actually appearing.
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const now = await alreadyVerified(base, contract.address);
    if (now) { ok(`${contract.name} verified`, `${now.bytes} bytes of source · ${base}/address/${contract.address}#code`); return true; }
  }
  warn(`${contract.name} — accepted but not confirmed within 60 s`, `check ${base}/address/${contract.address}#code`);
  return "pending";
}

/**
 * Etherscan family, through hardhat-verify (API V2, one key for all of them).
 *
 * Retries while Etherscan says the address has no bytecode: its indexer lags a fresh deployment by
 * a minute or two, and treating that as a failure means a perfectly good contract is reported
 * unverified because the explorer was simply behind.
 */
async function verifyEtherscan(contract) {
  if (!process.env.ETHERSCAN_API_KEY) {
    warn(`${contract.name} skipped`, "ETHERSCAN_API_KEY is not set in .env");
    return "skipped";
  }
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await run("verify:verify", {
        address: contract.address,
        constructorArguments: contract.constructorArgs,
        contract: contract.fullyQualifiedName,
      });
      ok(`${contract.name} verified`, attempt > 1 ? `on attempt ${attempt}` : "");
      return true;
    } catch (e) {
      const m = String(e.message || e);
      if (/already verified/i.test(m)) { ok(`${contract.name} already verified`); return "already"; }
      const indexing = /does not have bytecode|unable to locate|not found|pending in queue/i.test(m);
      if (indexing && attempt < 8) {
        warn(`${contract.name}: the explorer has not indexed it yet`, `attempt ${attempt}/8, waiting 20 s`);
        await sleep(20_000);
        continue;
      }
      bad(`${contract.name} failed`, m.split("\n").slice(0, 3).join(" · "));
      return false;
    }
  }
  return false;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const { path: recPath, data: rec } = readRecord(network.name, process.env.RECORD);

  console.log(`\nnetwork : ${network.name} (chainId ${net.chainId})`);
  console.log(`record  : ${recPath}`);
  console.log(`deployed: ${rec.localTime || rec.deployedAt}\n`);

  if (Number(rec.chainId) !== Number(net.chainId)) {
    throw new Error(`the record is for chainId ${rec.chainId}, but --network ${network.name} is ${net.chainId}`);
  }

  let targets = rec.contracts || [];
  if (process.env.ADDRESS) {
    const want = process.env.ADDRESS.toLowerCase();
    targets = targets.filter((t) => t.address.toLowerCase() === want);
    if (targets.length === 0) throw new Error(`${process.env.ADDRESS} is not in ${recPath}`);
  }
  if (process.env.ONLY) {
    const names = process.env.ONLY.split(",").map((s) => s.trim());
    targets = targets.filter((t) => names.includes(t.name));
  }
  if (targets.length === 0) throw new Error("nothing to verify");

  const base = BLOCKSCOUT[network.name];
  console.log(`backend : ${base ? `Blockscout (${base})` : "Etherscan API V2 via hardhat-verify"}`);
  console.log(`targets : ${targets.length}\n`);

  let good = 0, failed = 0;
  for (const t of targets) {
    // Refuse to verify an address with no code — otherwise the explorer's "pending" is mistaken
    // for a slow queue when in fact nothing is deployed there.
    const code = await ethers.provider.getCode(t.address);
    if (code === "0x") { bad(`${t.name} at ${t.address}`, "there is no contract at this address"); failed++; continue; }

    const r = base ? await verifyBlockscout(base, t) : await verifyEtherscan(t);
    markVerified(recPath, t.address, { result: r === true ? "verified" : String(r), at: new Date().toISOString() });
    r === false ? failed++ : good++;
  }

  console.log(`\n${good} verified or already verified · ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

process.on("unhandledRejection", (e) => { console.error("\nUNHANDLED:", e); process.exitCode = 1; });
main().catch((e) => { console.error(`\n${c.r}FAILED: ${e?.message ?? e}${c.x}`); process.exitCode = 1; });
