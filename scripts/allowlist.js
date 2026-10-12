/**
 * Adds to or removes from the wallet's two registries.
 *
 *   WALLET=0x… ACTION=allow-token  TARGET=0x… LABEL="Kotkata" \
 *   npx hardhat run scripts/allowlist.js --network gembatestnet
 *
 *   ACTION = allow-token | revoke-token | allow-recipient | revoke-recipient
 *
 * Runs the whole propose -> confirm -> execute sequence, and gathers as many signatures as the
 * contract actually requires for that action — three for a new recipient, two for everything else.
 * Set ALL_THREE=true to have the third owner sign anyway where only two are needed.
 *
 * A new RECIPIENT is timelocked: this script proposes and confirms it, prints when it matures, and
 * stops. It does not sit waiting for 72 hours. Run it again after that, or call
 * executeAllowRecipient(id) directly.
 */
const { ethers, network } = require("hardhat");

/**
 * The proposal id, taken from the Proposed event in the receipt.
 *
 * NOT from `proposalCount()` after the transaction: a public endpoint behind a load balancer
 * answers from a block or two behind, returned the OLD count, and the script then tried to
 * confirm an already-executed proposal. The receipt cannot be stale — it is the transaction's
 * own log.
 */
function idFromReceipt(w, rc) {
  for (const log of rc.logs) {
    try {
      const p = w.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p && p.name === "Proposed") return p.args[0];
    } catch { /* not ours */ }
  }
  throw new Error("no Proposed event in the receipt — cannot determine the proposal id");
}

const KIND = { ALLOW_TOKEN: 6, REVOKE_TOKEN: 7, ALLOW_RECIPIENT: 8, REVOKE_RECIPIENT: 9 };

const ACTIONS = {
  "allow-token":      { kind: KIND.ALLOW_TOKEN,      propose: "proposeAllowToken",      exec: "executeAllowToken",      needsLabel: true },
  "revoke-token":     { kind: KIND.REVOKE_TOKEN,     propose: "proposeRevokeToken",     exec: "executeRevokeToken",     needsLabel: false },
  "allow-recipient":  { kind: KIND.ALLOW_RECIPIENT,  propose: "proposeAllowRecipient",  exec: "executeAllowRecipient",  needsLabel: true },
  "revoke-recipient": { kind: KIND.REVOKE_RECIPIENT, propose: "proposeRevokeRecipient", exec: "executeRevokeRecipient", needsLabel: false },
};

async function main() {
  const addr = process.env.WALLET;
  const action = process.env.ACTION;
  const target = process.env.TARGET;
  const label = process.env.LABEL || "";
  const a = ACTIONS[action];
  if (!addr) throw new Error("WALLET is not set");
  if (!a) throw new Error(`ACTION must be one of: ${Object.keys(ACTIONS).join(", ")}`);
  if (!target) throw new Error("TARGET is not set");
  if (a.needsLabel && !label) throw new Error("LABEL is required for this action — the label is yours, never read from the token");

  const [, o1, o2, o3] = await ethers.getSigners();
  const w = await ethers.getContractAt("PersonalWallet", addr, o1);

  console.log(`network : ${network.name}`);
  console.log(`wallet  : ${addr}`);
  console.log(`action  : ${action}  ${target}${label ? `  "${label}"` : ""}`);

  // Already in the state being asked for?
  if (action === "allow-token" && await w.isTokenAllowed(target)) { console.log("already allowed — nothing to do"); return; }
  if (action === "allow-recipient" && await w.isRecipientAllowed(target)) { console.log("already allowed — nothing to do"); return; }
  if (action === "revoke-token" && !(await w.isTokenAllowed(target))) { console.log("not allowed anyway — nothing to do"); return; }
  if (action === "revoke-recipient" && !(await w.isRecipientAllowed(target))) { console.log("not allowed anyway — nothing to do"); return; }

  // Resume an identical pending proposal instead of stacking another.
  let id = null;
  const count = await w.proposalCount();
  for (let i = count; i >= 1n && i > count - 8n; i--) {
    const p = await w.getProposal(i);
    if (p.executed || p.cancelled || Number(p.kind) !== a.kind) continue;
    const subject = (action.endsWith("token") ? p.token : p.to).toLowerCase();
    if (subject === target.toLowerCase()) { id = i; break; }
  }
  if (id != null) console.log(`propose : identical proposal already pending — resuming id ${id}`);
  else {
    const args = a.needsLabel ? [target, label] : [target];
    const rc = await (await w[a.propose](...args)).wait();
    id = idFromReceipt(w, rc);
    console.log(`propose : id ${id}  tx ${rc.hash}`);
  }

  const need = await w.requiredConfirmations(id);
  const eff = await w.effectiveAt(id);
  console.log(`votes   : needs ${need}${eff > 0n ? `  (timelocked until ${new Date(Number(eff) * 1000).toISOString()})` : "  (no timelock)"}`);

  // Gather signatures: as many as required, or all three if asked.
  const wantAll = String(process.env.ALL_THREE).toLowerCase() === "true" || need === 3n;
  for (const o of [o2, o3]) {
    if (!o) continue;
    const have = await w.confirmations(id);
    if (have >= need && !wantAll) break;
    if (await w.hasConfirmed(id, o.address)) { console.log(`confirm : ${o.address} already signed`); continue; }
    const rc = await (await w.connect(o).confirm(id)).wait();
    console.log(`confirm : ${o.address}  tx ${rc.hash}`);
  }
  const have = await w.confirmations(id);
  console.log(`votes   : ${have} of ${need}`);
  if (have < need) throw new Error(`only ${have} of ${need} — cannot execute`);

  if (eff > 0n && BigInt(Math.floor(Date.now() / 1000)) < eff) {
    console.log(`\nTimelocked. Not executing now.`);
    console.log(`  matures : ${new Date(Number(eff) * 1000).toISOString()}`);
    console.log(`  then    : executeAllowRecipient(${id})      to stop it: veto(${id})`);
    return;
  }

  const rc = await (await w[a.exec](id)).wait();
  console.log(`execute : tx ${rc.hash}  gas ${rc.gasUsed}`);

  // Read it back, with retries — a public endpoint answers from a block behind right after a tx.
  const check = action.endsWith("token") ? () => w.isTokenAllowed(target) : () => w.isRecipientAllowed(target);
  const expected = action.startsWith("allow");
  for (let i = 1; i <= 10; i++) {
    if (await check() === expected) { console.log(`verified: on chain, allowed=${expected}${i > 1 ? ` (on read ${i})` : ""}`); return; }
    if (i === 10) throw new Error("the registry on chain does not match what was requested after 10 reads");
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
