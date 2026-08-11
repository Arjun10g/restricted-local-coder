#!/usr/bin/env bash
# Runs the integration suite inside a real VS Code extension host.
#
# No npm packages: @vscode/test-electron exists to download an editor and build
# this command line, and an editor is already installed. The repo ships zero
# dependencies and that is worth more than the convenience.
#
# Usage: tools/run-integration-tests.sh [path-to-VS Code.app]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve the editor executable. macOS keeps it inside the bundle under a name
# that varies by build; Linux ships a plain binary. VSCODE_BINARY overrides both,
# which is how CI points at a downloaded build.
if [ -n "${VSCODE_BINARY:-}" ]; then
  binary="$VSCODE_BINARY"
elif [ "$(uname -s)" = "Darwin" ]; then
  app="${1:-/Applications/Visual Studio Code.app}"
  binary=""
  for candidate in "Code" "Code - Insiders" "Electron" "VSCodium"; do
    if [ -x "$app/Contents/MacOS/$candidate" ]; then
      binary="$app/Contents/MacOS/$candidate"
      break
    fi
  done
  if [ -z "$binary" ]; then
    echo "No VS Code executable inside $app" >&2
    echo "Looked for: Code, Code - Insiders, Electron, VSCodium" >&2
    exit 1
  fi
else
  binary="${1:-$(command -v code || true)}"
fi

if [ ! -x "$binary" ]; then
  echo "No VS Code executable found." >&2
  echo "Set VSCODE_BINARY, or pass the path as the first argument." >&2
  exit 1
fi

# A scratch workspace and a scratch user profile, so the run cannot touch the
# developer's real settings, extensions or window state.
workspace="$(mktemp -d)"
profile="$(mktemp -d)"
trap 'rm -rf "$workspace" "$profile"' EXIT

echo "Extension host: $binary"
echo "Workspace:      $workspace"

# A terminal inside VS Code inherits the extension host's environment, and two of
# those variables break this badly and confusingly:
#
#   ELECTRON_RUN_AS_NODE=1 makes the executable behave as plain Node, so every
#   flag below comes back as "bad option" from Node's parser rather than doing
#   anything -- the failure looks like the flags are wrong.
#
#   VSCODE_IPC_HOOK points at the already-running editor, so the launch is
#   handed to that instance instead of starting a test host. Nothing fails; the
#   tests simply never run, and the exit code is 0.
#
# The second is the dangerous one, because a silent pass is worse than an error.
unset ELECTRON_RUN_AS_NODE VSCODE_IPC_HOOK VSCODE_PID VSCODE_CWD \
      VSCODE_NLS_CONFIG VSCODE_ESM_ENTRYPOINT VSCODE_CODE_CACHE_PATH \
      VSCODE_HANDLES_UNCAUGHT_ERRORS VSCODE_CRASH_REPORTER_PROCESS_TYPE

# A hard wall-clock limit. An extension host that fails to reach run() waits for
# a window that will never be closed, and the failure mode is an editor process
# left behind rather than a red test. Bounded here so a hang is a failure.
limit_seconds="${INTEGRATION_TIMEOUT:-180}"

# --disable-extensions isolates the run to this extension; without it a third
# party extension can hold a document open and change what undo applies to.
"$binary" \
  --extensionDevelopmentPath="$root/extension" \
  --extensionTestsPath="$root/extension/test-integration/index.js" \
  --user-data-dir="$profile" \
  --extensions-dir="$profile/extensions" \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-release-notes \
  --skip-welcome \
  --disable-gpu \
  ${VSCODE_EXTRA_ARGS:-} \
  "$workspace" &
host=$!

( sleep "$limit_seconds"; kill -9 "$host" 2>/dev/null ) 2>/dev/null &
watchdog=$!

set +e
wait "$host"
status=$?
set -e
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true

if [ "$status" -ne 0 ]; then
  echo "Extension host exited $status (killed at ${limit_seconds}s if it hung)." >&2
  exit "$status"
fi
