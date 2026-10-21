/**
 * What does a PersonalWallet actually hold, split by token standard?
 *
 * This exists because the 2026-10-23 sweep has to move every asset out of four wallets, and
 * getting the inventory wrong means either a reverted proposal (72 hours lost — the timelock
 * cannot be re-run) or an asset silently left behind. Three approaches were tried; two do not
 * work on these chains, and the reasons are worth keeping:
 *
 *  1. ERC-165 `supportsInterface` — ✗ A LIAR. "Kotkata by GembaPay" answers ERC-165 itself with
 *     true and the ERC-721 interface id with FALSE, while `ownerOf` works, `name`/`symbol` work
 *     and the indexer lists it as ERC-721. Classifying by ERC-165 files it as a non-NFT, the
 *     sweep then calls `transfer(address,uint256)` on it, and the proposal reverts.
 *  2. `eth_getLogs` over the Transfer topic — ✗ rpc1.gembascan.io rejects the call outright
 *     (even a 200k-block window), and on a Hardhat fork historical ranges come back empty, which
 *     is worse than an error: it silently reports "no NFTs".
 *  3. The chain's INDEXER plus on-chain verification of every row — ✓ what this module does.
 *     The indexer knows the id space (the mocks mint at 9001+, so no 0..totalSupply walk finds
 *     them) and every row it returns is then confirmed against the chain, because an indexer
 *     lagging one block would hand us an id the wallet no longer owns.
 *
 * Classification is BEHAVIOURAL, never by advertised interface:
 *     decimals() answers        → ERC-20
 *     ownerOf(id) answers       → ERC-721
 *     balanceOf(addr,id) answers→ ERC-1155
 */
const { ethers } = require("ethers");

const INDEXER = {
  821207: { kind: "blockscout", url: "https://gembascan.io" },
  11155111: { kind: "etherscan", chainid: 11155111 },
};

