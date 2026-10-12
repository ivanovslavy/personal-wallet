#!/usr/bin/env node
"use strict";
/**
 * Checks every configured endpoint and prints a table.
 *
 *   node listeners/probe.js            # both networks
 *   node listeners/probe.js sepolia
 *
 * Two things are tested, because they fail independently: `eth_blockNumber`, which almost
 * everything answers, and `eth_getLogs`, which plenty of "public" endpoints refuse or cap. An
 * endpoint that serves blocks but not logs is useless to this listener and must not sit at the top
 * of the fallback list pretending to be healthy.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { ethers } = require("ethers");
const { networkConfig, knownNetworks } = require("./config");
const { redact } = require("./lib/rpc");

const TIMEOUT_MS = 12_000;
const race = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms / 1000}s ${what}`)), ms))]);

async function probe(cfg, e) {
  const t0 = Date.now();
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(e.url, cfg.chainId, {
      staticNetwork: ethers.Network.from(cfg.chainId), batchMaxCount: 1,
    });
    const head = await race(provider.getBlockNumber(), TIMEOUT_MS, "getBlockNumber");
    const blockMs = Date.now() - t0;

    // Right chain? An endpoint quietly serving a different network is worse than a dead one.
    const net = await race(provider.getNetwork(), TIMEOUT_MS, "getNetwork");
    if (Number(net.chainId) !== cfg.chainId) {
      return { ...e, ok: false, why: `wrong chain: ${net.chainId}` };
    }

    // The getLogs probe MUST mirror the shape the listener actually uses — filtered by address.
    // An unfiltered range query returns every log on the chain and gets refused by endpoints that
    // serve the real query perfectly well; probing that way reported publicnode as unusable when
    // it is not.
    const t1 = Date.now();
    let logs = "yes", logMs = null;
    try {
      await race(provider.getLogs({
        address: ["0x0000000000000000000000000000000000000001"],
        fromBlock: head - 20, toBlock: head - 1,
      }), TIMEOUT_MS, "getLogs");
      logMs = Date.now() - t1;
    } catch (err) {
      logs = `NO (${String(err.shortMessage || err.message).slice(0, 44)})`;
    }
    return { ...e, ok: true, head, blockMs, logs, logMs };
  } catch (err) {
    return { ...e, ok: false, why: String(err.shortMessage || err.message).slice(0, 58) };
  } finally {
    try { provider?.destroy(); } catch { /* nothing to do */ }
  }
}

(async () => {
  const only = process.argv[2];
  // Only probe networks that are actually configured — a default with no WATCH set is not in use.
  const names = only ? [only] : knownNetworks().filter((n) => { try { networkConfig(n); return true; } catch { return false; } });
  if (names.length === 0) { console.error("no network is configured — set <NET>_WATCH and <NET>_RPC_URLS in .env"); process.exit(2); }
  let anyUsable = false;

  // One failed attempt is not proof: all three gembascan endpoints were reported dead in a run,
  // then answered HTTP 200 to curl seconds later and worked both sequentially and concurrently on
  // retry. A transient blip at a CDN must not get an endpoint written off.
  const probeTwice = async (cfg, e) => {
    const first = await probe(cfg, e);
    if (first.ok && first.logs === "yes") return first;
    await new Promise((r) => setTimeout(r, 1500));
    const second = await probe(cfg, e);
    return (second.ok && second.logs === "yes") ? { ...second, retried: true } : { ...second, retried: true };
  };

  for (const name of names) {
    let cfg;
    try { cfg = networkConfig(name); }
    catch (e) { console.error(`\n${name}: ${e.message}`); continue; }
    const endpoints = cfg.endpoints;
    console.log(`\n${name}  (chainId ${cfg.chainId})  ${endpoints.length} endpoint(s) configured`);
    console.log("  " + "-".repeat(104));
    console.log(`  ${"endpoint".padEnd(36)} ${"keyed".padEnd(6)} ${"head".padEnd(10)} ${"ms".padEnd(6)} logs`);
    console.log("  " + "-".repeat(104));

    const results = await Promise.all(endpoints.map((e) => probeTwice(cfg, e)));
    for (const r of results) {
      if (r.ok) {
        console.log(`  ${r.label.padEnd(36)} ${(r.keyed ? "yes" : "no").padEnd(6)} ${String(r.head).padEnd(10)} ${String(r.blockMs).padEnd(6)} ${r.logs}${r.logMs != null ? ` (${r.logMs} ms)` : ""}${r.retried ? "  [on retry]" : ""}`);
      } else {
        console.log(`  ${r.label.padEnd(36)} ${(r.keyed ? "yes" : "no").padEnd(6)} ${"-".padEnd(10)} ${"-".padEnd(6)} FAILED${r.retried ? " TWICE" : ""}: ${r.why}`);
      }
    }
    const usable = results.filter((r) => r.ok && r.logs === "yes");
    console.log("  " + "-".repeat(104));
    console.log(`  usable for this listener (blocks AND logs): ${usable.length} of ${endpoints.length}`);
    if (usable.length === 0) console.log(`  >>> NOTHING USABLE — the ${name} listener cannot run`);
    else {
      anyUsable = true;
      const heads = usable.map((r) => r.head);
      const spread = Math.max(...heads) - Math.min(...heads);
      console.log(`  head spread across usable endpoints: ${spread} block(s)${spread > 10 ? "  <-- one of them is lagging" : ""}`);
      // Any endpoint whose URL carries a secret is printed redacted, never raw.
      console.log(`  order the pool will try: ${endpoints.map((e) => e.label).join(" -> ")}`);
      for (const r of usable.slice(0, 3)) console.log(`     ${r.label}: ${redact(r.url)}`);
    }
  }
  process.exit(anyUsable ? 0 : 1);
})();
