#!/usr/bin/env bash
# macOS/Linux development startup script for AI Jarvis
# Equivalent to start-real.ps1 for Windows

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_SMOKE_TEST=false

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --skip-smoke-test) SKIP_SMOKE_TEST=true ;;
  esac
done

# Check Python
PYTHON=""
for candidate in python3.12 python3 python; do
  if command -v "$candidate" &>/dev/null; then
    version=$("$candidate" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')
    major=$(echo "$version" | cut -d. -f1)
    minor=$(echo "$version" | cut -d. -f2)
    if [ "$major" -ge 3 ] && [ "$minor" -ge 12 ]; then
      PYTHON="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  echo "错误：需要 Python 3.12 或更高版本" >&2
  exit 1
fi

# Create venv if needed
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "正在创建 Python 虚拟环境..."
  "$PYTHON" -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Install dependencies
echo "正在安装依赖..."
pip install -e "$SCRIPT_DIR[packaging]" --quiet

# Run smoke test unless skipped
if [ "$SKIP_SMOKE_TEST" = false ]; then
  echo "正在运行自检..."
  python -m jarvis_backend.packaged_launcher --self-test
fi

# Start the backend
echo "正在启动 AI Jarvis 后端..."
exec python -m jarvis_backend.packaged_launcher "$@"
