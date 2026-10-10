"""Regression checks for evidence reporting and source preservation. Run with -B."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("verify_change", Path(__file__).with_name("verify_change.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="holoboard-runner-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        (self.repo / "web").mkdir(parents=True)
        (self.repo / "relay").mkdir()
        (self.repo / "web/package.json").write_text("{}\n")
        (self.repo / "relay/go.mod").write_text("module fixture\ngo 1.26.0\ntoolchain go1.27.1\n")
        self.source = self.repo / "web/source.ts"
        self.source.write_text("export const value = 1\n")
        for args in (("init", "-q"), ("add", "."),
                     ("-c", "user.name=ptrio42", "-c", "user.email=ptrio42@users.noreply.github.com",
                      "commit", "-qm", "Fixture")):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)
        self.out = self.root / "output"
        self.out.mkdir()
        self.guards = {self.repo: verify.snapshot(self.repo)}

    def execute(self, runner, browser=False):
        self.report = {"steps": [
            {"name": name, "command": ["fixture"], "cwd": ".", "env": {},
             "browser": browser if name == "first" else False, "status": "planned"}
            for name in ("first", "later")], "source_preserved": True}
        with contextlib.redirect_stdout(io.StringIO()):
            result = verify.execute(self.repo, self.out, self.report, self.guards, runner=runner)
        saved = json.loads((self.out / "report.json").read_text())
        self.assertEqual(saved, self.report)
        return result

    def test_command_failure_stops_and_keeps_report(self):
        calls = []
        def runner(*args):
            calls.append(args)
            return 7
        self.assertEqual(self.execute(runner), 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.report["status"], "failed")
        self.assertEqual(self.report["steps"][1]["status"], "not-run")
        self.assertTrue(self.report["source_preserved"])

    def test_changed_source_is_preserved_even_when_process_fails(self):
        def runner(*args):
            self.source.write_text("concurrent work\n")
            return 1
        self.assertEqual(self.execute(runner), 1)
        self.assertFalse(self.report["source_preserved"])
        self.assertEqual(self.source.read_text(), "concurrent work\n")

    def test_empty_or_missing_browser_evidence_cannot_pass(self):
        for evidence in (None, {}, {"stats": {"expected": 0, "skipped": 12}},
                         {"stats": {"expected": 2, "unexpected": 1}}):
            with self.subTest(evidence=evidence):
                def runner(command, cwd, env, log):
                    path = Path(env["PLAYWRIGHT_JSON_OUTPUT_FILE"])
                    path.unlink(missing_ok=True)
                    if evidence is not None:
                        path.write_text(json.dumps(evidence))
                    return 0
                self.assertEqual(self.execute(runner, browser=True), 1)
                self.assertEqual(self.report["status"], "failed")

    def test_browser_pass_retains_skips_and_uses_fresh_server(self):
        def runner(command, cwd, env, log):
            if "PLAYWRIGHT_JSON_OUTPUT_FILE" in env:
                self.assertEqual(env["CI"], "1")
                self.assertGreater(int(env["HOLOBOARD_TEST_PORT"]), 0)
                Path(env["PLAYWRIGHT_JSON_OUTPUT_FILE"]).write_text(json.dumps({
                    "stats": {"expected": 3, "unexpected": 0, "skipped": 1}, "errors": []}))
            return 0
        self.assertEqual(self.execute(runner, browser=True), 0)
        self.assertEqual(self.report["steps"][0]["tests"]["skipped"], 1)

    def test_cancellation_stops_remaining_checks(self):
        def runner(*args):
            raise KeyboardInterrupt
        self.assertEqual(self.execute(runner), 1)
        self.assertEqual(self.report["status"], "cancelled")
        self.assertEqual(self.report["steps"][1]["status"], "not-run")

    def test_occupied_port_is_rejected(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            with self.assertRaises(OSError):
                verify.available_port(listener.getsockname()[1])

    def test_real_command_has_no_inherited_application_credentials(self):
        script = "import os,sys; print(os.environ.get('NWC_URL', 'absent')); sys.exit(6)"
        log = self.out / "process.log"
        with patch.dict(os.environ, {"NWC_URL": "private-fixture", "VITE_API_URL": "wrong"}):
            code = verify.run_command([sys.executable, "-c", script], self.repo, {}, log)
        self.assertEqual(code, 6)
        self.assertEqual(log.read_text().strip(), "absent")

    def test_plan_is_read_only_and_selected_checks_are_not_full_acceptance(self):
        (self.repo / "draft.txt").write_text("existing draft")
        before = verify.snapshot(self.repo)
        with contextlib.redirect_stdout(io.StringIO()):
            code = verify.main(["--repo", str(self.repo), "--out", str(self.out),
                                "--profile", "frontend", "--only", "default-browser"])
        self.assertEqual(code, 0)
        report = json.loads((self.out / "report.json").read_text())
        self.assertEqual(report["status"], "planned")
        self.assertIn("unit", report["omitted_stages"])
        self.assertIn("draft.txt", report["changed_paths"])
        self.assertEqual(verify.snapshot(self.repo), before)

    def test_output_cannot_modify_a_protected_checkout(self):
        with contextlib.redirect_stderr(io.StringIO()):
            code = verify.main(["--repo", str(self.repo), "--out", str(self.repo / "reports"),
                                "--profile", "frontend"])
        self.assertEqual(code, 2)
        self.assertFalse((self.repo / "reports").exists())

    def test_enabled_rollback_uses_enabled_artifact_only_for_enabled_profiles(self):
        for profiles, expected in (({"readers"}, False), ({"publication"}, True), ({"payments"}, True)):
            plan = verify.make_plan(self.repo, self.out, profiles, [], rollback=self.root / "baseline")
            enabled = [step for step in plan if step["name"] == "pwa-enabled-rollback"]
            self.assertEqual(bool(enabled), expected)
            if expected:
                self.assertEqual(enabled[0]["env"]["HOLOBOARD_ENABLED_DIST"], str(self.out / "builds/enabled"))
                self.assertEqual(enabled[0]["env"]["VITE_ENABLE_NOSTR_CONNECT"], "false")


if __name__ == "__main__":
    unittest.main()
