#!/usr/bin/env bash
set -euo pipefail

# Build a signed, runnable NotchSPI.app for REAL-DEVICE QA testing — no DMG, no notarization,
# no netdisk publish. Developer-ID + hardened runtime so Screen Recording permission is stable
# and Gatekeeper stays happy; version marked "-test" so it is distinguishable from the release
# install, while keeping the production bundle ID so the existing permission grant carries over.

cd "$(dirname "$0")/.."  # -> native/

APP_NAME="NotchSPI"
BUNDLE_ID="com.rottesya.notchspi"
VERSION="2.9-test"
ICON_FILE="NotchSPI.icns"
OUT="dist-qa"

echo "==> Building release binary (trying universal)…"
if swift build -c release --arch arm64 --arch x86_64 >/dev/null 2>&1; then
  BINDIR="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"
else
  echo "    universal build unavailable; building for the native arch only"
  swift build -c release >/dev/null
  BINDIR="$(swift build -c release --show-bin-path)"
fi
BIN="$BINDIR/$APP_NAME"
echo "    $(file "$BIN")"

echo "==> Assembling $APP_NAME.app…"
rm -rf "$OUT"
APP="$OUT/$APP_NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$APP_NAME"
chmod +x "$APP/Contents/MacOS/$APP_NAME"
cp "Resources/$ICON_FILE" "$APP/Contents/Resources/$ICON_FILE"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME (test)</string>
  <key>CFBundleIconFile</key><string>$ICON_FILE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>16</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>NotchSPI</string>
</dict>
</plist>
PLIST

SIGN_ID="${SIGN_ID:-$(security find-identity -v -p codesigning | grep 'Developer ID Application' | head -1 | sed -E 's/.*"(.*)".*/\1/')}"
if [ -n "$SIGN_ID" ]; then
  echo "==> Code signing (Developer ID + hardened runtime): $SIGN_ID"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_ID" "$APP"
else
  echo "==> Ad-hoc code signing (no Developer ID cert found)"
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --verbose "$APP" 2>&1 | sed 's/^/    /' || true

# Locally built files carry no com.apple.quarantine attribute, so Gatekeeper lets this launch
# without a prompt. Strip it defensively in case anything set it.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "==> Done:"
du -sh "$APP" | sed 's/^/    /'
echo "    $(cd "$OUT" && pwd)/$APP_NAME.app"
