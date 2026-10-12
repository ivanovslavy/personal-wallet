#!/usr/bin/env node
"use strict";
/**
 * Checks that each listener is actually polling, and restarts the ones that are not.
 *
 *   node listeners/watchdog.js            # check and act
 *   node listeners/watchdog.js --dry-run  # report only
 *
 * WHY THIS EXISTS AND systemd ALONE IS NOT ENOUGH. `Restart=always` catches a process that
 * exits. It does nothing about one that is still running and no longer working — a socket wedged
 * on a half-open connection, a promise that never settles, a provider stuck mid-call. To systemd
 * that process is perfectly healthy. To the wallet it is gone.
 *
 * So the test is not "is it running" but "did it poll recently". Every cycle writes `lastPollAt`
 * into its state file, so a stale timestamp is proof of a hang regardless of what the process
 * looks like from outside.
 *
 * Deliberately a separate, short-lived process on a timer rather than a thread inside the
 * listener: a watchdog that shares a process with the thing it watches dies with it.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { knownNetworks, networkConfig, mailConfig, stateFile } = require("./config");
const { Mailer } = require("./lib/mailer");

const DRY = process.argv.includes("--dry-run");
const UNIT = (net) => `personal-wallet-listener-${net}`;

/** A poll is late once it is this far past due. Generous, so a slow cycle is not called a hang. */
const lateAfterMs = (pollMs) => Math.max(5 * pollMs, 5 * 60_000);

const out = [];
const say = (s) => { out.push(s); console.log(s); };

function unitState(net) {
  try {
    return execFileSync("systemctl", ["is-active", UNIT(net)], { encoding: "utf8" }).trim();
  } catch (e) {
    return String(e.stdout || "unknown").trim();
  }
}

function restart(net) {
  if (DRY) { say(`  would restart ${UNIT(net)}`); return "dry-run"; }
  try {
    execFileSync("systemctl", ["restart", UNIT(net)], { encoding: "utf8" });
    return "restarted";
  } catch (e) {
    return `restart FAILED: ${String(e.message).slice(0, 120)}`;
  }
}

async function main() {
  // Only networks that are actually configured — a default with no WATCH set is not in use.
  const nets = knownNetworks().filter((n) => { try { networkConfig(n); return true; } catch { return false; } });
  if (nets.length === 0) { console.log("no network is configured — nothing to watch"); return; }

  const problems = [];

  for (const net of nets) {
    const cfg = networkConfig(net);
    const active = unitState(net);
    const file = stateFile(net);

    let age = null, lastBlock = null;
    try {
      const st = JSON.parse(fs.readFileSync(file, "utf8"));
      lastBlock = st.lastBlock;
      if (st.lastPollAt) age = Date.now() - new Date(st.lastPollAt).getTime();
    } catch (e) {
      // No state file yet is normal for a listener that has only just started.
      say(`${net}: state file unreadable (${e.code || e.message})`);
    }

    const late = age != null && age > lateAfterMs(cfg.pollMs);
    const ageStr = age == null ? "unknown" : `${Math.round(age / 1000)}s ago`;
    say(`${net}: unit ${active} · last poll ${ageStr} · block ${lastBlock} · poll every ${cfg.pollMs / 1000}s`);

    if (active !== "active") {
      const r = restart(net);
      problems.push({ net, why: `the unit was ${active}`, action: r });
      say(`  -> ${r}`);
    } else if (late) {
      // Running but not polling. This is the case systemd cannot see.
      const r = restart(net);
      problems.push({
        net,
        why: `running but has not polled for ${Math.round(age / 1000)}s `
           + `(expected every ${cfg.pollMs / 1000}s; late past ${lateAfterMs(cfg.pollMs) / 1000}s)`,
        action: r,
      });
      say(`  -> HUNG: ${r}`);
    }
  }

  if (problems.length === 0) { say("all listeners are polling"); return; }

  if (DRY) {
    // A dry run reports and does nothing — including not sending mail. It sent one anyway the
    // first time it was tried, from a machine where the listeners are not even installed.
    say(`--dry-run: would have emailed about ${problems.length} problem(s); nothing was sent`);
    return;
  }

  // Something was wrong. Say so by email — a watchdog that fixes things silently leaves nobody
  // any the wiser that the thing keeps breaking.
  const mc = mailConfig(null);
  if (!mc.host || !mc.user || !mc.pass || !mc.to) {
    say("mail is not configured — cannot report; fix SMTP_* in .env");
    process.exitCode = 1;
    return;
  }
  const mailer = new Mailer({ ...mc, log: (m) => console.log(m) });
  const lines = [
    `The watchdog found ${problems.length} listener(s) not working and acted.`,
    "",
    ...problems.flatMap((p) => [
      `${p.net}:`,
      `  problem: ${p.why}`,
      `  action : ${p.action}`,
      "",
    ]),
    "Full check:",
    ...out.map((l) => `  ${l}`),
    "",
    "A restart resumes from the saved block, so nothing between there and the chain head is lost.",
  ];
  await mailer.send({
    subject: `[watchdog] ${problems.length} listener(s) restarted: ${problems.map((p) => p.net).join(", ")}`,
    text: lines.join("\n"),
  });
  process.exitCode = 1; // so `systemctl status` and the journal show the timer run as notable
}

main().catch((e) => { console.error(`watchdog failed: ${e.message}`); process.exitCode = 2; });
