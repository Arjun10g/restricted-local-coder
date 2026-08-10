#!/usr/bin/env python3
"""Repackage official llama.cpp release binaries into extension/runtime/<key>.

The project previously compiled llama.cpp from source, which took roughly forty
minutes per platform and produced binaries nobody ever hashed. Upstream now
publishes tagged builds for every platform this project targets, so the runtime
is fetched instead, and every archive is checked against the SHA-256 recorded in
vendor/llama.cpp.lock.json before a single byte is unpacked.

  python3 tools/fetch-runtime.py --key darwin-arm64 --verify

Archive shapes differ between platforms and both are handled: Windows zips are
flat, while the macOS and Linux tarballs nest their payload under llama-<tag>/
and are the only ones carrying LICENSE.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import zipfile

RELEASE_URL = "https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{name}"
LICENSE_URL = "https://raw.githubusercontent.com/ggml-org/llama.cpp/{commit}/LICENSE"
CHUNK = 1024 * 1024


def executable_name(key: str) -> str:
    return "llama-server.exe" if key.startswith("win32") else "llama-server"


def is_runtime_library(name: str) -> bool:
    lowered = name.lower()
    return lowered.endswith(".dll") or lowered.endswith(".dylib") or ".so" in lowered


def wanted_library(name: str) -> bool:
    """Keep the libraries the server loads, not every tool in the archive.

    The archives carry one `-impl` library per command line tool. Only the
    server's is needed; the rest are a third of the payload. Everything else is
    kept, because the server links more of the ggml backends than is obvious --
    dropping ggml-rpc, for instance, makes it fail to load.
    """
    base = pathlib.PurePosixPath(name).name.lower()
    if not is_runtime_library(base):
        return False
    if "-impl" in base and "server-impl" not in base:
        return False
    return any(base.startswith(prefix) or prefix in base
               for prefix in ("ggml", "llama", "mtmd", "cudart", "cublas"))


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, target: pathlib.Path, attempts: int = 4) -> None:
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "restricted-local-coder/fetch-runtime"})
            with urllib.request.urlopen(request) as response, target.open("wb") as out:
                shutil.copyfileobj(response, out, CHUNK)
            return
        except (urllib.error.URLError, OSError) as error:  # noqa: PERF203 - retry loop
            last = error
            target.unlink(missing_ok=True)
            print(f"    attempt {attempt} failed: {error}", file=sys.stderr)
    raise RuntimeError(f"Could not download {url}: {last}")


def extract_members(archive: pathlib.Path, staging: pathlib.Path) -> None:
    """Flatten an archive into staging, keeping only basenames."""
    staging.mkdir(parents=True, exist_ok=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                if member.is_dir():
                    continue
                base = pathlib.PurePosixPath(member.filename).name
                if not base:
                    continue
                with bundle.open(member) as source, (staging / base).open("wb") as out:
                    shutil.copyfileobj(source, out, CHUNK)
        return

    # The macOS and Linux tarballs ship versioned libraries plus symlinks, and
    # the loader asks for the symlink names. Flattening drops links, so they are
    # dereferenced into real copies instead, following chains such as
    # libggml.dylib -> libggml.0.dylib -> libggml.0.19.0.dylib.
    links: dict[str, str] = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            base = pathlib.PurePosixPath(member.name).name
            if not base:
                continue
            if member.issym() or member.islnk():
                links[base] = pathlib.PurePosixPath(member.linkname).name
                continue
            if not member.isfile():
                continue
            extracted = bundle.extractfile(member)
            if extracted is None:
                continue
            with extracted, (staging / base).open("wb") as out:
                shutil.copyfileobj(extracted, out, CHUNK)

    for link, target in links.items():
        resolved, seen = target, {link}
        while resolved in links and resolved not in seen:
            seen.add(resolved)
            resolved = links[resolved]
        source = staging / resolved
        if source.is_file() and not (staging / link).exists():
            shutil.copy2(source, staging / link)


def main() -> int:
    root = pathlib.Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True, help="runtime key, e.g. win32-x64 or darwin-arm64")
    parser.add_argument("--lock", default=str(root / "vendor" / "llama.cpp.lock.json"))
    parser.add_argument("--destination", default=None, help="defaults to extension/runtime/<key>")
    parser.add_argument("--cache-dir", default=None, help="reuse downloaded archives from here")
    parser.add_argument("--verify", action="store_true", help="run llama-server --version afterwards")
    args = parser.parse_args()

    lock = json.loads(pathlib.Path(args.lock).read_text(encoding="utf-8"))
    if lock.get("schemaVersion") != 2:
        raise SystemExit("Unsupported lock schema; expected schemaVersion 2")

    entry = (lock.get("assets") or {}).get(args.key)
    if not entry:
        available = ", ".join(sorted((lock.get("assets") or {}).keys()))
        raise SystemExit(f"No assets recorded for runtime key '{args.key}'. Available: {available}")

    tag = lock["tag"]
    destination = pathlib.Path(args.destination) if args.destination else root / "extension" / "runtime" / args.key
    cache = pathlib.Path(args.cache_dir) if args.cache_dir else pathlib.Path(tempfile.mkdtemp(prefix="llama-runtime-"))
    cache.mkdir(parents=True, exist_ok=True)

    staging = pathlib.Path(tempfile.mkdtemp(prefix="llama-staging-"))
    try:
        for asset in entry["files"]:
            name, expected, size = asset["name"], asset["sha256"].lower(), asset["sizeBytes"]
            archive = cache / name
            if archive.exists() and archive.stat().st_size == size and sha256_file(archive) == expected:
                print(f"  {name}: reusing verified copy from cache")
            else:
                url = RELEASE_URL.format(tag=tag, name=name)
                print(f"  {name}: downloading {size:,} bytes")
                download(url, archive)

            actual_size = archive.stat().st_size
            if actual_size != size:
                raise SystemExit(f"{name} is {actual_size} bytes; the lock records {size}")
            actual = sha256_file(archive)
            if actual != expected:
                raise SystemExit(f"{name} SHA-256 mismatch.\n  expected {expected}\n  actual   {actual}")
            print(f"  {name}: SHA-256 verified")

            # Only unpack once the digest is known good.
            extract_members(archive, staging)

        server = staging / executable_name(args.key)
        if not server.is_file():
            raise SystemExit(f"{server.name} was not present in the verified archives")

        if destination.exists():
            for item in destination.iterdir():
                if item.name != "README.md":
                    shutil.rmtree(item) if item.is_dir() else item.unlink()
        destination.mkdir(parents=True, exist_ok=True)

        copied = 0
        target_server = destination / server.name
        shutil.copy2(server, target_server)
        copied += 1
        if os.name != "nt":
            target_server.chmod(target_server.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        for item in sorted(staging.iterdir()):
            if item.is_file() and wanted_library(item.name):
                shutil.copy2(item, destination / item.name)
                copied += 1

        # Windows archives omit LICENSE, so take it from the pinned commit.
        license_target = destination / "LLAMA_CPP_LICENSE.txt"
        staged_license = staging / "LICENSE"
        if staged_license.is_file():
            shutil.copy2(staged_license, license_target)
        else:
            print("  LICENSE absent from the archive; fetching it from the pinned commit")
            download(LICENSE_URL.format(commit=lock["commit"]), license_target)
        copied += 1

        total = sum(f.stat().st_size for f in destination.iterdir() if f.is_file())
        print(f"\n{args.key}: {copied} files, {total:,} bytes -> {destination}")

        if args.verify:
            environment = os.environ.copy()
            if args.key.startswith("linux"):
                environment["LD_LIBRARY_PATH"] = str(destination)
            elif args.key.startswith("darwin"):
                environment["DYLD_LIBRARY_PATH"] = str(destination)
            result = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [str(target_server), "--version"],
                env=environment, capture_output=True, text=True, timeout=120,
            )
            output = (result.stdout + result.stderr).strip().splitlines()
            print("verify: " + (output[0] if output else "(no output)"))
            if result.returncode != 0:
                raise SystemExit(f"llama-server --version exited {result.returncode}")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        if args.cache_dir is None:
            shutil.rmtree(cache, ignore_errors=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
