#!/usr/bin/env bash
#
# Stage approved model weights onto a GitHub release from a disposable machine.
#
# Intended for a throwaway cloud VM so that no large file, and no long transfer,
# ever touches a workstation or laptop. The machine needs enough disk for the
# model plus its parts, outbound access to the model source, and a GitHub token
# that can write releases on the target repository.
#
# It refuses to publish anything whose SHA-256 is not already approved in
# extension/models/manifest.json.
#
#   ./scripts/stage-model.sh --repo <owner>/<repo> --tag model-iq2m-v1
#
set -euo pipefail

PROFILE_ID=""
REPO=""
TAG=""
WORKDIR="${TMPDIR:-/tmp}/local-coder-staging"
PART_SIZE=1900000000
KEEP=false

usage() {
  cat >&2 <<USAGE
Usage: $0 --repo <owner>/<repo> --tag <release-tag> [options]

  --repo <owner>/<repo>   Repository that will hold the release assets (required)
  --tag <tag>             Immutable release tag for these weights (required)
  --profile <id>          Manifest profile id (default: manifest defaultProfile)
  --workdir <path>        Scratch directory (default: ${WORKDIR})
  --part-size <bytes>     Bytes per part (default: ${PART_SIZE}, must stay under 2 GB)
  --keep                  Keep the downloaded model and parts on exit
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?}"; shift 2 ;;
    --tag) TAG="${2:?}"; shift 2 ;;
    --profile) PROFILE_ID="${2:?}"; shift 2 ;;
    --workdir) WORKDIR="${2:?}"; shift 2 ;;
    --part-size) PART_SIZE="${2:?}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$REPO" ] || usage
[ -n "$TAG" ] || usage

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/extension/models/manifest.json"
[ -f "$MANIFEST" ] || { echo "Manifest not found at $MANIFEST" >&2; exit 1; }

for tool in node curl gh; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool not found: $tool" >&2; exit 1; }
done

read -r PROFILE_ID FILE_NAME EXPECTED_SHA SIZE_GIB DOWNLOAD_URL <<EOF
$(node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const id = process.argv[2] || manifest.defaultProfile;
const profile = manifest.models.find((m) => m.id === id);
if (!profile) { console.error("Unknown profile: " + id); process.exit(1); }
const url = (profile.downloadUrls || [])[0];
if (!url) { console.error("Profile has no download URL: " + id); process.exit(1); }
process.stdout.write([profile.id, profile.fileName, profile.acceptedSha256[0], profile.approximateSizeGiB, url].join(" "));
' "$MANIFEST" "$PROFILE_ID")
EOF

# A failure inside the command substitution above cannot trip `set -e`, so the
# result is checked explicitly rather than continuing with empty values.
if [ -z "${FILE_NAME:-}" ] || [ -z "${EXPECTED_SHA:-}" ] || [ -z "${DOWNLOAD_URL:-}" ]; then
  echo "Could not read a usable profile from $MANIFEST" >&2
  exit 1
fi

echo "Profile      : $PROFILE_ID"
echo "File         : $FILE_NAME (~${SIZE_GIB} GiB)"
echo "Approved hash: $EXPECTED_SHA"
echo "Destination  : $REPO @ $TAG"

mkdir -p "$WORKDIR"
MODEL="$WORKDIR/$FILE_NAME"
PARTS_DIR="$WORKDIR/parts"

# The model and its parts coexist on disk during the split.
NEEDED_KB=$(node -p "Math.ceil(($SIZE_GIB * 2 + 5) * 1024 * 1024)")
AVAIL_KB=$(df -Pk "$WORKDIR" | awk 'NR==2 {print $4}')
if [ "$AVAIL_KB" -lt "$NEEDED_KB" ]; then
  echo "Not enough free space in $WORKDIR." >&2
  echo "  need about $((NEEDED_KB / 1024 / 1024)) GiB, have $((AVAIL_KB / 1024 / 1024)) GiB" >&2
  echo "  attach a larger disk or pass --workdir on a bigger volume" >&2
  exit 1
fi

echo
echo "==> Downloading (resumable)"
curl -fL --retry 5 --retry-delay 5 -C - -o "$MODEL" "$DOWNLOAD_URL"

echo
echo "==> Verifying SHA-256 before anything is published"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$MODEL" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$MODEL" | awk '{print $1}')"
fi
if [ "$ACTUAL" != "$EXPECTED_SHA" ]; then
  echo "SHA-256 MISMATCH — refusing to publish." >&2
  echo "  expected $EXPECTED_SHA" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi
echo "matches the approved digest"

echo
echo "==> Splitting into release-sized parts"
BASE_URL="https://github.com/$REPO/releases/download/$TAG/"
rm -rf "$PARTS_DIR"
node "$ROOT/tools/split-model.js" \
  --input "$MODEL" \
  --output "$PARTS_DIR" \
  --profile "$PROFILE_ID" \
  --part-size "$PART_SIZE" \
  --base-url "$BASE_URL"

echo
echo "==> Publishing to $REPO"
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$REPO" --title "$TAG" \
    --notes "Approved weights for profile $PROFILE_ID. Verify SHA-256 against extension/models/manifest.json before use."
fi

# Upload then delete each part, so peak disk stays at model plus one part
# rather than model plus every part.
for part in "$PARTS_DIR"/*.part-*; do
  echo "uploading $(basename "$part")"
  gh release upload "$TAG" "$part" --repo "$REPO" --clobber
  $KEEP || rm -f "$part"
done

echo
echo "==> Manifest block — paste into profile $PROFILE_ID in extension/models/manifest.json"
echo
cat "$PARTS_DIR/parts.json"
echo
echo "Then run: npm run validate && git commit && git push, and tag a VSIX build."

if ! $KEEP; then
  rm -f "$MODEL"
  echo
  echo "Removed the local copy of the weights. Pass --keep to retain them."
fi
