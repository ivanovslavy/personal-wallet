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

Mail is global: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`.

The older names already in use (`WATCH_GEMBA`, `WATCH_SEPOLIA`, `GEMBA_RPC_URLS`, …) still
resolve, so an existing `.env` keeps running after an upgrade instead of silently watching
nothing. `node listeners/run.js` with no argument lists what is configured.

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
`RecipientNotAllowed(0x3A9D…)`, `TokenNotAllowed(0x1111…)`, `BadTtl(60)`. Skipped on a long
catch-up (over `MAX_FAILED_SCAN_BLOCKS`, default 300) rather than firing thousands of calls.

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
