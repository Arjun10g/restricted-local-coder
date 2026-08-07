#!/usr/bin/env python3
"""Collect llama-server and every adjacent runtime library into a VSIX runtime folder."""

from __future__ import annotations

import argparse
import os
import pathlib
import shutil
import stat
import subprocess
import sys


def executable_name() -> str:
    return "llama-server.exe" if os.name == "nt" else "llama-server"


def score(path: pathlib.Path) -> tuple[int, int]:
    text = str(path).lower().replace("\\", "/")
    points = 0
    if "/release/" in text:
        points += 20
    if "/bin/" in text:
        points += 10
    if "/debug/" in text:
        points -= 20
    return points, -len(path.parts)


def is_runtime_library(path: pathlib.Path) -> bool:
    name = path.name.lower()
    return name.endswith(".dll") or name.endswith(".dylib") or ".so" in name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-dir", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--source-dir")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    build = pathlib.Path(args.build_dir).resolve()
    destination = pathlib.Path(args.destination).resolve()
    candidates = [p for p in build.rglob(executable_name()) if p.is_file()]
    if not candidates:
        raise FileNotFoundError(f"Could not locate {executable_name()} below {build}")
    server = sorted(candidates, key=score, reverse=True)[0]
    bin_dir = server.parent

    if destination.exists():
        for item in destination.iterdir():
            if item.name != "README.md":
                if item.is_dir():
                    shutil.rmtree(item)
                else:
                    item.unlink()
    destination.mkdir(parents=True, exist_ok=True)

    copied: list[pathlib.Path] = []
    target_server = destination / executable_name()
    shutil.copy2(server, target_server)
    copied.append(target_server)
    if os.name != "nt":
        target_server.chmod(target_server.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    library_candidates: set[pathlib.Path] = set()
    for directory in {bin_dir, build / "bin", build / "bin" / "Release"}:
        if directory.exists():
            library_candidates.update(p for p in directory.iterdir() if p.is_file() and is_runtime_library(p))
    # Newer llama.cpp builds can place CPU implementation libraries one level away.
    library_candidates.update(p for p in build.rglob("*") if p.is_file() and is_runtime_library(p) and ("ggml" in p.name.lower() or "llama" in p.name.lower()))

    chosen_libraries: dict[str, pathlib.Path] = {}
    for library in library_candidates:
        current = chosen_libraries.get(library.name.lower())
        if current is None or score(library) > score(current):
            chosen_libraries[library.name.lower()] = library

    for library in sorted(chosen_libraries.values(), key=lambda p: p.name.lower()):
        target = destination / library.name
        shutil.copy2(library, target)
        copied.append(target)

    if args.source_dir:
        source = pathlib.Path(args.source_dir).resolve()
        license_file = source / "LICENSE"
        if license_file.exists():
            target = destination / "LLAMA_CPP_LICENSE.txt"
            shutil.copy2(license_file, target)
            copied.append(target)

    print(f"Collected runtime from {server}")
    for item in copied:
        print(f"  {item.name} ({item.stat().st_size} bytes)")

    if args.verify:
        environment = os.environ.copy()
        if os.name != "nt":
            variable = "DYLD_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"
            environment[variable] = str(destination) + os.pathsep + environment.get(variable, "")
        completed = subprocess.run([str(target_server), "--version"], cwd=destination, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        print(completed.stdout)
        if completed.returncode != 0:
            raise RuntimeError(f"Collected llama-server exited with {completed.returncode}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"collect-runtime failed: {exc}", file=sys.stderr)
        raise
