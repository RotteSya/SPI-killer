#!/usr/bin/env bash
# Full local regression. Stops on the first failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

step() { echo "==> $*"; }

step "repo-health"
node "$REPO_ROOT/scripts/repo-health.mjs"

step "typecheck"
( cd "$REPO_ROOT/server" && npm run typecheck )

step "node tests"
( cd "$REPO_ROOT/server" && npm test )

step "isolated local-server smoke"
HOST=0.0.0.0 \
OFFICIAL_PROVIDER=anthropic \
ANTHROPIC_API_KEY=poison-model-key \
POSTGRES_URL=postgres://poison:poison@127.0.0.1:1/production \
PAYMENT_PROVIDER=stripe \
STRIPE_SECRET_KEY=poison-stripe-key \
STRIPE_WEBHOOK_SECRET=poison-webhook-key \
VERCEL=1 \
NSPI_QA_EPHEMERAL=0 \
PORT=18787 \
"$REPO_ROOT/scripts/dev.sh" --smoke

step "swift tests (serial, warnings-as-errors)"
# Shared UserDefaults/Keychain make two first-run migration tests race under --parallel.
# Generic secret migration tests use the DEBUG in-process vault. The account integration
# suite explicitly uses a separate real Keychain service for its Security API coverage.
NSPI_QA_EPHEMERAL=1 swift test -Xswiftc -warnings-as-errors

step "release arm64 build"
swift build -c release --arch arm64

step "whitespace"
git diff HEAD --check

if [[ -n "${TEST_POSTGRES_URL:-}" ]]; then
  step "Postgres store suite"
  ( cd "$REPO_ROOT/server" && npm test )
fi

echo
echo "verify: passed"
