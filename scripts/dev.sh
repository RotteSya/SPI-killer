#!/usr/bin/env bash
# Local mock server + client. Does not read server/.env and does not touch production.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SERVER_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --server-only) SERVER_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--server-only]"
      exit 0
      ;;
    *)
      echo "dev: unknown argument: $arg" >&2
      echo "Usage: $0 [--server-only]" >&2
      exit 1
      ;;
  esac
done

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
BASE_URL="http://${HOST}:${PORT}"

export HOST
export PORT
export DB_PATH="${DB_PATH:-:memory:}"
export OFFICIAL_PROVIDER="${OFFICIAL_PROVIDER:-mock}"
export ALLOW_STUB_TOPUP="${ALLOW_STUB_TOPUP:-1}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
# Client-only: keep secrets out of the real Keychain. Harmless if the server sees it.
export NSPI_QA_EPHEMERAL="${NSPI_QA_EPHEMERAL:-1}"

SERVER_PID=""
SERVER_LOG="$(mktemp -t notchspi-dev-server)"
cleanup() {
  local code=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_LOG"
  exit "$code"
}
trap cleanup EXIT INT TERM

if [[ ! -d "$REPO_ROOT/server/node_modules" ]]; then
  echo "dev: server dependencies missing; run ./scripts/bootstrap.sh first" >&2
  exit 1
fi

echo "==> Starting official server at $BASE_URL"
(
  cd "$REPO_ROOT/server"
  exec node src/index.ts
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "dev: server exited before becoming ready" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  if curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [[ "$ready" != 1 ]]; then
  echo "dev: timed out waiting for $BASE_URL/healthz" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
echo "    /healthz ok"

if [[ "$SERVER_ONLY" == 1 ]]; then
  echo "dev: server-only mode. Ctrl-C to stop."
  wait "$SERVER_PID"
  exit $?
fi

echo "==> Building client if needed"
swift build >/dev/null
BIN_DIR="$(swift build --show-bin-path)"
BIN="$BIN_DIR/NotchSPI"
if [[ ! -x "$BIN" ]]; then
  echo "dev: missing client binary at $BIN" >&2
  exit 1
fi

echo "==> Launching client (-official.baseURL $BASE_URL)"
"$BIN" -official.baseURL "$BASE_URL"
