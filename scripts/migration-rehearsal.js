/**
 * Migration rehearsal — the whole 2026-10-23 sweep, against a LOCAL FORK of the live chain.
 *
 *   FORK_RPC=https://rpc1.gembascan.io [LOG_RPC=<archive rpc>] \
 *   OLD=0x…,0x… NEW=0x… npx hardhat run scripts/migration-rehearsal.js --network hardhat
 *
 * WHY. On 2026-10-23 four contracts holding real assets get swept into two. Nobody has performed
 * that operation before, and the 72-hour timelock cannot be re-run if the plan turns out to need
 * a step we did not anticipate. A fork costs nothing and answers the questions that matter BEFORE
 * the live attempt: how many proposals, does one NFT batch take everything, does anything revert,
 * and is each old wallet actually EMPTY afterwards.
 *
 * The inventory comes from scripts/lib/holdings.js — read its header before trusting any of this;
 * naive asset discovery silently finds nothing on these two chains, and the first version of this
 * rehearsal reported "1 NFT" where there were five.
 *
 * Nothing here touches a live chain. The fork is in memory and discarded when the process exits.
 */
const { ethers, network } = require("hardhat");
const { inventory } = require("./lib/holdings.js");

const log = (...a) => console.log("  ", ...a);

/**
 * A provider that gives up on a silent endpoint.
 *
 * ethers' FetchRequest defaults to **300 000 ms**. A log scan over ~90 000 blocks makes dozens of
 * getLogs calls, and one endpoint going quiet froze this script for five minutes with no output at
 * all — indistinguishable from a hang. The listeners had the identical defect and the identical
 * fix (listeners/lib/rpc.js); it is the same number in a second place.
 */
function withTimeout(url, ms) {
  const req = new ethers.FetchRequest(url);
  req.timeout = ms;
  return new ethers.JsonRpcProvider(req, undefined, { batchMaxCount: 1 });
}

const DELAY = 25 * 24 * 3600;   // the per-proposal delay the live sweep will use

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x3635C9ADC5DEA00000"]);
  return await ethers.getSigner(addr);
}

