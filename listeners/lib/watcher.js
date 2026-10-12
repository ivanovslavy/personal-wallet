"use strict";
/**
 * The watcher loop.
 *
 * One cycle: ask for the chain head, work out which block range is new and deep enough to trust,
 * pull the logs for the watched contracts in chunks, decode them, save the new position, and email
 * if anything happened. Every step is explicit; there is no subscription that can go quiet.
 *
 * Three decisions worth stating:
 *
 *  · CONFIRMATIONS. Logs are read up to `head - confirmations`, never to the head itself, so a
 *    reorg cannot make the listener report an event that later never happened. The cost is that an
 *    alert arrives a few blocks late, which for an email is nothing.
 *
 *  · THE POSITION IS SAVED PER CHUNK, not per cycle. If the process dies mid-cycle it resumes
 *    from the last chunk it actually finished. Saving at the end of a cycle risks re-reporting a
 *    whole range; saving before processing risks losing it.
 *
 *  · ONE EMAIL PER CYCLE, listing every event found. A separate email per event means a batch
 *    transfer of fifty NFTs arrives as fifty emails, and the next one gets filtered as spam.
 */

const CHUNK_RETRY_SPLIT = 4;

// keccak of the event signatures, hardcoded so no ABI is needed for tokens we know nothing about.
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";        // ERC-20 and ERC-721
const TOPIC_1155_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TOPIC_1155_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const pad32 = (addr) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

class Watcher {
  /**
   * @param {object} o
   * @param {string} o.network label used in logs and subjects
   * @param {import("./rpc").RpcPool} o.pool
   * @param {import("./state").State} o.state
   * @param {import("./mailer").Mailer} o.mailer
   * @param {string[]} o.addresses contracts to watch
   * @param {import("ethers").Interface} o.iface for decoding
   * @param {string} o.explorer base explorer URL, for links in the email
   * @param {number} [o.confirmations]
   * @param {number} [o.pollMs]
   * @param {number} [o.maxSpan] biggest getLogs range to ask for in one call
   * @param {number} [o.startBlock] where to begin when there is no saved position
   * @param {(m:string,x?:object)=>void} [o.log]
   */
  constructor(o) {
    Object.assign(this, {
      confirmations: 3,
      pollMs: 30_000,
      maxSpan: 2_000,
      startBlock: null,
      // Watch for tokens arriving by a plain transfer, which the wallet itself cannot see:
      // an ERC-20 transfer runs none of the wallet's code, so it emits no wallet event and
      // without this the arrival is invisible.
      watchIncoming: true,
      // Watch for transactions to the wallet that REVERTED. A failed transaction emits no logs
      // at all, so a refused attempt to drain the wallet produces no event and, without this,
      // no alert — which is precisely the signal most worth having.
      watchFailed: true,
      // Scanning for failed transactions costs one getBlock per block. Skipped on a long
      // catch-up rather than firing thousands of calls; the log scan still covers that range.
      maxFailedScanBlocks: 300,
      log: () => {},
    }, o);
    this.addresses = o.addresses.map((a) => a.toLowerCase());
    this.consecutiveFailures = 0;
    this.failureAlerted = false;
    this.stopping = false;
  }

