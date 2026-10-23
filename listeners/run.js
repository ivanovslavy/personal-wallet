#!/usr/bin/env node
"use strict";
/**
 * One listener, told which network to watch:
 *
 *   node listeners/run.js gembatestnet
 *   node listeners/run.js sepolia
 *
 * Two systemd units run two copies of this. One implementation rather than two near-identical
 * files, because a bug fixed in one copy and forgotten in the other is the predictable outcome of
 * duplicating a polling loop.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { ethers } = require("ethers");
const { RpcPool, redact } = require("./lib/rpc");
const { State } = require("./lib/state");
const { Mailer } = require("./lib/mailer");
const { Watcher } = require("./lib/watcher");
const { networkConfig, knownNetworks, mailConfig, stateFile } = require("./config");
// The committed ABI export, so the Pi needs neither Hardhat nor a solc download. Falls back to
// the build artefact when running from a full development checkout.
const abiFile = (() => {
  try { return require("./abi/PersonalWallet.json"); }
  catch { return require("../artifacts/contracts/PersonalWallet.sol/PersonalWallet.json"); }
})();
const walletAbi = abiFile.abi;

const network = process.argv[2];
if (!network) {
  console.error(`usage: node listeners/run.js <network>`);
  console.error(`known: ${knownNetworks().join(", ")}`);
  console.error(`any other name works too, given <NAME>_CHAIN_ID, <NAME>_WATCH and <NAME>_RPC_URLS in .env`);
  process.exit(2);
}

// The whole configuration comes from .env (with networks.default.json supplying defaults as data).
// A missing piece fails here, loudly, with the variable name to set — rather than starting a
// listener that watches nothing.
let cfg;
try { cfg = networkConfig(network); }
catch (e) { console.error(`config error for "${network}": ${e.message}`); process.exit(2); }

/** Structured, one line per event, with any API key in a URL stripped out. */
function log(msg, extra) {
  const line = { t: new Date().toISOString(), net: network, msg: redact(String(msg)) };
  if (extra) line.extra = JSON.parse(redact(JSON.stringify(extra)));
  console.log(JSON.stringify(line));
}

async function main() {
  const addresses = cfg.addresses;
  const endpoints = cfg.endpoints;
  log(`starting`, {
    chainId: cfg.chainId,
    watching: addresses,
    endpoints: endpoints.map((e) => e.label),
    free: endpoints.filter((e) => !e.keyed).length,
    keyed: endpoints.filter((e) => e.keyed).length,
    pollSeconds: cfg.pollMs / 1000,
    confirmations: cfg.confirmations,
    watchIncoming: cfg.watchIncoming,
    watchFailed: cfg.watchFailed,
  });

  const pool = new RpcPool({ name: network, chainId: cfg.chainId, endpoints, log });
  const state = new State(stateFile(network));
  const mailer = new Mailer({ ...mailConfig(network), log });
  fatalMailer = mailer;        // see the crash handler at the bottom of this file

  // Prove the mail path before claiming to be a working alerter. A listener that cannot send is
  // worse than no listener, because it looks like everything is fine.
  await mailer.verify();
  log("smtp verified");

  const watcher = new Watcher({
    network, pool, state, mailer, addresses,
    iface: new ethers.Interface(walletAbi),
    explorer: cfg.explorer,
    confirmations: cfg.confirmations,
    pollMs: cfg.pollMs,
    maxSpan: cfg.maxSpan,
    startBlock: cfg.startBlock,
    watchIncoming: cfg.watchIncoming,
    watchFailed: cfg.watchFailed,
    maxFailedScanBlocks: cfg.maxFailedScanBlocks,
    anomalyMailMs: cfg.anomalyMailMs,
    summaryMs: cfg.summaryMs,
    mailOnSwitch: cfg.mailOnSwitch,
    log,
  });

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => { log(`${sig} received, finishing the current cycle`); watcher.stop(); });
  }
  await watcher.start();
}

/**
 * Reporting a CRASH, which is a different thing from a shutdown.
 *
 * The watcher deliberately does not mail when it stops cleanly: a clean stop is always somebody's
 * act (a restart, a deploy, the watchdog) and those report themselves. A crash is the opposite —
 * nobody asked for it and nobody else knows. So this is the one exit worth an email, and until now
 * it only wrote a line to the journal, which is exactly the "goes quiet and looks fine" failure
 * the whole design is meant to avoid.
 *
 * The mail is best-effort and bounded: if SMTP is also broken, the process must still exit rather
 * than hang on it, so the send races a 10-second timer and the exit happens either way. systemd
 * restarts the unit and the watchdog checks within five minutes regardless.
 */
let fatalMailer = null;

main().catch(async (e) => {
  const msg = String(e.message || e).slice(0, 600);
  log("fatal", { error: msg });
  if (fatalMailer) {
    await Promise.race([
      fatalMailer.send({
        subject: `[${network || "listener"}] listener CRASHED`,
        text: `The listener exited on an unhandled error — nobody asked it to stop.\n\n`
          + `${msg}\n\n`
          + `systemd will restart it, and the watchdog checks every 5 minutes that it is really\n`
          + `polling. If this mail arrives repeatedly, the restart is not fixing it.\n`,
      }).catch(() => {}),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }
  process.exit(1);
});
