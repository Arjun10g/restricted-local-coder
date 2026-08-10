#!/usr/bin/env bash
#
# Stage approved model weights into a Cloud Storage bucket from a disposable VM.
#
# An object store has no per-file size limit, so the weights are published as the
# single file named in the manifest and the extension's existing mirror path
# serves them. Nothing is split, no manifest change is needed, and no VSIX has to
# be rebuilt: localCoder.modelMirrorBaseUrl is a workstation setting, while the
# file name and approved digest already ship inside the extension.
#
# Run on a throwaway VM so no large transfer touches a laptop. Needs python3,
# curl and gcloud, and write access to the bucket.
#
#   ./scripts/stage-model-gcs.sh --bucket my-bucket
#
set -euo pipefail

BUCKET=""
PROFILE_ID=""
WORKDIR="${TMPDIR:-/tmp}/local-coder-staging"
KEEP=false

usage() {
  cat >&2 <<USAGE
Usage: $0 --bucket <name> [options]

  --bucket <name>     Destination Cloud Storage bucket, without gs:// (required)
  --profile <id>      Manifest profile id (default: manifest defaultProfile)
  --workdir <path>    Scratch directory (default: ${WORKDIR})
  --keep              Keep the downloaded weights on exit
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bucket) BUCKET="${2:?}"; shift 2 ;;
    --profile) PROFILE_ID="${2:?}"; shift 2 ;;
    --workdir) WORKDIR="${2:?}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$BUCKET" ] || usage
BUCKET="${BUCKET#gs://}"
BUCKET="${BUCKET%/}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/extension/models/manifest.json"
[ -f "$MANIFEST" ] || { echo "Manifest not found at $MANIFEST" >&2; exit 1; }

for tool in python3 curl gcloud; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool not found: $tool" >&2; exit 1; }
done

read -r PROFILE_ID FILE_NAME EXPECTED_SHA SIZE_GIB DOWNLOAD_URL <<EOF
$(python3 - "$MANIFEST" "${PROFILE_ID}" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
wanted = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else manifest["defaultProfile"]
profile = next((m for m in manifest["models"] if m["id"] == wanted), None)
if profile is None:
    sys.exit("Unknown profile: %s" % wanted)
urls = profile.get("downloadUrls") or []
if not urls:
    sys.exit("Profile has no download URL: %s" % wanted)
print(profile["id"], profile["fileName"], profile["acceptedSha256"][0],
      profile["approximateSizeGiB"], urls[0])
PY
)
EOF

if [ -z "${FILE_NAME:-}" ] || [ -z "${EXPECTED_SHA:-}" ] || [ -z "${DOWNLOAD_URL:-}" ]; then
  echo "Could not read a usable profile from $MANIFEST" >&2
  exit 1
fi

echo "Profile      : $PROFILE_ID"
echo "File         : $FILE_NAME (~${SIZE_GIB} GiB)"
echo "Approved hash: $EXPECTED_SHA"
echo "Destination  : gs://$BUCKET/$FILE_NAME"

mkdir -p "$WORKDIR"
MODEL="$WORKDIR/$FILE_NAME"

# Only one copy is held locally, since the file is uploaded as-is.
NEEDED_KB=$(python3 -c "import math,sys; print(math.ceil((float(sys.argv[1]) + 3) * 1024 * 1024))" "$SIZE_GIB")
AVAIL_KB=$(df -Pk "$WORKDIR" | awk 'NR==2 {print $4}')
if [ "$AVAIL_KB" -lt "$NEEDED_KB" ]; then
  echo "Not enough free space in $WORKDIR." >&2
  echo "  need about $((NEEDED_KB / 1024 / 1024)) GiB, have $((AVAIL_KB / 1024 / 1024)) GiB" >&2
  exit 1
fi

echo
echo "==> Downloading (resumable)"
curl -fL --retry 5 --retry-delay 5 -C - -o "$MODEL" "$DOWNLOAD_URL"

echo
echo "==> Verifying SHA-256 before anything is published"
ACTUAL="$(sha256sum "$MODEL" | awk '{print $1}')"
if [ "$ACTUAL" != "$EXPECTED_SHA" ]; then
  echo "SHA-256 MISMATCH — refusing to publish." >&2
  echo "  expected $EXPECTED_SHA" >&2
  echo "  actual   $ACTUAL" >&2
  exit 1
fi
echo "matches the approved digest"

echo
echo "==> Uploading to gs://$BUCKET/$FILE_NAME"
gcloud storage cp "$MODEL" "gs://$BUCKET/$FILE_NAME"

echo
echo "==> Confirming the published object is reachable and complete"
PUBLIC_URL="https://storage.googleapis.com/$BUCKET/$FILE_NAME"
REMOTE_BYTES="$(curl -sSIL "$PUBLIC_URL" | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {v=$2} END{gsub(/\r/,"",v); print v}')"
LOCAL_BYTES="$(stat -c %s "$MODEL" 2>/dev/null || stat -f %z "$MODEL")"
if [ "$REMOTE_BYTES" != "$LOCAL_BYTES" ]; then
  echo "Published object is $REMOTE_BYTES bytes but the local file is $LOCAL_BYTES." >&2
  echo "Re-run the upload before pointing any workstation at it." >&2
  exit 1
fi
echo "published $REMOTE_BYTES bytes, matching the verified local file"

cat <<SUMMARY

==> Done. On the workstation, add to VS Code settings:

  "localCoder.modelMirrorBaseUrl": "https://storage.googleapis.com/$BUCKET/",
  "localCoder.network.allowPublicModelDownload": false

then run: Local Coder: Download or Repair Model

The extension appends the manifest file name to that base URL and verifies the
SHA-256 itself, so no manifest change and no new VSIX are required.
SUMMARY

if ! $KEEP; then
  rm -f "$MODEL"
  echo
  echo "Removed the local copy of the weights. Pass --keep to retain them."
fi
