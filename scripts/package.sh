#!/usr/bin/env bash
# Build the macOS app. Usage: package.sh qa|release [--unsigned]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

usage() {
  echo "Usage: $0 qa|release [--unsigned]" >&2
  echo "  qa       → dist-qa/NotchSPI.app" >&2
  echo "  release  → dist/NotchSPI.dmg (Developer ID + notarize + staple)" >&2
  echo "  --unsigned  release only: ad-hoc signed DMG, skip notarization" >&2
}

MODE=""
UNSIGNED=0
for arg in "$@"; do
  case "$arg" in
    qa|release) MODE="$arg" ;;
    --unsigned) UNSIGNED=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "package: unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  usage
  exit 1
fi
if [[ "$UNSIGNED" == 1 && "$MODE" != "release" ]]; then
  echo "package: --unsigned is only valid with release" >&2
  exit 1
fi

load_version() {
  local file="$REPO_ROOT/VERSION.env"
  [[ -f "$file" ]] || { echo "package: missing $file" >&2; exit 1; }
  APP_VERSION=""
  BUILD_NUMBER=""
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      APP_VERSION) APP_VERSION="$value" ;;
      BUILD_NUMBER) BUILD_NUMBER="$value" ;;
      *)
        echo "package: unexpected key in VERSION.env: $key" >&2
        exit 1
        ;;
    esac
  done < "$file"
  [[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || {
    echo "package: APP_VERSION must look like 1.2 or 1.2.3 (got '$APP_VERSION')" >&2
    exit 1
  }
  [[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || {
    echo "package: BUILD_NUMBER must be an integer (got '$BUILD_NUMBER')" >&2
    exit 1
  }
}

load_version

APP_NAME="NotchSPI"
BUNDLE_ID="com.rottesya.notchspi"
ICON_FILE="NotchSPI.icns"
SHORT_VERSION="$APP_VERSION"
DISPLAY_NAME="$APP_NAME"
if [[ "$MODE" == "qa" ]]; then
  DISPLAY_NAME="$APP_NAME (test)"
fi

find_sign_id() {
  if [[ -n "${SIGN_ID:-}" ]]; then
    printf '%s' "$SIGN_ID"
    return
  fi
  security find-identity -v -p codesigning 2>/dev/null \
    | grep 'Developer ID Application' \
    | head -1 \
    | sed -E 's/.*"(.*)".*/\1/' \
    || true
}

SIGN_ID="$(find_sign_id)"
NOTARY_PROFILE="${NOTARY_PROFILE:-notchtutor}"

if [[ "$MODE" == "release" && "$UNSIGNED" != 1 && -z "$SIGN_ID" ]]; then
  echo "package: release requires a Developer ID Application certificate." >&2
  echo "    Pass --unsigned for an ad-hoc local build, or set SIGN_ID." >&2
  exit 1
fi

echo "==> Building release binary (arm64)"
swift build -c release --arch arm64
BINDIR="$(swift build -c release --arch arm64 --show-bin-path)"
BIN="$BINDIR/$APP_NAME"
[[ -x "$BIN" ]] || { echo "package: missing binary $BIN" >&2; exit 1; }
echo "    $(file "$BIN")"

if [[ "$MODE" == "qa" ]]; then
  OUT="dist-qa"
  rm -rf "$OUT"
  APP="$OUT/$APP_NAME.app"
else
  OUT="dist"
  STAGING="$OUT/staging"
  rm -rf "$OUT"
  APP="$STAGING/$APP_NAME.app"
fi

echo "==> Assembling $APP_NAME.app"
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
  <key>CFBundleDisplayName</key><string>$DISPLAY_NAME</string>
  <key>CFBundleIconFile</key><string>$ICON_FILE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$SHORT_VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>NotchSPI</string>
</dict>
</plist>
PLIST

sign_app() {
  if [[ -n "$SIGN_ID" && "$UNSIGNED" != 1 ]]; then
    echo "==> Code signing (Developer ID + hardened runtime): $SIGN_ID"
    codesign --force --deep --options runtime --timestamp --sign "$SIGN_ID" "$APP"
  else
    echo "==> Ad-hoc code signing"
    codesign --force --deep --sign - "$APP"
  fi
}

sign_app
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "==> Verifying app signature"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /'

if [[ "$MODE" == "qa" ]]; then
  echo "==> Done:"
  du -sh "$APP" | sed 's/^/    /'
  echo "    $(cd "$OUT" && pwd)/$APP_NAME.app"
  exit 0
fi

echo "==> Staging DMG contents"
ln -s /Applications "$STAGING/Applications"

echo "==> Creating DMG"
# Pin the distribution filesystem instead of inheriting the host's APFS default.
# The read-only installer volume needs only the app and Applications link.
hdiutil create -volname "$APP_NAME" -fs HFS+ -srcfolder "$STAGING" -ov -format UDZO "$OUT/$APP_NAME.dmg" >/dev/null
echo "==> Verifying DMG integrity"
hdiutil verify "$OUT/$APP_NAME.dmg"

if [[ "$UNSIGNED" == 1 || -z "$SIGN_ID" ]]; then
  echo "==> Unsigned DMG (ad-hoc). Recipients must bypass Gatekeeper."
  echo "==> Done:"
  ls -lh "$OUT/$APP_NAME.dmg"
  exit 0
fi

echo "==> Signing DMG"
codesign --force --timestamp --sign "$SIGN_ID" "$OUT/$APP_NAME.dmg"
codesign --verify --strict --verbose=2 "$OUT/$APP_NAME.dmg" 2>&1 | sed 's/^/    /'
echo "==> Notarizing with Apple (profile: $NOTARY_PROFILE)"
xcrun notarytool submit "$OUT/$APP_NAME.dmg" --keychain-profile "$NOTARY_PROFILE" --wait
echo "==> Stapling notarization ticket"
xcrun stapler staple "$OUT/$APP_NAME.dmg"
xcrun stapler validate "$OUT/$APP_NAME.dmg" 2>&1 | sed 's/^/    /'

echo "==> Done:"
ls -lh "$OUT/$APP_NAME.dmg"
