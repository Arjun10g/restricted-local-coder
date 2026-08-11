# Enterprise deployment paths

## Path A — approved internal mirror

This is the preferred connected route.

1. On a staging segment allowed to reach ModelScope, acquire the exact file listed in `extension/models/manifest.json`.
2. Verify its SHA-256 before promotion.
3. Publish the immutable object under an approved internal **HTTPS directory or reverse proxy** whose final path is `<base>/<manifest fileName>`. Nexus, Artifactory, an authenticated object gateway, or an S3-backed HTTPS proxy all work.
4. Configure managed VS Code settings:

```json
{
  "localCoder.modelMirrorBaseUrl": "https://approved.example/models/local-coder/",
  "localCoder.network.allowPublicModelDownload": false,
  "localCoder.runtime.contextSize": 8192,
  "localCoder.runtime.promptCacheMiB": 512,
  "localCoder.inlineCompletions.enabled": false,
  "localCoder.context.maxCharacters": 48000
}
```

The extension appends the manifest file name to the base URL. A service that emits a different presigned URL for every object is not a base-directory interface; use a stable reverse proxy or maintain an organization-specific manifest with approved full URLs.

SHA-256 verification is mandatory in the extension and has no user setting that disables it.

## Path B — offline bundle

On a connected, governed staging machine:

```powershell
.\scripts\New-OfflineBundle.ps1 `
  -VsixPath .\restricted-local-coder-0.4.1-win32-x64.vsix `
  -ModelPath .\muse-glimmer-30B-kquant-17gb.gguf `
  -OutputDirectory .\offline-local-coder `
  -CreateZip
```

The script verifies the model, copies the VSIX and model, and writes a bundle manifest containing both SHA-256 values. Transfer the bundle through the approved channel, install the VSIX, and run **Local Coder: Import Existing GGUF Model**. The extension performs its own mandatory verification again before first load.

## Path C — direct ModelScope

Keep `localCoder.network.allowPublicModelDownload` enabled and run **Local Coder: Download or Repair Model**. Only the HTTPS URLs checked into the allow-list are used; redirects are rechecked and Hugging Face hosts remain blocked.

This path may fail behind corporate TLS interception, URL categorization, or large-file controls. The internal mirror and offline routes remove that runtime dependency.

## Path D — split parts on GitHub releases

Use this when the workstation may reach `github.com` but not ModelScope, and no
internal mirror exists. Everything the workstation needs then comes from one
GitHub repository: source, the platform VSIX, and the weights.

The weight file cannot be committed. Git rejects blobs over 100 MB, Git LFS caps
a file at 2 GB and bills storage and bandwidth, and a release asset is also
capped at 2 GB. An 10.9 GB GGUF therefore has to be published as parts.

On the governed staging machine that can reach the model source:

```powershell
.\scripts\Publish-ModelParts.ps1 `
  -ModelPath .\muse-glimmer-30B-kquant-17gb.gguf `
  -Repository <owner>/<repo> `
  -Tag model-iq2m-v1
```

The script refuses to publish unless the whole-file SHA-256 already matches
`acceptedSha256` for the profile, splits the file into `.part-NNN` assets below
the release limit, uploads them to an immutable tag, and prints a `parts` block:

```json
"parts": {
  "baseUrls": ["https://github.com/<owner>/<repo>/releases/download/model-iq2m-v1/"],
  "files": [
    { "name": "muse-glimmer-30B-kquant-17gb.gguf.part-001", "bytes": 1900000000, "sha256": "…" }
  ]
}
```

Paste it into the profile in `extension/models/manifest.json`, run
`npm run validate`, and rebuild the VSIX. `tools/check-manifest.js` then enforces
part naming, unique digests, the 2 GB asset ceiling, and that the parts sum to
the declared model size.

On the workstation, **Local Coder: Download or Repair Model** takes the parted
route automatically whenever the selected profile declares `parts`:

- parts stream directly into the destination file in order, so peak disk is one
  model plus the part in flight rather than two copies;
- each part is verified against its own SHA-256 as it lands, so one bad part is
  re-fetched alone and is repaired in place without discarding later parts;
- an interrupted acquisition resumes mid-part with an HTTP `Range` request;
- a part that 404s or fails verification fails over to the next approved base
  URL, so a mirror can be listed alongside the release;
- the assembled file is then checked against the same whole-file SHA-256 the
  single-file path uses, and quarantined rather than installed if it disagrees.

Setting `localCoder.modelMirrorBaseUrl` adds that mirror ahead of the release
URL for parts too, so Path A and Path D compose.

## VS Code extension delivery

The native runtime is packaged into the VSIX, making the release platform-specific. Publish each approved artifact to an internal extension gallery or distribute the file through software deployment. The intended laptop uses the `win32-x64` artifact.

The target user does not need administrator rights, Git, CMake, a compiler, Python, Node/npm, Docker, Ollama, or another model manager. The extension is self-contained except for the separately governed GGUF weight file.

## Build and release governance

Treat the extension, native runtime, and model as three governed components:

1. Build from the immutable commit in `vendor/llama.cpp.lock.json`.
2. Retain the workflow-produced VSIX SHA-256 sidecar.
3. Scan the VSIX and extracted native binary with normal endpoint and software-composition controls.
4. Run `scripts/Invoke-SmokeTest.ps1` against the exact model/runtime pair.
5. Run `scripts/Invoke-ModelBenchmark.ps1` plus organization-specific coding tasks.
6. Compare quality, first-token latency, total latency, and peak working set against the currently approved pair.
7. Promote the VSIX and model independently and keep the prior versions for rollback.
8. Never update an approved model digest merely because a publisher replaced a file under the same name.

## Recommended policy boundary

- Public model download disabled after internal mirroring.
- 8K context initially, then 16K only after memory measurement.
- 512 MiB prompt cache or zero where prompt retention is undesirable.
- Inline completion disabled during the pilot to avoid continuous CPU load.
- No unmanaged `runtimePath` override in centrally governed deployments.
- No generated-code execution or automatic file edits outside explicit VS Code editor commands.

## GitHub service compatibility

The checked-in workflows target **GitHub.com or GitHub Enterprise Cloud** and pin current official actions to full commits. Some GitHub Enterprise Server releases do not support the modern artifact service/actions used by the release job. In that case, keep the source validation and native build logic but replace action references with organization-approved GHES mirrors/versions, or run `scripts/Build-Runtime.ps1` and `scripts/Package-Vsix.ps1` on an approved Windows build worker. Do not downgrade action versions blindly; preserve full-commit pinning and the SHA-256 release step.
