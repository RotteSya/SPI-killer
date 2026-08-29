#!/usr/bin/env bash
# Full local regression. Stops on the first failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

step() { echo "==> $*"; }

step "repo-health"
node "$REPO_ROOT/scripts/repo-health.mjs"

step "typecheck"
npm --prefix "$REPO_ROOT/server" run typecheck

step "node tests"
npm --prefix "$REPO_ROOT/server" test

step "swift tests (serial, warnings-as-errors)"
# Shared UserDefaults/Keychain make two first-run migration tests race under --parallel.
swift test -Xswiftc -warnings-as-errors

step "release arm64 build"
swift build -c release --arch arm64

step "whitespace"
git diff HEAD --check

if [[ -n "${TEST_POSTGRES_URL:-}" ]]; then
  step "Postgres store suite"
  npm --prefix "$REPO_ROOT/server" test
fi

echo
echo "verify: passed"
