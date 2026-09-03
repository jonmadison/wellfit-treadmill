#!/bin/bash
# Builds an optimized bundle and installs it to /Applications.
set -euo pipefail

cd "$(dirname "$0")"
DEST="${1:-/Applications}"

./bundle.sh release build

pkill -f "WELLFIT TM.app" 2>/dev/null || true
rm -rf "$DEST/WELLFIT TM.app"
cp -R "build/WELLFIT TM.app" "$DEST/"

echo
echo "Installed to $DEST/WELLFIT TM.app"
echo "Launch it from Spotlight or: open \"$DEST/WELLFIT TM.app\""
echo "Grant Bluetooth access on first run when macOS asks."
