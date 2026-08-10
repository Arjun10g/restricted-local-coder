#!/usr/bin/env bash
#
# Deprecated. The runtime is no longer compiled here.
#
# Official llama.cpp release binaries are repackaged instead, pinned by tag and
# verified against the SHA-256 recorded for every asset in
# vendor/llama.cpp.lock.json. That is both faster and stronger: the binaries
# used to ship unhashed.
#
#   python3 tools/fetch-runtime.py --key darwin-arm64 --verify
#
# Building from source is still supported for governed rebuilds, but the flags
# live in one place now — the workflow_dispatch source-build path in
# .github/workflows/build-vsix.yml — rather than being duplicated here where
# they silently rotted. This script previously passed BUILD_SHARED_LIBS=OFF and
# LLAMA_BUILD_TOOLS=OFF, both of which make the build fail outright.
#
set -euo pipefail

cat >&2 <<'MESSAGE'
scripts/build-runtime.sh is deprecated and no longer builds anything.

Fetch the pinned, verified runtime instead:

  python3 tools/fetch-runtime.py --key <runtime-key> --verify

Runtime keys: win32-x64, win32-x64-cuda, darwin-arm64, linux-x64, linux-arm64.

To build from source for a governed rebuild, see docs/ENTERPRISE_DEPLOYMENT.md.
MESSAGE
exit 2
