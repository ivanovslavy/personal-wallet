"use strict";
/**
 * Network configuration for the listeners — entirely environment-driven.
 *
 * NOTHING IS HARDCODED IN LOGIC. `networks.default.json` holds defaults as data, every value is
 * overridable from `.env`, and a network that is not in that file at all can be defined purely
 * from environment variables. Putting a wallet on a new chain — including a mainnet — is a matter
 * of adding env lines and a systemd unit, never of editing this file.
 *
 * THE SCHEME. For a network called `<net>`, the prefix is its name upper-cased with anything
 * non-alphanumeric turned into `_`:
 *
 *   <NET>_CHAIN_ID         required for a network not in networks.default.json
 *   <NET>_WATCH            the contract address(es) to watch, comma-separated   (required)
 *   <NET>_RPC_URLS         comma-separated endpoints, free ones first           (recommended)
 *   <NET>_RPC_URL          a single endpoint; wins over the list
 *   <NET>_EXPLORER         base explorer URL, used for links in the email
 *   <NET>_POLL_MS          how often to poll
 *   <NET>_CONFIRMATIONS    how deep a log must be before it is reported
 *   <NET>_MAX_SPAN         the largest getLogs range to ask for in one call
 *   <NET>_START_BLOCK      where to begin when there is no saved position
 *   <NET>_WATCH_INCOMING   false to stop watching for plain token arrivals
 *   <NET>_WATCH_FAILED     false to stop watching for reverted transactions
 *
 * Mail is global: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO.
 * Per-network override of the recipient: <NET>_MAIL_TO.
 *
 * LEGACY NAMES still work, because they are already in use on the running box:
 *   GEMBA_RPC_URLS -> GEMBATESTNET_RPC_URLS · WATCH_GEMBA -> GEMBATESTNET_WATCH
 *   WATCH_SEPOLIA -> SEPOLIA_WATCH · GEMBA_POLL_MS, SEPOLIA_POLL_MS, …
 */
const fs = require("fs");
const path = require("path");

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, "networks.default.json"), "utf8")).networks;

/** Env prefix for a network name: "gembatestnet" -> "GEMBATESTNET", "gemba-main" -> "GEMBA_MAIN". */
const prefixOf = (net) => String(net).toUpperCase().replace(/[^A-Z0-9]+/g, "_");

const raw = (k) => {
  const v = process.env[k];
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
};

/**
 * Names already in use on the running machine, mapped to the uniform scheme. Kept so an existing
 * .env keeps working rather than silently watching nothing after an upgrade.
 */
const LEGACY = {
  GEMBATESTNET_RPC_URLS: ["GEMBA_RPC_URLS"],
  GEMBATESTNET_WATCH: ["WATCH_GEMBA"],
  GEMBATESTNET_POLL_MS: ["GEMBA_POLL_MS"],
  GEMBATESTNET_CONFIRMATIONS: ["GEMBA_CONFIRMATIONS"],
  GEMBATESTNET_MAX_SPAN: ["GEMBA_MAX_SPAN"],
  SEPOLIA_WATCH: ["WATCH_SEPOLIA"],
  GEMBA_WATCH: ["WATCH_GEMBA_MAINNET"],
};

/** Reads <NET>_<KEY>, then any legacy alias, then the default from the json, then `fallback`. */
function cfg(net, key, fallback = null) {
  const name = `${prefixOf(net)}_${key}`;
  const direct = raw(name);
  if (direct != null) return direct;
  for (const alias of LEGACY[name] || []) {
    const v = raw(alias);
    if (v != null) return v;
  }
  const d = DEFAULTS[net];
  const jsonKey = { CHAIN_ID: "chainId", EXPLORER: "explorer", POLL_MS: "pollMs",
    CONFIRMATIONS: "confirmations", MAX_SPAN: "maxSpan" }[key];
  if (d && jsonKey && d[jsonKey] != null) return String(d[jsonKey]);
  return fallback;
}

const asBool = (v, d) => (v == null ? d : String(v).toLowerCase() === "true");
const asList = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);

/** True when a URL carries something that looks like a credential, so it is tried last. */
function looksKeyed(url) {
  return /\/v[23]\/[A-Za-z0-9_-]{16,}|\/[0-9a-f]{32,}(\/|$)|[?&](api[-_]?key|key|apikey)=|quiknode\.pro|\.quiknode\./i.test(url);
}

