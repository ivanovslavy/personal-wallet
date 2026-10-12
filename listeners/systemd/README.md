# The two listeners

Two systemd services, one per chain, both running the same `listeners/run.js` with a different
argument. One implementation rather than two near-identical files: a polling loop duplicated is a
bug fixed in one copy and forgotten in the other.

| unit | watches | poll | confirmations |
|---|---|---|---|
| `personal-wallet-listener-gembatestnet` | GembaChain testnet, chainId 821207 | 20 s | 3 |
| `personal-wallet-listener-sepolia` | Sepolia, chainId 11155111 | 60 s | 4 |

Both read `WATCH_GEMBA` / `WATCH_SEPOLIA` from `.env` for the contract addresses, email every event
they find to `MAIL_TO`, and keep their position in `.listener-state/<network>.json`.

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
