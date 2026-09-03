#!/bin/bash
# Rebuilds and launches the app for development.
#
# The frontend is embedded into the binary at compile time, so any change to
# ui/ needs this rerun — editing the files alone does nothing.
set -euo pipefail

cd "$(dirname "$0")"
pkill -f "build/WELLFIT TM.app" 2>/dev/null || true
./bundle.sh debug build
open "build/WELLFIT TM.app"
