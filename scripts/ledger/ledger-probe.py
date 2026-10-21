#!/usr/bin/env python3
"""
Read a Ledger hardware wallet over raw USB HID. No Ledger Live, no npm, no pip.

    scripts/ledger/ledger-probe.py info          # firmware, mode, onboarding state
    scripts/ledger/ledger-probe.py apps          # installed apps, with hashes
    scripts/ledger/ledger-probe.py eth [path]    # Ethereum address  (default 44'/60'/0'/0/0)
    scripts/ledger/ledger-probe.py sol [path]    # Solana address    (default 44'/501'/0')
    scripts/ledger/ledger-probe.py btc [path]    # Bitcoin xpub + first address (default 84'/0'/0')
    scripts/ledger/ledger-probe.py all           # all three in ONE pass — one unlock, ~30 s
    scripts/ledger/ledger-probe.py open Ethereum # leave the device in an app (or BOLOS)
    scripts/ledger/ledger-probe.py selftest      # prove the BTC derivation against the BIP-84 vector

WHY THIS EXISTS AT ALL, when Ledger Live shows the same things. Two reasons, and the second is the
real one:

 1. Ledger Live is a 212 MB Electron app and a GUI. A question like "is this device onboarded" or
    "which apps are actually on the chip" should be answerable in one command, scriptable, from a
    terminal, and the answer should come from the SECURE ELEMENT rather than from a screen that is
    rendering cached state.
 2. This tool has ZERO dependencies — standard library only, including its own base58, bech32,
    secp256k1 and BIP-32. Nothing near a hardware wallet should pull a dependency tree it has not
    read. The whole point of the device is to shrink the trust surface; reading it through forty
    transitive npm packages gives that back.

WHAT IT CANNOT DO, on purpose: it never asks for, derives, stores or transmits a private key, and
it cannot install or remove apps. Installing official apps needs a secure channel to Ledger's HSM,
which is Ledger Live's job; the CLI alternatives load locally built, UNSIGNED apps and leave the
device reporting "not genuine", which is a trade not worth making.

── THE USB HID FRAMING, because it is undocumented in any one place

Every APDU is wrapped and split into 64-byte reports:

    channel(2) | 0x05 | sequence(2) | <payload chunk>            padded to 64 bytes with 0x00
    payload = length(2, big endian) | APDU

and the reply is reassembled the same way: strip the 5-byte header of each report, the first two
payload bytes of the FIRST report are the total length. /dev/hidrawN is 0660 root:root on most
distributions but systemd's uaccess tags it with an ACL for the logged-in user, so **no udev rule
is needed** — if you are at the console, you can already talk to the device.

── STATUS WORDS worth recognising

    9000   fine
    5515   THE DEVICE IS LOCKED — enter the PIN. Every read below returns this until you do.
    6e00   this CLA is not handled by whatever is currently running (wrong app open)
    6982   security status not satisfied

── A TRAP: opening an app RE-ENUMERATES THE USB DEVICE

`openApp` makes the Nano disconnect and come back as a new USB device, so /dev/hidrawN changes
underneath you. Every command here that needs a specific app therefore re-discovers the device
after switching, instead of caching a path. Without that, the second command in any script fails
with ENODEV and looks like a device fault.
"""

import os, sys, time, glob, select, hashlib, hmac

VENDOR = "2c97"
# ── THE TWO CLASSES OF COMMAND, and the mistake that costs an hour
#
# CLA 0xB0 is answered by the dashboard AND by every app — `B0 01` asks what is running, `B0 A7`
# quits back to the dashboard. CLA 0xE0 belongs to whoever is in charge: on the dashboard it is the
# OS (GET_VERSION, LIST_APPS, OPEN_APP), inside an app it is the APP's own protocol. So quitting
# with `E0 A7` silently does nothing while an app is open — the app sees a CLA it does not handle —
# and every later command keeps landing in the wrong place. Quit is B0.
GET_APP = "b001000000"
QUIT_APP = "b0a7000000"

SW = {"9000": "OK", "5515": "устройството е ЗАКЛЮЧЕНО — въведи PIN",
      "6e00": "командата не се разбира от текущото приложение",
      "6901": "устройството чака ЧОВЕК — потвърждение на екрана, или е заключено",
      "6982": "security status not satisfied", "6a80": "невалидни данни",
      "6d00": "INS не се поддържа"}


# ─────────────────────────────── transport ───────────────────────────────

