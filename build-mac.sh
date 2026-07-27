#!/usr/bin/env bash
# Build AI Jarvis for macOS with Metal acceleration
# Usage: ./build-mac.sh [--stub]
#   --stub: Build with stub runtime (no model inference, for testing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build/native-macos"
STUB_MODE=false

for arg in "$@"; do
  case "$arg" in
    --stub) STUB_MODE=true ;;
  esac
done

echo "=== Building AI Jarvis for macOS ==="
echo ""

# Create build directory
mkdir -p "$BUILD_DIR"

# Configure
echo "[1/3] Configuring CMake..."
CMAKE_ARGS=(
  -S "$SCRIPT_DIR"
  -B "$BUILD_DIR"
  -DCMAKE_BUILD_TYPE=Release
)

if [ "$STUB_MODE" = true ]; then
  echo "  Mode: Stub runtime (no model inference)"
  CMAKE_ARGS+=(-DJARVIS_ENABLE_STUB_RUNTIME=ON)
else
  echo "  Mode: Full runtime with Metal acceleration"
  CMAKE_ARGS+=(
    -DGGML_METAL=ON
    -DGGML_CUDA=OFF
    -DJARVIS_RUNTIME_ENABLE_UPSTREAM=ON
  )
fi

cmake "${CMAKE_ARGS[@]}"

# Build
echo ""
echo "[2/3] Building..."
cmake --build "$BUILD_DIR" --config Release --parallel

# Copy to desktop runtime directory
echo ""
echo "[3/3] Preparing runtime..."
RUNTIME_DIR="$SCRIPT_DIR/desktop/build/runtime"
mkdir -p "$RUNTIME_DIR"

cp "$BUILD_DIR/native/jarvis-native-worker" "$RUNTIME_DIR/"
chmod +x "$RUNTIME_DIR/jarvis-native-worker"

if [ -f "$BUILD_DIR/default_ref_audio.wav" ]; then
  cp "$BUILD_DIR/default_ref_audio.wav" "$RUNTIME_DIR/"
fi

echo ""
echo "=== Build Complete ==="
echo "Binary: $RUNTIME_DIR/jarvis-native-worker"
echo ""
echo "To build the full DMG installer, run:"
echo "  cd desktop && npm run build:mac"
