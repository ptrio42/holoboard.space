#!/usr/bin/env python3
"""Prepare the pinned, isolated Keycast build without deploying or migrating."""
import argparse
import pathlib
import json
from urllib.parse import urlparse
import subprocess

REVISION = "fe9c6460c89e82e22c3aab4ba1dc79b7f0dd54c0"
ROOT = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=pathlib.Path, default=ROOT.parent / "output/keycast/source")
parser.add_argument("--app-origin", required=True, help="Exact Holoboard origin allowed to revoke app sessions")
args = parser.parse_args()
origin = urlparse(args.app_origin)
if not origin.hostname or origin.path not in ("", "/") or origin.query or origin.fragment or origin.username or origin.password or origin.scheme not in ("http", "https") or (origin.scheme == "http" and origin.hostname not in ("localhost", "127.0.0.1", "::1")):
    raise SystemExit("Use an exact HTTPS origin (HTTP only for loopback).")
source = args.source.resolve()
if not source.exists():
    subprocess.run(["git", "clone", "https://github.com/divinevideo/keycast.git", str(source)], check=True)
dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True)
if dirty:
    raise SystemExit("Source checkout has tracked changes; use a fresh destination.")
head = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
if head != REVISION:
    subprocess.run(["git", "-C", str(source), "checkout", "--detach", REVISION], check=True)
template = (ROOT / "holoboard-session.html").read_text()
(source / "web/static/holoboard-session.html").write_text(template.replace('const allowedOrigins = ["http://127.0.0.1:4173"];', "const allowedOrigins = " + json.dumps([args.app_origin.rstrip("/")]) + ";"))
print(f"Prepared Keycast {REVISION}; no services started.")
