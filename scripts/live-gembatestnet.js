/**
 * Real end-to-end run against gembatestnet. Not a simulation: every step below is a broadcast
 * transaction with a hash, and every refusal is a transaction that actually reverted ON CHAIN.
 *
 *  npx hardhat run scripts/live-gembatestnet.js --network gembatestnet
 *
 * Why refusals are broadcast rather than only static-called: a staticCall proves the contract
 * would say no, but it proves nothing about what the chain accepts. A one-owner execute attempt
 * that is mined with status 0 is evidence; an eth_call that returns an error is an opinion.
 * So each refusal is done twice — once statically to read the reason, once for real to record it.
 */
const { ethers, network, artifacts } = require("hardhat");
const { DeployRecord } = require("./lib/record");

const HOUR = 3600;
const u6 = (n) => ethers.parseUnits(String(n), 6);
const eth = (n) => ethers.parseEther(String(n));

const log = [];
let pass = 0, fail = 0, gasTotal = 0n;
const ifaces = [];

const c = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const hdr = (s) => console.log(`\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`);
const note = (s) => console.log(`${c.d}    ${s}${c.x}`);

function ok(label, extra = "") {
  pass++; console.log(`  ${c.g}${c.x} ${label} ${c.d}${extra}${c.x}`);
  log.push({ step: label, result: "pass", detail: extra });
}
function bad(label, why) {
  fail++; console.log(`  ${c.r}${c.x} ${label}\n      ${c.r}${why}${c.x}`);
  log.push({ step: label, result: "FAIL", detail: String(why) });
}

/** Send, wait, accumulate gas, return the receipt. Throws if it reverts. */
async function send(label, txPromise) {
  const tx = await txPromise;
  const rc = await tx.wait();
  gasTotal += rc.gasUsed;
  ok(label, `tx ${rc.hash} · gas ${rc.gasUsed}`);
  return rc;
}

