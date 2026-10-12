"use strict";
/**
 * Network and endpoint configuration for the listeners.
 *
 * ENDPOINT ORDER IS THE POLICY: free endpoints first, keyed ones last. The pool walks the list in
 * order, so a quota-bearing endpoint is only reached when every free one has failed. Endpoints are
 * verified by `npm run listeners:probe` rather than trusted from a documentation page — half the
 * "public Sepolia RPC" lists on the internet point at hosts that no longer resolve.
 *
 * Keyed endpoints are built from environment variables and are simply absent when the variable is
 * not set, so the same config works on a machine with no keys at all.
 */
const path = require("path");

const env = (k, d = null) => {
  const v = process.env[k];
  return v && String(v).trim() !== "" ? String(v).trim() : d;
};

/** Only includes an endpoint when its key/url is actually present. */
function keyed(list) {
  return list.filter((e) => e && e.url);
}

/**
 * Endpoints come from the same comma-separated lists GembaPay already maintains — read from
 * `SEPOLIA_RPC_URLS` and `GEMBA_RPC_URLS` in `.env`, the variables his own `rpc-rebuild` tool
 * generates after probing each candidate. Reusing those rather than keeping a fourth independent
 * list: the project already has four overlapping endpoint lists that have drifted apart, and a
 * fifth would be a fifth thing to forget to update.
 *
 * A small set of known-good free endpoints is appended as a floor, so the listener still runs on a
 * machine with no `.env` at all.
 *
 * ORDERING IS THE POLICY, and it is derived rather than trusted: every URL is classified as keyed
 * or free by looking for a credential-shaped segment, then free ones are tried first. His own
 * `rpcProvider.js` carries a comment claiming "free public RPCs first" while in fact putting the
 * env-supplied keyed URLs ahead of the public ones — sorting here instead of relying on the order
 * in the file means the quota is genuinely spent last.
 */

/** True when the URL carries something that looks like a credential. */
function looksKeyed(url) {
  return /\/v[23]\/[A-Za-z0-9_-]{16,}|\/[0-9a-f]{32,}(\/|$)|[?&](api[-_]?key|key|apikey)=|quiknode\.pro|\.quiknode\./i.test(url);
}

/** Splits a comma-separated env list into endpoint records, free first. */
function fromEnvList(varName) {
  const raw = env(varName, "");
  const seen = new Set();
  const out = [];
  for (const u of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (seen.has(u)) continue;
    seen.add(u);
    let host = u;
    try { host = new URL(u).host; } catch { /* keep the raw string */ }
    const keyed = looksKeyed(u);
    // Several Ankr keys give several endpoints on the same host; number them so the labels in the
    // logs and in the probe table stay distinguishable.
    const base = host.replace(/^(www\.)?/, "");
    let label = keyed ? `${base}#${out.filter((e) => e.url.includes(base)).length + 1}` : base;
    out.push({ label, url: u, keyed });
  }
  return out;
}

/** Known-good free endpoints, used as a floor and merged without duplicates. */
const SEPOLIA_FREE_FLOOR = [
  { label: "ethereum-sepolia-rpc.publicnode.com", url: "https://ethereum-sepolia-rpc.publicnode.com" },
  { label: "sepolia.drpc.org", url: "https://sepolia.drpc.org" },
  { label: "sepolia.gateway.tenderly.co", url: "https://sepolia.gateway.tenderly.co" },
  { label: "eth-sepolia.api.onfinality.io", url: "https://eth-sepolia.api.onfinality.io/public" },
];

const GEMBA_FREE_FLOOR = [
  { label: "rpc1.gembascan.io", url: "https://rpc1.gembascan.io" },
  { label: "rpc2.gembascan.io", url: "https://rpc2.gembascan.io" },
  { label: "rpc3.gembascan.io", url: "https://rpc3.gembascan.io" },
];

/** Merge, de-duplicate by URL, then order: free before keyed. */
function pool(envVar, floor, singleOverride) {
  const list = [];
  const push = (e) => { if (e && e.url && !list.some((x) => x.url === e.url)) list.push(e); };
  // An explicit single-URL override wins outright — it is someone saying "use this one".
  if (singleOverride) push({ label: `env:${singleOverride.name}`, url: singleOverride.url, keyed: looksKeyed(singleOverride.url) });
  for (const e of fromEnvList(envVar)) push(e);
  for (const e of floor) push(e);
  return [...list.filter((e) => !e.keyed), ...list.filter((e) => e.keyed)];
}

const NETWORKS = {
  gembatestnet: {
    label: "gembatestnet",
    chainId: 821207,
    explorer: "https://gembascan.io",
    // The chain makes a block every few seconds and nobody else is competing for these RPCs,
    // so a short poll is cheap and the alert is prompt.
    pollMs: Number(env("GEMBA_POLL_MS", "20000")),
    confirmations: Number(env("GEMBA_CONFIRMATIONS", "3")),
    maxSpan: Number(env("GEMBA_MAX_SPAN", "2000")),
    endpoints: () => pool("GEMBA_RPC_URLS", GEMBA_FREE_FLOOR,
      env("GEMBATESTNET_RPC_URL") ? { name: "GEMBATESTNET_RPC_URL", url: env("GEMBATESTNET_RPC_URL") } : null),
  },
  sepolia: {
    label: "sepolia",
    chainId: 11155111,
    explorer: "https://sepolia.etherscan.io",
    // Free Sepolia endpoints rate-limit, so this is deliberately slower. A 12 s block time means
    // a 60 s poll still sees everything; only the alert is up to a minute later.
    pollMs: Number(env("SEPOLIA_POLL_MS", "60000")),
    confirmations: Number(env("SEPOLIA_CONFIRMATIONS", "4")),
    maxSpan: Number(env("SEPOLIA_MAX_SPAN", "1000")),
    endpoints: () => pool("SEPOLIA_RPC_URLS", SEPOLIA_FREE_FLOOR,
      env("SEPOLIA_RPC_URL") ? { name: "SEPOLIA_RPC_URL", url: env("SEPOLIA_RPC_URL") } : null),
  },
};

/** Contracts to watch, per network, from the environment. */
function watchedAddresses(network) {
  const key = network === "gembatestnet" ? "WATCH_GEMBA" : "WATCH_SEPOLIA";
  const raw = env(key, "");
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new Error(`${key} is empty — nothing to watch`);
  return list;
}

const mailConfig = () => ({
  host: env("SMTP_HOST", "mail.gembamail.com"),
  port: Number(env("SMTP_PORT", "587")),
  user: env("SMTP_USER"),
  pass: env("SMTP_PASS"),
  from: env("MAIL_FROM", env("SMTP_USER")),
  to: env("MAIL_TO", "slavy@gembamail.com"),
});

const stateFile = (network) =>
  env("STATE_DIR", path.join(__dirname, "..", ".listener-state")) + `/${network}.json`;

module.exports = { NETWORKS, watchedAddresses, mailConfig, stateFile, env };