def find_device(timeout=12.0, soft=False):
    """The hidraw node of the first Ledger on the bus. Retries, because an app switch re-enumerates.

    `soft=True` returns None instead of exiting — for callers that are polling through a transition
    and for which "not there yet" is not an error.
    """
    deadline = time.time() + timeout
    while True:
        for h in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
            real = os.path.realpath(os.path.join(h, "device"))
            # walk up to the USB device directory that carries idVendor
            d = real
            for _ in range(6):
                d = os.path.dirname(d)
                v = os.path.join(d, "idVendor")
                if os.path.exists(v):
                    if open(v).read().strip() == VENDOR:
                        return "/dev/" + os.path.basename(h)
                    break
        if time.time() > deadline:
            if soft:
                return None
            raise SystemExit(f"   не намирам Ledger на USB (вендор {VENDOR}) — включен ли е?")
        time.sleep(0.4)


def _wrap(apdu, channel=0x0101):
    payload = len(apdu).to_bytes(2, "big") + apdu
    out, seq = [], 0
    while payload:
        chunk, payload = payload[:59], payload[59:]
        out.append((channel.to_bytes(2, "big") + b"\x05" + seq.to_bytes(2, "big") + chunk).ljust(64, b"\x00"))
        seq += 1
    return out


class Timeout(Exception):
    """The device accepted the command and said nothing back within the deadline."""


def flush(dev):
    """Finish off a possibly half-sent APDU.

    Status 6901 turned up three times here with three different surroundings, so take it as
    "THE DEVICE IS WAITING FOR A HUMAN" rather than as any one fault:
      • twice it preceded 5515 by a few seconds — the screen was locking;
      • once it was the answer to OPEN_APP while the device was showing its confirmation prompt;
      • once it cleared after writing the frames below.
    A process killed between the first and last report of a multi-report APDU does leave the device
    waiting for the rest, and then every later command is read as that continuation — which these
    empty continuations clear. But that is a cheap mitigation, not a diagnosis. **On 6901, look at
    the device screen first.**
    """
    fd = os.open(dev, os.O_RDWR)
    try:
        for seq in range(1, 8):
            os.write(fd, (b"\x01\x01\x05" + seq.to_bytes(2, "big")).ljust(64, b"\x00"))
    finally:
        os.close(fd)
    time.sleep(0.4)


def exchange(dev, apdu, timeout=20.0, _retried=False):
    """One APDU in, (data, status) out. `apdu` may be hex text or bytes.

    THE TIMEOUT IS NOT OPTIONAL. `os.read` on a hidraw node blocks forever, and a Ledger stays
    silent whenever it is waiting for a button press — or when the APDU was malformed enough that
    the app never answers. Without a deadline the tool simply hangs, which is the least useful
    failure mode there is: it looks identical to a broken device. `select` turns that into a
    Timeout that says what to look at.
    """
    if isinstance(apdu, str):
        apdu = bytes.fromhex(apdu)
    fd = os.open(dev, os.O_RDWR)
    try:
        for p in _wrap(apdu):
            os.write(fd, p)
        data, total, deadline = b"", None, time.time() + timeout
        while True:
            left = deadline - time.time()
            if left <= 0 or not select.select([fd], [], [], left)[0]:
                raise Timeout(f"няма отговор за {timeout:.0f} s — виж ЕКРАНА на устройството, "
                              f"най-често чака потвърждение с бутон")
            r = os.read(fd, 64)
            if len(r) < 5:
                break
            body = r[5:]
            if total is None:
                total = int.from_bytes(body[:2], "big")
                body = body[2:]
            data += body
            if len(data) >= total:
                break
    finally:
        os.close(fd)
    full = data[:total]
    body, sw = full[:-2], full[-2:].hex()
    if sw == "6901" and not _retried:
        flush(dev)
        return exchange(dev, apdu, timeout, _retried=True)
    return body, sw


def need(data, sw, what):
    if sw != "9000":
        raise SystemExit(f"   {what}: статус {sw}" + (f" — {SW[sw]}" if sw in SW else ""))
    return data


# ─────────────────────────────── dashboard ───────────────────────────────

