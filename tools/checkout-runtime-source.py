#!/usr/bin/env python3
"""Checkout the exact llama.cpp commit recorded in vendor/llama.cpp.lock.json."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys


def run(*args: str, cwd: pathlib.Path | None = None) -> str:
    completed = subprocess.run(args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if completed.stdout:
        print(completed.stdout, end="")
    return completed.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", default="vendor/llama.cpp.lock.json")
    parser.add_argument("--destination", default="third_party/llama.cpp")
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parents[1]
    lock_path = (root / args.lock).resolve()
    destination = (root / args.destination).resolve()
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    repository = lock["repository"]
    commit = lock["commit"]
    tag = lock.get("tag", "")
    if repository != "https://github.com/ggml-org/llama.cpp.git":
        raise ValueError(f"Unexpected runtime repository: {repository}")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Runtime lock commit must be a full lowercase 40-character Git SHA")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", tag):
        raise ValueError("Runtime lock tag contains unsupported characters")

    if args.clean and destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if not (destination / ".git").exists():
        run("git", "init", str(destination))
        run("git", "remote", "add", "origin", repository, cwd=destination)
    else:
        remotes = run("git", "remote", cwd=destination).splitlines()
        if "origin" not in remotes:
            run("git", "remote", "add", "origin", repository, cwd=destination)
        else:
            run("git", "remote", "set-url", "origin", repository, cwd=destination)

    remote_tag = f"refs/tags/{tag}"
    local_tag = f"refs/tags/{tag}"
    run("git", "fetch", "--depth", "1", "origin", f"{remote_tag}:{local_tag}", cwd=destination)
    run("git", "checkout", "--detach", "--force", local_tag, cwd=destination)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=destination, text=True).strip()
    if actual != commit:
        raise RuntimeError(f"Runtime source mismatch: expected {commit}, got {actual}")
    print(f"Checked out llama.cpp {lock.get('tag', '')} at {actual}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"Command failed with exit code {exc.returncode}", file=sys.stderr)
        if exc.stdout:
            print(exc.stdout, file=sys.stderr, end="" if exc.stdout.endswith("\n") else "\n")
        raise
