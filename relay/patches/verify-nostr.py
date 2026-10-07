#!/usr/bin/env python3
"""Reconstruct the pinned partial module and compare it with the vendored tree."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="directory of the downloaded upstream module")
    args = parser.parse_args()
    patch_dir = Path(__file__).resolve().parent
    vendor = patch_dir.parent / "third_party" / "nostr"
    manifest = json.loads((vendor / "SOURCE.json").read_text())
    with tempfile.TemporaryDirectory(prefix="holoboard-nostr-verify-") as temporary:
        rebuilt = Path(temporary)
        for relative, expected in manifest["files"].items():
            source = args.source / relative
            actual = hashlib.sha256(source.read_bytes()).hexdigest()
            if actual != expected:
                raise SystemExit(f"Upstream checksum mismatch: {relative}")
            target = rebuilt / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        with (patch_dir / "nostr-holoboard.patch").open() as patch:
            result = subprocess.run(
                ["patch", "-p1", "--batch", "--forward"], cwd=rebuilt,
                stdin=patch, capture_output=True, text=True,
            )
        if result.returncode:
            raise SystemExit(result.stdout + result.stderr)
        ignored = {"WHY.md", "SOURCE.json"}
        expected_files = {
            str(path.relative_to(vendor))
            for path in vendor.rglob("*") if path.is_file() and path.name not in ignored
        }
        actual_files = {str(path.relative_to(rebuilt)) for path in rebuilt.rglob("*") if path.is_file()}
        if expected_files != actual_files:
            raise SystemExit(f"Snapshot file-set mismatch: {sorted(expected_files ^ actual_files)}")
        for relative in sorted(expected_files):
            if (rebuilt / relative).read_bytes() != (vendor / relative).read_bytes():
                raise SystemExit(f"Snapshot content mismatch: {relative}")
    print(f"Verified {manifest['revision']}: {len(expected_files)} retained files")


if __name__ == "__main__":
    main()
