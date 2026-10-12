"use strict";
/**
 * RPC with fallback.
 *
 * Why polling and not a WebSocket subscription: a `provider.on("logs", …)` subscription dies
 * quietly. The socket closes, no error surfaces, and the listener sits there looking healthy while
 * seeing nothing. On a box at the end of a domestic line that is not a corner case, it is Tuesday.
 * Polling `eth_getLogs` over an explicit block range is slower and completely verifiable: every
 * cycle either returns a range or throws, and the last processed block is on disk either way.
 *
 * Why an ordered list rather than a "best" endpoint: free public endpoints rate-limit, go down for
 * maintenance, and lag. Keyed endpoints have quotas worth saving. So the list is tried in order —
 * free first, keyed last — and an endpoint that fails is parked for a cooldown rather than
 * hammered.
 */
const { ethers } = require("ethers");

const DEFAULT_COOLDOWN_MS = 120_000;

class RpcPool {
  /**
   * @param {object} o
   * @param {string} o.name network label, for logs
   * @param {number} o.chainId expected chain id — an endpoint reporting anything else is dropped
   * @param {Array<{url:string,label:string,keyed?:boolean}>} o.endpoints in preference order
   * @param {(msg:string,extra?:object)=>void} [o.log]
   * @param {number} [o.cooldownMs]
   */
  constructor(o) {
    this.name = o.name;
    this.chainId = Number(o.chainId);
    this.log = o.log || (() => {});
    this.cooldownMs = o.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.endpoints = o.endpoints.map((e) => ({
      ...e,
      failedUntil: 0,
      failures: 0,
      successes: 0,
      lastError: null,
    }));
    if (this.endpoints.length === 0) throw new Error(`${this.name}: no RPC endpoints configured`);
    this.current = null;
  }

  /** Endpoints that are not in cooldown, in preference order. */
  _available() {
    const now = Date.now();
    return this.endpoints.filter((e) => e.failedUntil <= now);
  }

  _provider(e) {
    // staticNetwork: the chain id is known, so ethers must not probe for it on every call.
    // cacheTimeout -1: ethers caches eth_call/getBalance results for 250 ms by default, which has
    // bitten this setup before on nonce reads (see the ethers v6 note in the project memory).
    const p = new ethers.JsonRpcProvider(e.url, this.chainId, {
      staticNetwork: ethers.Network.from(this.chainId),
      batchMaxCount: 1,
    });
    p.pollingInterval = 10_000;
    return p;
  }

  /**
   * Runs `fn(provider)` against the first endpoint that works, moving down the list on failure.
   * Throws only when every endpoint has been tried and failed.
   */
  async withProvider(fn) {
    const tried = [];
    let avail = this._available();
    // If everything is in cooldown, ignore the cooldown rather than refuse to work — a stale
    // listener is worse than a hammered endpoint.
    if (avail.length === 0) {
      this.log(`${this.name}: every endpoint is in cooldown, trying them all anyway`);
      avail = this.endpoints.slice();
    }

    for (const e of avail) {
      let provider;
      try {
        provider = this._provider(e);
        const out = await fn(provider);
        if (this.current !== e.label) {
          this.log(`${this.name}: using ${e.label}`, { url: redact(e.url) });
          this.current = e.label;
        }
        e.successes++;
        e.failures = 0;
        return out;
      } catch (err) {
        e.failures++;
        e.lastError = String(err.shortMessage || err.message || err).slice(0, 200);
        e.failedUntil = Date.now() + this.cooldownMs * Math.min(e.failures, 5);
        tried.push(`${e.label}: ${e.lastError}`);
        this.log(`${this.name}: ${e.label} failed, moving on`, { error: e.lastError });
      } finally {
        try { provider?.destroy(); } catch { /* nothing to do */ }
      }
    }
    const err = new Error(`${this.name}: all ${avail.length} endpoints failed\n  ` + tried.join("\n  "));
    err.allEndpointsFailed = true;
    throw err;
  }

  /** A snapshot for the status report, with keys stripped out. */
  stats() {
    return this.endpoints.map((e) => ({
      label: e.label,
      keyed: Boolean(e.keyed),
      successes: e.successes,
      failures: e.failures,
      inCooldown: e.failedUntil > Date.now(),
      lastError: e.lastError,
    }));
  }
}

/** Hides an API key that lives in the URL path or query, for safe logging. */
function redact(url) {
  return String(url)
    .replace(/(\/v[23]\/)[A-Za-z0-9_-]{8,}/g, "$1<KEY>")
    .replace(/([?&](?:api[-_]?key|key|apikey)=)[^&]+/gi, "$1<KEY>")
    .replace(/\/[0-9a-f]{32}(\/|$)/gi, "/<KEY>$1")
    .replace(/\/[A-Za-z0-9_-]{30,}(\/|$)/g, "/<KEY>$1");
}

module.exports = { RpcPool, redact };
