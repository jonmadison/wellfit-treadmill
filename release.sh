#!/bin/bash
# Builds a release bundle and packages it as a DMG for distribution.
#
# Usage: ./release.sh [version]
#        ./release.sh 0.1.0
#
# Version defaults to the one in src-tauri/tauri.conf.json.
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:-$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)}"
APP="WELLFIT TM.app"
OUT="dist"
DMG="$OUT/WELLFIT-TM-$VERSION.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

./bundle.sh release build

mkdir -p "$OUT"
rm -f "$DMG"

# ditto rather than cp: it preserves the code signature and resource forks.
ditto "build/$APP" "$STAGE/$APP"
ln -s /Applications "$STAGE/Applications"

hdiutil create \
  -volname "WELLFIT TM" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG" >/dev/null

SIZE=$(du -h "$DMG" | cut -f1)
ARCH=$(lipo -archs "build/$APP/Contents/MacOS/wellfit-tm")

cat <<EOF

Built $DMG ($SIZE, $ARCH)

To publish:
  git tag -a v$VERSION -m "v$VERSION"
  git push origin v$VERSION

Then open
  https://github.com/jonmadison/wellfit-treadmill/releases/new?tag=v$VERSION
and attach $DMG.

Recipients: drag the app to Applications. Because the bundle is ad-hoc signed,
macOS quarantines it after download — the first launch needs right-click > Open,
or:
  xattr -dr com.apple.quarantine "/Applications/WELLFIT TM.app"
EOF
