require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const { extendProvider } = require("hardhat/config");

/**
 * SURFACE COVERAGE HOOK.
 *
 * `extendProvider` is the official place to wrap the JSON-RPC chain, and the only one that
 * actually sees everything: patching `hre.network.provider.request` from a test does not
 * intercept, because hardhat-ethers holds its own reference by then (measured 0 of 72 calls).
 *
 * Collects, into a global, every selector sent to a contract and every custom-error selector
 * returned by a revert. `test/00-surface.js` turns that into a pass/fail gate. See that file for
 * why this exists instead of solidity-coverage.
 */
extendProvider(async (provider) => {
  const bucket = (globalThis.__surface ||= { selectors: new Set(), errors: new Set(), tos: new Map() });
  const original = provider.request.bind(provider);
  provider.request = async (args) => {
    const { method, params } = args;
    try {
      if ((method === "eth_sendTransaction" || method === "eth_call") && params && params[0]) {
        const { to, data } = params[0];
        if (to) {
          const key = String(to).toLowerCase();
          if (!bucket.tos.has(key)) {
            bucket.tos.set(key, await original({ method: "eth_getCode", params: [key, "latest"] }));
          }
          bucket.selectors.add(`${key}|${(data || "0x").slice(0, 10).toLowerCase()}`);
        }
      }
    } catch { /* measurement must never break a call */ }
    try {
      return await original(args);
    } catch (e) {
      for (const d of [e?.data, e?.error?.data, e?.info?.error?.data, e?.cause?.data]) {
        const hex = typeof d === "string" ? d : d?.data;
        if (typeof hex === "string" && hex.length >= 10) bucket.errors.add(hex.slice(0, 10).toLowerCase());
      }
      throw e;
    }
  };
  return provider;
});

/**
 * PersonalWallet — Hardhat 2 config, Etherscan **V2** (one API key for every chain).
 *
 * Networks: hardhat (local), gembatestnet, sepolia, mainnet, bsc, polygon.
 */

// An RPC can always be overridden per network with <NETWORK>_RPC_URL in .env. The fallbacks are
// public endpoints, fine for reading and for test traffic; put a private endpoint in .env before
// sending anything that matters on a paid chain.
const RPC_FALLBACKS = {
  gembatestnet: "https://rpc1.gembascan.io",
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  mainnet: "https://eth.llamarpc.com",
  bsc: "https://bsc-dataseed1.binance.org",
  polygon: "https://polygon-rpc.com",
};

/**
 * solidity-coverage cannot instrument IR-compiled code — with viaIR on it reports ~9 % and the
 * number is meaningless. So the coverage run compiles through the LEGACY pipeline instead, which
 * produces the same source semantics but a 26 573 B artefact; that is over EIP-170, which is why
 * the coverage run also lifts the local size limit. Deployment always uses viaIR.
 *  npm run coverage      COVERAGE=true, legacy pipeline, unlimited local size
 */
const COVERAGE = process.env.COVERAGE === "true";

/**
 * Endpoint selection, in order of specificity:
 *   1. <NETWORK>_RPC_URL — someone naming one endpoint explicitly
 *   2. the first entry of <NETWORK>_RPC_URLS — the comma-separated list the project already
 *      maintains for the listeners (and which GembaPay's own rpc-rebuild tool generates after
 *      probing each candidate). Free endpoints come first in that list.
 *   3. a hardcoded public endpoint
 *
 * Hardhat's provider has no fallback of its own: one unreachable endpoint fails the whole task,
 * which is exactly how a Sepolia ERC-20 deposit died mid-script. Reading the maintained list at
 * least means the single endpoint it picks is one that was verified recently. For a task that
 * must not fail on a blip, run `node listeners/probe.js <network>` first and pass the winner as
 * <NETWORK>_RPC_URL.
 */
const getRpcUrl = (networkName) => {
  const upper = networkName.toUpperCase();
  const custom = process.env[`${upper}_RPC_URL`];
  if (custom && custom.trim() !== "") return custom.trim();
  const list = process.env[`${upper}_RPC_URLS`];
  if (list && list.trim() !== "") {
    const first = list.split(",").map((x) => x.trim()).filter(Boolean)[0];
    if (first) return first;
  }
  return RPC_FALLBACKS[networkName] || "";
};

