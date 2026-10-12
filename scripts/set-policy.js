/**
 * Changes the wallet's policy — the delay and the two allowlist requirements.
 *
 *   WALLET=0x… REQUIRE_RECIPIENT=true REQUIRE_TOKEN=true \
 *   npx hardhat run scripts/set-policy.js --network gembatestnet
 *
 * Two owners, and the whole propose → confirm → execute sequence in one run.
 *
 * TIGHTENING takes effect immediately; LOOSENING waits out the current delay and any single owner
 * can veto it. The script says which of the two it is doing before it does anything, because
 * "switch the allowlist off" and "switch it on" look identical in a command line and are opposite
 * in consequence.
 */
const { ethers, network } = require("hardhat");

const bool = (v, d) => (v == null ? d : String(v).toLowerCase() === "true");

async function main() {
  const addr = process.env.WALLET;
  if (!addr) throw new Error("WALLET is not set");
  const signers = await ethers.getSigners();
  const [, o1, o2, o3] = signers;
  if (!o1 || !o2) throw new Error("need PRIVATE_KEY_OWNER1 and _OWNER2 in .env");

  const w = await ethers.getContractAt("PersonalWallet", addr, o1);
  const [curDelay, curRec, curTok] = await Promise.all([
    w.delay(), w.requireAllowedRecipient(), w.requireAllowedToken(),
  ]);

  const newDelay = BigInt(process.env.DELAY || curDelay);
  const reqRec = bool(process.env.REQUIRE_RECIPIENT, curRec);
  const reqTok = bool(process.env.REQUIRE_TOKEN, curTok);

  console.log(`network : ${network.name}`);
  console.log(`wallet  : ${addr}`);
  console.log(`now     : delay ${curDelay}s · requireRecipient=${curRec} · requireToken=${curTok}`);
  console.log(`wanted  : delay ${newDelay}s · requireRecipient=${reqRec} · requireToken=${reqTok}`);

  if (newDelay === curDelay && reqRec === curRec && reqTok === curTok) {
    console.log("nothing to change");
    return;
  }

  const loosens = newDelay < curDelay || (curRec && !reqRec) || (curTok && !reqTok);
  console.log(loosens
    ? "effect  : LOOSENING — timelocked, and any single owner can veto it"
    : "effect  : TIGHTENING — takes effect as soon as two owners agree");

  // What this costs, stated before it is done rather than after.
  if (reqRec && !curRec) {
    const [list, labels] = await w.allowedRecipients();
    console.log(`\nAfter this, the wallet can ONLY send to these ${list.length} address(es):`);
    list.forEach((a, i) => console.log(`  ${a}  "${labels[i]}"`));
    console.log("Adding another needs ALL THREE owners plus the full delay, and any one owner can veto it.");
  }

  // Resume an identical proposal rather than stacking a second one.
  let id = null;
  const count = await w.proposalCount();
  for (let i = count; i >= 1n && i > count - 5n; i--) {
    const p = await w.getProposal(i);
    if (Number(p.kind) === 10 && !p.executed && !p.cancelled
        && BigInt(p.value) === newDelay
        && BigInt(p.amount) === BigInt((reqRec ? 1 : 0) | (reqTok ? 2 : 0))) { id = i; break; }
  }
  if (id != null) {
    console.log(`\npropose : an identical proposal already exists — resuming id ${id}`);
  } else {
    const rc1 = await (await w.proposeSetPolicy(newDelay, reqRec, reqTok)).wait();
    id = await w.proposalCount();
    console.log(`\npropose : id ${id}  tx ${rc1.hash}`);
  }

  const eff = await w.effectiveAt(id);

  // Idempotent on purpose. A confirm can land on chain and still surface as an error — ethers
  // reported "execution reverted" for a transaction that had in fact been mined, and the script
  // aborted on a proposal that was already ready to execute. So each step checks the chain state
  // first and skips what has already happened, instead of failing on it.
  const need = await w.requiredConfirmations(id);
  if (await w.hasConfirmed(id, o2.address)) {
    console.log(`confirm : already confirmed by ${o2.address} — skipping`);
  } else {
    const rc2 = await (await w.connect(o2).confirm(id)).wait();
    console.log(`confirm : tx ${rc2.hash}`);
  }
  let have = await w.confirmations(id);
  // ALLOW_RECIPIENT needs all three; a policy change needs two. Pull in the third if required.
  if (have < need && o3 && !(await w.hasConfirmed(id, o3.address))) {
    const rc2b = await (await w.connect(o3).confirm(id)).wait();
    console.log(`confirm : third owner tx ${rc2b.hash}`);
    have = await w.confirmations(id);
  }
  console.log(`votes   : ${have} of ${need}`);
  if (have < need) throw new Error(`only ${have} of ${need} confirmations — cannot execute`);

  if (eff > 0n) {
    console.log(`\nTimelocked until ${new Date(Number(eff) * 1000).toISOString()} — not executing now.`);
    console.log(`When it matures:  executeSetPolicy(${id})     To stop it:  veto(${id})`);
    return;
  }

  const rc3 = await (await w.executeSetPolicy(id)).wait();
  console.log(`execute : tx ${rc3.hash}  gas ${rc3.gasUsed}`);

  // Read it back off the chain rather than trusting the call — with retries, because a public
  // endpoint behind a load balancer answers from a block or two behind right after a transaction
  // and will happily report the OLD policy. Reported a successful change as a mismatch once.
  for (let i = 1; i <= 10; i++) {
    const [d2, r2, t2] = await Promise.all([w.delay(), w.requireAllowedRecipient(), w.requireAllowedToken()]);
    if (d2 === newDelay && r2 === reqRec && t2 === reqTok) {
      console.log(`\non chain: delay ${d2}s · requireRecipient=${r2} · requireToken=${t2}`);
      console.log(`verified: the policy on chain matches what was requested${i > 1 ? ` (on read ${i})` : ""}`);
      return;
    }
    if (i === 10) {
      console.log(`\non chain: delay ${d2}s · requireRecipient=${r2} · requireToken=${t2}`);
      throw new Error("the policy on chain does not match what was requested after 10 reads");
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
