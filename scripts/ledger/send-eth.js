/**
 * Sign an EVM transaction ON a Ledger and broadcast it. No @ledgerhq packages.
 *
 *   TO=0x… AMOUNT=0.5 npx hardhat run scripts/ledger/send-eth.js --network gembatestnet
 *   PATH_ETH="44'/60'/0'/0/1"  — optional, defaults to the first account
 *
 * WHY NOT `@ledgerhq/hw-app-eth`. It works, and it brings a dependency tree. This file needs
 * exactly three things the libraries provide — the derivation path encoding, the SIGN apdu, and
 * reassembling v/r/s — and all three fit here in a page. Next to a device whose entire purpose is
 * to shrink what you must trust, a page you have read beats a tree you have not.
 *
 * The USB transport is NOT reimplemented here: `ledger-probe.py apdu` carries it, because the
 * framing, the re-enumeration on app switch, the select-based deadline and the 6901 recovery were
 * all paid for once and should not be paid for again in a second language.
 *
 * ── HOW THE SIGNATURE IS PUT BACK TOGETHER, and why this way
 *
 * The Ethereum app answers with v(1) r(32) s(32), and that `v` is NOT usable as-is: for EIP-155 it
 * is truncated to one byte, so reconstructing it means knowing the chain id, whether the tx is
 * typed, and reproducing the app's own arithmetic. Instead of re-deriving that, this tries BOTH
 * parities, recovers the sender from each, and keeps the one that equals the address the device
 * reported for this path. That removes a whole class of "signed with the wrong v" bugs and, more
 * importantly, it PROVES the signature belongs to the expected account before anything is
 * broadcast. A transaction that does not recover to the Ledger's own address is never sent.
 */
const { ethers, network } = require("hardhat");
const { execFileSync } = require("child_process");
const path = require("path");

const PROBE = path.join(__dirname, "ledger-probe.py");
const log = (...a) => console.log("  ", ...a);

function probe(args, timeoutMs = 240000) {
  return execFileSync("python3", [PROBE, ...args], { encoding: "utf8", timeout: timeoutMs });
}

/** "44'/60'/0'/0/0" → the bytes the app expects: count, then 4-byte big-endian components. */
function pathBytes(text) {
  const parts = text.replace(/^m\//, "").split("/").filter(Boolean);
  const out = [parts.length];
  for (const p of parts) {
    const hard = /['hH]$/.test(p);
    const n = parseInt(p.replace(/['hH]$/, ""), 10) + (hard ? 0x80000000 : 0);
    out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  return Buffer.from(out);
}

function apdu(hex, seconds = 180) {
  const out = probe(["apdu", hex, String(seconds)]).trim().split("\n").pop().trim();
  const sw = out.slice(-4);
  if (sw !== "9000") {
    const why = { "5515": "устройството е ЗАКЛЮЧЕНО", "6985": "ОТКАЗАНО на устройството",
                  "6a80": "невалидни данни", "6d00": "INS не се поддържа",
                  "6e00": "грешно приложение е отворено" }[sw];
    throw new Error(`APDU върна ${sw}${why ? " — " + why : ""}`);
  }
  return Buffer.from(out.slice(0, -4), "hex");
}

async function main() {
  const TO = ethers.getAddress(process.env.TO);
  const AMOUNT = process.env.AMOUNT || "0.5";
  const DPATH = process.env.PATH_ETH || "44'/60'/0'/0/0";

  log(`мрежа ${network.name} · път m/${DPATH}`);
  log("отварям приложението Ethereum…");
  log(probe(["open", "Ethereum"]).trim());

  // The address for this path, read from the chip — the yardstick every signature is checked against.
  const pb = pathBytes(DPATH);
  const got = apdu("e0020000" + pb.length.toString(16).padStart(2, "0") + pb.toString("hex"), 30);
  const pubLen = got[0];
  const from = ethers.getAddress("0x" + got.subarray(1 + pubLen + 1, 1 + pubLen + 1 + 40).toString("ascii"));
  log(`подписващ адрес: ${from}`);

  const provider = ethers.provider;
  const chainId = (await provider.getNetwork()).chainId;
  const balance = await provider.getBalance(from);
  const value = ethers.parseEther(AMOUNT);
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? ethers.parseUnits("1", "gwei");
  const gasLimit = 21000n;
  const cost = value + gasPrice * gasLimit;

  log(`салдо ${ethers.formatEther(balance)} · пращам ${AMOUNT} · газ ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  if (balance < cost) {
    throw new Error(`не стига: трябват ${ethers.formatEther(cost)}, има ${ethers.formatEther(balance)}`);
  }

  // Legacy (type 0). Cosmos-EVM chains all accept it; typed transactions are not universally
  // supported and this path has to work on the custom chain as well as on Sepolia.
  const tx = ethers.Transaction.from({
    type: 0, chainId, to: TO, value, gasLimit, gasPrice,
    nonce: await provider.getTransactionCount(from, "pending"),
  });

  const unsigned = Buffer.from(ethers.getBytes(tx.unsignedSerialized));
  const payload = Buffer.concat([pb, unsigned]);
  if (payload.length > 255) throw new Error("не се налага разделяне за превод, но payload-ът е голям");

  log("");
  log("🔴 ПОТВЪРДИ НА УСТРОЙСТВОТО. Сверѝ на екрана му:");
  log(`      получател : ${TO}`);
  log(`      сума      : ${AMOUNT}`);
  log(`   чакам до 3 минути…`);
  const sig = apdu("e0040000" + payload.length.toString(16).padStart(2, "0") + payload.toString("hex"), 180);
  const r = "0x" + sig.subarray(1, 33).toString("hex");
  const s = "0x" + sig.subarray(33, 65).toString("hex");
  log(`подпис получен · r ${r.slice(0, 12)}… s ${s.slice(0, 12)}…`);

  // Try both parities and keep the one that recovers to the device's own address.
  let signed = null;
  for (const yParity of [0, 1]) {
    const t = ethers.Transaction.from(tx.toJSON());
    try {
      t.signature = { r, s, yParity };
      if (t.from && t.from.toLowerCase() === from.toLowerCase()) { signed = t; break; }
    } catch { /* that parity does not recover at all */ }
  }
  if (!signed) throw new Error("подписът НЕ се възстановява до адреса на устройството — не изпращам нищо");
  log(`✓ подписът се възстановява до ${signed.from} — съвпада с устройството`);

  const sent = await provider.broadcastTransaction(signed.serialized);
  log(`tx: ${sent.hash}`);
  const rec = await sent.wait(1);
  log(`блок ${rec.blockNumber} · статус ${rec.status === 1 ? "успех" : "ПРОВАЛ"} · газ ${rec.gasUsed}`);

  const at = await provider.getBlockNumber();
  log(`салдо на Ledger-а : ${ethers.formatEther(await provider.getBalance(from, at))}  (на блок ${at})`);
  log(`салдо на ${TO.slice(0, 10)}… : ${ethers.formatEther(await provider.getBalance(TO, at))}`);
}

main().catch((e) => { console.error("ГРЕШКА:", e.shortMessage || e.message); process.exitCode = 1; });
