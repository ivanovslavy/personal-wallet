/**
 * Regression test for the failed-transaction scan (2026-11-22).
 *
 * WHY THIS EXISTS: on 21.11.2026 one stranger's EIP-7702 transaction on BSC (an authorization with
 * yParity 0xbc, block 134791636) made ethers' getBlock(n, true) throw on EVERY endpoint; the listener
 * logged 728 "endpoint failures" and then stepped over the block in silence, and a 705-block catch-up
 * skipped the scan for the whole range. Asserted here: the block is read raw, nothing is ever skipped,
 * a held block is mailed once and its release once, and an unreadable incoming-transfer range throws.
 *
 *   node listeners/test/failed-scan.test.js
 */
const assert = require("assert");
const { Watcher } = require("../lib/watcher.js");

const WALLET = "0x97218e98a3c6f479ece1d6f97ef82bcf6a0026ec";
const BAD_7702 = { hash: "0xbad", from: "0x01", to: "0x02", input: "0x", value: "0x0", type: "0x4",
  authorizationList: [{ chainId: "0x38", address: "0x03", nonce: "0x0", yParity: "0xbc", r: "0x1", s: "0x2" }] };
const REFUSED = { hash: "0xref", from: "0x04", to: WALLET, input: "0xa9059cbb0000", value: "0x5", type: "0x2" };

function make({ blocks, receipts = {}, start = 99, last = 100, extra = {} }) {
  const sent = [];
  const data = { lastBlock: last, eventsSeen: 0, alertsSent: 0, failedScanBlock: start };
  const provider = {
    send: async (m, [tag]) => {
      assert.strictEqual(m, "eth_getBlockByNumber");
      const b = blocks[parseInt(tag, 16)];
      if (b instanceof Error) throw b;
      return b;
    },
    getTransactionReceipt: async (h) => (h in receipts ? receipts[h] : { status: 1 }),
    call: async () => { const e = new Error("reverted"); e.data = "0x08c379a0"; throw e; },
    getLogs: async () => { throw new Error("logs refused"); },
  };
  const w = new Watcher({
    network: "bsc",
    pool: { onAnomaly: null, current: "x", stats: () => [], withProvider: (fn) => fn(provider) },
    state: { data, set(p) { Object.assign(data, p); } },
    mailer: { send: async (m) => { sent.push(m); return true; } },
    addresses: [WALLET],
    iface: { parseLog: () => null, parseError: () => null },
    ...extra,
  });
  return { w, sent, data };
}

let pass = 0;
const ok = (m) => { pass++; console.log(`  ok ${pass} — ${m}`); };

(async () => {
  // 1) The 21.11 block: a malformed 7702 tx next to a refused tx to the wallet → the refusal is found.
  {
    const { w, data } = make({ blocks: { 100: { transactions: [BAD_7702, REFUSED] } }, receipts: { "0xref": { status: 0 } } });
    const out = await w.scanFailed(100);
    assert.strictEqual(out.length, 1); assert.strictEqual(out[0].txHash, "0xref"); assert.strictEqual(out[0].args.value, "5");
    assert.strictEqual(data.failedScanBlock, 100);
    ok("block with an invalid 7702 authorization is read raw; the refused tx to the wallet is reported");
  }

  // 2) An unreadable block HOLDS the position — never skipped — and the next cycle continues from it.
  {
    const blocks = { 100: { transactions: [] }, 101: new Error("boom"), 102: { transactions: [] } };
    const { w, data, sent } = make({ blocks, last: 102, extra: { failedScanStallMs: 0 } });
    await w.scanFailed(102);
    assert.strictEqual(data.failedScanBlock, 100, "stops BEFORE the unreadable block");
    assert.strictEqual(sent.length, 1); assert.match(sent[0].subject, /HELD at block 101/);
    await w.scanFailed(102);
    assert.strictEqual(sent.length, 1, "the hold is mailed once, not every cycle");
    blocks[101] = { transactions: [] };
    await w.scanFailed(102);
    assert.strictEqual(data.failedScanBlock, 102, "continues through 101 and 102");
    assert.strictEqual(sent.length, 2); assert.match(sent[1].subject, /moving again \(block 101 read\)/);
    ok("unreadable block 101 holds the scan at 100, mailed once; when readable: 101 and 102 scanned, release mailed");
  }

  // 3) A missing receipt is an error too — the block is not marked done.
  {
    const { w, data } = make({ blocks: { 100: { transactions: [REFUSED] } }, receipts: { "0xref": null } });
    await w.scanFailed(100);
    assert.strictEqual(data.failedScanBlock, 99);
    ok("no receipt → block not marked scanned");
  }

  // 4) A catch-up bigger than maxFailedScanBlocks is worked through, not skipped.
  {
    const blocks = {}; for (let n = 100; n <= 1099; n++) blocks[n] = { transactions: [] };
    const { w, data } = make({ blocks, last: 1099, extra: { maxFailedScanBlocks: 300 } });
    await w.scanFailed(1099); assert.strictEqual(data.failedScanBlock, 399);
    await w.scanFailed(1099); assert.strictEqual(data.failedScanBlock, 699);
    await w.scanFailed(1099); await w.scanFailed(1099); assert.strictEqual(data.failedScanBlock, 1099);
    await w.scanFailed(1099); assert.strictEqual(data.failedScanBlock, 1099, "never runs ahead of the log scan");
    ok("1000-block backlog: 300 per cycle, every block covered, never past the log position");
  }

  // 5) An unreadable incoming-transfer range THROWS (so the position is not saved past it).
  {
    const { w } = make({ blocks: {} });
    await assert.rejects(() => w.scanIncoming(100, 200), /logs refused/);
    ok("scanIncoming error propagates instead of reading as 'no arrivals'");
  }

  // 6) The daily summary names a held scan.
  {
    const { w, sent } = make({ blocks: { 100: new Error("x") }, extra: { summaryMs: 1 } });
    await w.scanFailed(100); w.lastSummaryMail = 0;
    await w.reportSummary();
    assert.match(sent.at(-1).subject, /HELD at 100/); assert.match(sent.at(-1).text, /failed-tx scan  : block 99/);
    ok("daily summary carries the held block in subject and body");
  }
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