const A20 = ["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];
const A721 = ["function ownerOf(uint256) view returns (address)"];
const A1155 = ["function balanceOf(address,uint256) view returns (uint256)"];

const ok = async f => { try { return await f(); } catch { return undefined; } };

/** ERC20 = 0, ERC721 = 1, ERC1155 = 2 — mirrors the contract's own enum. */
async function classify(provider, token, probeId) {
  // decimals() first: of the three standards only ERC-20 answers it, and it needs no token id —
  // so this branch is decided before any id guess can go wrong.
  if (await ok(() => new ethers.Contract(token, A20, provider).decimals()) !== undefined) return "erc20";
  // An id is now required, and a WRONG id reverts exactly like a missing function. The mocks mint
  // at 9001+, so a hardcoded 1 files MockERC721 as "unknown"; callers that know a real id (from
  // the indexer) must pass it.
  if (probeId !== undefined) {
    if (await ok(() => new ethers.Contract(token, A721, provider).ownerOf(probeId)) !== undefined) return "erc721";
    if (await ok(() => new ethers.Contract(token, A1155, provider).balanceOf(ethers.ZeroAddress, probeId)) !== undefined) return "erc1155";
  }
  return "unknown";
}

/** Ask the chain's indexer which (contract, id, amount) triples an address holds. */
async function indexerNFTs(chainId, holder) {
  const cfg = INDEXER[chainId];
  if (!cfg) return null;
  let url;
  if (cfg.kind !== "blockscout") return null;   // Etherscan V2 has no free NFT-inventory action:
                                                // `addresstokennftinventory` answers
                                                // "Missing Or invalid Action name". Sepolia uses
                                                // the log scan below instead.
  url = `${cfg.url}/api/v2/addresses/${holder}/nft?type=ERC-721%2CERC-1155%2CERC-404`;
  const r = await fetch(url, { signal: AbortSignal.timeout(45000) });   // a throw is CORRECT here:
  const body = await r.json();                                         // an indexer that refuses
  if (!Array.isArray(body.items)) throw new Error(`индексаторът не върна списък: ${JSON.stringify(body).slice(0, 120)}`);
  return body.items.map(it => ({
    token: ethers.getAddress((it.token || {}).address_hash || (it.token || {}).address),
    id: BigInt(it.id),
    amount: BigInt(it.value || 1),
    type: ((it.token || {}).type || "").toUpperCase(),
  }));
}

/**
 * Which block was this contract created in? Needed as the lower bound of the log scan.
 *
 * Etherscan's free `getcontractcreation` answers it in one call. The binary search on eth_getCode
 * is only a fallback, because it needs an ARCHIVE node: Sepolia's public RPC refuses historical
 * getCode and the search dies with "could not coalesce error".
 */
async function creationBlock(provider, addr, chainId) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (key && INDEXER[chainId] && INDEXER[chainId].kind === "etherscan") {
    try {
      const r = await fetch(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${addr}&apikey=${key}`, { signal: AbortSignal.timeout(30000) });
      const b = await r.json();
      const n = Number(((b.result || [])[0] || {}).blockNumber);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through to the search */ }
  }
  let lo = 0, hi = await provider.getBlockNumber();
  if ((await provider.getCode(addr, hi)) === "0x") throw new Error(`${addr} няма код`);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await provider.getCode(addr, mid)) === "0x") lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * NFT holdings from the Transfer/TransferSingle/TransferBatch log, in windows the RPC will accept.
 *
 * The fallback for chains with no indexer, and every free RPC tier fights it differently:
 *   publicnode  → "pruned history unavailable" (code 4444) — keeps only ~10k blocks of logs, so
 *                 NO chunk size helps; the data is simply gone. Unusable for this.
 *   1rpc        → 50 blocks per call. Unusable.
 *   Infura/dRPC → full history, 10 000 blocks per call. ✓ usable when chunked.
 * ethers reports all of them as "could not coalesce error", which hides the reason — the real
 * message is in `error.error.message`, and that is what gets surfaced here.
 *
 * Scanning starts at the WALLET's creation block; it cannot have held anything before it existed.
 */
async function logScanNFTs(provider, wallet, tokens, fromBlock) {
  const T721 = ethers.id("Transfer(address,address,uint256)");
  const TSINGLE = ethers.id("TransferSingle(address,address,address,uint256,uint256)");
  const TBATCH = ethers.id("TransferBatch(address,address,address,uint256[],uint256[])");
  const pad = a => ethers.zeroPadValue(ethers.getAddress(a), 32);
  const to = pad(wallet);
  const latest = await provider.getBlockNumber();

  const out = [];
  for (const topic of [T721, TSINGLE, TBATCH]) {
    let from = fromBlock, span = 9000;   // 10 000 is the documented cap and the range is inclusive
    while (from <= latest) {
      const upto = Math.min(from + span - 1, latest);
      try {
        // Filtered by EVENT only, not by indexed sender/recipient: ERC-1155 puts `id` in the
        // data, so the holder has to be matched during the replay below anyway, and one query per
        // event is cheaper than two (incoming + outgoing) per event.
        out.push(...await provider.getLogs({ address: tokens, topics: [topic], fromBlock: from, toBlock: upto }));
        from = upto + 1;
      } catch (e) {
        const real = ((e.error || {}).message) || e.shortMessage || e.message;
        if (/pruned|history unavailable/i.test(real)) throw new Error(`възелът е изчистил логовете (${real}) — трябва архивен RPC за блок ${from}`);
        if (span <= 500) throw new Error(`getLogs отказва и на ${span} блока: ${real}`);
        span = Math.floor(span / 2);
      }
    }
  }

  // Replay in order; a holding is what arrived and never left.
  const held = new Map();   // "token:id" → amount
  const key = (t, i) => `${t.toLowerCase()}:${i}`;
  const bump = (t, i, d) => { const k = key(t, i); const v = (held.get(k) || 0n) + d; v > 0n ? held.set(k, v) : held.delete(k); };
  out.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  const abi = new ethers.Interface([
    "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
    "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  ]);
  for (const l of out) {
    if (l.topics[0] === T721) {
      if (l.topics.length !== 4) continue;                      // 3 topics = an ERC-20 Transfer
      const [, f, t] = l.topics, id = BigInt(l.topics[3]);
      if (t === to) bump(l.address, id, 1n);
      else if (f === to) bump(l.address, id, -1n);
    } else {
      const ev = abi.parseLog(l);
      const pairs = l.topics[0] === TSINGLE ? [[ev.args.id, ev.args.value]] : ev.args.ids.map((x, i) => [x, ev.args.values[i]]);
      const dir = l.topics[3] === to ? 1n : (l.topics[2] === to ? -1n : 0n);
      if (dir === 0n) continue;
      for (const [id, v] of pairs) bump(l.address, id, dir * v);
    }
  }
  return [...held].map(([k, amount]) => {
    const [token, id] = k.split(":");
    return { token: ethers.getAddress(token), id: BigInt(id), amount, type: "" };
  });
}

/**
 * The full inventory, every number verified against the chain.
 *
 * `restrictTo` limits the result to assets the wallet's own registry allows, because a proposal
 * for an unregistered token reverts — anything the indexer finds outside the registry is reported
 * separately as `stranded`, since it cannot be moved without registering it first.
 */
async function inventory(provider, wallet, chainId, opts = {}) {
  const logProvider = opts.logProvider || provider;   // calls and logs often need DIFFERENT nodes
  const w = new ethers.Contract(wallet, [
    "function allowedTokens() view returns (address[],string[])",
    "function erc20Balance(address) view returns (uint256)",
    "function erc1155Balance(address,uint256) view returns (uint256)",
    "function nativeBalance() view returns (uint256)",
  ], provider);

  const [toks, labels] = await w.allowedTokens();
  const label = new Map(toks.map((t, i) => [ethers.getAddress(t).toLowerCase(), labels[i]]));
  const registered = new Set([...label.keys()]);

  const kinds = new Map();
  for (const t of toks) kinds.set(ethers.getAddress(t).toLowerCase(), await classify(provider, t));

  // ---- fungibles: only what the registry calls a token AND behaves like one -----------------
  const erc20 = [];
  for (const t of toks) {
    const a = ethers.getAddress(t), k = a.toLowerCase();
    if (kinds.get(k) !== "erc20") continue;
    const bal = await w.erc20Balance(a);
    if (bal > 0n) erc20.push({ token: a, label: label.get(k), amount: bal });
  }

  // ---- non-fungibles: from the indexer, each row re-read from the chain ---------------------
  // Indexer first (exact and cheap); log scan when the chain has none. Either path must SUCCEED —
  // "no NFTs found" is only trustworthy when the method actually ran.
  let rows = null, how = "индексатор";
  try { rows = await indexerNFTs(chainId, wallet); } catch (e) { rows = null; how = `индексаторът се провали (${e.message.slice(0, 60)})`; }
  if (rows === null) {
    const nftTokens = toks.filter(t => kinds.get(ethers.getAddress(t).toLowerCase()) !== "erc20");
    if (nftTokens.length === 0) { rows = []; how = "в регистъра няма NFT договор"; }
    else { rows = await logScanNFTs(logProvider, wallet, nftTokens.map(t => ethers.getAddress(t)), await creationBlock(provider, wallet, chainId)); how = "сканиран лог"; }
  }
  const nft = [], stranded = [];
  for (const r of rows) {
    const k = r.token.toLowerCase();
    let kind = kinds.get(k);
    if (kind === undefined || kind === "unknown") kind = await classify(provider, r.token, r.id);
    let confirmed = 0n, standard;
    if (kind === "erc721") {
      const owner = await ok(() => new ethers.Contract(r.token, A721, provider).ownerOf(r.id));
      confirmed = owner && owner.toLowerCase() === wallet.toLowerCase() ? 1n : 0n;
      standard = 0; // ERC721 in the contract's Standard enum
    } else if (kind === "erc1155") {
      confirmed = await w.erc1155Balance(r.token, r.id);
      standard = 1; // ERC1155
    } else continue;
    if (confirmed === 0n) continue;                       // the indexer was stale — skip it
    const item = { token: r.token, standard, id: r.id, amount: standard === 1 ? confirmed : 0n, label: label.get(k) || r.type || "?" };
    (registered.has(k) ? nft : stranded).push(item);
  }

  return { erc20, nft, stranded, native: await w.nativeBalance(), kinds, how };
}

module.exports = { inventory, classify, indexerNFTs, logScanNFTs, creationBlock };