  async start() {
    this.state.set({ startedAt: new Date().toISOString() });
    this.log(`${this.network}: watching ${this.addresses.length} contract(s)`, {
      addresses: this.addresses,
      confirmations: this.confirmations,
      pollSeconds: this.pollMs / 1000,
    });

    while (!this.stopping) {
      try {
        await this.cycle();
        if (this.consecutiveFailures > 0) {
          this.log(`${this.network}: recovered after ${this.consecutiveFailures} failed cycle(s)`);
          if (this.failureAlerted) {
            await this.mailer.send({
              subject: `[${this.network}] listener recovered`,
              text: `The listener is reading the chain again after ${this.consecutiveFailures} failed cycles.\n`
                + `Current position: block ${this.state.data.lastBlock}.\n`,
            });
          }
        }
        this.consecutiveFailures = 0;
        this.failureAlerted = false;
      } catch (e) {
        this.consecutiveFailures++;
        const msg = String(e.message || e).slice(0, 1500);
        this.log(`${this.network}: cycle failed (${this.consecutiveFailures} in a row)`, { error: msg });
        // Alert once, after a few failures — not on the first blip, and not every cycle after.
        if (this.consecutiveFailures === 5 && !this.failureAlerted) {
          this.failureAlerted = true;
          await this.mailer.send({
            subject: `[${this.network}] listener cannot read the chain`,
            text: `Five consecutive cycles failed.\n\nLast error:\n${msg}\n\n`
              + `Endpoint status:\n${JSON.stringify(this.pool.stats(), null, 2)}\n\n`
              + `Position held: block ${this.state.data.lastBlock}. No events are being missed yet —\n`
              + `the listener resumes from that block once an endpoint answers.\n`,
          });
        }
      }
      await this.sleep(this.pollMs);
    }
    this.log(`${this.network}: stopped`);
  }

  async cycle() {
    const head = await this.pool.withProvider((p) => p.getBlockNumber());
    const target = head - this.confirmations;
    this.state.set({ lastPollAt: new Date().toISOString() });

    if (this.state.data.lastBlock == null) {
      const from = this.startBlock != null ? this.startBlock : target;
      this.state.set({ lastBlock: from - 1 });
      this.log(`${this.network}: no saved position, starting at block ${from}`, { head });
    }

    let from = this.state.data.lastBlock + 1;
    if (from > target) return; // nothing deep enough yet

    const rangeStart = from;
    const found = [];
    const incoming = [];
    const failed = [];

    while (from <= target && !this.stopping) {
      const to = Math.min(from + this.maxSpan - 1, target);
      const logs = await this.getLogs(from, to);
      for (const l of logs) found.push(this.decode(l));
      if (this.watchIncoming) incoming.push(...await this.scanIncoming(from, to));
      this.state.set({ lastBlock: to });
      from = to + 1;
    }

    if (this.watchFailed && !this.stopping) {
      const span = target - rangeStart + 1;
      if (span > this.maxFailedScanBlocks) {
        this.log(`${this.network}: ${span} blocks to catch up — skipping the failed-transaction scan for this range`);
      } else if (span > 0) {
        failed.push(...await this.scanFailed(rangeStart, target));
      }
    }

    // A deposit made through the proper path emits BOTH a wallet event and a token Transfer.
    // Report it once: the wallet's own event wins, and the raw transfer is dropped.
    const seenTx = new Set(found.map((e) => e.txHash.toLowerCase()));
    const newIncoming = incoming.filter((e) => !seenTx.has(e.txHash.toLowerCase()));

    if (newIncoming.length || failed.length) {
      this.log(`${this.network}: ${newIncoming.length} unaccounted arrival(s), ${failed.length} failed transaction(s)`);
    }

    if (found.length || newIncoming.length || failed.length) {
      found.push(...newIncoming, ...failed);
      found.sort((a, b) => a.blockNumber - b.blockNumber);
      this.state.set({ eventsSeen: this.state.data.eventsSeen + found.length });
      this.log(`${this.network}: ${found.length} event(s)`, { blocks: `${found[0].blockNumber}..${found[found.length - 1].blockNumber}` });
      const ok = await this.mailer.send(this.compose(found));
      if (ok) this.state.set({ alertsSent: this.state.data.alertsSent + 1 });
    }
  }