/**
 * The endpoint pool: an explicit single URL first, then the env list, then the defaults from the
 * json — de-duplicated, and ordered FREE BEFORE KEYED so a quota-bearing endpoint is only reached
 * when the free ones have failed. The order is derived from the URLs, not trusted from the order
 * they were written in.
 */
function endpoints(net) {
  const out = [];
  const push = (url, label) => {
    if (!url || out.some((e) => e.url === url)) return;
    let host = url;
    try { host = new URL(url).host; } catch { /* keep the raw string */ }
    const keyed = looksKeyed(url);
    const same = out.filter((e) => e.url.includes(host)).length;
    out.push({ label: label || (keyed ? `${host}#${same + 1}` : host), url, keyed });
  };

  const single = cfg(net, "RPC_URL");
  if (single) push(single, `env:${prefixOf(net)}_RPC_URL`);
  for (const u of asList(cfg(net, "RPC_URLS"))) push(u);
  for (const u of (DEFAULTS[net]?.rpcs || [])) push(u);

  return [...out.filter((e) => !e.keyed), ...out.filter((e) => e.keyed)];
}

/** Everything one listener needs, assembled for a network name. */
function networkConfig(net) {
  const chainId = Number(cfg(net, "CHAIN_ID"));
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`${prefixOf(net)}_CHAIN_ID is not set and "${net}" is not in networks.default.json`);
  }
  const eps = endpoints(net);
  if (eps.length === 0) {
    throw new Error(`no RPC endpoints for "${net}" — set ${prefixOf(net)}_RPC_URLS or ${prefixOf(net)}_RPC_URL`);
  }
  const watch = asList(cfg(net, "WATCH"));
  if (watch.length === 0) {
    throw new Error(`${prefixOf(net)}_WATCH is empty — there is nothing to watch`);
  }
  return {
    label: net,
    chainId,
    explorer: cfg(net, "EXPLORER", ""),
    pollMs: Number(cfg(net, "POLL_MS", "60000")),
    confirmations: Number(cfg(net, "CONFIRMATIONS", "5")),
    maxSpan: Number(cfg(net, "MAX_SPAN", "1000")),
    startBlock: cfg(net, "START_BLOCK") ? Number(cfg(net, "START_BLOCK")) : null,
    watchIncoming: asBool(cfg(net, "WATCH_INCOMING"), true),
    watchFailed: asBool(cfg(net, "WATCH_FAILED"), true),
    maxFailedScanBlocks: Number(cfg(net, "MAX_FAILED_SCAN_BLOCKS", "300")),
    // Alert cadence. All three are per-network and come from the env, so a mainnet listener can
    // be made quieter or louder than a testnet one without touching code.
    //   <NET>_ANOMALY_MAIL_MS  how often a FAILURE digest may go out        (default 30 min)
    //   <NET>_SUMMARY_MS       the one-per-period heartbeat, 0 = none       (default 24 h)
    //   <NET>_MAIL_ON_SWITCH   mail the moment the active endpoint changes  (default false)
    anomalyMailMs: Number(cfg(net, "ANOMALY_MAIL_MS", String(30 * 60_000))),
    summaryMs: Number(cfg(net, "SUMMARY_MS", String(24 * 60 * 60_000))),
    mailOnSwitch: asBool(cfg(net, "MAIL_ON_SWITCH"), false),
    addresses: watch,
    endpoints: eps,
  };
}

/** Networks that could be run: the defaults plus anything given a <NET>_CHAIN_ID in the env. */
function knownNetworks() {
  const fromEnv = Object.keys(process.env)
    .filter((k) => k.endsWith("_CHAIN_ID"))
    .map((k) => k.replace(/_CHAIN_ID$/, "").toLowerCase());
  const listed = asList(raw("LISTEN_NETWORKS")).map((x) => x.toLowerCase());
  return [...new Set([...Object.keys(DEFAULTS), ...fromEnv, ...listed])].sort();
}

const mailConfig = (net) => ({
  host: raw("SMTP_HOST"),
  port: Number(raw("SMTP_PORT") || 587),
  user: raw("SMTP_USER"),
  pass: raw("SMTP_PASS"),
  from: raw("MAIL_FROM") || raw("SMTP_USER"),
  to: (net && cfg(net, "MAIL_TO")) || raw("MAIL_TO"),
});

const stateFile = (net) =>
  path.join(raw("STATE_DIR") || path.join(__dirname, "..", ".listener-state"), `${net}.json`);

module.exports = { networkConfig, knownNetworks, mailConfig, stateFile, endpoints, prefixOf, DEFAULTS };
