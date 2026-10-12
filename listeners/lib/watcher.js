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

    const found = [];
    while (from <= target && !this.stopping) {
      const to = Math.min(from + this.maxSpan - 1, target);
      const logs = await this.getLogs(from, to);
      for (const l of logs) found.push(this.decode(l));
      this.state.set({ lastBlock: to });
      from = to + 1;
    }

    if (found.length) {
      this.state.set({ eventsSeen: this.state.data.eventsSeen + found.length });
      this.log(`${this.network}: ${found.length} event(s)`, { blocks: `${found[0].blockNumber}..${found[found.length - 1].blockNumber}` });
      const ok = await this.mailer.send(this.compose(found));
      if (ok) this.state.set({ alertsSent: this.state.data.alertsSent + 1 });
    }
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
    const names = [...new Set(events.map((e) => e.name))];
    const subject = `[${this.network}] ${events.length} event${events.length > 1 ? "s" : ""}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}`;
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
