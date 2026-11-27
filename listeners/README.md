# The two listeners

Two systemd services, one per chain, both running the same `listeners/run.js` with a different
argument. One implementation rather than two near-identical files: a polling loop duplicated is a
bug fixed in one copy and forgotten in the other.

| unit | watches | poll | confirmations |
|---|---|---|---|
| `personal-wallet-listener-gembatestnet` | GembaChain testnet, chainId 821207 | 20 s | 3 |
| `personal-wallet-listener-sepolia` | Sepolia, chainId 11155111 | 60 s | 4 |

Both take their contract addresses, timings and endpoints from `.env`, email what they find to
`MAIL_TO`, and keep their position in `.listener-state/<network>.json`.

## Nothing is hardcoded

Every value comes from `.env`; `networks.default.json` only supplies defaults **as data**. A
network absent from that file can be defined purely from environment variables, so putting a
wallet on a new chain — including a mainnet — is env lines plus a systemd unit, never a code
change.

For a network called `<net>`, the prefix is its name upper-cased with non-alphanumerics as `_`:

| variable | meaning |
|---|---|
| `<NET>_WATCH` | contract address(es) to watch, comma-separated — **required** |
| `<NET>_CHAIN_ID` | required only for a network absent from `networks.default.json` |
| `<NET>_RPC_URLS` | comma-separated endpoints; free ones are tried first regardless of order |
| `<NET>_RPC_URL` | a single endpoint, wins over the list |
| `<NET>_EXPLORER` | base URL for the links in the email |
| `<NET>_POLL_MS` · `<NET>_CONFIRMATIONS` · `<NET>_MAX_SPAN` | timing and depth |
| `<NET>_START_BLOCK` | where to begin with no saved position |
| `<NET>_WATCH_INCOMING` · `<NET>_WATCH_FAILED` | `false` to switch off either extra scan |
| `<NET>_MAIL_TO` | per-network recipient, overriding the global `MAIL_TO` |
| `<NET>_ANOMALY_MAIL_MS` | how often a **failure** digest may go out (default 30 min) |
| `<NET>_SUMMARY_MS` | one heartbeat per period, `0` for none (default 24 h) |
| `<NET>_MAIL_ON_SWITCH` | `true` to also mail the moment the active endpoint changes (default `false`) |
| `<NET>_ENDPOINT_ALERT_AFTER` | failures **in a row** of one endpoint before a failure digest is mailed (default 3) |

