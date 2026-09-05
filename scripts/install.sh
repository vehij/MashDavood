#!/usr/bin/env bash
# Build, sign, install MashDavood into /Applications and make it the default .md app.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run dist
codesign --force --deep --sign - release/mac-arm64/MashDavood.app
rm -rf /Applications/MashDavood.app
cp -R release/mac-arm64/MashDavood.app /Applications/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/MashDavood.app

# default handler for markdown files (asks LaunchServices, may prompt on first run)
TMP=$(mktemp -d)
swiftc -O -o "$TMP/setdefault" scripts/set-default-md-app.swift
"$TMP/setdefault"
rm -rf "$TMP"

# install the Estedad font for the rest of the system too (optional)
mkdir -p ~/Library/Fonts && cp -f assets/fonts/Estedad-VF.ttf ~/Library/Fonts/

echo "MashDavood installed."
