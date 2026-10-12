const hre = require("hardhat");
const { expect } = require("chai");

/**
 * SURFACE COVERAGE — measured from what the suite actually sent to the chain.
 *
 * `solidity-coverage` cannot run on this contract: its instrumented artefact measured 81 783 B,
 * and 64 307 B with the Yul optimizer forced on, against the 49 152 B initcode cap that Cancun
 * enforces through EIP-3860. No Hardhat setting lifts that (`allowUnlimitedContractSize` only
 * touches the EIP-170 runtime cap), and the build cannot target a pre-Shanghai EVM because
 * OpenZeppelin 5.6 emits `mcopy`. Nothing was removed from the contract to please the tool.
 *
 * So the measurement comes from the provider hook in hardhat.config.js instead:
 *   · every selector sent to a PersonalWallet instance — the function RAN;
 *   · every custom-error selector returned by a revert — the guard FIRED.
 *
 * This is a gate, not a report: an entry point nobody calls, or a revert nobody triggers, fails
 * the suite. It says less than line coverage about branches inside a function, and more than it
 * about whether each guard is real.
 */
const art = require("../artifacts/contracts/PersonalWallet.sol/PersonalWallet.json");
const RUNTIME = art.deployedBytecode.toLowerCase();

// Canonical signature. A tuple must be expanded into its components — using the ABI's literal
// "tuple[]" produces the wrong selector, which made the batch functions look uncalled.
const fmt = (i) => (i.type.startsWith("tuple")
  ? `(${i.components.map(fmt).join(",")})${i.type.slice(5)}`
  : i.type);
const sig = (f) => `${f.name}(${f.inputs.map(fmt).join(",")})`;
const FNS = new Map(art.abi.filter((f) => f.type === "function")
  .map((f) => [hre.ethers.id(sig(f)).slice(0, 10), sig(f)]));
const ERRS = new Map(art.abi.filter((f) => f.type === "error")
  .map((f) => [hre.ethers.id(sig(f)).slice(0, 10), sig(f)]));

after(function () {
  const b = globalThis.__surface;
  expect(b, "the provider hook in hardhat.config.js did not run").to.not.equal(undefined);

  // Only traffic to an address whose code IS PersonalWallet counts; mocks share some selectors.
  const wallets = new Set([...b.tos].filter(([, code]) => String(code).toLowerCase() === RUNTIME).map(([a]) => a));
  const called = new Set();
  let sawReceive = false, sawFallback = false;
  for (const entry of b.selectors) {
    const [to, sel] = entry.split("|");
    if (!wallets.has(to)) continue;
    if (sel === "0x") { sawReceive = true; continue; }
    if (FNS.has(sel)) called.add(sel);
    else sawFallback = true; // calldata matching no function reached fallback()
  }
  const thrown = new Set([...b.errors].filter((s) => ERRS.has(s)));

  const missingFns = [...FNS].filter(([s]) => !called.has(s)).map(([, v]) => v);
  const missingErrs = [...ERRS].filter(([s]) => !thrown.has(s)).map(([, v]) => v);

  console.log("\n  ── surface coverage (observed traffic, not instrumentation) ─────────────");
  console.log(`  PersonalWallet instances seen : ${wallets.size}`);
  console.log(`  external functions invoked    : ${called.size}/${FNS.size}  (${(100 * called.size / FNS.size).toFixed(1)}%)`);
  console.log(`  custom errors returned        : ${thrown.size}/${ERRS.size}  (${(100 * thrown.size / ERRS.size).toFixed(1)}%)`);
  console.log(`  receive() / fallback()        : ${sawReceive ? "yes" : "NO"} / ${sawFallback ? "yes" : "NO"}`);
  if (missingFns.length) console.log(`  NEVER CALLED : ${missingFns.join(", ")}`);
  if (missingErrs.length) console.log(`  NEVER THROWN : ${missingErrs.join(", ")}`);
  console.log("  ────────────────────────────────────────────────────────────────────────\n");

  expect(missingFns, "external functions never invoked by the suite").to.deep.equal([]);
  expect(missingErrs, "custom errors never returned to the suite").to.deep.equal([]);
  expect(sawReceive, "receive() was never exercised").to.equal(true);
  expect(sawFallback, "fallback() was never exercised").to.equal(true);
});
