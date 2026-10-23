/**
 * Regression test for the alert cadence AND for what counts as worth waking a human.
 *
 * WHY THIS EXISTS: the sepolia listener sent 48 mails a day reading
 * "0 RPC failure(s), 40 switch(es)" — every one of them saying nothing was wrong. Two defects
 * produced it: the pool counted normal per-call routing as an endpoint switch, and the digest
 * mailed switches at all. Both are asserted here so neither can come back.
 *
 *   node listeners/test/alerting.test.js
 */
const assert = require("assert");
const { RpcPool } = require("../lib/rpc.js");
const { Watcher } = require("../lib/watcher.js");

function makeWatcher(extra = {}) {
  const sent = [];
  const w = new Watcher({
    network: "sepolia",
    pool: { onAnomaly: null, current: "drpc", stats: () => [] },
    state: { data: { lastBlock: 100, eventsSeen: 0, alertsSent: 0 }, set() {} },
    mailer: { send: async (m) => { sent.push(m); return m; } },
    addresses: ["0x0000000000000000000000000000000000000001"],
    iface: { parseLog: () => null },
    ...extra,
  });
  return { w, sent };
}

let pass = 0;
const ok = (msg) => { pass++; console.log(`  ok ${pass} — ${msg}`); };

/** The timeout numbers are the whole fix for the 01:09 hang, so they are pinned here. */
function timeoutChecks() {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "rpc.js"), "utf8");
  const req = Number((src.match(/DEFAULT_REQUEST_TIMEOUT_MS = ([0-9_]+)/) || [])[1].replace(/_/g, ""));
  const wsrc = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "watcher.js"), "utf8");
  const logs = Number((wsrc.match(/LOGS_TIMEOUT_MS = ([0-9_]+)/) || [])[1].replace(/_/g, ""));
  // The watchdog calls a listener hung at max(5 × pollMs, 5 min). ethers' own default request
  // timeout is 300 000 ms — the SAME number — which is why one silent endpoint cost a restart.
  const watchdogPatience = 5 * 60_000;
  assert.ok(req < watchdogPatience / 2, `request timeout ${req} must be well under ${watchdogPatience}`);
  assert.ok(logs < watchdogPatience, `logs timeout ${logs} must be under ${watchdogPatience}`);
  assert.ok(req <= logs, "a single read must not be given longer than a logs range");
  return { req, logs, watchdogPatience };
}

