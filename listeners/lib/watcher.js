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
      // When every endpoint has failed every round, STOP trying at the poll cadence and wait.
      // Hammering dead endpoints every 20 seconds helps nobody, fills the journal, and can get
      // the listener rate-limited precisely when it needs to come back.
      backoffMs: 15 * 60_000,
      // RPC anomalies are aggregated and sent at most this often, so a flapping endpoint cannot
      // turn the alerting into a flood.
      anomalyMailMs: 30 * 60_000,
      // ONE HEARTBEAT PER DAY, carrying the counters. Set to 0 to send none. This is the only
      // mail that goes out when nothing is wrong — everything else is triggered by an event.
      summaryMs: 24 * 60 * 60_000,
      // A real endpoint change is already described in the failure digest that caused it. Turn
      // this on to also get it the moment it happens.
      mailOnSwitch: false,
      log: () => {},
    }, o);
    this.addresses = o.addresses.map((a) => a.toLowerCase());
    this.consecutiveFailures = 0;
    this.failureAlerted = false;
    this.stopping = false;
    this.inBackoff = false;
    this.anomalies = [];
    this.lastAnomalyMail = 0;
    // Running counters for the daily heartbeat. Switches land here instead of in an email.
    this.tally = { switches: 0, failures: 0, since: new Date().toISOString() };
    this.lastSummaryMail = Date.now();

    // The pool reports; the watcher decides. Collected here and mailed on a timer rather than
    // one message per event.
    this.pool.onAnomaly = (a) => {
      if (a.type === "switched") this.tally.switches++;
      if (a.type === "endpointFailed") this.tally.failures++;
      this.anomalies.push({ ...a, at: new Date().toISOString() });
      if (this.anomalies.length > 50) this.anomalies.splice(0, this.anomalies.length - 50);
    };
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
              text: `The listener is reading the chain again after ${this.consecutiveFailures} failed cycle(s)`
                + `${this.inBackoff ? " and a pause" : ""}.\n`
                + `Current position: block ${this.state.data.lastBlock}.\n`
                + `Now using: ${this.pool.current}\n`,
            });
          }
        }
        this.consecutiveFailures = 0;
        this.failureAlerted = false;
        this.inBackoff = false;
      } catch (e) {
        this.consecutiveFailures++;
        const msg = String(e.message || e).slice(0, 1500);
        this.log(`${this.network}: cycle failed (${this.consecutiveFailures} in a row)`, { error: msg });

        // Every endpoint failed every round. Stop trying at the poll cadence and back off.
        if (e.allEndpointsFailed) {
          this.inBackoff = true;
          if (!this.failureAlerted) {
            this.failureAlerted = true;
            await this.mailer.send({
              subject: `[${this.network}] NO RPC IS ANSWERING — the listener has paused`,
              text: `Every endpoint failed on all ${e.rounds} rounds, so the listener has stopped\n`
                + `retrying at its normal cadence and will wait ${this.backoffMs / 60000} minutes before\n`
                + `trying again. It is not in a tight loop and it has not lost its place.\n\n`
                + `Position held: block ${this.state.data.lastBlock} — nothing between there and the chain\n`
                + `head will be missed; it resumes from that block the moment an endpoint answers.\n\n`
                + `What was tried:\n  ${(e.tried || []).join("\n  ")}\n\n`
                + `Endpoint status:\n${JSON.stringify(this.pool.stats(), null, 2)}\n`,
            });
          }
        } else if (this.consecutiveFailures === 5 && !this.failureAlerted) {
          // Alert once, after a few failures — not on the first blip, and not every cycle after.
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

      await this.reportAnomalies();
      await this.reportSummary();
      const wait = this.inBackoff ? this.backoffMs : this.pollMs;
      if (this.inBackoff) this.log(`${this.network}: backing off for ${wait / 60000} minutes before retrying`);
      await this.sleep(wait);
    }
    this.log(`${this.network}: stopped`);
    // Say so. A listener that goes quiet is indistinguishable from a listener that is fine.
    await this.mailer.send({
      subject: `[${this.network}] listener STOPPED`,
      text: `The listener has shut down cleanly.\n\n`
        + `Position held: block ${this.state.data.lastBlock}\n`
        + `Events seen: ${this.state.data.eventsSeen} · alerts sent: ${this.state.data.alertsSent}\n\n`
        + `If this was not deliberate, the chain is no longer being watched. systemd is set to\n`
        + `restart it, and the watchdog timer checks every 5 minutes that it is actually polling.\n`,
    }).catch(() => {});
  }

  /**
   * Sends a digest of RPC anomalies — but ONLY when an endpoint actually failed.
   *
   * 🔴 A SWITCH ON ITS OWN IS NOT NEWS. The pool routes each call to an endpoint that can serve
   * it, so the active endpoint legitimately changes between call classes. Mailing that produced
   * 48 messages a day saying "0 failures, 40 switches" — noise that buries the one message that
   * matters. Switches are counted into the daily heartbeat (reportSummary) and are described in
   * full inside the failure digest they belong to; set mailOnSwitch to get them live.
   * "allFailed" and "cannot read the chain" have their own, louder mails and are not folded in.
   */
  async reportAnomalies() {
    if (this.anomalies.length === 0) return;
    const hasFailure = this.anomalies.some((a) => a.type === "endpointFailed");
    if (!hasFailure && !this.mailOnSwitch) {
      // Nothing failed. Keep the events for the daily heartbeat's context and send no mail.
      if (this.anomalies.length > 50) this.anomalies.splice(0, this.anomalies.length - 50);
      return;
    }
    const since = Date.now() - this.lastAnomalyMail;
    if (this.lastAnomalyMail && since < this.anomalyMailMs) return;

    const items = this.anomalies.splice(0, this.anomalies.length);
    const switched = items.filter((a) => a.type === "switched");
    const failed = items.filter((a) => a.type === "endpointFailed");
    if (failed.length === 0 && !this.mailOnSwitch) return;

    const lines = [
      `${items.length} RPC anomal${items.length === 1 ? "y" : "ies"} on ${this.network}.`,
      `The listener kept working — this is the fallback doing its job, reported so a provider`,
      `that is quietly degrading does not go unnoticed.`,
      "",
    ];
    if (failed.length) {
      lines.push(`Endpoints that failed (${failed.length}):`);
      for (const a of failed.slice(0, 12)) lines.push(`  ${a.at}  ${a.endpoint}  round ${a.round}  ${a.error}`);
      if (failed.length > 12) lines.push(`  …and ${failed.length - 12} more`);
      lines.push("");
    }
    if (switched.length) {
      lines.push(`Active endpoint changed (${switched.length}):`);
      for (const a of switched.slice(0, 12)) lines.push(`  ${a.at}  ${a.from} -> ${a.to}`);
      if (switched.length > 12) lines.push(`  …and ${switched.length - 12} more`);
      lines.push("");
    }
    lines.push(`Currently using: ${this.pool.current}`);
    lines.push(`Position: block ${this.state.data.lastBlock}`);
    lines.push("");
    lines.push(`Endpoint status:\n${JSON.stringify(this.pool.stats(), null, 2)}`);

    this.lastAnomalyMail = Date.now();
    await this.mailer.send({
      subject: `[${this.network}] ${failed.length} RPC failure(s), ${switched.length} switch(es)`,
      text: lines.join("\n"),
    });
  }

  /**
   * ONE heartbeat per summaryMs, carrying the counters since the last one. This is deliberately
   * the ONLY mail that goes out when nothing is wrong: it proves the listener is alive, which a
   * silent listener cannot. Everything else in here is triggered by an actual event.
   * summaryMs = 0 switches it off entirely.
   */
  async reportSummary() {
    if (!this.summaryMs) return;
    if (Date.now() - this.lastSummaryMail < this.summaryMs) return;

    const t = this.tally;
    const hours = ((Date.now() - new Date(t.since).getTime()) / 3_600_000).toFixed(1);
    const health = t.failures === 0 ? "healthy" : `${t.failures} RPC failure(s)`;
    const lines = [
      `${this.network} listener is alive. Nothing here needs action unless a number looks wrong.`,
      "",
      `period          : ${t.since} .. ${new Date().toISOString()} (${hours} h)`,
      `position        : block ${this.state.data.lastBlock}`,
      `events seen     : ${this.state.data.eventsSeen}`,
      `alerts sent     : ${this.state.data.alertsSent}`,
      `rpc failures    : ${t.failures}`,
      `endpoint changes: ${t.switches}   (routing between call types — not a fault)`,
      `active endpoint : ${this.pool.current || "unknown"}`,
      `poll interval   : ${this.pollMs / 1000} s · confirmations ${this.confirmations}`,
      "",
      `Endpoint status:\n${JSON.stringify(this.pool.stats(), null, 2)}`,
    ];
    this.lastSummaryMail = Date.now();
    this.tally = { switches: 0, failures: 0, since: new Date().toISOString() };
    await this.mailer.send({
      subject: `[${this.network}] daily summary — ${health}, block ${this.state.data.lastBlock}`,
      text: lines.join("\n"),
    }).catch(() => {});
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