def app_running(dev):
    """(name, version) of whatever is open. `B0 01` is answered by the dashboard AND by every app,
    which makes it the only reliable way to ask 'where am I'."""
    d, sw = exchange(dev, GET_APP)
    if sw != "9000":
        return None, sw
    # DEFENSIVE ON PURPOSE. While the device is re-enumerating after an app switch, `B0 01` can
    # answer 9000 with a short or empty body. The first version indexed straight into it, threw
    # IndexError out of wait_for_app — which only caught OSError — and killed the whole run with a
    # traceback that looked like a tool crash rather than a transient. A malformed reply is just
    # "do not know yet"; say that and let the caller poll again.
    try:
        i = 1
        n = d[i]; i += 1; name = d[i:i+n].decode(errors="replace"); i += n
        n = d[i]; i += 1; ver = d[i:i+n].decode(errors="replace")
    except (IndexError, UnicodeDecodeError):
        return None, sw
    return (name, ver), sw


def wait_for_app(want, timeout=15.0):
    """Poll until `want` is the running app, re-finding the device each round.

    WHY POLLING AND NOT A SLEEP. Quitting or opening an app makes the Nano drop off USB and come
    back, and the window is not a fixed length — a `time.sleep(1.2)` followed by one check worked
    on a warm device and failed on a cold one, reporting "could not open Solana (now: Ethereum)"
    because the quit had not landed yet. Waiting for the STATE instead of for a duration removes
    the race entirely. Transient OSError here is expected: that is the node disappearing.
    """
    deadline = time.time() + timeout
    while True:
        try:
            dev = find_device(timeout=min(1.0, max(0.2, deadline - time.time())), soft=True)
            if dev is not None:
                cur, sw = app_running(dev)
                if sw == "5515":
                    # NOT swallowed: an earlier version caught SystemExit here alongside the
                    # transient errors, which turned "locked" into "could not open the app" —
                    # the single most misleading message this tool could produce.
                    raise SystemExit("   устройството е ЗАКЛЮЧЕНО — въведи PIN и пробвай пак")
                if cur and cur[0] == want:
                    return dev, cur
        except (OSError, Timeout):
            pass                             # the node vanishing mid-switch is the normal case
        if time.time() > deadline:
            return None, None
        time.sleep(0.3)


def ensure_app(dev, want):
    """Make `want` the running app and return its (possibly new) hidraw path."""
    cur, sw = app_running(dev)
    if sw == "5515":
        raise SystemExit("   устройството е ЗАКЛЮЧЕНО — въведи PIN и пробвай пак")
    if cur and cur[0] == want:
        return dev
    if cur and cur[0] != "BOLOS":
        try:
            exchange(dev, QUIT_APP)          # quit back to the dashboard
        except (OSError, Timeout):
            pass                             # it may vanish mid-reply; that IS the quit
        d, _ = wait_for_app("BOLOS")
        if d is None:
            raise SystemExit("   не успях да се върна на началния екран (dashboard)")
        dev = d
    if want == "BOLOS":
        d, _ = wait_for_app("BOLOS")
        if d is None:
            raise SystemExit("   не успях да се върна на началния екран (dashboard)")
        return d
    name = want.encode()
    try:
        d, sw = exchange(dev, bytes.fromhex("e0d80000") + bytes([len(name)]) + name)
        if sw not in ("9000", "6d00", "6e00"):
            # 6d00/6e00 here mean the command landed inside an app instead of the dashboard, which
            # the poll below recovers from. Anything else is a real refusal worth naming.
            print(f"   OPEN_APP върна {sw}" + (f" — {SW[sw]}" if sw in SW else ""))
    except (OSError, Timeout):
        pass

    # 🔴 OPENING AN APP NEEDS A BUTTON PRESS ON THE DEVICE.
    # The host asks; the Nano shows a prompt and waits for a human. An earlier version polled for
    # 15 seconds in silence and then reported "could not open <app> — is it installed?", which is
    # false and sends you to reinstall a perfectly good app. Say what is actually needed, then wait
    # long enough for a person to reach the device.
    dev, cur = wait_for_app(want, timeout=4)
    if dev is None:
        print(f"   👉 ПОТВЪРДИ НА УСТРОЙСТВОТО отварянето на „{want}“ — чакам до 60 s…")
        dev, cur = wait_for_app(want, timeout=60)
    if dev is None:
        raise SystemExit(f"   „{want}“ не се отвори. Или не беше потвърдено на устройството, или "
                         f"приложението липсва — `ledger-probe.py apps` показва какво има на чипа.")
    return dev