// Key 0 deploys and pays gas. Keys 1–3 are the three owners of the wallet.
// Absent keys are dropped rather than crashing the config, so `hardhat compile` and the local
// tests work on a machine with no .env at all.
const accounts = [
  process.env.PRIVATE_KEY_DEPLOYER,
  process.env.PRIVATE_KEY_OWNER1,
  process.env.PRIVATE_KEY_OWNER2,
  process.env.PRIVATE_KEY_OWNER3,
].filter(Boolean);

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Pinned deliberately, not left to the compiler default. Verified on 2026-10-11 that
      // gembatestnet executes MCOPY (0x5e) and TLOAD (0x5c), so Cancun bytecode runs there;
      // Ethereum, Sepolia, BSC (Pascal) and Polygon (Ahmedabad) are all at or past Cancun.
      // If a future target is older, lower this to "paris" rather than hoping.
      // viaIR is REQUIRED here, not a preference: with the legacy pipeline this contract
      // compiles to 26 573 B and is undeployable (EIP-170 caps runtime code at 24 576 B).
      // Measured 2026-10-12 — legacy runs=200: 26 573 B · runs=20: 25 908 · runs=1: 25 934
      // (lowering runs barely helps and costs runtime gas); viaIR runs=200: 21 602 B.
      // So: viaIR for the size, runs=200 for the runtime gas. 2 974 B of headroom left.
      viaIR: true,
      evmVersion: "cancun",
      // Metadata in the bytecode makes source verification reproducible on every explorer.
      metadata: { bytecodeHash: "ipfs" },
    },
  },

  networks: {
    hardhat: {
      chainId: 31337,
      // Forking a CUSTOM chain needs its hardfork history spelled out: Hardhat only ships one for
      // the chains it knows, and without it a fork of GembaChain dies with "No known hardfork for
      // execution on historical block". Both chains run Cancun from genesis as far as we care.
      chains: {
        821207: { hardforkHistory: { cancun: 0 } },
        11155111: { hardforkHistory: { cancun: 0 } },
      },
      // FORK_RPC turns the in-memory node into a fork of a live chain. Set via the environment
      // rather than hardcoded, because the same config has to serve plain unit tests. It has to be
      // declared HERE and not through hardhat_reset: a reset drops the `chains` above, and without
      // the hardfork history a fork of a custom chain refuses to execute anything.
      ...(process.env.FORK_RPC ? { forking: { url: process.env.FORK_RPC } } : {}),
      // Only lifted for the coverage run, which cannot use viaIR — see the note above.
      // Instrumented, legacy-compiled bytecode is far larger and its deployment runs out of gas
      // against a normal block limit, so the coverage run also gets a huge one.
      allowUnlimitedContractSize: COVERAGE,
      ...(COVERAGE
        ? { blockGasLimit: 300_000_000, gas: 300_000_000, initialBaseFeePerGas: 0 }
        : {}),
    },
    gembatestnet: {
      url: getRpcUrl("gembatestnet"),
      accounts,
      chainId: 821207,
    },
    sepolia: {
      url: getRpcUrl("sepolia"),
      accounts,
      chainId: 11155111,
    },
    mainnet: {
      url: getRpcUrl("mainnet"),
      accounts,
      chainId: 1,
    },
    bsc: {
      url: getRpcUrl("bsc"),
      accounts,
      chainId: 56,
    },
    polygon: {
      url: getRpcUrl("polygon"),
      accounts,
      chainId: 137,
    },
  },

  // ───── Etherscan API **V2** — a single key covers Ethereum, BSC and Polygon.
  // (hardhat-verify 2.1.3 talks V2 when apiKey is a plain string.)
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "gembatestnet",
        chainId: 821207,
        urls: {
          apiURL: "https://gembascan.io/api",
          browserURL: "https://gembascan.io",
        },
      },
    ],
  },

  // Sourcify is OFF on purpose: hardhat-verify 2.1.3 talks Sourcify API **v1**, which was
  // removed upstream (every call returns 404 "API v1 is removed"). Leaving it enabled only
  // produces a guaranteed error next to every successful explorer verification.
  sourcify: { enabled: false },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },

  mocha: {
    // The gembatestnet e2e script waits on real blocks; the local suite never needs this long.
    timeout: 600000,
  },
};
