#!/usr/bin/env python3
"""Verify the actual Android artifact before allowing Zapstore publication."""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

sys.dont_write_bytecode = True
ANDROID = Path(__file__).resolve().parents[1]
ROOT = ANDROID.parent


def pixels(image):
    image = image.convert("RGBA")
    return image.size, hashlib.sha256(image.tobytes()).hexdigest()


def verify(apk, unsigned=False):
    from PIL import Image

    manifest = json.loads((ANDROID / "twa-manifest.json").read_text())
    gradle = (ANDROID / "app/build.gradle").read_text()
    version = manifest["appVersionName"]
    code = manifest["appVersionCode"]
    if not re.search(rf'versionCode\s+{code}\b', gradle) or not re.search(rf'versionName\s+"{re.escape(version)}"', gradle):
        raise ValueError("Android manifest and Gradle versions differ")
    if manifest.get("appVersion") != version:
        raise ValueError("Android appVersion is out of sync")
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise ValueError("Set ANDROID_HOME to the Android SDK")
    tools = Path(sdk) / "build-tools/36.1.0"
    badging = subprocess.check_output([str(tools / "aapt2"), "dump", "badging", str(apk)], text=True)
    package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    if not package or package.groups() != (manifest["packageId"], str(code), version):
        raise ValueError(f"Stale or wrong APK: expected {manifest['packageId']} {version} ({code})")
    subprocess.run([str(tools / "zipalign"), "-c", "-P", "16", "4", str(apk)], check=True, capture_output=True)
    expected_fingerprint = manifest["fingerprints"][0]["value"].replace(":", "").lower()
    assetlinks = json.loads((ROOT / "web/public/.well-known/assetlinks.json").read_text())
    if not any(entry.get("target", {}).get("package_name") == manifest["packageId"] and
               expected_fingerprint in [value.replace(":", "").lower() for value in entry["target"].get("sha256_cert_fingerprints", [])]
               for entry in assetlinks):
        raise ValueError("APK signing identity and website assetlinks differ")
    fingerprint = None
    if not unsigned:
        signed = subprocess.run([str(tools / "apksigner"), "verify", "--print-certs", str(apk)], capture_output=True, text=True)
        if signed.returncode:
            raise ValueError("APK signature verification failed; sign the current APK first")
        found = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)", signed.stdout, re.I)
        fingerprint = found[0].lower() if len(found) == 1 else None
        if fingerprint != expected_fingerprint:
            raise ValueError("The APK was signed with a different Android release key")
    spec = importlib.util.spec_from_file_location("brand_assets", ROOT / "web/scripts/brand-assets.py")
    brand = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(brand)
    mark = ET.parse(ROOT / "web/src/assets/holoboard-mark.svg").getroot()
    sources = []
    resources = ANDROID / "app/src/main/res"
    for pattern, fraction, transparent in [("mipmap-*/ic_launcher.png", .625, False),
                                            ("mipmap-*/ic_maskable.png", .546875, False),
                                            ("drawable-*/splash.png", .875, True)]:
        for path in sorted(resources.glob(pattern)):
            with Image.open(path) as image:
                actual = pixels(image)
                if actual != pixels(brand.render(mark, image.width, fraction, transparent)):
                    raise ValueError(f"Regenerate stale brand asset: {path.relative_to(ROOT)}")
            sources.append((path, actual))
    if len(sources) != 15:
        raise ValueError("Expected launcher, maskable and splash assets for all five densities")
    packaged = set()
    with zipfile.ZipFile(apk) as archive:
        if archive.testzip() is not None:
            raise ValueError("APK archive is corrupt")
        for name in archive.namelist():
            if name.startswith("res/") and name.endswith(".png"):
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    packaged.add(pixels(image))
    for path, identity in sources:
        if identity not in packaged:
            raise ValueError(f"APK lacks current icon/splash: {path.relative_to(ROOT)}")
    with Image.open(ANDROID / "store_icon.png") as image:
        if pixels(image) != pixels(brand.render(mark, 512)):
            raise ValueError("Regenerate the Zapstore icon")
    notes = f"./android/store/release-notes-{version}.md"
    config = (ROOT / "zapstore.yaml").read_text()
    if f"release_notes: {notes}" not in config or not (ROOT / notes).is_file():
        raise ValueError("Zapstore release notes do not match the APK version")
    if "release_source: ./android/app-release-signed.apk" not in config:
        raise ValueError("Review the changed Zapstore APK source before publishing")
    return {"package": manifest["packageId"], "version": version, "version_code": code,
            "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(), "signature_checked": not unsigned,
            "certificate_sha256": fingerprint, "current_packaged_brand_assets": len(sources),
            "permissions": sorted(re.findall(r"^uses-permission: name='([^']+)'", badging, re.M))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unsigned", action="store_true", help="Inspect a build artifact without approving it for publication")
    parser.add_argument("--apk", type=Path)
    args = parser.parse_args()
    apk = args.apk or ANDROID / ("app-release-unsigned-aligned.apk" if args.unsigned else "app-release-signed.apk")
    try:
        print(json.dumps(verify(apk, args.unsigned), indent=2))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"Android release check failed: {error}", file=sys.stderr)
        raise SystemExit(1)
