#!/usr/bin/env bash
# Refuses to let a secret reach the repository.
#
# A .gitignore is not a control: it only covers files nobody has force-added, and it does nothing
# about a key pasted into a source file or a README. This scans the actual content that git would
# publish and exits non-zero if it finds anything that looks like a credential.
#
#   scripts/check-secrets.sh            # scan what git tracks (plus staged changes)
#   scripts/check-secrets.sh --all      # scan the whole working tree, tracked or not
#
# Wired as a pre-commit and pre-push hook by `npm run hooks:install`.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

MODE="${1:-tracked}"
FAIL=0
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
yel()  { printf '\033[33m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }

# What to scan.
if [ "$MODE" = "--all" ]; then
  mapfile -t FILES < <(find . -type f \
    -not -path './.git/*' -not -path './node_modules/*' -not -path './artifacts/*' \
    -not -path './cache/*' -not -path './coverage/*' -not -path './v1/artifacts/*' \
    -not -path './.listener-state/*' | sed 's|^\./||')
else
  mapfile -t FILES < <(git ls-files 2>/dev/null; git diff --cached --name-only --diff-filter=ACM 2>/dev/null)
  mapfile -t FILES < <(printf '%s\n' "${FILES[@]:-}" | sort -u | grep -v '^$')
fi
[ "${#FILES[@]}" -eq 0 ] && { yel "nothing to scan"; exit 0; }

report() { red "  REFUSED  $1"; printf '           %s\n' "$2"; FAIL=1; }

# ── 1 · files that must never be tracked at all ────────────────────────────────────────────────
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  case "$(basename "$f")" in
    .env|.env.local|.env.production|.env.*.local|*.key|*.pem|id_rsa|id_rsa.*|id_ed25519|id_ed25519.*|*.keystore|*.pass)
      [ "$(basename "$f")" = ".env.example" ] && continue
      report "$f" "a file of this name must never be committed" ;;
    allbotinfo*) report "$f" "this is the master credential file" ;;
  esac
done

# ── 2 · content patterns ───────────────────────────────────────────────────────────────────────
# A bare 32-byte hex value is ambiguous: a private key and a transaction hash look identical. So
# the test is CONTEXTUAL — a hex blob assigned to a secret-sounding name — plus a hard block on
# mnemonics and keyed provider URLs, which are unambiguous.
SECRET_ASSIGN='(priv(ate)?[_-]?key|secret|mnemonic|seed[_-]?phrase|passphrase|password|passwd|smtp[_-]?pass|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer)["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9+/=_-]{16,}'
HEX_SECRET='(priv(ate)?[_-]?key|secret|mnemonic|pk)["'"'"']?\s*[:=]\s*["'"'"']?(0x)?[0-9a-fA-F]{64}'
PROVIDER_KEYED='(infura\.io/v3/|alchemy\.com/v2/|ankr\.com/[a-z_]+/|quiknode\.pro/|chainstack\.com/|moralis-nodes\.com/[a-z]+\?apiKey=)[A-Za-z0-9_-]{16,}'

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  case "$f" in
    scripts/check-secrets.sh|.gitignore) continue ;;   # this file names the patterns on purpose
    *.png|*.jpg|*.jpeg|*.gif|*.pdf|*.zip|*.flac|*.wav) continue ;;
  esac
  file --mime-type -b "$f" | grep -q '^text/' || continue

  while IFS=: read -r ln _; do
    [ -n "${ln:-}" ] && report "$f:$ln" "a value assigned to a secret-sounding name"
  done < <(grep -nEi "$SECRET_ASSIGN" "$f" 2>/dev/null | grep -viE '=(\s*)?("")?$|<KEY>|<PK|your[_-]|example|xxxx|changeme|placeholder|\$\{|process\.env|env\(|getenv' | cut -d: -f1 | sed 's/$/:/')

  while IFS=: read -r ln _; do
    [ -n "${ln:-}" ] && report "$f:$ln" "a 32-byte hex value next to a key-like name"
  done < <(grep -nEi "$HEX_SECRET" "$f" 2>/dev/null | cut -d: -f1 | sed 's/$/:/')

  while IFS=: read -r ln _; do
    [ -n "${ln:-}" ] && report "$f:$ln" "a provider URL carrying an API key"
  done < <(grep -nEi "$PROVIDER_KEYED" "$f" 2>/dev/null | grep -viE '<KEY>|\$\{|example' | cut -d: -f1 | sed 's/$/:/')

done

# ── 3 · mnemonics, checked against the real BIP-39 wordlist and checksum ───────────────────────
# A shape-based regex is useless here: twelve ordinary English words match it. `bip39-scan.js`
# requires every word to be in the 2048-word list AND the checksum to validate.
if command -v node >/dev/null 2>&1 && [ -f scripts/lib/bip39-scan.js ]; then
  while read -r hit; do
    [ -n "$hit" ] && report "$hit" "a valid BIP-39 mnemonic (wordlist + checksum both match)"
  done < <(printf '%s\n' "${FILES[@]}" | grep -v '^$' | xargs -r node scripts/lib/bip39-scan.js 2>/dev/null)
else
  yel "  node or bip39-scan.js missing — mnemonic check SKIPPED, do not treat this run as clean"
  FAIL=1
fi

echo
if [ "$FAIL" -ne 0 ]; then
  red "SECRET SCAN FAILED — nothing was committed or pushed."
  echo "If a hit is a false positive, make it obviously inert (<KEY>, process.env.X) rather than"
  echo "weakening this script."
  exit 1
fi
grn "secret scan clean — ${#FILES[@]} file(s) checked"