Mail is global: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`.

The older names already in use (`WATCH_GEMBA`, `WATCH_SEPOLIA`, `GEMBA_RPC_URLS`, …) still
resolve, so an existing `.env` keeps running after an upgrade instead of silently watching
nothing. `node listeners/run.js` with no argument lists what is configured.

## When a mail goes out — and when it deliberately does not

🔴 **A switch of the active endpoint is not an alert.** Each call is routed to an endpoint that
can serve it: `scanIncoming` needs `logsWithoutAddress` and only some providers allow an
unfiltered `eth_getLogs`, while `getBlockNumber` takes the first free one. The active endpoint
therefore changes **between call classes every single cycle** — normal routing, not a fault.

That was learned the hard way. The pool kept one global "current endpoint", so the two call
classes overwrote each other twice per cycle and each overwrite was reported as an anomaly:
**48 mails in one day on sepolia**, every one of them reading `0 RPC failure(s), 40 switch(es)`
— noise that buries the one message that matters. Two fixes, both covered by
`listeners/test/alerting.test.js`:

1. The pool tracks the active endpoint **per capability bucket**, so a switch means a change
   *within* one call class. Alternating between classes emits nothing.
2. The digest goes out **only when an endpoint actually failed**. Switch counts ride along inside
   that digest and in the daily heartbeat; `<NET>_MAIL_ON_SWITCH=true` restores live reporting
   for anyone who wants it.
3. **2026-11-22: and only when ONE endpoint failed `ENDPOINT_ALERT_AFTER` (3) times in a row**, with no
   good answer in between. A single timeout is the fallback doing its job (polygon's publicnode: four in a
   week, each alone, each one a mail). It is counted per endpoint and error in the daily heartbeat
   (`polygon-bor-rpc.publicnode.com: 3 × request timeout (3)`). With the pool's cooldown (2 min, then 4),
   three in a row means at least ~6 minutes without a good answer. One mail per outage — subject
   `[<net>] <endpoint> down — 3+ failures in a row` — and none again for that endpoint until it has answered.

| what happens | what arrives |
|---|---|
| a wallet event, an arriving token, a **refused** transaction | immediately, one mail per batch |
| an endpoint fails once or twice | nothing — counted per endpoint in the daily heartbeat |
| one endpoint fails **3 times in a row** | "<endpoint> down" digest, once per outage, at most once per `ANOMALY_MAIL_MS` |
| the active endpoint merely changes | nothing — counted only |
| **every** endpoint fails every round | its own louder mail, not rate-limited |
| five cycles in a row fail | "listener cannot read the chain" |
| the listener shuts down | "listener STOPPED" |
| nothing at all is wrong | one heartbeat per `SUMMARY_MS` with the counters |

## Three things each cycle looks for

**1 · Events the wallet emits** — `eth_getLogs` filtered to the watched addresses.

**2 · Tokens arriving by a plain transfer.** An ERC-20 transfer runs none of the wallet's code, so
it emits no wallet event and without this the arrival is invisible. Scanned by `Transfer` /
`TransferSingle` / `TransferBatch` with the wallet as indexed recipient, deliberately **not**
filtered by token address — the point is to see tokens nobody allowlisted. Each is tagged
`allowlisted: true/false`, and unknown-token arrivals are capped at three per email so a dust
attack cannot become a flood. A deposit through the proper path emits both a wallet event and a
token `Transfer`; it is reported once.

**3 · Transactions to the wallet that REVERTED.** A failed transaction writes no logs, so a
log-based listener can never show a refused attempt — and "someone tried and was refused" is the
single most useful thing a savings wallet can tell you. Each cycle reads its blocks with their
transactions, picks out those addressed to the wallet, checks the receipts for `status 0`, and
replays the call at that block to **decode the revert reason**. The subject leads with the count:
`[sepolia] 1 REFUSED + 2 events`. Verified live on both chains —
`RecipientNotAllowed(0x3A9D…)`, `TokenNotAllowed(0x1111…)`, `BadTtl(60)`.

🔴 **No block is ever skipped (2026-11-22).** The scan keeps its own position (`failedScanBlock` in the
state file), trails the log scan by at most `MAX_FAILED_SCAN_BLOCKS` (default 300) per cycle and works a
long catch-up off cycle by cycle — it used to skip the whole range. A block it cannot read **holds** the
position there: retried every cycle, mailed once as `failed-transaction scan HELD at block N` after 15
minutes, and once more when it moves on; the daily summary shows the scan's block and lag. Blocks are read
**raw** (`eth_getBlockByNumber`), not through ethers' `getBlock(n, true)`: on 21.11.2026 one stranger's
EIP-7702 transaction with an invalid authorization (`yParity 0xbc`, BSC block 134791636) made ethers reject
the whole block on every endpoint — 728 "endpoint failures" in seven minutes, then a silent skip. ethers
6.17.0 is the latest release, so upgrading is not a fix. Likewise an unreadable incoming-transfer range
now fails the cycle (position not saved) instead of reading as "no arrivals".
`listeners/test/failed-scan.test.js` covers all of it.

Request cost, measured: gemba at a 20 s poll is ~42 calls/min against his own nodes; Sepolia at
90 s is **8 calls/min** — fewer than the two-call version made at 60 s.

## Staying alive, and knowing when it is not

Four separate mechanisms, because each covers a failure the others cannot see.

**1 · The endpoint list wraps round, three times.** `withProvider` makes up to **three complete
passes** over every endpoint. The first pass respects the per-endpoint cooldown; later passes
ignore it, which is what makes the list genuinely wrap back to the first endpoint instead of
stalling once everything is parked. Measured: two endpoints, three rounds, six attempts.

**2 · Then it stops, rather than looping.** When all three rounds fail, the listener does **not**
keep retrying at its poll cadence — hammering dead endpoints every 20 seconds fills the journal
and can get it rate-limited exactly when it needs to come back. It backs off for
`backoffMs` (15 minutes by default), sends one loud email, and retries. It keeps its block
position throughout, so nothing between there and the chain head is lost.

**3 · systemd restarts a process that exits.** `Restart=always`, `RestartSec=15`.

**4 · A watchdog restarts a process that HANGS.** This is the one systemd cannot do.
`Restart=always` catches a process that exits; it does nothing about one still running and no
longer working — a wedged socket, a promise that never settles. To systemd that process is
healthy; to the wallet it is gone.

So the test is not "is it running" but "did it poll recently". Every cycle writes `lastPollAt`
into its state file, and `listeners/watchdog.js` — a short-lived process on its own 5-minute
timer, deliberately not a thread inside the listener, since a watchdog sharing a process dies
with it — restarts anything that has not polled for `max(5 × pollMs, 5 min)` and emails what it
did.

Both paths were tested on the real box rather than reasoned about:

| test | what happened |
|---|---|
| listener stopped (`systemctl stop`) | watchdog: `unit inactive` → restarted → emailed |
| listener **hung** (`SIGSTOP`) | systemd still reported `active`; watchdog saw `last poll 350s ago` against a 300 s threshold → `HUNG: restarted` → emailed → caught up from block 4003395 to 4003584 |

```bash
node listeners/watchdog.js --dry-run     # report, change nothing, send nothing
systemctl list-timers 'personal-wallet-*'
```

## What gets emailed

| event | when |
|---|---|
| wallet events, plain arrivals, refused transactions | every cycle that finds something |
| **no RPC is answering** | once, when all three rounds fail; the listener pauses |
| recovered | once, when it reads the chain again after failing |
| RPC failures and endpoint switches | aggregated, at most one digest every 30 minutes |
| listener **stopped** | on a clean shutdown — a listener that goes quiet is indistinguishable from one that is fine |
| watchdog restarted something | whenever it had to act |
| **POLICY ALARM** — an open `SET_POLICY` proposal | on sight, at every stage change, and again every 6 h until it is executed, cancelled or expired |
| policy alarm cannot read the wallet / reading again | once after six failed checks in a row, once when it reads again |

### The policy alarm (2026-11-27)
Every 10 minutes (`<NET>_POLICY_CHECK_MS`, `0` = off) the listener reads the wallet's proposals that are
not yet final and mails every open `SET_POLICY` (`<NET>_POLICY_REMIND_MS`, default 6 h, for the reminder).
Why a plain event mail is not enough: whether a policy proposal is timelocked is decided when it is
**proposed**, but its absolute values are written when it is **executed**. A confirmed "tightening"
proposal left open can therefore set the policy back **instantly** — no timelock, no veto — once the
policy has been tightened by another proposal, and a confirmed non-timelocked proposal can be neither
cancelled nor vetoed; it only expires after 7 days. The rule that follows: execute a policy change
right after confirming it, and never tighten while another policy proposal is open.

| stage in the subject | what it means | what to do |
|---|---|---|
| `AWAITING CONFIRMATION` | proposed, 1 of 2 | confirm only if you execute right after; not yours → do not confirm |
| `CONFIRMED NOT EXECUTED` | confirmed, not timelocked, cannot be cancelled | yours → **execute now**; not yours → two keys are compromised |
| `LOOSENING SCHEDULED` | loosens, timelocked | not yours → **veto** before it takes effect (any single owner) |

Plain event mails now name the proposal kind (`SET_POLICY (10)` instead of `10`) and lead with
`POLICY CHANGE +` when a policy proposal or `PolicyChanged` is among them. The daily summary carries
a `policy alarm` line. Tested against the real contract: `npx hardhat test test/09-listener-policy-alarm.js`.

Endpoint switching is normal, successful behaviour; it is reported so a provider that is quietly
degrading becomes visible, not because anything is broken. The digest is rate-limited so a
flapping endpoint cannot turn the alerting into a flood — the same reasoning that caps unknown
token arrivals at three per email.

## Capability, as distinct from health

An endpoint can be perfectly alive and refuse one kind of call. `publicnode` serves
`eth_getLogs` **with** an address filter and refuses it **without** one (measured 2026-10-12).
Treating that as ill-health was wrong twice over: it pushed every other call off a healthy
endpoint, and it retried a call that can never work there.

So the pool records per-endpoint **capabilities** separately from health. `publicnode` keeps
serving the main log scan while the unfiltered scan goes to `drpc` or `tenderly`. A transient
error — timeout, reset, 429, 5xx — never counts towards a capability verdict, after `drpc` was
written off for a capability it demonstrably has. And a **contract revert is an answer, not a
failure**: it leaves the endpoint's health untouched and the revert data intact, which is what
made decoded revert reasons possible at all.

## Install on the Pi

```bash
# from the laptop, with the project already copied to /home/slavy/personal_wallet on the Pi
sudo cp listeners/systemd/personal-wallet-listener-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now personal-wallet-listener-gembatestnet
sudo systemctl enable --now personal-wallet-listener-sepolia
```

## Checking on them

```bash
systemctl status 'personal-wallet-listener-*'
journalctl -u personal-wallet-listener-sepolia -f            # structured JSON, one line per event
cat /home/slavy/personal_wallet/.listener-state/sepolia.json  # where it is up to
node listeners/probe.js                                       # which endpoints are usable right now
```

## Why it polls instead of subscribing

A `provider.on("logs", …)` subscription dies quietly: the socket closes, nothing throws, and the
service looks healthy while seeing nothing. Polling `eth_getLogs` over an explicit range either
returns a range or raises — and the position is on disk either way, so a crash resumes instead of
skipping.

## What is hardened in the unit, and why

- `Restart=always`, not `on-failure` — a clean exit after a transient `SIGTERM` would otherwise
  leave the chain unwatched until someone noticed.
- `TimeoutStopSec=90` — the current cycle gets time to save its position before being killed.
- `ProtectSystem=strict` + `ProtectHome=read-only` with a single `ReadWritePaths` for the state
  directory: the service can read its own code and `.env`, write its position, and nothing else.
- `MemoryMax=512M` — the loop is small and bounded; if it ever is not, systemd stops it rather than
  letting it compete with Permitiv and the IPFS node on a 8 GB Pi.
- No secrets in the unit. They come from `.env` (mode 600), so nothing sensitive lands in journald
  or in `systemctl show`.