  /**
   * Tokens arriving at the wallet from outside.
   *
   * Two calls: one for ERC-20 and ERC-721 (they share the `Transfer` topic and are told apart by
   * how many topics the log carries), one for both ERC-1155 events using a topic alternation.
   * Deliberately NOT filtered by token address — the point is to see tokens nobody allowlisted,
   * including dust and lookalikes. Unknown tokens are capped in the email so a dust attack
   * cannot turn into a flood.
   */
  async scanIncoming(from, to) {
    const out = [];
    for (const target of this.addresses) {
      const to32 = pad32(target);
      const [erc20ish, multi] = await Promise.all([
        this.pool.withProvider(
          (p) => p.getLogs({ topics: [TOPIC_TRANSFER, null, to32], fromBlock: from, toBlock: to }),
          { capability: "logsWithoutAddress" }).catch(() => []),
        this.pool.withProvider(
          (p) => p.getLogs({ topics: [[TOPIC_1155_SINGLE, TOPIC_1155_BATCH], null, null, to32], fromBlock: from, toBlock: to }),
          { capability: "logsWithoutAddress" }).catch(() => []),
      ]);

      for (const l of erc20ish) {
        const isNft = l.topics.length === 4;           // ERC-721 indexes the tokenId as well
        out.push({
          address: l.address,
          blockNumber: l.blockNumber,
          txHash: l.transactionHash,
          logIndex: l.index ?? l.logIndex,
          name: isNft ? "ARRIVED: ERC-721 (plain transfer)" : "ARRIVED: ERC-20 (plain transfer)",
          args: {
            token: l.address,
            from: "0x" + String(l.topics[1]).slice(26),
            to: target,
            ...(isNft ? { tokenId: BigInt(l.topics[3]).toString() } : { rawAmount: BigInt(l.data || "0x0").toString() }),
            allowlisted: String(await this.isAllowed(l.address)),
          },
        });
      }
      for (const l of multi) {
        out.push({
          address: l.address,
          blockNumber: l.blockNumber,
          txHash: l.transactionHash,
          logIndex: l.index ?? l.logIndex,
          name: l.topics[0].toLowerCase() === TOPIC_1155_SINGLE ? "ARRIVED: ERC-1155 (plain transfer)" : "ARRIVED: ERC-1155 batch (plain transfer)",
          args: {
            token: l.address,
            operator: "0x" + String(l.topics[1]).slice(26),
            from: "0x" + String(l.topics[2]).slice(26),
            to: target,
            allowlisted: String(await this.isAllowed(l.address)),
          },
        });
      }
    }
    return out;
  }

  /** Is this token on the wallet's own allowlist? Cached, because it rarely changes. */
  async isAllowed(token) {
    this._allowCache ||= new Map();
    const k = token.toLowerCase();
    if (this._allowCache.has(k)) return this._allowCache.get(k);
    let v = "unknown";
    try {
      v = await this.pool.withProvider(async (p) => {
        const c = new (require("ethers").Contract)(this.addresses[0], this.iface, p);
        return c.isTokenAllowed(token);
      });
    } catch { /* leave as unknown */ }
    this._allowCache.set(k, v);
    return v;
  }

  /**
   * Transactions sent TO the wallet that reverted.
   *
   * A reverted transaction writes no logs, so `eth_getLogs` can never show a refused attempt —
   * and a refused attempt to drain the wallet is the single most useful thing to be told about.
   * So the blocks are read with their transactions, those addressed to the wallet are picked out,
   * and their receipts checked for status 0.
   */
  async scanFailed(from, to) {
    const watched = new Set(this.addresses);
    const out = [];
    for (let n = from; n <= to && !this.stopping; n++) {
      let block;
      try { block = await this.pool.withProvider((p) => p.getBlock(n, true)); } catch { continue; }
      if (!block) continue;
      for (const tx of (block.prefetchedTransactions || [])) {
        if (!tx.to || !watched.has(tx.to.toLowerCase())) continue;
        let rc;
        try { rc = await this.pool.withProvider((p) => p.getTransactionReceipt(tx.hash)); } catch { continue; }
        if (!rc || rc.status !== 0) continue;
        // Why did it fail? The same call replayed at that block returns the revert data.
        let reason = "(could not decode)";
        try {
          await this.pool.withProvider((p) => p.call({ to: tx.to, from: tx.from, data: tx.data, value: tx.value, blockTag: n }));
        } catch (e) {
          const d = e?.data ?? e?.info?.error?.data;
          if (typeof d === "string" && d.length >= 10) {
            try { const parsed = this.iface.parseError(d); reason = parsed ? `${parsed.name}(${parsed.args.map(String).join(", ")})` : d.slice(0, 20); }
            catch { reason = d.slice(0, 20); }
          }
        }
        out.push({
          address: tx.to, blockNumber: n, txHash: tx.hash, logIndex: 0,
          name: "REFUSED: a transaction to the wallet reverted",
          args: { from: tx.from, selector: String(tx.data).slice(0, 10), reason, value: tx.value.toString() },
        });
      }
    }
    return out;
  }

