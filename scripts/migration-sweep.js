/**
 * The live sweep — empties the retired wallets into the current one.
 *
 * This is the rehearsed plan, not a new one. `scripts/migration-rehearsal.js` ran exactly these
 * steps against a fork of both chains first; read the Task 10 section of docs/INVARIANTS.md before
 * running it, including the five ways naive asset discovery silently loses assets.
 *
 *   # what it would do, no transactions sent (the default):
 *   OLD=0x…,0x… NEW=0x… npx hardhat run scripts/migration-sweep.js --network gembatestnet
 *
 *   # and for real:
 *   I_MEAN_IT=yes OLD=… NEW=… npx hardhat run scripts/migration-sweep.js --network gembatestnet
 *
 * WHY THE GUARD. Each old wallet's recipient approval took 72 hours to mature and can only be
 * spent once. A half-finished sweep is not a retry — it is three more days. So the default is a
 * dry run that prints the full plan, and the live mode is opt-in by an environment variable that
 * cannot be typed by accident.
 *
 * ONE TRANSACTION AT A TIME, with the nonce read fresh before each. Batching these is how the
 * Sepolia deployments produced `in-flight transaction limit reached for delegated accounts` and
 * `gapped-nonce tx`: the deployer there has an EIP-7702 delegation, and a delegated account does
 * not accept a queue. Reads are re-verified at a fixed blockTag afterwards, because an RPC will
 * happily answer `ownerOf` from a block before the transfer it just mined.
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

const LIVE = process.env.I_MEAN_IT === "yes";
const DELAY = 25 * 24 * 3600;

async function send(label, fn) {
  if (!LIVE) { log(`   [на сухо] ${label}`); return null; }
  const tx = await fn();
  log(`   ${label} → ${tx.hash}`);
  const r = await tx.wait(1);
  if (r.status !== 1) throw new Error(`${label}: транзакцията се провали (${tx.hash})`);
  return r;
}

async function main() {
  const NEW = ethers.getAddress(process.env.NEW);
  const olds = process.env.OLD.split(",").map(a => ethers.getAddress(a.trim()));
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const logProvider = process.env.LOG_RPC
    ? withTimeout(process.env.LOG_RPC, 60_000)
    : ethers.provider;

  const signers = await ethers.getSigners();
  log(`мрежа ${network.name} (chainId ${chainId}) · ${LIVE ? "🔴 НАЖИВО" : "на сухо, нищо не се праща"}`);
  log(`получател: ${NEW}`);

  for (const oldAddr of olds) {
    log("");
    log(`═══ ${oldAddr}`);
    const w0 = await ethers.getContractAt("PersonalWallet", oldAddr);
    const owners = (await w0.owners()).map(a => a.toLowerCase());
    const mine = signers.filter(s => owners.includes(s.address.toLowerCase()));
    if (mine.length < 2) throw new Error(`имам само ${mine.length} от собствениците на ${oldAddr} — трябват 2`);
    const [a, b] = mine;

    const inv = await inventory(ethers.provider, oldAddr, chainId, { logProvider });
    log(`наличности (${inv.how}): ${inv.erc20.length} ERC20 · ${inv.nft.length} NFT · ${ethers.formatEther(inv.native)} native`);
    for (const s of inv.stranded) log(`   🔶 ${s.label} id=${s.id} е ИЗВЪН регистъра — остава, трябва ново вписване`);

    if (!await w0.isRecipientAllowed(NEW)) {
      // The approval must already be matured and executed; doing it here would mean the 72 hours
      // had not been waited out and the sweep is premature.
      const count = await w0.proposalCount();
      let id = 0n;
      for (let i = count; i >= 1n; i--) {
        const p = await w0.getProposal(i);
        if (p.to.toLowerCase() === NEW.toLowerCase() && !p.executed && !p.cancelled) { id = i; break; }
      }
      if (id === 0n) throw new Error(`${oldAddr}: ${NEW} не е одобрен и няма чакащо предложение`);
      const eff = Number(await w0.effectiveAt(id));
      const now = Math.floor(Date.now() / 1000);
      if (eff > now) {
        const msg = `предложение ${id} съзрява в ${new Date(eff * 1000).toISOString()} — още ${Math.round((eff - now) / 3600)} ч`;
        // Fatal only when it would actually send: a dry run exists precisely to be read BEFORE the
        // timelock matures, so refusing to print the plan would defeat its purpose.
        if (LIVE) throw new Error(`${oldAddr}: ${msg}`);
        log(`   ⏳ ${msg}`);
      } else await send(`одобрение ${id}`, () => w0.connect(a).executeAllowRecipient(id));
    } else log("получателят вече е одобрен");

    const step = async (label, propose, execute) => {
      const r = await send(`${label}: предложение`, propose);
      if (!LIVE) { log(`   [на сухо] ${label}: потвърждение + изпълнение`); return; }
      const ev = r.logs.find(l => { try { return w0.interface.parseLog(l).name === "Proposed"; } catch { return false; } });
      const id = w0.interface.parseLog(ev).args.id;
      await send(`${label}: потвърждение ${id}`, () => w0.connect(b).confirm(id));
      await send(`${label}: изпълнение ${id}`, () => execute(id));
    };

    for (const t of inv.erc20) {
      await step(`ERC20 ${t.label}`,
        () => w0.connect(a).proposeERC20(t.token, NEW, t.amount, DELAY),
        id => w0.connect(a).executeERC20(id));
    }
    if (inv.nft.length) {
      const items = inv.nft.map(x => [x.token, x.standard, x.id, x.amount]);
      await step(`NFT партида ×${items.length}`,
        () => w0.connect(a).proposeNFTBatch(NEW, items, DELAY),
        id => w0.connect(a).executeNFTBatch(id));
    }
    // Native last: the steps above are paid by the owners, so emptying it earlier buys nothing.
    if (inv.native > 0n) {
      await step(`native ${ethers.formatEther(inv.native)}`,
        () => w0.connect(a).proposeNative(NEW, inv.native, DELAY),
        id => w0.connect(a).executeNative(id));
    }

    if (LIVE) {
      // Re-read at a FIXED block. A fresh-tag read can answer from before the transfer was mined.
      const at = await ethers.provider.getBlockNumber();
      const left = [];
      for (const t of inv.erc20) if (await w0.erc20Balance(t.token, { blockTag: at }) > 0n) left.push(t.label);
      for (const n of inv.nft) {
        if (n.standard === 1) { if (await w0.erc1155Balance(n.token, n.id, { blockTag: at }) > 0n) left.push(`${n.label}#${n.id}`); }
        else {
          const c = new ethers.Contract(n.token, ["function ownerOf(uint256) view returns (address)"], ethers.provider);
          if ((await c.ownerOf(n.id, { blockTag: at })).toLowerCase() === oldAddr.toLowerCase()) left.push(`${n.label}#${n.id}`);
        }
      }
      if (await w0.nativeBalance({ blockTag: at }) > 0n) left.push("native");
      if (left.length) log(`🔴 ОСТАВА: ${left.join(", ")}`);
      else log("✓ празен");
    }
  }

  log("");
  if (!LIVE) log("нищо не е пратено. За наживо: I_MEAN_IT=yes");
}
main().catch(e => { console.error("ГРЕШКА:", e.shortMessage || e.message); process.exitCode = 1; });
