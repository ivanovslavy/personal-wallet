/**
 * The listener's POLICY ALARM against the REAL contract (2026-11-27, audit 26.11.2026 PersonalWallet F1).
 *
 * A confirmed, non-timelocked SET_POLICY proposal that is left open can later LOOSEN the policy
 * instantly (its values are written at execution, its timelock was decided at proposal). It cannot
 * be cancelled or vetoed. The listener therefore reads the wallet's open proposals from the chain and
 * mails every open SET_POLICY until it is executed, cancelled or expired. This suite drives the real
 * PersonalWallet on the Hardhat network through the listener's real Watcher and checks every mail.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { Watcher } = require("../listeners/lib/watcher.js");
const { deployFixture, loadFixture, HOUR, DAY } = require("./helpers");

function makeWatcher(wallet, addr, pool) {
  const sent = [];
  const state = { data: { lastBlock: 0, eventsSeen: 0, alertsSent: 0 }, set(p) { Object.assign(this.data, p); } };
  const w = new Watcher({
    network: "hardhat",
    pool: pool || { onAnomaly: null, current: "hardhat", stats: () => [], withProvider: (fn) => fn(ethers.provider) },
    state,
    mailer: { send: async (m) => { sent.push(m); return true; } },
    addresses: [addr],
    iface: wallet.interface,
    explorer: "https://example.invalid",
  });
  // run a check now, regardless of the 10-minute cadence
  const check = async () => { w.lastPolicyCheck = 0; await w.checkPolicy(); };
  return { w, sent, state, check };
}

describe("09 · listener policy alarm (real contract)", () => {
  it("is silent while no SET_POLICY proposal is open", async () => {
    const { wallet, addr } = await loadFixture(deployFixture);
    const { w, sent, check } = makeWatcher(wallet, addr);
    await check();
    expect(sent).to.have.length(0);
    expect(w.openPolicy).to.have.length(0);
    expect(w.policyCheckOkAt).to.be.a("string");
  });

  it("mails the stale-proposal case: proposed → confirmed (EXECUTE NOW) → reminded → executed (quiet)", async () => {
    const { wallet, addr, o1, o2 } = await loadFixture(deployFixture);
    const { w, sent, state, check } = makeWatcher(wallet, addr);

    await wallet.connect(o1).proposeSetPolicy(30 * DAY, true, false); // lengthens the delay → "tightening"
    const id = Number(await wallet.proposalCount());
    expect(await wallet.effectiveAt(id)).to.equal(0n, "not timelocked — the F1 precondition");
    await check();
    expect(sent).to.have.length(1);
    expect(sent[0].subject).to.equal(`[hardhat] POLICY ALARM: SET_POLICY #${id} AWAITING CONFIRMATION`);
    expect(sent[0].text).to.include("delay 720 h · recipient allowlist ON · token allowlist OFF");
    expect(sent[0].text).to.include("Once confirmed it can no longer be cancelled");

    await wallet.connect(o2).confirm(id);
    await check();
    expect(sent).to.have.length(2, "a stage change is mailed at once");
    expect(sent[1].subject).to.equal(`[hardhat] POLICY ALARM: SET_POLICY #${id} CONFIRMED NOT EXECUTED`);
    expect(sent[1].text).to.include(`EXECUTE IT NOW (executeSetPolicy(${id}))`);
    expect(sent[1].text).to.include("can NOT be cancelled or vetoed");

    await check();
    expect(sent).to.have.length(2, "no repeat before the reminder is due");
    state.data.policyAlerts[`${addr.toLowerCase()}#${id}`].at -= w.policyRemindMs;
    await check();
    expect(sent).to.have.length(3, "reminded after policyRemindMs");
    expect(sent[2].subject).to.include("CONFIRMED NOT EXECUTED");

    await wallet.connect(o1).executeSetPolicy(id);
    await check();
    expect(sent).to.have.length(3, "an executed proposal is not mailed");
    expect(w.openPolicy).to.have.length(0);
    expect(state.data.policyScanFrom[addr.toLowerCase()]).to.equal(id + 1, "final proposals are not read again");
  });

  it("mails a loosening proposal with the VETO instruction and goes quiet after the veto", async () => {
    const { wallet, addr, o1, o3 } = await loadFixture(deployFixture);
    const { sent, check, w } = makeWatcher(wallet, addr);
    await wallet.connect(o1).proposeSetPolicy(24 * HOUR, false, false); // shorter delay → loosening, timelocked
    const id = Number(await wallet.proposalCount());
    await check();
    expect(sent).to.have.length(1);
    expect(sent[0].subject).to.equal(`[hardhat] POLICY ALARM: SET_POLICY #${id} LOOSENING SCHEDULED`);
    expect(sent[0].text).to.include(`VETO IT before then — any single owner can (veto(${id}))`);
    await wallet.connect(o3).veto(id);
    await check();
    expect(sent).to.have.length(1);
    expect(w.openPolicy).to.have.length(0);
  });

  it("goes quiet once an open proposal expires (7 days)", async () => {
    const { wallet, addr, o1, o2 } = await loadFixture(deployFixture);
    const { sent, check, w } = makeWatcher(wallet, addr);
    await wallet.connect(o1).proposeSetPolicy(30 * DAY, false, false);
    await wallet.connect(o2).confirm(Number(await wallet.proposalCount()));
    await check();
    expect(sent).to.have.length(1);
    await time.increase(7 * DAY + 60);
    await check();
    expect(sent).to.have.length(1);
    expect(w.openPolicy).to.have.length(0);
  });

  it("keeps reading past open transfer proposals and still finds a later SET_POLICY", async () => {
    const { wallet, addr, o1, recipient } = await loadFixture(deployFixture);
    const { sent, check } = makeWatcher(wallet, addr);
    await wallet.connect(o1).proposeNative(recipient.address, 1n, 3600); // open, not policy
    await check();
    expect(sent).to.have.length(0);
    await wallet.connect(o1).proposeSetPolicy(30 * DAY, false, false);
    await check();
    expect(sent).to.have.length(1);
    expect(sent[0].subject).to.include(`#${Number(await wallet.proposalCount())} AWAITING CONFIRMATION`);
  });

  it("the plain event mail names the kind and leads with POLICY CHANGE", async () => {
    const { wallet, addr, o1 } = await loadFixture(deployFixture);
    const { w } = makeWatcher(wallet, addr);
    const rc = await (await wallet.connect(o1).proposeSetPolicy(30 * DAY, false, false)).wait();
    const events = rc.logs.map((l) => w.decode(l));
    const proposed = events.find((e) => e.name === "Proposed");
    expect(proposed.args.kind).to.equal("SET_POLICY (10)");
    expect(w.compose(events).subject).to.match(/^\[hardhat\] POLICY CHANGE \+ 2 events: Proposed, Confirmed$/);
  });

  it("mails once after six failed reads, and once when it reads again", async () => {
    const { wallet, addr } = await loadFixture(deployFixture);
    let broken = true;
    const pool = { onAnomaly: null, current: "x", stats: () => [],
      withProvider: (fn) => (broken ? Promise.reject(new Error("rpc down")) : fn(ethers.provider)) };
    const { sent, check } = makeWatcher(wallet, addr, pool);
    for (let i = 0; i < 8; i++) await check();
    expect(sent.map((m) => m.subject)).to.deep.equal(["[hardhat] policy alarm cannot read the wallet"]);
    broken = false;
    await check();
    expect(sent.map((m) => m.subject)).to.deep.equal(["[hardhat] policy alarm cannot read the wallet", "[hardhat] policy alarm reading again"]);
  });
});