  /**
   * `eth_getLogs` with the range halved on refusal. Public endpoints cap the span, and the cap
   * differs per provider and is not discoverable — so the range is narrowed until it is accepted
   * rather than guessed from documentation.
   */
  async getLogs(from, to, depth = 0) {
    try {
      return await this.pool.withProvider((p) =>
        p.getLogs({ address: this.addresses, fromBlock: from, toBlock: to }));
    } catch (e) {
      const msg = String(e.message || e);
      const tooWide = /range|limit|too many|exceed|more than|block range/i.test(msg);
      if (tooWide && to > from && depth < CHUNK_RETRY_SPLIT) {
        const mid = from + Math.floor((to - from) / 2);
        this.log(`${this.network}: range ${from}..${to} refused, splitting`, { reason: msg.slice(0, 120) });
        return [...await this.getLogs(from, mid, depth + 1), ...await this.getLogs(mid + 1, to, depth + 1)];
      }
      throw e;
    }
  }

  decode(l) {
    const base = {
      address: l.address,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      logIndex: l.index ?? l.logIndex,
    };
    try {
      const p = this.iface.parseLog({ topics: [...l.topics], data: l.data });
      if (!p) return { ...base, name: "(unrecognised event)", args: {} };
      const args = {};
      p.fragment.inputs.forEach((inp, i) => {
        const v = p.args[i];
        args[inp.name || `arg${i}`] = typeof v === "bigint" ? v.toString() : String(v);
      });
      return { ...base, name: p.name, args };
    } catch {
      return { ...base, name: "(undecodable)", args: { topic0: l.topics[0] } };
    }
  }

  compose(events) {
    // A dust attack is many arrivals of an unknown token. Keep three, count the rest, so one
    // attacker cannot turn the alerting into a flood.
    const junk = events.filter((e) => e.name.startsWith("ARRIVED") && e.args.allowlisted === "false");
    let dropped = 0;
    if (junk.length > 3) {
      const keep = new Set(junk.slice(0, 3));
      events = events.filter((e) => !junk.includes(e) || keep.has(e));
      dropped = junk.length - 3;
    }
    const names = [...new Set(events.map((e) => e.name))];
    // A refusal leads the subject: it is the line that should make someone look.
    const refused = events.filter((e) => e.name.startsWith("REFUSED")).length;
    const prefix = refused ? `${refused} REFUSED + ` : "";
    const subject = `[${this.network}] ${prefix}${events.length} event${events.length > 1 ? "s" : ""}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}`;
    const lines = [
      `${events.length} event(s) on ${this.network}`,
      `blocks ${events[0].blockNumber}..${events[events.length - 1].blockNumber}`,
      `detected ${new Date().toISOString()}`,
      "",
    ];
    for (const e of events) {
      lines.push(`${e.name}`);
      lines.push(`  contract : ${e.address}`);
      lines.push(`  block    : ${e.blockNumber}`);
      lines.push(`  tx       : ${e.txHash}`);
      if (this.explorer) lines.push(`  explorer : ${this.explorer}/tx/${e.txHash}`);
      for (const [k, v] of Object.entries(e.args)) lines.push(`  ${k.padEnd(9)}: ${v}`);
      lines.push("");
    }
    if (dropped) lines.push(`(${dropped} further arrival(s) of non-allowlisted tokens omitted — likely dust)`);
    lines.push(`position: block ${this.state.data.lastBlock}`);
    lines.push(`rpc: ${this.pool.current || "unknown"}`);
    return { subject, text: lines.join("\n") };
  }

  sleep(ms) {
    return new Promise((r) => {
      this.timer = setTimeout(r, ms);
      if (this.stopping) { clearTimeout(this.timer); r(); }
    });
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
  }
}

module.exports = { Watcher };