async function main() {
  // 1) The exact live symptom: many switches, nothing failed → NO mail at all.
  {
    const { w, sent } = makeWatcher();
    for (let i = 0; i < 40; i++) w.pool.onAnomaly({ type: "switched", from: "a", to: "b", round: 1 });
    await w.reportAnomalies();
    assert.strictEqual(sent.length, 0, "switches alone must send nothing");
    assert.strictEqual(w.tally.switches, 40, "but they must still be counted");
    ok("40 switches, 0 failures → 0 mails (counted: 40)");
  }

  // 2) A real failure still gets through, and carries the switches with it.
  {
    const { w, sent } = makeWatcher();
    for (let i = 0; i < 40; i++) w.pool.onAnomaly({ type: "switched", from: "a", to: "b", round: 1 });
    w.pool.onAnomaly({ type: "endpointFailed", endpoint: "publicnode", error: "timeout", round: 1 });
    await w.reportAnomalies();
    assert.strictEqual(sent.length, 1, "a failure must send");
    assert.match(sent[0].subject, /1 RPC failure\(s\), 40 switch\(es\)/);
    ok(`1 real failure → 1 mail: "${sent[0].subject}"`);
  }

  // 3) The rate limit still holds, so a flapping provider cannot flood.
  {
    const { w, sent } = makeWatcher({ anomalyMailMs: 60_000 });
    w.pool.onAnomaly({ type: "endpointFailed", endpoint: "a", error: "x", round: 1 });
    await w.reportAnomalies();
    w.pool.onAnomaly({ type: "endpointFailed", endpoint: "a", error: "x", round: 1 });
    await w.reportAnomalies();
    assert.strictEqual(sent.length, 1, "the second failure inside the window must wait");
    ok("two failures inside the window → 1 mail (rate limit intact)");
  }

  // 4) MAIL_ON_SWITCH=true is honoured for people who do want every change.
  {
    const { w, sent } = makeWatcher({ mailOnSwitch: true });
    w.pool.onAnomaly({ type: "switched", from: "a", to: "b", round: 1 });
    await w.reportAnomalies();
    assert.strictEqual(sent.length, 1);
    ok("MAIL_ON_SWITCH=true → the switch is mailed");
  }

  // 5) The heartbeat: one per period, never more.
  {
    const { w, sent } = makeWatcher({ summaryMs: 50 });
    await w.reportSummary();
    assert.strictEqual(sent.length, 0, "not before the period is up");
    w.lastSummaryMail = Date.now() - 60;
    await w.reportSummary();
    await w.reportSummary();
    assert.strictEqual(sent.length, 1, "exactly one per period");
    assert.match(sent[0].subject, /daily summary — healthy/);
    ok(`heartbeat: 1 per period, not more — "${sent[0].subject}"`);
  }

  // 6) SUMMARY_MS=0 switches the heartbeat off entirely.
  {
    const { w, sent } = makeWatcher({ summaryMs: 0 });
    w.lastSummaryMail = 0;
    await w.reportSummary();
    assert.strictEqual(sent.length, 0);
    ok("SUMMARY_MS=0 → no heartbeat");
  }

  // 7) THE ROOT CAUSE. publicnode refuses capability calls, drpc serves them; a call with no
  //    capability goes to publicnode. Alternating the two used to emit a switch EVERY TIME.
  {
    const anomalies = [];
    const pool = new RpcPool({
      name: "sepolia", chainId: 11155111, log: () => {},
      endpoints: [
        { label: "publicnode", url: "https://a", keyed: false },
        { label: "drpc", url: "https://b", keyed: false },
      ],
      onAnomaly: (a) => anomalies.push(a),
    });
    pool._provider = (e) => ({ label: e.label, destroy() {} });
    for (let i = 0; i < 20; i++) {
      await pool.withProvider(
        async (p) => { if (p.label === "publicnode") throw new Error("eth_getLogs is not available"); return "logs"; },
        { capability: "logsWithoutAddress" },
      );
      await pool.withProvider(async () => 123);
    }
    const sw = anomalies.filter((a) => a.type === "switched").length;
    assert.ok(sw <= 2, `routing between call types must not count as switching — got ${sw}`);
    ok(`20 cycles of alternating call types → ${sw} switches (was ~2 per cycle = ~40)`);
  }

  // 5) A CLEAN STOP IS SILENT. It is always somebody's act — a restart, a deploy, the watchdog —
  //    and each of those reports itself. See the note at the top of the file.
  {
    const { w, sent } = makeWatcher();
    w.stopping = true;
    await w.start();
    const stopped = sent.filter((m) => /STOPPED/i.test(m.subject));
    assert.strictEqual(stopped.length, 0, "a clean shutdown must not mail");
    ok(`clean stop → 0 mails (was 1, and it was the scariest subject in the system)`);
  }

  // 6) The timeouts that caused the 01:09 restart cannot drift back into a race with the watchdog.
  {
    const { req, logs, watchdogPatience } = timeoutChecks();
    ok(`request ${req / 1000}s · logs ${logs / 1000}s · watchdog patience ${watchdogPatience / 1000}s — no race`);
  }

  // Assert the count, do not just print it. A hardcoded "7" next to a growing list of cases is
  // how a test file quietly stops running half of itself.
  const EXPECTED = 9;
  console.log(`\n  ${pass}/${EXPECTED} passed`);
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