def cmd_info(dev):
    # GET_VERSION is CLA E0, so it only answers on the dashboard. Asking first what is running —
    # and stepping back to the dashboard if needed — is why this works regardless of state,
    # instead of dying with 6901 and looking like a fault.
    cur, sw = app_running(dev)
    if sw == "5515":
        raise SystemExit("   устройството е ЗАКЛЮЧЕНО — въведи PIN")
    if cur and cur[0] != "BOLOS":
        print(f"   отворено е „{cur[0]} {cur[1]}“ — връщам се на началния екран, за да прочета OS-а")
        dev = ensure_app(dev, "BOLOS")
    d = need(*exchange(dev, "e001000000"), "GET_VERSION")
    target = d[:4].hex(); i = 4
    def field():
        nonlocal i
        n = d[i]; i += 1; v = d[i:i+n]; i += n; return v
    se, flags, mcu = field(), field(), field()
    boot = field() if i < len(d) else b""
    MODELS = {"31100004": "Nano S", "33000004": "Nano X", "33100004": "Nano S Plus", "33200004": "Stax"}
    print(f"   модел       : {MODELS.get(target, 'неизвестен')}  (targetId 0x{target})")
    if target.startswith("0501"):
        print("   🔴 РЕЖИМ    : BOOTLOADER — това е състоянието на бракувано/прекъснато обновяване")
    print(f"   SE firmware : {se.decode(errors='replace')}")
    print(f"   MCU         : {mcu.decode(errors='replace') or '(ПРАЗНО → bootloader)'}")
    if boot:
        print(f"   bootloader  : {boot.decode(errors='replace')}")
    f0 = flags[0] if flags else 0
    # Measured, not taken from a table: bit 0x04 flipped 0→1 exactly when the seed was created,
    # and 0x08 tracks whether the PIN has been entered in this session.
    print(f"   флагове     : {flags.hex()}  → onboarded={'да' if f0 & 0x04 else 'НЕ'}, "
          f"PIN въведен={'да' if f0 & 0x08 else 'не'}")
    cur, _ = app_running(dev)
    print(f"   отворено    : {cur[0] + ' ' + cur[1] if cur else '?'}")


def cmd_apps(dev):
    apps, apdu = [], "e0de000000"
    while True:
        d, sw = exchange(dev, apdu)
        if sw != "9000":
            need(d, sw, "LIST_APPS")
        if len(d) <= 1:
            break
        i = 1
        while i < len(d):
            n = d[i]
            if n == 0:
                break
            e = d[i+1:i+n]; i += n
            apps.append((e[68+1:68+1+e[68]].decode(errors="replace"), e[0:4].hex(), e[4:36].hex()))
        apdu = "e0df000000"
    if not apps:
        print("   няма инсталирани приложения")
    for name, flags, h in apps:
        print(f"   {name:<22} флагове {flags}  хеш {h}")


# ─────────────────────────── derivation paths ───────────────────────────

def parse_path(text):
    """\"44'/60'/0'/0/0\" → bytes the device expects: count, then 4-byte big-endian components."""
    parts = [p for p in text.replace("m/", "").split("/") if p]
    out = bytes([len(parts)])
    for p in parts:
        hardened = p.endswith(("'", "h", "H"))
        n = int(p.rstrip("'hH"))
        out += ((n + 0x80000000) if hardened else n).to_bytes(4, "big")
    return out


# ───────────────────────── encodings, self-contained ─────────────────────────

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58encode(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58); s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\x00"))) + s

def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + body

def b58check_decode(s):
    raw = b58decode(s)
    body, chk = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != chk:
        raise SystemExit("   base58 контролната сума не съвпада")
    return body

BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

def _polymod(values):
    GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((top >> i) & 1) else 0
    return chk

def bech32_encode(hrp, witver, witprog):
    data = [witver] + _convertbits(witprog, 8, 5)
    exp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    const = 0x2bc830a3 if witver else 1          # bech32m for v1+, bech32 for v0
    pm = _polymod(exp + data + [0] * 6) ^ const
    return hrp + "1" + "".join(BECH32[d] for d in data + [(pm >> 5 * (5 - i)) & 31 for i in range(6)])

def _convertbits(data, frm, to):
    acc, bits, out = 0, 0, []
    for b in data:
        acc = (acc << frm) | b; bits += frm
        while bits >= to:
            bits -= to; out.append((acc >> bits) & ((1 << to) - 1))
    if bits:
        out.append((acc << (to - bits)) & ((1 << to) - 1))
    return out

