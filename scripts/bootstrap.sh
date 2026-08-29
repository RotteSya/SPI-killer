#!/usr/bin/env bash
# Idempotent local toolchain check + dependency install + debug client build.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  echo "bootstrap: $*" >&2
  exit 1
}

need_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "missing \`$cmd\`. $hint"
  fi
}

version_ge() {
  # Compare dotted versions $1 >= $2 (major.minor[.patch], missing = 0).
  local a="$1" b="$2"
  local IFS=.
  local -a pa=($a) pb=($b)
  local i n x y
  n=$(( ${#pa[@]} > ${#pb[@]} ? ${#pa[@]} : ${#pb[@]} ))
  for ((i = 0; i < n; i++)); do
    x="${pa[i]:-0}"
    y="${pb[i]:-0}"
    x="${x%%[!0-9]*}"
    y="${y%%[!0-9]*}"
    x="${x:-0}"
    y="${y:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

echo "==> Checking prerequisites"

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "macOS 14+ on Apple Silicon is required (found $(uname -s))"
fi

os_ver="$(sw_vers -productVersion 2>/dev/null || true)"
[[ -n "$os_ver" ]] || fail "could not read macOS version (sw_vers)"
if ! version_ge "$os_ver" "14.0"; then
  fail "macOS 14+ is required (found $os_ver)"
fi

arch="$(uname -m)"
if [[ "$arch" != "arm64" ]]; then
  fail "Apple Silicon (arm64) is required (found $arch)"
fi

if ! xcode-select -p >/dev/null 2>&1; then
  fail "Xcode Command Line Tools are missing. Install via Xcode, or run: xcode-select --install"
fi
need_cmd xcrun "Install Xcode Command Line Tools: xcode-select --install"
if ! xcrun --find swift >/dev/null 2>&1; then
  fail "Swift is not available through xcrun. Install Xcode Command Line Tools: xcode-select --install"
fi
need_cmd swift "Install Xcode Command Line Tools: xcode-select --install"

swift_ver="$(swift --version 2>/dev/null | awk 'NR==1 {
  for (i = 1; i <= NF; i++) if ($i == "version") { print $(i+1); exit }
}')"
[[ -n "$swift_ver" ]] || fail "could not parse \`swift --version\`"
if ! version_ge "$swift_ver" "5.9"; then
  fail "Swift 5.9+ is required (found $swift_ver)"
fi

need_cmd node "Install Node.js 22.5+ from https://nodejs.org (LTS). This script will not install it."
need_cmd npm "Install npm (ships with Node.js 22.5+) from https://nodejs.org"

node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
[[ -n "$node_ver" ]] || fail "could not parse \`node -v\`"
if ! version_ge "$node_ver" "22.5"; then
  fail "Node.js ≥ 22.5 is required (found v$node_ver). Install from https://nodejs.org"
fi

echo "    macOS $os_ver ($arch), Swift $swift_ver, Node v$node_ver"

echo "==> Installing server dependencies (npm ci)"
( cd "$REPO_ROOT/server" && npm ci )

echo "==> Building client (debug)"
swift build

echo "==> Repo health"
node "$REPO_ROOT/scripts/repo-health.mjs"

echo
echo "bootstrap: ready"
echo "Next: ./scripts/dev.sh"
