#!/usr/bin/env bash
# Wires the secret scan into git, so a credential cannot be committed or pushed by accident.
#
#   npm run hooks:install
#
# Uses core.hooksPath rather than writing into .git/hooks, so the hooks are versioned with the
# repository and a fresh clone gets them with one command instead of being quietly unprotected.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mkdir -p .githooks

cat > .githooks/pre-commit <<'HOOK'
#!/usr/bin/env bash
# Refuses the commit if the secret scan finds anything.
set -euo pipefail
echo "pre-commit: scanning for credentials…"
bash scripts/check-secrets.sh
HOOK

cat > .githooks/pre-push <<'HOOK'
#!/usr/bin/env bash
# Last line before anything leaves the machine. Scans the whole working tree, not just the index,
# because a file added with `git add -f` in an earlier commit would already be tracked.
set -euo pipefail
echo "pre-push: scanning for credentials…"
bash scripts/check-secrets.sh
echo "pre-push: running the test suite…"
npx hardhat test >/dev/null 2>&1 || { echo "pre-push: TESTS FAILED — nothing pushed"; exit 1; }
echo "pre-push: tests pass"
HOOK

chmod +x .githooks/pre-commit .githooks/pre-push
git config core.hooksPath .githooks

echo "hooks installed:"
echo "  pre-commit  -> secret scan"
echo "  pre-push    -> secret scan + full test suite"
echo "  core.hooksPath = $(git config core.hooksPath)"