def hash160(b):
    return hashlib.new("ripemd160", hashlib.sha256(b).digest()).digest()


# ───────────── secp256k1 + BIP-32, public-key side only ─────────────
# Only CKDpub is implemented: this tool never has a private key and must never be able to need one.

P  = 2**256 - 2**32 - 977
N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8

def _add(p1, p2):
    if p1 is None: return p2
    if p2 is None: return p1
    x1, y1 = p1; x2, y2 = p2
    if x1 == x2 and (y1 + y2) % P == 0: return None
    if p1 == p2:
        l = 3 * x1 * x1 * pow(2 * y1, P - 2, P) % P
    else:
        l = (y2 - y1) * pow(x2 - x1, P - 2, P) % P
    x3 = (l * l - x1 - x2) % P
    return (x3, (l * (x1 - x3) - y1) % P)

def _mul(k, p=(GX, GY)):
    r = None
    while k:
        if k & 1: r = _add(r, p)
        p = _add(p, p); k >>= 1
    return r

def decompress(pub33):
    x = int.from_bytes(pub33[1:], "big")
    y = pow((x * x * x + 7) % P, (P + 1) // 4, P)
    if (y & 1) != (pub33[0] & 1):
        y = P - y
    return (x, y)

def compress(pt):
    x, y = pt
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")

def ckd_pub(pub33, chaincode, index):
    """BIP-32 non-hardened child of a public key. Hardened children are impossible without the
    private key — which is exactly why only the receive chain can be derived here."""
    if index >= 0x80000000:
        raise SystemExit("   закалено (hardened) извеждане е невъзможно от публичен ключ")
    I = hmac.new(chaincode, pub33 + index.to_bytes(4, "big"), hashlib.sha512).digest()
    k = int.from_bytes(I[:32], "big")
    if k >= N:
        raise SystemExit("   IL ≥ n — пробвай следващия индекс (вероятност ~2⁻¹²⁷)")
    return compress(_add(_mul(k), decompress(pub33))), I[32:]

def xpub_parts(xpub):
    """→ (depth, fingerprint, chaincode, pubkey33). Works for xpub/ypub/zpub alike: only the
    4-byte version prefix differs and the payload layout is identical."""
    b = b58check_decode(xpub)
    return b[4], b[5:9], b[13:45], b[45:78]


def p2wpkh(pub33):
    return bech32_encode("bc", 0, hash160(pub33))


# ─────────────────────────────── coins ───────────────────────────────

def cmd_eth(dev, path="44'/60'/0'/0/0"):
    dev = ensure_app(dev, "Ethereum")
    d = need(*exchange(dev, bytes.fromhex("e0020000") + bytes([len(parse_path(path))]) + parse_path(path)),
             "ETH GET_PUBLIC_KEY")
    i = 0
    n = d[i]; i += 1; pub = d[i:i+n]; i += n
    n = d[i]; i += 1; addr = d[i:i+n].decode()
    print(f"   път     : m/{path}")
    print(f"   адрес   : 0x{addr}")
    # The full key, not a prefix: it is what lets the address be re-derived independently
    # (keccak256 of the 64 bytes after the 0x04 prefix, last 20 bytes) instead of trusted as text.
    print(f"   pubkey  : {pub.hex()}")

def cmd_sol(dev, path="44'/501'/0'"):
    dev = ensure_app(dev, "Solana")
    p = parse_path(path)
    d = need(*exchange(dev, bytes.fromhex("e0050000") + bytes([len(p)]) + p), "SOL GET_PUBKEY")
    print(f"   път     : m/{path}")
    print(f"   адрес   : {b58encode(d)}")

def cmd_btc(dev, path="84'/0'/0'"):
    dev = ensure_app(dev, "Bitcoin")
    p = parse_path(path)
    # The Bitcoin app ≥ 2.0 speaks its own CLA 0xE1; data is display-flag, then the path.
    d = need(*exchange(dev, bytes.fromhex("e1000000") + bytes([1 + len(p)]) + b"\x00" + p),
             "BTC GET_EXTENDED_PUBKEY")
    xpub = d.decode().strip()
    print(f"   път     : m/{path}   (BIP-84, native segwit)")
    print(f"   xpub    : {xpub}")
    _, _, cc, pub = xpub_parts(xpub)
    recv, cc2 = ckd_pub(pub, cc, 0)              # external chain
    first, _ = ckd_pub(recv, cc2, 0)             # index 0
    print(f"   адрес 0 : {p2wpkh(first)}        ← m/{path}/0/0")
    print("   🔑 сверѝ го с Ledger Live, преди да пратиш нещо: xpub-ът идва от чипа, но "
          "последната стъпка е сметнатa тук.")


def cmd_selftest():
    """Prove the derivation and the address encoding against the official BIP-84 test vector,
    BEFORE anyone trusts an address this tool printed for a real wallet."""
    zpub = ("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868R"
            "vUUkgDKf31mGDtKsAYz2oz2AGutZYs")
    want_pub = "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c"
    want_addr = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
    ok = True
    print("   ── RIPEMD-160('abc')")
    got = hashlib.new("ripemd160", b"abc").hexdigest()
    ok &= got == "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"
    print(f"      {got}  {'✓' if ok else '✗'}")
    print("   ── BIP-84 вектор, m/84'/0'/0'/0/0")
    _, _, cc, pub = xpub_parts(zpub)
    recv, cc2 = ckd_pub(pub, cc, 0)
    first, _ = ckd_pub(recv, cc2, 0)
    gp, ga = first.hex(), p2wpkh(first)
    print(f"      pubkey  {gp}  {'✓' if gp == want_pub else '✗ очаквано ' + want_pub}")
    print(f"      адрес   {ga}  {'✓' if ga == want_addr else '✗ очаквано ' + want_addr}")
    ok &= gp == want_pub and ga == want_addr
    print("   " + ("✓ извеждането и кодирането са верни" if ok else "🔴 ПРОВАЛ — не вярвай на btc адресите"))
    return 0 if ok else 1


def cmd_apdu(dev, hexapdu, timeout="30"):
    """Send one raw APDU and print `<data><SW>` as hex.

    The reason this exists: the transport — framing, re-enumeration, the select-based deadline,
    the 6901 recovery — should live in ONE place. Tools that need to sign (which needs keccak and
    RLP, so they are written in JavaScript against the project's existing ethers) call this instead
    of re-implementing USB HID in a second language and getting the timeout wrong again.

    It cannot leak a key: the device has no command that returns one.
    """
    d, sw = exchange(dev, hexapdu, timeout=float(timeout))
    print(d.hex() + sw)


def cmd_open(dev, want="BOLOS"):
    """Leave the device sitting in a named app — or back on the dashboard.

    Exists so other tools do not have to re-implement the app switch. Getting it right means
    knowing that QUIT is CLA B0 while OPEN is CLA E0, and that both re-enumerate the USB device;
    one place in the tree should carry that knowledge.
    """
    dev = ensure_app(dev, want)
    cur, _ = app_running(dev)
    print(f"   отворено: {cur[0]} {cur[1]}  ({dev})")


def cmd_all(dev):
    """All three addresses in ONE run.

    WHY THIS EXISTS. A Nano X locks its screen after a minute or two of inactivity, and each app
    switch re-enumerates the USB device and takes a couple of seconds. Reading the three coins as
    three separate invocations therefore means three unlocks and a good chance of landing mid-lock
    with a 6901 that looks like a fault. One pass, one unlock, around half a minute.
    """
    for label, fn in (("ETHEREUM", cmd_eth), ("SOLANA", cmd_sol), ("BITCOIN", cmd_btc)):
        print(f"   ── {label}")
        try:
            fn(find_device())
        except SystemExit as e:
            print(f"      🔴 {e}")


def main():
    args = sys.argv[1:] or ["info"]
    cmd, rest = args[0], args[1:]
    if cmd == "selftest":
        raise SystemExit(cmd_selftest())
    dev = find_device()
    print(f"   устройство: {dev}")
    if cmd == "info":   cmd_info(dev)
    elif cmd == "apps": cmd_apps(dev)
    elif cmd == "eth":  cmd_eth(dev, *rest)
    elif cmd == "sol":  cmd_sol(dev, *rest)
    elif cmd == "btc":  cmd_btc(dev, *rest)
    elif cmd == "all":  cmd_all(dev)
    elif cmd == "open": cmd_open(dev, *rest)
    elif cmd == "apdu": cmd_apdu(dev, *rest)
    else:
        raise SystemExit(f"   непозната подкоманда „{cmd}“ — info | apps | eth | sol | btc | all | open | apdu | selftest")

if __name__ == "__main__":
    main()
