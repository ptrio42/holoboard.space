#!/usr/bin/env python3
"""Plan or execute sequential local Holoboard checks. Requires Python 3.10+."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time

PROFILES = ("frontend", "readers", "payments", "publication", "backend")
FLAGS = ("VITE_ENABLE_DISCUSSIONS", "VITE_ENABLE_PROFILES",
         "VITE_ENABLE_NOSTR_CONNECT", "VITE_ENABLE_REPLY_PUBLICATION")
OFF = dict.fromkeys(FLAGS, "false")
READERS = OFF | dict.fromkeys(FLAGS[:2], "true")
ENABLED = dict.fromkeys(FLAGS, "true")
MOCK = {"VITE_RELAY_URL": "ws://127.0.0.1:3334",
        "VITE_API_URL": "http://127.0.0.1:3334",
        "VITE_PUBLIC_RELAYS": "ws://127.0.0.1:3334",
        "VITE_SATS_ENDPOINT": "http://127.0.0.1:3334/api/board"}
# Preserve tool locations and caches, excluding application/wallet credentials.
TOOL_ENV = ("PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP",
            "LANG", "LC_ALL", "SHELL", "GOCACHE", "GOMODCACHE", "GOPATH",
            "GOTOOLCHAIN", "GOPROXY", "GOSUMDB", "GOPRIVATE", "GONOSUMDB")


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def snapshot(repo):
    """Hash source and index state without recording file contents or secrets."""
    paths = git(repo, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    result = {}
    for relative in set(os.fsdecode(paths).split("\0")) - {""}:
        path = repo / relative
        if path.is_symlink():
            value = os.fsencode(os.readlink(path))
        elif path.is_file():
            value = path.read_bytes()
        else:
            value = b"<missing>"
        result[relative] = hashlib.sha256(value).hexdigest()
    result["<HEAD>"] = git(repo, "rev-parse", "HEAD").decode().strip()
    result["<index>"] = hashlib.sha256(git(repo, "diff", "--cached", "--binary")).hexdigest()
    result["<status>"] = hashlib.sha256(git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")).hexdigest()
    return result


def changed_paths(repo, base):
    values = git(repo, "diff", "--name-only", "-z", "HEAD")
    if base:
        values += git(repo, "diff", "--name-only", "-z", f"{base}...HEAD")
    values += git(repo, "ls-files", "--others", "--exclude-standard", "-z")
    return sorted(set(os.fsdecode(values).split("\0")) - {""})


def environment(overrides):
    return {key: os.environ[key] for key in TOOL_ENV if key in os.environ} | overrides


def available_port(requested=None):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", requested or 0))
        return listener.getsockname()[1]


def make_plan(repo, output, profiles, changed, legacy=None, rollback=None, upstream=None):
    steps = []

    def add(name, command, cwd="web", env=None, browser=False):
        steps.append({"name": name, "command": command, "cwd": cwd,
                      "env": env or {}, "browser": browser, "status": "planned"})

    def build(name, flags):
        add(f"build-{name}", ["npm", "run", "build", "--", "--outDir",
                             str(output / "builds" / name), "--emptyOutDir"], env=MOCK | flags)

    def browser(name, files, flags, extra=None, env=None):
        add(name, ["npm", "run", "test:e2e", "--", *files, "--workers=1",
                   "--reporter=line,json", f"--output={output / name / 'artifacts'}", *(extra or [])],
            env=MOCK | flags | (env or {}), browser=True)

    frontend = bool(set(profiles) - {"backend"}) or legacy or rollback
    if frontend:
        lint = [p[4:] for p in changed if p.startswith("web/")
                and p.endswith((".ts", ".tsx")) and (repo / p).is_file()]
        if lint:
            add("lint-changed", ["npm", "exec", "--no", "--", "eslint", *lint])
        add("unit", ["npm", "test", "--", "--maxWorkers=2"], env=MOCK | OFF)
        build("default", OFF)
        browser("default-browser", ["tests/discussions.spec.ts", "tests/profiles.spec.ts",
                "tests/replyPublication.spec.ts", "tests/payments.spec.ts"], OFF,
                ["--grep", "entry points|dedicated routes|anonymous split invoices"])
    if "readers" in profiles or rollback:
        build("readers", READERS)
    if "readers" in profiles:
        browser("readers-browser", ["tests/discussions.spec.ts", "tests/profiles.spec.ts",
                "tests/readingPointers.spec.ts", "tests/notes.spec.ts", "tests/socketBudget.spec.ts"], READERS)
    if {"payments", "publication"} & set(profiles):
        build("enabled", ENABLED)
    if "payments" in profiles:
        browser("payments-browser", ["tests/payments.spec.ts", "tests/wallet.spec.ts",
                "tests/updates.spec.ts"], ENABLED)
    if "publication" in profiles:
        browser("publication-mocks", ["tests/replyPublication.spec.ts", "tests/publicOutbox.spec.ts"], ENABLED)
    if "backend" in profiles:
        toolchain = next((line.split()[1] for line in (repo / "relay/go.mod").read_text().splitlines()
                          if line.startswith("toolchain ")), "auto")
        add("go-race", ["go", "test", "-race", "-p", "1", "-count=1", "-timeout=8m",
                        "./...", "fiatjaf.com/nostr/..."], "relay",
            {"GOMAXPROCS": "2", "GOTOOLCHAIN": toolchain})
        if upstream:
            add("nostr-provenance", [sys.executable, "relay/patches/verify-nostr.py", str(upstream)], ".")
    if legacy:
        browser("pwa-invoice-update", ["tests/pwa.spec.ts"], OFF,
                ["--grep", "previous frontend works"],
                {"HOLOBOARD_LEGACY_DIST": str(legacy), "HOLOBOARD_CURRENT_DIST": str(output / "builds/default")})
    if rollback:
        browser("pwa-reader-rollback", ["tests/pwa.spec.ts"], OFF,
                ["--grep", "read-only PWA"],
                {"HOLOBOARD_ROLLBACK_DIST": str(rollback), "HOLOBOARD_READER_DIST": str(output / "builds/readers")})
    return steps


def run_command(command, cwd, env, log):
    with log.open("w") as stream:
        process = subprocess.Popen(command, cwd=cwd, env=environment(env),
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait()
        except KeyboardInterrupt:
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise


def execute(repo, output, report, guards, port=None, runner=run_command):
    def save():
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    report["status"] = "running"
    save()
    for step in report["steps"]:
        started = time.monotonic()
        try:
            if step["browser"]:
                step["env"] |= {"CI": "1", "HOLOBOARD_TEST_PORT": str(available_port(port)),
                                "PLAYWRIGHT_JSON_OUTPUT_FILE": str(output / (step["name"] + ".json"))}
            print("Running " + step["name"], flush=True)
            log = output / (step["name"] + ".log")
            code = runner(step["command"], repo / step["cwd"], step["env"], log)
            step.update(returncode=code, log=log.name, status="passed" if code == 0 else "failed")
            if step["browser"] and code == 0:
                result = json.loads((output / (step["name"] + ".json")).read_text())
                stats = result.get("stats") if isinstance(result, dict) else None
                if not isinstance(stats, dict) or not isinstance(stats.get("expected"), int):
                    raise ValueError("Missing browser test counts")
                step["tests"] = stats
                if result.get("errors") or stats.get("unexpected", 0) or stats["expected"] < 1:
                    raise ValueError("Browser stage did not produce successful, nonempty acceptance evidence")
        except KeyboardInterrupt:
            step["status"] = "cancelled"
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            step.update(status="failed", error=str(error))
        try:
            preserved = all(snapshot(path) == before for path, before in guards.items())
            report["source_preserved"] = preserved
            if not preserved:
                step.update(status="failed", source_error="A protected source checkout changed; inspect it without reverting")
        except (OSError, subprocess.SubprocessError) as error:
            report["source_preserved"] = None
            step.update(status="failed", source_error="Could not verify source preservation: " + str(error))
        step["seconds"] = round(time.monotonic() - started, 2)
        save()
        if step["status"] != "passed":
            report["status"] = step["status"]
            for remaining in report["steps"]:
                if remaining["status"] == "planned":
                    remaining["status"] = "not-run"
            save()
            return 1
    report["status"] = "passed"
    save()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--profile", choices=PROFILES, action="append", required=True)
    parser.add_argument("--base", help="Comparison ref for committed changes; dirty work is always included")
    parser.add_argument("--run", action="store_true", help="Execute the plan; otherwise only save and print it")
    parser.add_argument("--out", type=Path, help="Fresh empty directory outside protected checkouts")
    parser.add_argument("--only", action="append", help="Execute only named stages; omitted stages are reported separately")
    parser.add_argument("--port", type=int, help="Require an unused loopback port; otherwise allocate one per browser stage")
    parser.add_argument("--protect-worktree", type=Path, action="append", default=[])
    for name in ("legacy-dist", "rollback-dist", "nostr-upstream"):
        parser.add_argument("--" + name, type=Path)
    args = parser.parse_args(argv)
    try:
        repo = Path(os.fsdecode(git(args.repo, "rev-parse", "--show-toplevel")).strip()).resolve()
        if not (repo / "web/package.json").is_file() or not (repo / "relay/go.mod").is_file():
            raise ValueError("Select the Holoboard source checkout")
        protected = {repo, *(path.resolve() for path in args.protect_worktree)}
        for name in ("legacy_dist", "rollback_dist", "nostr_upstream"):
            value = getattr(args, name)
            if value:
                value = value.resolve()
                if not value.is_dir() or name.endswith("dist") and not (value / "index.html").is_file():
                    raise ValueError(f"Invalid {name.replace('_', '-')} input")
                setattr(args, name, value)
        if args.nostr_upstream and "backend" not in args.profile:
            raise ValueError("Use --nostr-upstream with the backend profile")
        if args.port is not None and not 1024 <= args.port <= 65535:
            raise ValueError("Choose a port between 1024 and 65535")
        output = args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix="holoboard-verify-"))
        if any(output.is_relative_to(path) or path.is_relative_to(output) for path in protected):
            raise ValueError("Keep reports and build outputs outside source checkouts")
        if output.exists() and any(output.iterdir()):
            raise ValueError("Choose a fresh empty output directory")
        output.mkdir(parents=True, exist_ok=True)
        guards = {path: snapshot(path) for path in protected}
        changed = changed_paths(repo, args.base)
        steps = make_plan(repo, output, set(args.profile), changed, args.legacy_dist, args.rollback_dist, args.nostr_upstream)
        omitted = []
        if args.only:
            unknown = set(args.only) - {step["name"] for step in steps}
            if unknown:
                raise ValueError("Unknown selected stages: " + ", ".join(sorted(unknown)))
            omitted = [step["name"] for step in steps if step["name"] not in args.only]
            steps = [step for step in steps if step["name"] in args.only]
        report = {"scope": "local automated checks; not release approval", "status": "planned",
                  "revision": git(repo, "rev-parse", "HEAD").decode().strip(),
                  "base": args.base, "comparison": "base...HEAD plus dirty work" if args.base else "dirty work only",
                  "profiles": sorted(set(args.profile)), "changed_paths": changed, "steps": steps,
                  "omitted_stages": omitted, "source_preserved": True,
                  "inputs": {name: str(value) for name, value in {
                      "legacy_dist": args.legacy_dist, "rollback_dist": args.rollback_dist,
                      "nostr_upstream": args.nostr_upstream}.items() if value},
                  "not_performed": [name for name, selected in {
                      "legacy-invoice PWA update": args.legacy_dist,
                      "reader PWA update and code rollback": args.rollback_dist,
                      "retained-module provenance": args.nostr_upstream}.items() if not selected]}
        if "publication" in args.profile:
            report["limitations"] = ["Signers and public deliveries use fixtures; physical signers and independent public delivery are unverified"]
        if "backend" in args.profile:
            report.setdefault("limitations", []).append("Container behavior and real DM/payment/account-publication interoperability are unverified")
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("Report: " + str(output / "report.json"), flush=True)
        if not args.run:
            print(json.dumps(report, indent=2))
            return 0
        result = execute(repo, output, report, guards, args.port)
        print("Local checks: " + report["status"], flush=True)
        return result
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
