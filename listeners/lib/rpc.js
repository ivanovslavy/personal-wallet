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
/** One read. ethers' own default is 300 000 ms, the same as the watchdog's patience. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** getLogs over maxSpan (1 000 blocks) is legitimately slower than a single read. Still 1/5 of the
 *  watchdog's patience, so even the slow path cannot turn a cycle into a hang. */
const DEFAULT_LOGS_TIMEOUT_MS = 60_000;
const DEFAULT_ROUNDS = 3;
const ROUND_PAUSE_MS = 2_000;

/** Thrown when every endpoint failed on every round. Carries enough detail to put in an email. */
class AllEndpointsFailed extends Error {
  constructor(name, rounds, tried) {
    super(`${name}: all endpoints failed on ${rounds} full rounds\n  ` + tried.join("\n  "));
    this.name = "AllEndpointsFailed";
    this.allEndpointsFailed = true;
    this.rounds = rounds;
    this.tried = tried;
  }
}

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
    // Far below the watchdog's max(5 × pollMs, 5 min) — see the note in _provider(). A plain read
    // that has not answered in 20 s is not going to; waiting is how a cycle turns into a hang.
    this.requestTimeoutMs = o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.log = o.log || (() => {});
    this.cooldownMs = o.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    // How many complete passes over the endpoint list before giving up. On the second and later
    // passes the cooldown is ignored, so the list really does wrap round to the first endpoint.
    this.rounds = o.rounds ?? DEFAULT_ROUNDS;
    // Anomalies worth telling a human about: an endpoint going down, the active one changing,
    // everything failing. The watcher decides what to do with them; the pool only reports.
    this.onAnomaly = o.onAnomaly || (() => {});
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
    // WHY A MAP AND NOT ONE VALUE: calls do not all have the same requirement. scanIncoming asks
    // for "logsWithoutAddress" and only some endpoints serve it; getBlockNumber asks for nothing
    // and takes the first free one. With a single `current` the two call classes overwrite each
    // other EVERY CYCLE, and each overwrite looked like an endpoint switch — 40 "anomalies" in
    // 30 minutes on sepolia with nothing whatsoever wrong. A switch is a change WITHIN one
    // capability bucket; alternating between buckets is just normal routing.
    this.currentBy = new Map();
  }

  /** Endpoints that are not in cooldown, in preference order. */
  _available() {
    const now = Date.now();
    return this.endpoints.filter((e) => e.failedUntil <= now);
  }

  _provider(e, timeoutMs = this.requestTimeoutMs) {
    // 🔴 THE REQUEST TIMEOUT IS THE WHOLE POINT OF THIS FUNCTION, so it goes first.
    //
    // ethers' FetchRequest defaults to **300 000 ms**. The watchdog calls a listener hung once it
    // has not polled for max(5 × pollMs, 5 min) — which at a 20 s poll is also **300 000 ms**. The
    // two numbers were identical, so an endpoint that accepted the connection and then went silent
    // held one cycle for the full five minutes and the watchdog restarted the listener on the same
    // second. That is exactly what happened on 2026-10-23 at 01:09:18 — the failures in the
    // journal are at 01:04:18 and 01:09:18, five minutes apart to the second.
    //
    // A silent endpoint must therefore be abandoned in seconds, not minutes. Reads of a block or a
    // receipt are small; logs over a range can legitimately take longer, so that call passes its
    // own, larger budget via opts.timeoutMs. Both stay far below the watchdog's patience, so the
    // pool gets to rotate and finish the cycle instead of racing a restart.
    const req = new ethers.FetchRequest(e.url);
    req.timeout = timeoutMs;

    // staticNetwork: the chain id is known, so ethers must not probe for it on every call.
    // cacheTimeout -1: ethers caches eth_call/getBalance results for 250 ms by default, which has
    // bitten this setup before on nonce reads (see the ethers v6 note in the project memory).
    const p = new ethers.JsonRpcProvider(req, this.chainId, {
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
  /**
   * @param {object} [opts]
   * @param {string} [opts.capability]
   * @param {number} [opts.timeoutMs] per-call request budget; defaults to requestTimeoutMs
   */
  async withProvider(fn, opts = {}) {
    const cap = opts.capability || null;
    const rounds = opts.rounds ?? this.rounds;
    const tried = [];

    for (let round = 1; round <= rounds; round++) {
      // Round 1 respects the cooldown. Later rounds ignore it, which is what makes the list wrap
      // back to the first endpoint instead of stalling once everything is parked.
      let avail = round === 1 ? this._available() : this.endpoints.slice();
      if (cap) {
        const supported = avail.filter((e) => !e.unsupported.has(cap));
        if (supported.length > 0) avail = supported;
        else if (round === rounds) {
          // Nothing claims to support it — clear the record and let the last round try anyway,
          // in case a provider gained the capability since it was last tested.
          for (const e of avail) e.unsupported.delete(cap);
          this.log(`${this.name}: no endpoint supports "${cap}" — cleared the record for one retry`);
        }
      }
      if (avail.length === 0) avail = this.endpoints.slice();

      for (const e of avail) {
        let provider;
        try {
          provider = this._provider(e, opts.timeoutMs);
          const out = await fn(provider);
          this.current = e.label;
          const bucket = cap || "";
          const from = this.currentBy.get(bucket);
          if (from !== e.label) {
            this.currentBy.set(bucket, e.label);
            this.log(`${this.name}: using ${e.label}`, { url: redact(e.url), capability: cap || null });
            // Only report a CHANGE WITHIN THE SAME BUCKET, and only after something was already
            // in use there — the first selection at startup is not an anomaly.
            if (from) this.onAnomaly({ type: "switched", from, to: e.label, round, capability: cap || null });
          }
          e.successes++;
          e.failures = 0;
          return out;
        } catch (err) {
          if (cap && !isRevert(err) && !isTransient(err)) {
            const n = (e.capFailures.get(cap) || 0) + 1;
            e.capFailures.set(cap, n);
            if (n >= 3) {
              e.unsupported.add(cap);
              this.log(`${this.name}: ${e.label} does not support "${cap}" — skipping it for that call only`,
                { error: String(err.shortMessage || err.message || err).slice(0, 120) });
            }
            tried.push(`round ${round} · ${e.label}: ${String(err.shortMessage || err.message).slice(0, 80)}`);
            continue;
          }
          // A CONTRACT REVERT IS AN ANSWER, NOT A FAILURE. The endpoint executed the call and
          // returned the revert data; rotating would slander it and destroy the payload.
          if (isRevert(err)) {
            e.successes++;
            e.failures = 0;
            throw err;
          }
          e.failures++;
          e.lastError = String(err.shortMessage || err.message || err).slice(0, 200);
          e.failedUntil = Date.now() + this.cooldownMs * Math.min(e.failures, 5);
          tried.push(`round ${round} · ${e.label}: ${e.lastError}`);
          this.log(`${this.name}: ${e.label} failed, moving on`, { error: e.lastError, round });
          this.onAnomaly({ type: "endpointFailed", endpoint: e.label, error: e.lastError, round });
        } finally {
          try { provider?.destroy(); } catch { /* nothing to do */ }
        }
      }

      if (round < rounds) {
        this.log(`${this.name}: round ${round} of ${rounds} exhausted every endpoint — pausing before the next`);
        await new Promise((r) => setTimeout(r, ROUND_PAUSE_MS * round));
      }
    }

    const err = new AllEndpointsFailed(this.name, rounds, tried);
    this.onAnomaly({ type: "allFailed", rounds, tried, stats: this.stats() });
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

module.exports = { RpcPool, redact, isRevert, isTransient, AllEndpointsFailed };
