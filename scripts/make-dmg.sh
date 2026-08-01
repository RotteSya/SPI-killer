#!/usr/bin/env bash
set -euo pipefail

# Build a shareable NotchSPI.dmg: universal (arm64 + x86_64 when possible),
# wrapped in a .app bundle. If a "Developer ID Application" cert is present, the app + DMG are
# signed with a hardened runtime and Apple-notarized + stapled; otherwise it falls back to
# ad-hoc signing (NOT notarizable — recipients must bypass Gatekeeper manually).

cd "$(dirname "$0")/.."  # -> native/

APP_NAME="NotchSPI"
BUNDLE_ID="com.rottesya.notchspi"
VERSION="2.9"
ICON_FILE="NotchSPI.icns"
OUT="dist"
STAGING="$OUT/staging"

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
APP="$STAGING/$APP_NAME.app"
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
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
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

# A "Developer ID Application" cert enables real signing + notarization.
SIGN_ID="${SIGN_ID:-$(security find-identity -v -p codesigning | grep 'Developer ID Application' | head -1 | sed -E 's/.*"(.*)".*/\1/')}"
NOTARY_PROFILE="${NOTARY_PROFILE:-notchtutor}"

if [ -n "$SIGN_ID" ]; then
  echo "==> Code signing (Developer ID + hardened runtime): $SIGN_ID"
  codesign --force --deep --options runtime --timestamp --sign "$SIGN_ID" "$APP"
else
  echo "==> Ad-hoc code signing (no Developer ID cert found — NOT notarizable)"
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --verbose "$APP" 2>&1 | sed 's/^/    /' || true

echo "==> Staging DMG contents…"
ln -s /Applications "$STAGING/Applications"

echo "==> Creating DMG…"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -ov -format UDZO "$OUT/$APP_NAME.dmg" >/dev/null

if [ -n "$SIGN_ID" ]; then
  echo "==> Signing DMG…"
  codesign --force --timestamp --sign "$SIGN_ID" "$OUT/$APP_NAME.dmg"
  echo "==> Notarizing with Apple (profile: $NOTARY_PROFILE — can take a few minutes)…"
  xcrun notarytool submit "$OUT/$APP_NAME.dmg" --keychain-profile "$NOTARY_PROFILE" --wait
  echo "==> Stapling notarization ticket…"
  xcrun stapler staple "$OUT/$APP_NAME.dmg"
  xcrun stapler validate "$OUT/$APP_NAME.dmg" 2>&1 | sed 's/^/    /' || true
else
  echo "==> (Ad-hoc DMG — recipients must bypass Gatekeeper manually.)"
fi

echo "==> Done:"
ls -lh "$OUT/$APP_NAME.dmg"

# Publish to Quark cloud drive (夸克网盘) for real releases only:
# a notarized DMG (SIGN_ID present) means this is a release, not an ad-hoc dev build.
# Opt out with PUBLISH_QUARK=0. Non-fatal: a netdisk failure never discards the built DMG.
if [ -n "$SIGN_ID" ] && [ "${PUBLISH_QUARK:-1}" != "0" ]; then
  echo "==> Publishing DMG to Quark cloud drive…"
  VERSION="$VERSION" "$(dirname "$0")/publish-quark.sh" \
    || echo "    ⚠️  网盘上传失败（DMG 已在本地/GitHub 不受影响）；修好后重跑: scripts/publish-quark.sh"
fi
