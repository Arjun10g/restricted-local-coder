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
import struct
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

    This is a deny-list on purpose. An earlier version kept only names starting
    with ggml/llama/mtmd/cudart/cublas, which silently dropped
    libomp140.x86_64.dll -- the LLVM OpenMP runtime that every ggml-cpu backend
    imports. The result was a server that could not start at all on a machine
    without Visual Studio, while CI passed because its runners have LLVM
    installed.

    Guessing which libraries matter from their names does not work. The archive
    is upstream's own runtime payload, so everything in it is kept except the
    per-tool `-impl` libraries, which are genuinely one-per-command-line-tool and
    about a third of the download.
    """
    base = pathlib.PurePosixPath(name).name.lower()
    if not is_runtime_library(base):
        return False
    if "-impl" in base and "server-impl" not in base:
        return False
    return True


# DLLs that are part of Windows itself, so a workstation always has them. Any
# import outside this set has to be shipped beside the server.
WINDOWS_SYSTEM_DLL_PREFIXES = (
    "api-ms-win", "ext-ms-win", "kernel32", "kernelbase", "user32", "advapi32",
    "shell32", "ole32", "oleaut32", "ws2_32", "crypt32", "bcrypt", "ncrypt",
    "ntdll", "rpcrt4", "shlwapi", "psapi", "gdi32", "version", "winmm",
    "iphlpapi", "secur32", "userenv", "dbghelp", "powrprof", "setupapi",
    "cfgmgr32", "combase", "msvcrt.dll", "ucrtbase", "dxgi", "d3d12", "vulkan-1",
    "opengl32", "winhttp", "wininet", "imm32", "comdlg32", "comctl32",
)


def pe_imports(path: pathlib.Path) -> list:
    """Names of the DLLs a PE file imports, read straight from its import table.

    Running the binary is not a sufficient check: it proves only that the
    *build machine* could resolve every dependency, and CI runners carry
    developer tooling that a locked-down workstation does not.
    """
    data = path.read_bytes()
    if data[:2] != b"MZ":
        return []
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        return []
    section_count = struct.unpack_from("<H", data, pe + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    import_rva = struct.unpack_from("<I", data, directories + 8)[0]
    if import_rva == 0:
        return []

    sections = []
    table = pe + 24 + optional_size
    for index in range(section_count):
        entry = table + index * 40
        virtual_size, virtual_address, raw_size, raw_pointer = struct.unpack_from("<IIII", data, entry + 8)
        sections.append((virtual_address, max(virtual_size, raw_size), raw_pointer))

    def to_offset(rva: int):
        for virtual_address, size, raw_pointer in sections:
            if virtual_address <= rva < virtual_address + size:
                return raw_pointer + (rva - virtual_address)
        return None

    names = []
    cursor = to_offset(import_rva)
    if cursor is None:
        return []
    while True:
        descriptor = struct.unpack_from("<IIIII", data, cursor)
        if not any(descriptor):
            break
        name_offset = to_offset(descriptor[3])
        if name_offset is not None:
            end = data.index(b"\0", name_offset)
            names.append(data[name_offset:end].decode("ascii", "replace"))
        cursor += 20
    return names


# Copied in by the packaging workflow from the build agent's redistributable,
# because the upstream archive does not carry them. During a fetch they are
# legitimately absent; the strict pass after packaging is where they must exist.
MSVC_REDIST_DLLS = ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")


def verify_windows_dependencies(destination: pathlib.Path, strict: bool = True) -> None:
    """Fail if any shipped binary imports a DLL that will not be there."""
    present = {item.name.lower() for item in destination.iterdir() if item.is_file()}
    deferred = {}
    missing = {}
    for item in sorted(destination.iterdir()):
        if item.suffix.lower() not in (".exe", ".dll"):
            continue
        for dependency in pe_imports(item):
            lowered = dependency.lower()
            if lowered in present or lowered.startswith(WINDOWS_SYSTEM_DLL_PREFIXES):
                continue
            if not strict and lowered in MSVC_REDIST_DLLS:
                deferred.setdefault(lowered, []).append(item.name)
                continue
            missing.setdefault(lowered, []).append(item.name)

    if deferred:
        print("dependency check: still to be supplied by the packaging step: "
              + ", ".join(sorted(deferred)))

    if missing:
        report = "\n".join(
            f"  {name} - imported by {', '.join(users[:3])}{'...' if len(users) > 3 else ''}"
            for name, users in sorted(missing.items())
        )
        raise SystemExit(
            "These dependencies are neither bundled nor part of Windows, so the "
            f"server cannot start on a clean machine:\n{report}"
        )
    if deferred:
        print(f"dependency check: {len(present)} files checked; everything else resolves locally")
    else:
        print(f"dependency check: every import of {len(present)} files resolves locally")


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
    parser.add_argument(
        "--check-dependencies-only",
        action="store_true",
        help="do not download; strictly check that an assembled runtime directory has every DLL it imports",
    )
    args = parser.parse_args()

    # Run after the packaging step has added the MSVC redistributable, so the
    # directory being checked is exactly what ships.
    if args.check_dependencies_only:
        directory = pathlib.Path(args.destination) if args.destination else root / "extension" / "runtime" / args.key
        if not directory.is_dir():
            raise SystemExit(f"{directory} does not exist")
        if not args.key.startswith("win32"):
            print(f"{args.key}: import checking is Windows-only; nothing to do")
            return 0
        verify_windows_dependencies(directory, strict=True)
        return 0

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

        # Always runs, verify or not: it is a static check of what was just
        # assembled, and it is the only one that reflects the target machine
        # rather than the build machine.
        if args.key.startswith("win32"):
            verify_windows_dependencies(destination, strict=False)

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
