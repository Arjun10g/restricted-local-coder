# Staging the model through Cloud Storage — copy and paste

Publishing 10.9 GB of weights without any large transfer touching a laptop, and
without rebuilding the extension.

Every command is literal. Values used throughout:

| | |
|---|---|
| GCP project | `dazzling-howl-491904-s0` |
| Zone | `us-east1-d` |
| Bucket | `restricted-local-coder-dazzling-howl-491904` |
| VM name | `local-coder-staging` |
| Model file | `Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf` |
| Approved SHA-256 | `0a860d0a6876b4c2f8b903aef62eeb020f34c83ae64a1d8e65687c9af0c1d1f5` |

An object store has no per-file size limit, so the weights are published as one
file and the extension's existing mirror path serves them. **No manifest change
and no new VSIX are needed**, because `localCoder.modelMirrorBaseUrl` is a
workstation setting while the file name and approved digest already ship inside
the extension.

---

## Step 1 — Prove the bucket is reachable before spending anything

Run this **on the restricted workstation**. It is the only step that gates the
rest, because a network that denies `storage.googleapis.com` makes the whole
approach useless.

```powershell
Invoke-WebRequest -Uri "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/probe.txt" -UseBasicParsing | Select-Object -ExpandProperty Content
```

| Result | Meaning |
|---|---|
| `reachability-probe-ok` | Proceed |
| Timeout, refused, or a block page | Stop — use a GitHub release instead, see [ENTERPRISE_DEPLOYMENT.md](ENTERPRISE_DEPLOYMENT.md) |

---

## Step 2 — Create the staging VM

Run on any machine with `gcloud` authenticated. A 64 GB disk leaves ample room
for one copy of the weights.

```bash
gcloud compute instances create local-coder-staging \
  --project=dazzling-howl-491904-s0 \
  --zone=us-east1-d \
  --machine-type=e2-standard-2 \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=64GB \
  --boot-disk-type=pd-balanced \
  --scopes=https://www.googleapis.com/auth/devstorage.read_write
```

Connect to it:

```bash
gcloud compute ssh local-coder-staging --project=dazzling-howl-491904-s0 --zone=us-east1-d
```

---

## Step 3 — Stage the model, on the VM

Everything below runs inside the SSH session. `gcloud` is preinstalled on the
Debian image.

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq git python3 curl
git clone https://github.com/Arjun10g/restricted-local-coder.git
cd restricted-local-coder
./scripts/stage-model-gcs.sh --bucket restricted-local-coder-dazzling-howl-491904
```

The script refuses to publish anything whose digest is not already approved. It
downloads resumably, verifies the SHA-256 **before** uploading, uploads, then
confirms the published object's length matches the verified local file. Expect
it to take a while; the download and upload are each about 11 GB.

If the SSH session drops mid-transfer, reconnect and rerun the same command —
the download resumes rather than starting over.

Leave the VM with:

```bash
exit
```

---

## Step 4 — Delete the VM

Do this as soon as staging succeeds. The bucket keeps the weights; the VM has no
further purpose and bills while it exists.

```bash
gcloud compute instances delete local-coder-staging \
  --project=dazzling-howl-491904-s0 \
  --zone=us-east1-d \
  --quiet
```

Confirm nothing is left running:

```bash
gcloud compute instances list --project=dazzling-howl-491904-s0
```

---

## Step 5 — Point the workstation at the bucket

No reinstall. In VS Code, `Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)`
and add:

```json
{
  "localCoder.modelProfile": "qwen3-coder-30b-a3b-iq2m",
  "localCoder.modelMirrorBaseUrl": "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/",
  "localCoder.network.allowPublicModelDownload": false,
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.runtime.autoStart": false,
  "localCoder.inlineCompletions.enabled": false
}
```

The trailing slash matters — the extension appends the manifest file name to
this base. Setting `allowPublicModelDownload` to `false` stops it falling back
to ModelScope, which the workstation cannot reach anyway.

Optional sanity check that the object is visible from the workstation before
starting an 11 GB download:

```powershell
(Invoke-WebRequest -Uri "https://storage.googleapis.com/restricted-local-coder-dazzling-howl-491904/Qwen3-Coder-30B-A3B-Instruct-1M-UD-IQ2_M.gguf" -Method Head -UseBasicParsing).Headers["Content-Length"]
```

Expect roughly `11703785882`.

---

## Step 6 — Download and run

`Ctrl+Shift+P`, in order:

1. **Local Coder: Run Preflight** — confirm the machine is still READY TO PROCEED
2. **Local Coder: Download or Repair Model** — about 11 GB, resumable, and the
   SHA-256 is verified on completion
3. **Local Coder: Run Preflight** — *Model file* should now be PASS
4. **Local Coder: Start Local Runtime** — first load is slow while the weights
   page in
5. **Local Coder: Open Chat**

The weights land in `%LOCALAPPDATA%\RestrictedLocalCoder\models\`.

---

## Step 7 — Clean up the bucket

Once the workstation holds a verified copy, the bucket is no longer needed. It
is publicly readable, so anyone with the URL can pull 10.9 GB and the egress
bills to the project.

```bash
gcloud storage rm "gs://restricted-local-coder-dazzling-howl-491904/**" --project=dazzling-howl-491904-s0
gcloud storage buckets delete gs://restricted-local-coder-dazzling-howl-491904 --project=dazzling-howl-491904-s0
```

Keep it only if other machines still need to pull the model.

---

## Costs

Approximate, and dominated by egress rather than compute:

| Item | Rough cost |
|---|---|
| `e2-standard-2` for two or three hours | ~$0.20 |
| 64 GB balanced disk, prorated | a few cents |
| Ingress from ModelScope to the VM | free |
| Storage of 10.9 GB, briefly | ~$0.05 |
| Egress, VM to bucket, same region | free |
| **Egress, bucket to the workstation** | **~$1.30 per download** |

Deleting the VM promptly matters more than the machine type. Each workstation
that downloads the model incurs the egress charge again.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Probe times out on the workstation | `storage.googleapis.com` denied | Use a GitHub release instead |
| `AccessDeniedException` on upload | VM lacks the storage scope | Recreate the VM with `--scopes=...devstorage.read_write` |
| `SHA-256 MISMATCH` | Wrong or corrupted source file | The script refuses to publish; rerun, the download resumes |
| `Not enough free space` | Disk smaller than the model plus headroom | Recreate the VM with `--boot-disk-size=64GB` |
| "No model source is enabled" in VS Code | Setting missing, or no trailing slash | Recheck `modelMirrorBaseUrl` in Step 5 |
| Download starts then fails verification | Truncated upload | Rerun Step 3; it confirms the published length |
| Quota error creating the VM | Region quota | Try another zone, for example `us-central1-a` |

The extension verifies the SHA-256 itself before first load and cannot be
configured to skip it, so a bad copy is rejected rather than used.
