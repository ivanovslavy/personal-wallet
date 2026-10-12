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
      // Capability, as distinct from health. An endpoint can be perfectly alive and simply refuse
      // one kind of call: publicnode serves eth_getLogs WITH an address filter and refuses it
      // WITHOUT one (measured 2026-10-12). Treating that as ill-health was wrong twice over — it
      // pushed every other call off a healthy endpoint, and it retried a call that can never work.
      unsupported: new Set(),
      capFailures: new Map(),
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
   *
   * @param {object} [opts]
   * @param {string} [opts.capability] Name this call's requirement — "logsWithoutAddress", say.
   *        An endpoint that fails such a call twice is remembered as not supporting it and is
   *        skipped for that capability alone; its health is never penalised, because refusing a
   *        kind of call is not the same as being down.
   */
  async withProvider(fn, opts = {}) {
    const cap = opts.capability || null;
    const tried = [];
    let avail = this._available().filter((e) => !cap || !e.unsupported.has(cap));
    if (avail.length === 0 && cap) {
      // Nothing claims to support it — try the unsupported ones once more rather than give up,
      // since a provider may have gained the capability since it was last recorded.
      avail = this._available();
      for (const e of avail) e.unsupported.delete(cap);
      this.log(`${this.name}: no endpoint supports "${cap}" — clearing the record and retrying all`);
    }
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
        // A capability failure is not ill-health: remember what this endpoint cannot do and
        // move on, leaving its health untouched so other calls keep using it.
        if (cap && !isRevert(err) && !isTransient(err)) {
          const n = (e.capFailures.get(cap) || 0) + 1;
          e.capFailures.set(cap, n);
          if (n >= 3) {
            e.unsupported.add(cap);
            this.log(`${this.name}: ${e.label} does not support "${cap}" — skipping it for that call only`,
              { error: String(err.shortMessage || err.message || err).slice(0, 120) });
          }
          tried.push(`${e.label}: ${String(err.shortMessage || err.message).slice(0, 80)}`);
          continue;
        }
        // A CONTRACT REVERT IS AN ANSWER, NOT A FAILURE. The endpoint did its job: it executed
        // the call and returned the revert data. Rotating here both slanders a healthy endpoint
        // and destroys the revert payload, which is the thing the caller wanted — it is why a
        // decoded revert reason came back as "(could not decode)".
        if (isRevert(err)) {
          e.successes++;
          e.failures = 0;
          throw err;
        }
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
      unsupported: [...e.unsupported],
      lastError: e.lastError,
    }));
  }
}

/**
 * Is this a transport problem rather than an answer? Timeouts, resets, rate limits and 5xx are
 * the endpoint having a bad moment — they must never be recorded as "this endpoint cannot do
 * that kind of call", because a capable endpoint would then be written off for a blip. drpc was
 * marked as lacking a capability it demonstrably has, on two transient failures.
 */
function isTransient(err) {
  const msg = `${err?.shortMessage || ""} ${err?.message || ""} ${err?.info?.responseBody || ""}`;
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return true;
  if (/rate.?limit|too many requests|\b429\b|\b50[0-9]\b|bad gateway|service unavailable/i.test(msg)) return true;
  const status = err?.info?.responseStatus;
  if (status && (Number(status) === 429 || (Number(status) >= 500 && Number(status) < 600))) return true;
  return false;
}

/**
 * Did the call reach the contract and revert, as opposed to the endpoint failing?
 *
 * Deliberately narrow: only a recognisable revert counts. Anything ambiguous is treated as an
 * endpoint problem, because rotating away from a healthy endpoint costs one retry while failing
 * to rotate away from a broken one costs the whole cycle.
 */
function isRevert(err) {
  if (!err) return false;
  if (err.code === "CALL_EXCEPTION") return true;
  const data = err.data ?? err.info?.error?.data ?? err.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) return true;
  const msg = String(err.shortMessage || err.message || "");
  return /execution reverted|revert/i.test(msg) && !/timeout|ECONN|ENOTFOUND|rate limit|429|503|502/i.test(msg);
}

/** Hides an API key that lives in the URL path or query, for safe logging. */
function redact(url) {
  return String(url)
    .replace(/(\/v[23]\/)[A-Za-z0-9_-]{8,}/g, "$1<KEY>")
    .replace(/([?&](?:api[-_]?key|key|apikey)=)[^&]+/gi, "$1<KEY>")
    .replace(/\/[0-9a-f]{32}(\/|$)/gi, "/<KEY>$1")
    .replace(/\/[A-Za-z0-9_-]{30,}(\/|$)/g, "/<KEY>$1");
}

module.exports = { RpcPool, redact, isRevert, isTransient };