async function main() {
  // The fork comes from hardhat.config.js via FORK_RPC — NOT from hardhat_reset, which would drop
  // the chains/hardforkHistory the config supplies and break execution on a custom chain.
  //
  // 🔑 MINE ONE BLOCK FIRST. At the fork block itself Hardhat treats every call as "historical" and
  // demands a hardfork activation history it does not have for a custom chain — reads of raw state
  // work, but any execution dies with "No known hardfork for execution on historical block". One
  // step forward and calls run against the configured hardfork like any normal block.
  await network.provider.send("evm_mine");
  log(`форкнато на блок ${await ethers.provider.getBlockNumber()}`);

  const NEW = ethers.getAddress(process.env.NEW);
  const olds = process.env.OLD.split(",").map(a => ethers.getAddress(a.trim()));
  // Discovery runs against the LIVE chain, not the fork: forks answer eth_getLogs for historical
  // ranges with an empty list instead of an error, which would report "no NFTs" and be believed.
  const live = withTimeout(process.env.FORK_RPC, 30_000);
  // And the chain id must come from the LIVE node too — the fork reports Hardhat's own 31337, no
  // indexer matches that, and discovery silently falls back to a log scan the node cannot serve.
  const chainId = Number((await live.getNetwork()).chainId);
  const logProvider = process.env.LOG_RPC
    ? withTimeout(process.env.LOG_RPC, 60_000)
    : live;

  let proposals = 0, txs = 0, gas = 0n;
  const failures = [], leftovers = [];

  for (const oldAddr of olds) {
    log("");
    log(`═══ ${oldAddr}`);
    const inv = await inventory(live, oldAddr, chainId, { logProvider });
    log(`наличности (${inv.how}): ${inv.erc20.length} ERC20 · ${inv.nft.length} NFT позиции · ${ethers.formatEther(inv.native)} native`);
    for (const s of inv.stranded) failures.push(`${oldAddr}: ${s.label} id=${s.id} е ИЗВЪН регистъра — не може да се мести без ново вписване`);

    const w0 = await ethers.getContractAt("PersonalWallet", oldAddr);
    const [o1, o2] = await Promise.all((await w0.owners()).slice(0, 2).map(impersonate));
    const w1 = w0.connect(o1), w2 = w0.connect(o2);

    const run = async (label, proposeFn, executeFn) => {
      try {
        const pr = await (await proposeFn(w1)).wait();
        const ev = pr.logs.find(l => { try { return w0.interface.parseLog(l).name === "Proposed"; } catch { return false; } });
        const id = w0.interface.parseLog(ev).args.id;
        await (await w2.confirm(id)).wait();
        const er = await (await executeFn(w1, id)).wait();
        proposals++; txs += 3; gas += pr.gasUsed + er.gasUsed;
        log(`   ${label}: предложение ${id} · газ ${pr.gasUsed + er.gasUsed}`);
        return true;
      } catch (e) {
        failures.push(`${oldAddr} ${label}: ${(e.shortMessage || e.message).slice(0, 110)}`);
        log(`   ${label}: 🔴 ПРОВАЛ`);
        return false;
      }
    };

    // ---- 1. the pending recipient approval, once its timelock has matured --------------------
    const count = await w0.proposalCount();
    let approvalId = 0n;
    for (let i = count; i >= 1n; i--) {
      const p = await w0.getProposal(i);
      if (p.to.toLowerCase() === NEW.toLowerCase() && !p.executed && !p.cancelled) { approvalId = i; break; }
    }
    if (approvalId === 0n) {
      if (await w0.isRecipientAllowed(NEW)) log("получателят вече е одобрен");
      else { failures.push(`${oldAddr}: няма предложение за одобрение на ${NEW}`); continue; }
    } else {
      const eff = Number(await w0.effectiveAt(approvalId));
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      if (eff > now) {
        await network.provider.send("evm_setNextBlockTimestamp", [eff + 60]);
        await network.provider.send("evm_mine");
        log(`прескочих timelock-а: +${Math.round((eff - now) / 3600)} ч`);
      }
      const r = await (await w1.executeAllowRecipient(approvalId)).wait();
      txs++; gas += r.gasUsed;
      log(`одобрение ${approvalId} изпълнено · газ ${r.gasUsed}`);
    }

    // ---- 2. the fungibles, one proposal each -------------------------------------------------
    for (const t of inv.erc20) {
      await run(`ERC20 ${t.label}`, w => w.proposeERC20(t.token, NEW, t.amount, DELAY), (w, id) => w.executeERC20(id));
    }

    // ---- 3. everything non-fungible in ONE batch --------------------------------------------
    if (inv.nft.length) {
      const items = inv.nft.map(x => [x.token, x.standard, x.id, x.amount]);
      log(`NFT за местене: ${items.length} позиции (лимитът на партидата е 50)`);
      await run(`NFT партида ×${items.length}`, w => w.proposeNFTBatch(NEW, items, DELAY), (w, id) => w.executeNFTBatch(id));
    }

    // ---- 4. native LAST — the steps above cost gas from the owners, not from the wallet ------
    if (inv.native > 0n) {
      await run(`native ${ethers.formatEther(inv.native)}`, w => w.proposeNative(NEW, inv.native, DELAY), (w, id) => w.executeNative(id));
    }

    // ---- 5. is it EMPTY? ---------------------------------------------------------------------
    // The point of the rehearsal. Checked against the FORK (post-sweep state), item by item.
    const after = [];
    for (const t of inv.erc20) { const b = await w0.erc20Balance(t.token); if (b > 0n) after.push(`${t.label}=${b}`); }
    for (const n of inv.nft) {
      if (n.standard === 1) { const b = await w0.erc1155Balance(n.token, n.id); if (b > 0n) after.push(`${n.label}#${n.id}=${b}`); }
      else {
        const o = await (new ethers.Contract(n.token, ["function ownerOf(uint256) view returns (address)"], ethers.provider)).ownerOf(n.id);
        if (o.toLowerCase() === oldAddr.toLowerCase()) after.push(`${n.label}#${n.id}`);
      }
    }
    const nat = await w0.nativeBalance();
    if (nat > 0n) after.push(`${ethers.formatEther(nat)} native`);
    if (after.length) { leftovers.push(`${oldAddr}: ${after.join(", ")}`); log(`🔴 ОСТАВА В СТАРИЯ: ${after.join(", ")}`); }
    else log("✓ старият портфейл е ПРАЗЕН");
  }

  log("");
  log("═══ РЕЗУЛТАТ ОТ РЕПЕТИЦИЯТА");
  log(`предложения : ${proposals}`);
  log(`транзакции  : ${txs}  (предложение + потвърждение + изпълнение за всяко, плюс одобренията)`);
  log(`общо газ    : ${gas}`);
  log(`провали     : ${failures.length}`);
  failures.forEach(f => log(`   🔴 ${f}`));
  log(`недоизпразнени: ${leftovers.length}`);
  leftovers.forEach(f => log(`   🔴 ${f}`));
  if (failures.length || leftovers.length) process.exitCode = 1;
}
main().catch(e => { console.error("ГРЕШКА:", e.shortMessage || e.message); process.exitCode = 1; });
