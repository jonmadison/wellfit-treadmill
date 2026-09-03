#!/bin/bash
# Builds a macOS .app bundle for the given cargo profile.
#
#   ./bundle.sh debug build          -> build/WELLFIT TM.app
#   ./bundle.sh release build        -> build/WELLFIT TM.app (optimized)
#
# We hand-roll the bundle instead of using `cargo tauri build` so the project
# needs no Node toolchain or tauri-cli install. macOS keys Bluetooth permission
# to a bundle identity, so a bundle (not a bare binary) is required for the
# permission prompt to appear at all.
set -euo pipefail

PROFILE="${1:-debug}"
DEST="${2:-build}"
cd "$(dirname "$0")"

if [ "$PROFILE" = "release" ]; then
  cargo build --release --manifest-path src-tauri/Cargo.toml
else
  cargo build --manifest-path src-tauri/Cargo.toml
fi

APP="$DEST/WELLFIT TM.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "src-tauri/target/$PROFILE/wellfit-tm" "$APP/Contents/MacOS/"
cp src-tauri/icons/icon.png "$APP/Contents/Resources/" 2>/dev/null || true

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>WELLFIT TM</string>
  <key>CFBundleDisplayName</key><string>WELLFIT TM</string>
  <key>CFBundleIdentifier</key><string>dev.local.wellfit-tm</string>
  <key>CFBundleExecutable</key><string>wellfit-tm</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>Connects to your treadmill to read speed and distance and to send start, stop, and speed commands.</string>
</dict>
</plist>
PLIST

# Ad-hoc signature: an unsigned bundle gets its Bluetooth grant revoked on
# every rebuild, since the grant is keyed to the binary's identity.
codesign --force --sign - --identifier dev.local.wellfit-tm "$APP" 2>/dev/null \
  || echo "warning: codesign failed; Bluetooth permission may re-prompt each build"

echo "built $APP"
