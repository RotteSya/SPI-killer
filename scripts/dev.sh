#!/usr/bin/env bash
# Local mock server + client. Does not read server/.env and does not touch production.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SERVER_ONLY=0
SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --server-only) SERVER_ONLY=1 ;;
    --smoke) SERVER_ONLY=1; SMOKE=1 ;;
    -h|--help)
      echo "Usage: $0 [--server-only|--smoke]"
      exit 0
      ;;
    *)
      echo "dev: unknown argument: $arg" >&2
      echo "Usage: $0 [--server-only|--smoke]" >&2
      exit 1
      ;;
  esac
done

# Only PORT and LOG_LEVEL are caller-tunable. The server starts from an empty environment below,
# so an operator shell containing production Postgres, Stripe, Vercel, or model credentials cannot
# leak those values into this local workflow.
HOST="127.0.0.1"
PORT="${PORT:-8787}"
BASE_URL="http://${HOST}:${PORT}"
LOG_LEVEL="${LOG_LEVEL:-info}"
# Client-only: keep secrets out of the real Keychain even if the caller exported 0.
export NSPI_QA_EPHEMERAL=1

SERVER_PID=""
SERVER_LOG="$(mktemp "${TMPDIR:-/tmp}/notchspi-dev-server.XXXXXX")"
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
  exec env -i \
    PATH="$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    HOST="$HOST" \
    PORT="$PORT" \
    PUBLIC_BASE_URL="$BASE_URL" \
    DB_PATH=":memory:" \
    OFFICIAL_PROVIDER="mock" \
    PAYMENT_PROVIDER="stub" \
    ALLOW_STUB_TOPUP="1" \
    LOG_LEVEL="$LOG_LEVEL" \
    node src/index.ts
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

ready=0
HEALTH=""
for _ in $(seq 1 50); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "dev: server exited before becoming ready" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  if HEALTH="$(curl -sf "$BASE_URL/healthz" 2>/dev/null)"; then
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

if [[ "$SMOKE" == 1 ]]; then
  [[ "$HEALTH" == *'"provider":"mock"'* ]] || { echo "dev: smoke expected mock provider: $HEALTH" >&2; exit 1; }
  [[ "$HEALTH" == *'"db":"sqlite"'* ]] || { echo "dev: smoke expected in-memory SQLite: $HEALTH" >&2; exit 1; }
  [[ "$HEALTH" == *'"payments":"stub"'* ]] || { echo "dev: smoke expected stub payments: $HEALTH" >&2; exit 1; }
  echo "dev: isolated mock smoke passed"
  exit 0
fi

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
