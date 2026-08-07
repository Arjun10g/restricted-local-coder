#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/build/llama}"
SOURCE_DIR="${SOURCE_DIR:-$ROOT/third_party/llama.cpp}"
CONFIGURATION="${CONFIGURATION:-Release}"
CLEAN="${CLEAN:-0}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) RUNTIME_KEY="linux-x64" ;;
  Linux-aarch64|Linux-arm64) RUNTIME_KEY="linux-arm64" ;;
  Darwin-arm64) RUNTIME_KEY="darwin-arm64" ;;
  Darwin-x86_64) RUNTIME_KEY="darwin-x64" ;;
  *) echo "Unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

if [[ "$CLEAN" == "1" ]]; then
  rm -rf "$BUILD_DIR" "$SOURCE_DIR"
fi

python3 "$ROOT/tools/checkout-runtime-source.py" --destination "${SOURCE_DIR#$ROOT/}"

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE="$CONFIGURATION" \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_BUILD_TOOLS=OFF \
  -DLLAMA_BUILD_APP=OFF \
  -DLLAMA_BUILD_UI=OFF \
  -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_BACKEND_DL=ON \
  -DGGML_CPU_ALL_VARIANTS=ON \
  -DGGML_CPU_KLEIDIAI=OFF

JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
cmake --build "$BUILD_DIR" --config "$CONFIGURATION" --target llama-server -j "$JOBS"

python3 "$ROOT/tools/collect-runtime.py" \
  --build-dir "$BUILD_DIR" \
  --destination "$ROOT/extension/runtime/$RUNTIME_KEY" \
  --source-dir "$SOURCE_DIR" \
  --verify

echo "Runtime ready in extension/runtime/$RUNTIME_KEY"
