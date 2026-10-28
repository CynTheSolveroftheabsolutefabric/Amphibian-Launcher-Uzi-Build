#!/usr/bin/env python3
"""Prepare framework resources for Cloudflare Pages' per-file size limit."""

import json
from pathlib import Path
import shutil
import sys


CHUNK_SIZE = 20 * 1024 * 1024
PAGES_LIMIT = 25 * 1024 * 1024
WORKER_LOADER = (
    'import { installWorkerResourceLoader } from "./split-resources.js";\n'
    'installWorkerResourceLoader();\n'
)


def split_resources(public):
    framework = public / "_framework"
    manifest_path = framework / "split-resources.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for resource in sorted(framework.iterdir()):
        if resource.suffix not in (".dll", ".wasm") or resource.stat().st_size <= CHUNK_SIZE:
            continue
        size = resource.stat().st_size
        parts = 0
        with resource.open("rb") as source:
            while chunk := source.read(CHUNK_SIZE):
                resource.with_name(resource.name + str(parts)).write_bytes(chunk)
                parts += 1
        manifest[resource.name] = {"size": size, "parts": parts}
        resource.unlink()
        print(f"Split {resource.name}: {parts} parts ({size} bytes)")

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(
        Path(__file__).parent / "frontend/src/dotnet/resources.js",
        framework / "split-resources.js",
    )
    for native in framework.glob("dotnet.native.*.js"):
        contents = native.read_text()
        if not contents.startswith(WORKER_LOADER):
            native.write_text(WORKER_LOADER + contents)

    oversized = [
        str(path.relative_to(public))
        for path in public.rglob("*")
        if path.is_file() and path.stat().st_size > PAGES_LIMIT
    ]
    if oversized:
        raise SystemExit("Assets exceed Cloudflare Pages' 25 MiB limit:\n" + "\n".join(oversized))


if __name__ == "__main__":
    split_resources(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("frontend/public"))