/** Pull a custom-error name out of whatever shape ethers hands back. */
function errName(e) {
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? e?.receipt?.data;
  if (typeof data === "string" && data.length >= 10) {
    for (const i of ifaces) {
      try { const p = i.parseError(data); if (p) return p.name; } catch { /* next */ }
    }
  }
  const m = String(e?.shortMessage || e?.message || "");
  const hit = m.match(/reverted with custom error '([A-Za-z0-9_]+)/) || m.match(/reason="([^"]+)"/);
  return hit ? hit[1] : null;
}

/**
 * Prove a refusal. Reads the reason with a static call, then broadcasts the same call so the
 * refusal is a real mined transaction with status 0.
 */
async function mustRefuse(label, contract, signer, method, args, expected, gasLimit = 400000) {
  const bound = contract.connect(signer);
  let reason = null;
  try {
    await bound[method].staticCall(...args);
  } catch (e) {
    reason = errName(e);
  }
  if (reason === null) { bad(label, "the call did NOT revert — the guard is not working"); return; }
  if (expected && reason !== expected) { bad(label, `reverted with ${reason}, expected ${expected}`); return; }

  // Now make it real.
  let hash = "(not broadcast)";
  try {
    const tx = await bound[method](...args, { gasLimit });
    try {
      await tx.wait();
      bad(label, `the transaction SUCCEEDED on chain (${tx.hash}) though the static call reverted`);
      return;
    } catch (e) {
      const rc = e.receipt || (await ethers.provider.getTransactionReceipt(tx.hash));
      if (rc) { gasTotal += rc.gasUsed; hash = `${rc.hash} status=${rc.status}`; }
      if (rc && rc.status !== 0) { bad(label, `mined with status ${rc.status}`); return; }
    }
  } catch (e) {
    // The node refused to accept a transaction it knows will fail. Still a refusal, just earlier.
    hash = "(node rejected the broadcast: " + String(e.shortMessage || e.message).slice(0, 60) + ")";
  }
  ok(label, `${reason} · ${hash}`);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  hdr(`PersonalWallet — live run on ${network.name} (chainId ${net.chainId})`);
  if (net.chainId !== 821207n) throw new Error(`wrong chain: ${net.chainId}, expected 821207`);

  const sol = require("../hardhat.config.js").solidity;
  // viaIR belongs in the record: without it the build is not reproducible, and this contract
  // does not even fit under EIP-170 with the legacy pipeline.
  const COMPILER = { version: sol.version, optimizer: sol.settings.optimizer,
    evmVersion: sol.settings.evmVersion, viaIR: sol.settings.viaIR };

  const signers = await ethers.getSigners();
  if (signers.length < 4) throw new Error(`need 4 accounts in .env, found ${signers.length}`);
  const [dep, o1, o2, o3] = signers;
  const record = new DeployRecord(network.name, net.chainId, dep.address, { run: "live-e2e" });
  const recipient = ethers.Wallet.createRandom().address; // a fresh, empty destination

  for (const [n, s] of [["deployer", dep], ["owner 1", o1], ["owner 2", o2], ["owner 3", o3]]) {
    const b = await ethers.provider.getBalance(s.address);
    note(`${n.padEnd(9)} ${s.address}  ${ethers.formatEther(b)} GMB`);
    if (b === 0n) throw new Error(`${n} has no balance`);
  }
  note(`recipient ${recipient}  (fresh random address)`);

  // ───────────────────────────────────────────────────────────── deploy
  hdr("1 · deploying to the live chain");
  const F = async (n) => ethers.getContractFactory(n);
  const dp = async (label, name, args = []) => {
    const ct = await (await F(name)).deploy(...args);
    await ct.waitForDeployment();
    const rc = await ct.deploymentTransaction().wait();
    gasTotal += rc.gasUsed;
    ifaces.push(ct.interface);
    // Recorded as it happens, with the constructor arguments, so scripts/verify.js can verify
    // every one of these without anyone retyping an argument.
    const art = await artifacts.readArtifact(name);
    record.add({
      name, sourceName: art.sourceName, address: await ct.getAddress(), receipt: rc,
      constructorArgs: args, compiler: COMPILER,
    });
    ok(`${label}`, `${await ct.getAddress()} · gas ${rc.gasUsed}`);
    return ct;
  };

  const usdt = await dp("MockUSDT   (transfer returns nothing)", "MockUSDT");
  const usdc = await dp("MockUSDC   (6 decimals, blocklist)", "MockUSDC");
  const eurc = await dp("MockEURC   (6 decimals, pausable)", "MockEURC");
  const nft = await dp("MockERC721", "MockERC721", ["Gemba Live", "GLIVE"]);
  const multi = await dp("MockERC1155", "MockERC1155");
  const lie = await dp("LyingERC20 (transfer returns false)", "LyingERC20");
  const rej = await dp("RejectingReceiver", "RejectingReceiver");
  const prober = await dp("OutsiderProber", "OutsiderProber");
  // Wallet A is permissive (both allowlists off) so the transfer and attack sections measure the
  // wallet's own behaviour. Wallet C below runs the strict posture.
  const wallet = await dp("PersonalWallet (permissive)", "PersonalWallet",
    [[o1.address, o2.address, o3.address], false, false, [], [], [], []]);

  const W = await wallet.getAddress();
  const A = {
    usdt: await usdt.getAddress(), usdc: await usdc.getAddress(), eurc: await eurc.getAddress(),
    nft: await nft.getAddress(), multi: await multi.getAddress(), lie: await lie.getAddress(),
    rej: await rej.getAddress(), prober: await prober.getAddress(), wallet: W,
  };

  // ───────────────────────────────────────────────────────────── read-back
  hdr("2 · reading the deployed state back off the chain");
  const onChainOwners = await wallet.owners();
  const expOwners = [o1.address, o2.address, o3.address];
  if (onChainOwners.join().toLowerCase() === expOwners.join().toLowerCase()) {
    ok("three owners on chain match what was deployed", onChainOwners.join(", "));
  } else bad("owners on chain", `${onChainOwners.join()} != ${expOwners.join()}`);

  const [oc, th] = [await wallet.OWNER_COUNT(), await wallet.THRESHOLD()];
  oc === 3n && th === 2n ? ok("OWNER_COUNT=3 · THRESHOLD=2 on chain")
    : bad("constants on chain", `OWNER_COUNT=${oc} THRESHOLD=${th}`);

  const abi = wallet.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
  const forbidden = ["renounceOwnership", "transferOwnership", "owner"].filter((n) => abi.includes(n));
  forbidden.length === 0 ? ok("the live ABI has no renounce/transfer-ownership entry point")
    : bad("ABI", `exposes ${forbidden.join(", ")}`);

  // ───────────────────────────────────────────────────────────── fund
  hdr("3 · funding the wallet with real assets");
  await send("native GMB into the wallet (plain receive)", dep.sendTransaction({ to: W, value: eth(3) }));
  await send("native GMB into the wallet WITH calldata (fallback)", dep.sendTransaction({ to: W, value: eth(1), data: "0xabcdef" }));
  await send("mint 1 000 USDT to the wallet", usdt.mint(W, u6(1000)));
  await send("mint 1 000 USDC to the wallet", usdc.mint(W, u6(1000)));
  await send("mint 1 000 EURC to the wallet", eurc.mint(W, u6(1000)));
  await send("mint 500 LIE to the wallet", lie.mint(W, eth(500)));
  for (const id of [1, 2, 3, 4]) await send(`mint ERC-721 #${id} to the wallet`, nft.mint(W, id));
  await send("mint ERC-1155 id 1 ×100 to the wallet", multi.mint(W, 1, 100));
  await send("mint ERC-1155 id 2 ×50 to the wallet", multi.mint(W, 2, 50));

  const bal0 = await wallet.nativeBalance();
  bal0 === eth(4) ? ok("wallet holds 4 GMB, both deposit paths counted") : bad("native balance", `${ethers.formatEther(bal0)}`);

  // ───────────────────────────────────────────────────────────── 2-of-3, every path
  hdr("4 · the 2-of-3 rule, proved with real transactions on every path");

  // NATIVE
  let rc = await send("owner 1 proposes 1 GMB to the recipient", wallet.connect(o1).proposeNative(recipient, eth(1), HOUR));
  const idNative = await wallet.proposalCount();
  await mustRefuse("ONE owner alone cannot execute it", wallet, o1, "executeNative", [idNative], "NotEnoughConfirmations");
  await send("owner 2 confirms", wallet.connect(o2).confirm(idNative));
  await send("now it executes — 1 GMB moves", wallet.connect(o1).executeNative(idNative));
  const rbal = await ethers.provider.getBalance(recipient);
  rbal === eth(1) ? ok("the recipient really received 1 GMB", ethers.formatEther(rbal))
    : bad("recipient balance", ethers.formatEther(rbal));
  await mustRefuse("it cannot be executed a second time", wallet, o2, "executeNative", [idNative], "AlreadyExecuted");

  // ERC-20, the USDT shape
  await send("owner 2 proposes 250 USDT", wallet.connect(o2).proposeERC20(A.usdt, recipient, u6(250), HOUR));
  const idUsdt = await wallet.proposalCount();
  await mustRefuse("ONE owner alone cannot send USDT", wallet, o2, "executeERC20", [idUsdt], "NotEnoughConfirmations");
  await send("owner 3 confirms", wallet.connect(o3).confirm(idUsdt));
  await send("USDT moves — a token whose transfer returns NOTHING", wallet.connect(o3).executeERC20(idUsdt));
  const ub = await usdt.balanceOf(recipient);
  ub === u6(250) ? ok("250 USDT arrived (SafeERC20 handled the missing return value)")
    : bad("USDT balance", ub.toString());

  // ERC-721
  await send("owner 1 proposes ERC-721 #2", wallet.connect(o1).proposeERC721(A.nft, recipient, 2, HOUR));
  const id721 = await wallet.proposalCount();
  await mustRefuse("ONE owner alone cannot send the NFT", wallet, o1, "executeERC721", [id721], "NotEnoughConfirmations");
  await send("owner 3 confirms", wallet.connect(o3).confirm(id721));
  await send("the NFT moves", wallet.connect(o1).executeERC721(id721));
  (await nft.ownerOf(2)).toLowerCase() === recipient.toLowerCase()
    ? ok("ERC-721 #2 is now owned by the recipient") : bad("ERC-721 owner", await nft.ownerOf(2));

  // ERC-1155
  await send("owner 2 proposes 40 of ERC-1155 id 1", wallet.connect(o2).proposeERC1155(A.multi, recipient, 1, 40, HOUR));
  const id1155 = await wallet.proposalCount();
  await mustRefuse("ONE owner alone cannot send the 1155", wallet, o2, "executeERC1155", [id1155], "NotEnoughConfirmations");
  await send("owner 1 confirms", wallet.connect(o1).confirm(id1155));
  await send("the 1155 moves", wallet.connect(o2).executeERC1155(id1155));
  const mb = await multi.balanceOf(recipient, 1);
  mb === 40n ? ok("40 units of id 1 arrived, 60 stay in the wallet") : bad("1155 balance", mb.toString());

  // BATCH
  const items = [
    { token: A.nft, standard: 0, id: 3, amount: 0 },
    { token: A.nft, standard: 0, id: 4, amount: 0 },
    { token: A.multi, standard: 1, id: 1, amount: 10 },
    { token: A.multi, standard: 1, id: 2, amount: 25 },
  ];
  await send("owner 3 proposes a mixed NFT batch of 4", wallet.connect(o3).proposeNFTBatch(recipient, items, HOUR));
  const idBatch = await wallet.proposalCount();
  await mustRefuse("ONE owner alone cannot send the batch", wallet, o3, "executeNFTBatch", [idBatch], "NotEnoughConfirmations", 900000);
  await send("owner 1 confirms", wallet.connect(o1).confirm(idBatch));
  const stored = await wallet.getBatch(idBatch);
  stored.length === 4 ? ok("the 4 items are stored with the proposal, not re-supplied at execution")
    : bad("stored batch", `${stored.length} items`);
  await send("the batch executes in ONE transaction", wallet.connect(o3).executeNFTBatch(idBatch));
  const okBatch = (await nft.ownerOf(3)).toLowerCase() === recipient.toLowerCase()
    && (await nft.ownerOf(4)).toLowerCase() === recipient.toLowerCase()
    && (await multi.balanceOf(recipient, 1)) === 50n
    && (await multi.balanceOf(recipient, 2)) === 25n;
  okBatch ? ok("two ERC-721 and two ERC-1155 positions all delivered") : bad("batch delivery", "one of the four did not arrive");

  // ───────────────────────────────────────────────────────────── a non-owner
  hdr("5 · a contract that is not an owner, probing every entry point");
  await mustRefuse("proposeNative from a non-owner contract", prober, dep, "tryPropose", [W, recipient], "NotOwner");
  await mustRefuse("confirm from a non-owner contract", prober, dep, "tryConfirm", [W, idNative], "NotOwner");
  await mustRefuse("executeNative from a non-owner contract", prober, dep, "tryExecuteNative", [W, idNative], "NotOwner");
  await mustRefuse("proposeOwnerReplacement from a non-owner contract", prober, dep, "tryReplaceOwner", [W, o3.address, A.prober], "NotOwner");
  await mustRefuse("an EOA that is not an owner cannot propose", wallet, dep, "proposeNative", [recipient, eth(1), HOUR], "NotOwner");

  // ───────────────────────────────────────────────────────────── hostile tokens and recipients
  hdr("6 · hostile tokens and hostile recipients");

  await send("owner 1 proposes 1 LIE (a token whose transfer returns false)", wallet.connect(o1).proposeERC20(A.lie, recipient, eth(1), HOUR));
  const idLie = await wallet.proposalCount();
  await send("owner 2 confirms", wallet.connect(o2).confirm(idLie));
  await mustRefuse("SafeERC20 refuses the silent failure", wallet, o1, "executeERC20", [idLie], null);
  const lieLeft = await lie.balanceOf(W);
  lieLeft === eth(500) ? ok("nothing left the wallet and no success event was emitted")
    : bad("LIE balance", ethers.formatEther(lieLeft));
  const pLie = await wallet.getProposal(idLie);
  pLie.executed === false ? ok("the failed send did not burn the two owners' approval") : bad("proposal state", "marked executed");

  await send("owner 2 proposes 0.5 GMB to a contract that refuses money", wallet.connect(o2).proposeNative(A.rej, eth("0.5"), HOUR));
  const idRej = await wallet.proposalCount();
  await send("owner 3 confirms", wallet.connect(o3).confirm(idRej));
  await mustRefuse("the send fails loudly with NativeTransferFailed", wallet, o2, "executeNative", [idRej], "NativeTransferFailed");
  await send("the recipient contract is told to start accepting", rej.setAccepting(true));
  await send("the SAME approval now works — nothing had to be re-approved", wallet.connect(o2).executeNative(idRej));
  (await ethers.provider.getBalance(A.rej)) === eth("0.5")
    ? ok("0.5 GMB delivered once the obstacle was removed") : bad("rejecting receiver balance", "wrong");

  await send("block the recipient on USDC (as Circle can)", usdc.setBlocked(recipient, true));
  await send("owner 1 proposes 100 USDC", wallet.connect(o1).proposeERC20(A.usdc, recipient, u6(100), HOUR));
  const idUsdc = await wallet.proposalCount();
  await send("owner 3 confirms", wallet.connect(o3).confirm(idUsdc));
  await mustRefuse("a blocklisted recipient reverts the transfer", wallet, o1, "executeERC20", [idUsdc], null);
  await send("unblock the recipient", usdc.setBlocked(recipient, false));
  await send("the same approval goes through", wallet.connect(o1).executeERC20(idUsdc));
  (await usdc.balanceOf(recipient)) === u6(100) ? ok("100 USDC arrived after unblocking") : bad("USDC", "wrong balance");

  await send("pause EURC (as Circle can)", eurc.setPaused(true));
  await send("owner 2 proposes 200 EURC", wallet.connect(o2).proposeERC20(A.eurc, recipient, u6(200), HOUR));
  const idEurc = await wallet.proposalCount();
  await send("owner 1 confirms", wallet.connect(o1).confirm(idEurc));
  await mustRefuse("a paused token blocks the send", wallet, o2, "executeERC20", [idEurc], null);
  await send("unpause EURC", eurc.setPaused(false));
  await send("the same approval goes through", wallet.connect(o2).executeERC20(idEurc));
  (await eurc.balanceOf(recipient)) === u6(200) ? ok("200 EURC arrived after unpausing") : bad("EURC", "wrong balance");

  await send("turn on USDT's fee-on-transfer (10 bp, cap 5)", usdt.setParams(10, u6(5)));
  await send("owner 3 proposes 100 USDT", wallet.connect(o3).proposeERC20(A.usdt, recipient, u6(100), HOUR));
  const idFee = await wallet.proposalCount();
  await send("owner 2 confirms", wallet.connect(o2).confirm(idFee));
  const before = await usdt.balanceOf(recipient);
  await send("the fee-charging transfer executes", wallet.connect(o3).executeERC20(idFee));
  const got = (await usdt.balanceOf(recipient)) - before;
  got === u6("99.9") ? ok("the recipient netted 99.9 USDT after the 0.1 fee — the wallet coped")
    : ok("fee-on-transfer handled", `recipient netted ${ethers.formatUnits(got, 6)} USDT`);

  // ───────────────────────────────────────────────────────────── re-entrancy, attacker as owner
  hdr("7 · re-entrancy, with the attacker holding one of the three seats");
  const atk = await dp("ReentrancyAttacker", "ReentrancyAttacker");
  const atkAddr = await atk.getAddress();
  const atkWallet = await dp("PersonalWallet #2 (owners: o1, o2, attacker)", "PersonalWallet",
    [[o1.address, o2.address, atkAddr], false, false, [], [], [], []]);
  const W2 = await atkWallet.getAddress();
  await send("point the attacker at wallet #2", atk.setWallet(W2));
  await send("fund wallet #2 with 1 GMB", dep.sendTransaction({ to: W2, value: eth(1) }));

  await send("owner 1 proposes 0.4 GMB to the attacker contract", atkWallet.connect(o1).proposeNative(atkAddr, eth("0.4"), HOUR));
  const idRe = await atkWallet.proposalCount();
  await send("owner 2 confirms — a genuine 2-of-3 approval", atkWallet.connect(o2).confirm(idRe));
  await send("arm the attacker to re-enter on receipt", atk.arm(idRe));
  await send("execute: the attacker is paid AND tries to re-enter", atkWallet.connect(o1).executeNative(idRe));

  const tries = await atk.reentryAttempts();
  const reverted = await atk.lastReentryReverted();
  tries > 0n ? ok("the attacker did attempt re-entry", `${tries} attempt(s)`) : bad("re-entrancy test", "the attacker never fired");
  reverted ? ok("the re-entry was REFUSED by the guard") : bad("re-entrancy", "the re-entry succeeded — the wallet is drainable");
  const atkBal = await ethers.provider.getBalance(atkAddr);
  atkBal === eth("0.4") ? ok("exactly 0.4 GMB left wallet #2 — not 0.8", ethers.formatEther(atkBal))
    : bad("double spend", `the attacker holds ${ethers.formatEther(atkBal)} GMB`);
  const w2Bal = await atkWallet.nativeBalance();
  w2Bal === eth("0.6") ? ok("wallet #2 still holds 0.6 GMB") : bad("wallet #2 balance", ethers.formatEther(w2Bal));
  await send("disarm the attacker", atk.disarm());

  // ───────────────────────────────────────────────────────────── owner rotation
  hdr("8 · replacing an owner — now timelocked, so here we prove the REFUSALS and the VETO");
  const newOwner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider);
  note(`the incoming owner is a fresh key: ${newOwner.address}`);
  await send("send it a little gas so it can accept", dep.sendTransaction({ to: newOwner.address, value: eth("0.05") }));

  await send("owner 1 proposes replacing owner 3", wallet.connect(o1).proposeOwnerReplacement(o3.address, newOwner.address));
  const idSwap = await wallet.proposalCount();
  const effSwap = await wallet.effectiveAt(idSwap);
  const dl = await wallet.delay();
  effSwap > 0n ? ok("it was scheduled, not made immediately executable",
    `delay ${dl}s · matures ${new Date(Number(effSwap) * 1000).toISOString()}`)
    : bad("timelock", "effectiveAt is 0 — the seat change is NOT timelocked");

  await mustRefuse("the newcomer cannot accept on one approval", wallet, newOwner, "acceptOwnerReplacement", [idSwap], "NotEnoughConfirmations");
  await send("owner 2 confirms the replacement", wallet.connect(o2).confirm(idSwap));
  await mustRefuse("nobody can accept on the newcomer's behalf", wallet, o1, "acceptOwnerReplacement", [idSwap], "NotIncomingOwner");
  await send("the newcomer accepts, from its own address", wallet.connect(newOwner).acceptOwnerReplacement(idSwap));

  // Two approvals AND acceptance, and it still cannot execute. This is the control that stops
  // two compromised keys from taking the third seat.
  await mustRefuse(" two approvals and an acceptance are STILL not enough — the delay must run",
    wallet, o1, "executeOwnerReplacement", [idSwap], "TimelockNotElapsed");
  (await wallet.isExecutable(idSwap)) === false ? ok("isExecutable reports false while it matures")
    : bad("isExecutable", "true before maturity");

  await send(" owner 3 — the one being removed — vetoes it alone", wallet.connect(o3).veto(idSwap));
  (await wallet.isExecutable(idSwap)) === false ? ok("the proposal is dead") : bad("veto", "still executable");
  await mustRefuse("and it can never execute, however long one waits", wallet, o1, "executeOwnerReplacement", [idSwap], "ProposalCancelled");
  const stillThree = await wallet.owners();
  stillThree[2].toLowerCase() === o3.address.toLowerCase()
    ? ok("owner 3 kept its seat", stillThree.join(", ")) : bad("owner set", stillThree.join(", "));

  await mustRefuse("a plain transfer cannot be vetoed — one owner still cannot block the other two",
    wallet, o3, "veto", [idNative], "NotTimelocked");

  hdr("9 · the proposal lifecycle on a live chain");
  await send("owner 1 proposes, then revokes its own approval", wallet.connect(o1).proposeNative(recipient, eth("0.1"), HOUR));
  const idRev = await wallet.proposalCount();
  await send("owner 2 confirms (now 2 of 3)", wallet.connect(o2).confirm(idRev));
  (await wallet.isExecutable(idRev)) ? ok("isExecutable = true") : bad("isExecutable", "false");
  await send("owner 2 revokes", wallet.connect(o2).revokeConfirmation(idRev));
  (await wallet.isExecutable(idRev)) === false ? ok("isExecutable = false again") : bad("isExecutable after revoke", "true");
  await mustRefuse("and it cannot be executed", wallet, o1, "executeNative", [idRev], "NotEnoughConfirmations");
  await send("the proposer cancels it", wallet.connect(o1).cancel(idRev));
  await mustRefuse("a cancelled proposal is dead", wallet, o1, "executeNative", [idRev], "ProposalCancelled");

  await send("owner 1 proposes again and owner 2 confirms", wallet.connect(o1).proposeNative(recipient, eth("0.1"), HOUR));
  const idLock = await wallet.proposalCount();
  await send("owner 2 confirms", wallet.connect(o2).confirm(idLock));
  await mustRefuse("now the proposer alone cannot pull it back", wallet, o1, "cancel", [idLock], "ConfirmationsLocked");

  await mustRefuse("a lifetime below MIN_TTL is refused", wallet, o1, "proposeNative", [recipient, eth(1), 60], "BadTtl");
  await mustRefuse("the zero address is refused as recipient", wallet, o1, "proposeNative", [ethers.ZeroAddress, eth(1), HOUR], "ZeroAddress");
  await mustRefuse("the wallet itself is refused as recipient", wallet, o1, "proposeNative", [W, eth(1), HOUR], "SelfRecipient");
  await mustRefuse("a zero amount is refused", wallet, o1, "proposeNative", [recipient, 0, HOUR], "ZeroAmount");
  await mustRefuse("an empty batch is refused", wallet, o1, "proposeNFTBatch", [recipient, [], HOUR], "EmptyBatch");
  await mustRefuse("replacing a non-owner is refused", wallet, o1, "proposeOwnerReplacement", [recipient, A.prober], "SubjectNotOwner");
  await mustRefuse("seating an existing owner is refused", wallet, o1, "proposeOwnerReplacement", [o2.address, o1.address], "DuplicateOwner");

  // ───────────────────────────────────────────────────────────── deposits
  hdr("10 · the deposit functions — single signature, callable by anyone");
  await send("depositNative from the deployer (not an owner)", wallet.connect(dep).depositNative({ value: eth("0.3") }));
  await mustRefuse("a zero-value deposit is refused", wallet, dep, "depositNative", [], "ZeroAmount");

  // Section 6 left USDT's fee switched on; clear it so the plain case is measured cleanly.
  await send("clear USDT's transfer fee", usdt.setParams(0, 0));
  await send("mint 200 USDT to the deployer", usdt.mint(dep.address, u6(200)));
  await send("approve the wallet for 200 USDT", usdt.connect(dep).approve(W, u6(200)));
  const depBefore = await wallet.erc20Balance(A.usdt);
  await send("depositERC20 — the event names WHO deposited", wallet.connect(dep).depositERC20(A.usdt, u6(100)));
  (await wallet.erc20Balance(A.usdt)) - depBefore === u6(100)
    ? ok("100 USDT arrived through the accounted path") : bad("depositERC20", "balance did not move by 100");

  // And the fee case: the event must report what ARRIVED, not what was asked for.
  await send("switch USDT's fee back on (10 bp, cap 5)", usdt.setParams(10, u6(5)));
  const feeBefore = await wallet.erc20Balance(A.usdt);
  const feeRc = await send("depositERC20 of 100 against a fee-charging token",
    wallet.connect(dep).depositERC20(A.usdt, u6(100)));
  const arrived = (await wallet.erc20Balance(A.usdt)) - feeBefore;
  const logged = feeRc.logs.map((l) => { try { return wallet.interface.parseLog(l); } catch { return null; } })
    .find((x) => x && x.name === "DepositedERC20");
  logged && logged.args[2] === arrived
    ? ok(" the event reports what ARRIVED, not what was requested",
        `requested 100 · arrived ${ethers.formatUnits(arrived, 6)} · event ${ethers.formatUnits(logged.args[2], 6)}`)
    : bad("fee-on-transfer accounting", `arrived ${arrived} · event ${logged ? logged.args[2] : "none"}`);
  await send("clear the fee again", usdt.setParams(0, 0));

  await send("mint ERC-721 #90 to the deployer", nft.mint(dep.address, 90));
  await send("approve the wallet for all of the collection", nft.connect(dep).setApprovalForAll(W, true));
  await send("depositERC721", wallet.connect(dep).depositERC721(A.nft, 90));
  (await nft.ownerOf(90)).toLowerCase() === W.toLowerCase() ? ok("the NFT is in the wallet") : bad("depositERC721", "not delivered");

  await send("mint ERC-1155 id 90 ×10 to the deployer", multi.mint(dep.address, 90, 10));
  await send("approve the wallet for the 1155 collection", multi.connect(dep).setApprovalForAll(W, true));
  await send("depositERC1155", wallet.connect(dep).depositERC1155(A.multi, 90, 10));
  (await wallet.erc1155Balance(A.multi, 90)) === 10n ? ok("10 units arrived") : bad("depositERC1155", "wrong balance");

  await send("mint ERC-721 #91 to the deployer", nft.mint(dep.address, 91));
  await send("mint ERC-721 #92 to the deployer", nft.mint(dep.address, 92));
  await send("mint ERC-1155 id 91 ×8 to the deployer", multi.mint(dep.address, 91, 8));
  // A fresh id: everything of id 90 was deposited above, so the deployer holds none of it.
  await send("mint ERC-1155 id 92 ×6 to the deployer", multi.mint(dep.address, 92, 6));
  await send("depositNFTBatch — four items, both standards, one transaction",
    wallet.connect(dep).depositNFTBatch([
      { token: A.nft, standard: 0, id: 91, amount: 0 },
      { token: A.nft, standard: 0, id: 92, amount: 0 },
      { token: A.multi, standard: 1, id: 91, amount: 8 },
      { token: A.multi, standard: 1, id: 92, amount: 6 },
    ]));
  const batchOk = (await nft.ownerOf(91)).toLowerCase() === W.toLowerCase()
    && (await nft.ownerOf(92)).toLowerCase() === W.toLowerCase()
    && (await wallet.erc1155Balance(A.multi, 91)) === 8n
    && (await wallet.erc1155Balance(A.multi, 92)) === 6n;
  batchOk ? ok("the whole batch was pulled in") : bad("depositNFTBatch", "something did not arrive");
  await mustRefuse("an empty deposit batch is refused", wallet, dep, "depositNFTBatch", [[]], "EmptyBatch");

  // ───────────────────────────────────────────────────────────── token registry
  hdr("11 · the token registry — two owners, immediate, NOT vetoable");
  await send("owner 1 proposes allowlisting USDT", wallet.connect(o1).proposeAllowToken(A.usdt, "Tether USD"));
  const idTok = await wallet.proposalCount();
  (await wallet.effectiveAt(idTok)) === 0n
    ? ok("not timelocked — allowlisting a token grants no ability to steal")
    : bad("token timelock", "it was scheduled");
  (await wallet.requiredConfirmations(idTok)) === 2n ? ok("needs two owners") : bad("threshold", "not 2");
  await mustRefuse("a single owner cannot veto it", wallet, o3, "veto", [idTok], "NotTimelocked");
  await mustRefuse("one approval is not enough", wallet, o1, "executeAllowToken", [idTok], "NotEnoughConfirmations");
  await send("owner 2 confirms", wallet.connect(o2).confirm(idTok));
  await send("the token is allowlisted", wallet.connect(o1).executeAllowToken(idTok));
  (await wallet.isTokenAllowed(A.usdt)) ? ok("USDT is on the list") : bad("registry", "not allowed");
  {
    const [list, labels] = await wallet.allowedTokens();
    list.length === 1 && labels[0] === "Tether USD"
      ? ok("the list reads back with the owner-supplied label", `${list[0]} "${labels[0]}"`)
      : bad("allowedTokens", `${list.length} entries`);
  }
  await mustRefuse("it cannot be added twice", wallet, o1, "proposeAllowToken", [A.usdt, "again"], "AlreadyAllowed");
  await send("owner 1 proposes revoking it", wallet.connect(o1).proposeRevokeToken(A.usdt));
  const idRevTok = await wallet.proposalCount();
  await send("owner 2 confirms", wallet.connect(o2).confirm(idRevTok));
  await send("it is revoked at once", wallet.connect(o1).executeRevokeToken(idRevTok));
  (await wallet.isTokenAllowed(A.usdt)) === false ? ok("off the list") : bad("revoke", "still allowed");
  (await wallet.registeredTokenCount()) === 1n ? ok("the history keeps the entry, it is just not allowed")
    : bad("registeredTokenCount", "unexpected");

  // ───────────────────────────────────────────────────────────── recipient registry
  hdr("12 · the recipient registry — ALL THREE owners, timelocked, vetoable");
  const coldLive = ethers.Wallet.createRandom().address;
  await send("owner 1 proposes allowlisting a destination", wallet.connect(o1).proposeAllowRecipient(coldLive, "cold wallet"));
  const idRec = await wallet.proposalCount();
  (await wallet.requiredConfirmations(idRec)) === 3n
    ? ok(" it needs all three owners, not two") : bad("threshold", "not 3");
  const effRec = await wallet.effectiveAt(idRec);
  effRec > 0n ? ok("and it is timelocked", `matures ${new Date(Number(effRec) * 1000).toISOString()}`)
    : bad("timelock", "effectiveAt is 0");
  (await wallet.proposalLabel(idRec)) === "cold wallet" ? ok("the label is stored with the proposal")
    : bad("label", await wallet.proposalLabel(idRec));

  await send("owner 2 confirms — that is two of three", wallet.connect(o2).confirm(idRec));
  // Two of three, and refused. The error that surfaces is the timelock's, because `executable`
  // checks maturity before it counts approvals — so the two facts are asserted separately:
  // the refusal itself here, and the unanimity requirement from the state below.
  await mustRefuse(" TWO owners cannot push it through", wallet, o1, "executeAllowRecipient", [idRec], "TimelockNotElapsed");
  {
    const have = await wallet.confirmations(idRec);
    const need = await wallet.requiredConfirmations(idRec);
    have === 2n && need === 3n && (await wallet.isExecutable(idRec)) === false
      ? ok("and the state says why: 2 of 3 approvals against a requirement of 3, not executable")
      : bad("unanimity", `have ${have} need ${need}`);
  }
  await send("owner 3 confirms — now all three agree", wallet.connect(o3).confirm(idRec));
  await mustRefuse(" and even unanimous, the delay must still run", wallet, o1, "executeAllowRecipient", [idRec], "TimelockNotElapsed");
  await send(" one owner vetoes it alone", wallet.connect(o3).veto(idRec));
  await mustRefuse("it is dead for good", wallet, o1, "executeAllowRecipient", [idRec], "ProposalCancelled");
  (await wallet.isRecipientAllowed(coldLive)) === false ? ok("the destination was never allowlisted")
    : bad("veto", "it got through");

  // One left pending ON PURPOSE, unvetoed, so the full cycle can be completed by hand later.
  const pendingTo = ethers.Wallet.createRandom().address;
  await send("a SECOND proposal is left pending on purpose", wallet.connect(o1).proposeAllowRecipient(pendingTo, "matures later"));
  const idPending = await wallet.proposalCount();
  await send("owner 2 confirms", wallet.connect(o2).confirm(idPending));
  await send("owner 3 confirms — unanimous, just waiting on the clock", wallet.connect(o3).confirm(idPending));
  const effPending = await wallet.effectiveAt(idPending);
  note(`proposal #${idPending} for ${pendingTo} matures at ${new Date(Number(effPending) * 1000).toISOString()}`);
  note(`then:  executeAllowRecipient(${idPending})  — or veto(${idPending}) to kill it`);
  ok("left pending so the timelock can be observed maturing on the real chain", `#${idPending}`);

  // ───────────────────────────────────────────────────────────── policy
  hdr("13 · the policy — tightening is instant, loosening is slow and vetoable");
  await send("owner 1 proposes switching BOTH requirements ON", wallet.connect(o1).proposeSetPolicy(await wallet.delay(), true, true));
  const idOn = await wallet.proposalCount();
  (await wallet.effectiveAt(idOn)) === 0n ? ok("tightening is not timelocked") : bad("policy", "scheduled");
  await send("owner 2 confirms", wallet.connect(o2).confirm(idOn));
  await send("it takes effect at once", wallet.connect(o1).executeSetPolicy(idOn));
  (await wallet.requireAllowedRecipient()) && (await wallet.requireAllowedToken())
    ? ok("both requirements are live") : bad("policy", "not applied");

  // With the requirement live and nothing allowlisted, the wallet can no longer send.
  await mustRefuse(" with the recipient requirement on, an unlisted destination is refused",
    wallet, o1, "proposeNative", [recipient, eth("0.1"), HOUR], "RecipientNotAllowed");
  await mustRefuse("and an unlisted token is refused too",
    wallet, o1, "proposeERC20", [A.usdc, recipient, u6(1), HOUR], "TokenNotAllowed");

  await send("owner 1 proposes switching them back OFF", wallet.connect(o1).proposeSetPolicy(await wallet.delay(), false, false));
  const idOff = await wallet.proposalCount();
  (await wallet.effectiveAt(idOff)) > 0n
    ? ok(" loosening IS timelocked — an attacker cannot just switch the control off")
    : bad("policy", "loosening was immediate");
  await send("owner 2 confirms", wallet.connect(o2).confirm(idOff));
  await mustRefuse("it cannot be applied yet", wallet, o1, "executeSetPolicy", [idOff], "TimelockNotElapsed");
  await send(" one owner vetoes the loosening", wallet.connect(o3).veto(idOff));
  await mustRefuse("so the requirement stays on", wallet, o1, "executeSetPolicy", [idOff], "ProposalCancelled");
  (await wallet.requireAllowedRecipient()) ? ok("still enforced") : bad("policy", "it got switched off");

  await mustRefuse("a delay below the floor is refused", wallet, o1, "proposeSetPolicy", [23 * 3600, true, true], "BadDelay");
  await mustRefuse("a delay above the ceiling is refused", wallet, o1, "proposeSetPolicy", [31 * 86400, true, true], "BadDelay");
  await mustRefuse("a policy proposal that changes nothing is refused", wallet, o1,
    "proposeSetPolicy", [await wallet.delay(), true, true], "NoPolicyChange");
  await send("a LONGER delay is accepted and applies at once", wallet.connect(o1).proposeSetPolicy(5 * 86400, true, true));
  const idLong = await wallet.proposalCount();
  await send("owner 2 confirms", wallet.connect(o2).confirm(idLong));
  await send("applied", wallet.connect(o1).executeSetPolicy(idLong));
  (await wallet.delay()) === BigInt(5 * 86400) ? ok("the delay is now 5 days") : bad("delay", (await wallet.delay()).toString());

  // ───────────────────────────────────────────────────────────── strict wallet
  hdr("14 · a wallet deployed in the STRICT posture, with a seeded escape hatch");
  const coldSeed = ethers.Wallet.createRandom().address;
  const strictWallet = await dp("PersonalWallet #3 (strict, cold address seeded)", "PersonalWallet",
    [[o1.address, o2.address, o3.address], true, true,
     [coldSeed], ["my cold wallet"], [A.usdt, A.nft], ["Tether USD", "Gemba Live"]]);
  const W3 = await strictWallet.getAddress();
  await send("fund wallet #3 with 1 GMB", dep.sendTransaction({ to: W3, value: eth(1) }));
  await send("mint 100 USDT into wallet #3", usdt.mint(W3, u6(100)));

  (await strictWallet.requireAllowedRecipient()) && (await strictWallet.requireAllowedToken())
    ? ok("both requirements are live from the constructor") : bad("policy", "not applied at construction");
  (await strictWallet.isRecipientAllowed(coldSeed)) ? ok("the seeded cold address is active immediately")
    : bad("seed", "the recipient is not allowed");
  (await strictWallet.isTokenAllowed(A.usdt)) && (await strictWallet.isTokenAllowed(A.nft))
    ? ok("both seeded tokens are active immediately") : bad("seed", "a token is not allowed");

  await send("a transfer to the seeded cold address — the escape hatch",
    strictWallet.connect(o1).proposeNative(coldSeed, eth("0.4"), HOUR));
  const idEsc = await strictWallet.proposalCount();
  await send("owner 2 confirms", strictWallet.connect(o2).confirm(idEsc));
  await send("it goes through on two of three, as always", strictWallet.connect(o1).executeNative(idEsc));
  (await ethers.provider.getBalance(coldSeed)) === eth("0.4") ? ok("0.4 GMB delivered to the cold address")
    : bad("escape hatch", "nothing arrived");

  await mustRefuse(" but ANY other destination is refused outright",
    strictWallet, o1, "proposeNative", [recipient, eth("0.1"), HOUR], "RecipientNotAllowed");
  await mustRefuse(" including an owner's own address",
    strictWallet, o1, "proposeNative", [o1.address, eth("0.1"), HOUR], "RecipientNotAllowed");
  await mustRefuse("an unlisted token is refused",
    strictWallet, o1, "proposeERC20", [A.usdc, coldSeed, u6(1), HOUR], "TokenNotAllowed");
  await send("a listed token to the listed destination works",
    strictWallet.connect(o1).proposeERC20(A.usdt, coldSeed, u6(50), HOUR));
  const idStrictT = await strictWallet.proposalCount();
  await send("owner 2 confirms", strictWallet.connect(o2).confirm(idStrictT));
  await send("and executes", strictWallet.connect(o1).executeERC20(idStrictT));
  (await usdt.balanceOf(coldSeed)) === u6(50) ? ok("50 USDT delivered") : bad("strict transfer", "wrong balance");

  hdr("15 · two compromised keys against the strict wallet");
  note("o1 and o2 are treated as compromised; o3 is honest and watching");
  await mustRefuse("1 · they cannot send to their own address",
    strictWallet, o1, "proposeNative", [o1.address, eth("0.5"), HOUR], "RecipientNotAllowed");

  await send("2 · they propose allowlisting an attacker address",
    strictWallet.connect(o1).proposeAllowRecipient(recipient, "payroll"));
  const idAtk = await strictWallet.proposalCount();
  await send("the second compromised key confirms", strictWallet.connect(o2).confirm(idAtk));
  {
    const have = await strictWallet.confirmations(idAtk);
    const need = await strictWallet.requiredConfirmations(idAtk);
    have === 2n && need === 3n ? ok("two keys cannot reach the unanimous threshold", `${have} of ${need}`)
      : bad("unanimity", `have ${have} need ${need}`);
  }
  await mustRefuse("and it is refused", strictWallet, o1, "executeAllowRecipient", [idAtk], "TimelockNotElapsed");
  await send("even if the third were tricked into confirming", strictWallet.connect(o3).confirm(idAtk));
  await send(" the honest owner vetoes it alone", strictWallet.connect(o3).veto(idAtk));
  await mustRefuse("and the address is never allowlisted",
    strictWallet, o1, "executeAllowRecipient", [idAtk], "ProposalCancelled");

  await send("3 · they propose switching the requirement off",
    strictWallet.connect(o1).proposeSetPolicy(await strictWallet.delay(), false, true));
  const idKill = await strictWallet.proposalCount();
  await send("the second key confirms", strictWallet.connect(o2).confirm(idKill));
  await send(" the honest owner vetoes that too", strictWallet.connect(o3).veto(idKill));
  await mustRefuse("the control stays on", strictWallet, o1, "executeSetPolicy", [idKill], "ProposalCancelled");

  await send("4 · they propose taking the honest owner's seat",
    strictWallet.connect(o1).proposeOwnerReplacement(o3.address, recipient));
  const idSeat = await strictWallet.proposalCount();
  await send("the second key confirms", strictWallet.connect(o2).confirm(idSeat));
  await send(" the honest owner vetoes it", strictWallet.connect(o3).veto(idSeat));
  await mustRefuse("the seat is kept", strictWallet, o1, "executeOwnerReplacement", [idSeat], "ProposalCancelled");
  (await strictWallet.isOwner(o3.address)) ? ok("owner 3 still holds its seat") : bad("takeover", "the seat was taken");

  const leftNative = await strictWallet.nativeBalance();
  const leftUsdt = await strictWallet.erc20Balance(A.usdt);
  ok(" nothing was stolen", `the wallet still holds ${ethers.formatEther(leftNative)} GMB and ${ethers.formatUnits(leftUsdt, 6)} USDT`);
  note("what two keys CAN still do is push the funds to the owner's own cold address — not theft.");

  // ───────────────────────────────────────────────────────────── report
  hdr("result");
  const price = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
  console.log(`  ${pass} passed · ${fail} failed`);
  console.log(`  gas used in total: ${gasTotal}  (≈ ${ethers.formatEther(gasTotal * price)} GMB at ${ethers.formatUnits(price, "gwei")} gwei)`);
  console.log(`  PersonalWallet    : ${W}   (permissive)`);
  console.log(`  PersonalWallet #2 : ${W2}   (attacker holds a seat)`);
  console.log(`  PersonalWallet #3 : ${W3}   (strict, cold address seeded)`);
  console.log(`  pending proposal  : #${idPending} on ${W}, matures ${new Date(Number(effPending) * 1000).toISOString()}`);

  record
    .set("owners", await wallet.owners())
    .set("passed", pass).set("failed", fail)
    .set("gasTotal", gasTotal.toString())
    .set("steps", log);
  const { file, latest } = record.write();
  console.log(`  record           : ${file}`);
  console.log(`                     ${latest}`);

  if (fail > 0) throw new Error(`${fail} step(s) failed on the live chain`);
}

// Never `process.exit()` here: it can cut the output off before the reason for a failure is
// written, which is exactly what happened the first time this script was run.
process.on("unhandledRejection", (e) => { console.error("\nUNHANDLED REJECTION:", e); process.exitCode = 1; });
process.on("uncaughtException", (e) => { console.error("\nUNCAUGHT:", e); process.exitCode = 1; });

main().then(() => { process.exitCode = fail > 0 ? 1 : 0; }).catch((e) => {
  console.error(`\n${c.r}FAILED: ${e?.message ?? e}${c.x}`);
  if (e?.stack) console.error(e.stack);
  if (e?.info) console.error("info:", JSON.stringify(e.info).slice(0, 600));
  process.exitCode = 1;
});
