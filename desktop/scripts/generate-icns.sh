#!/usr/bin/env bash
# Generate macOS .icns icon from icon.png
# Requires: sips (built into macOS), iconutil (built into macOS)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS_DIR="$(dirname "$SCRIPT_DIR")/assets"
SOURCE="$ASSETS_DIR/icon.png"
ICONSET="$ASSETS_DIR/icon.iconset"
OUTPUT="$ASSETS_DIR/icon.icns"

if [ ! -f "$SOURCE" ]; then
  echo "Error: $SOURCE not found" >&2
  exit 1
fi

echo "Generating icon.icns from icon.png..."

mkdir -p "$ICONSET"

# Generate all required icon sizes
sips -z 16 16     "$SOURCE" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32     "$SOURCE" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32     "$SOURCE" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64     "$SOURCE" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128   "$SOURCE" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256   "$SOURCE" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SOURCE" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512   "$SOURCE" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SOURCE" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SOURCE" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET" -o "$OUTPUT"
rm -rf "$ICONSET"

echo "Generated: $OUTPUT"
