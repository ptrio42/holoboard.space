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
        (self.repo / "web/production-features.json").write_text(json.dumps(verify.ENABLED | {"VITE_ENABLE_POST_CREATION": "true"}))
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

    def test_pages_build_is_opt_in_and_uses_mock_urls_with_disabled_ordinary_flags(self):
        default = verify.make_plan(self.repo, self.out, {"frontend"}, [])
        self.assertNotIn("build-pages-production", [step["name"] for step in default])
        before = verify.snapshot(self.repo)
        plan = verify.make_plan(self.repo, self.out, {"frontend"}, [], pages_production=True)
        stage = next(step for step in plan if step["name"] == "build-pages-production")
        for key, value in verify.OFF.items():
            self.assertEqual(stage["env"][key], value)
        for key, value in verify.MOCK.items():
            self.assertEqual(stage["env"][key], value)
        self.assertEqual(stage["env"]["CF_PAGES"], "1")
        self.assertEqual(stage["env"]["CF_PAGES_BRANCH"], "main")
        self.assertEqual(stage["pages_profile"]["flags"], verify.ENABLED | {"VITE_ENABLE_POST_CREATION": "true"})
        self.assertEqual(stage["pages_profile"]["revision"], self.guards[self.repo]["<HEAD>"])
        self.assertIn("--manifest", stage["command"])
        self.assertEqual(verify.snapshot(self.repo), before)

    def test_pages_cli_records_the_extra_build_and_omitted_checks(self):
        with contextlib.redirect_stdout(io.StringIO()):
            code = verify.main(["--repo", str(self.repo), "--out", str(self.out),
                                "--profile", "frontend", "--pages-production",
                                "--only", "build-pages-production"])
        self.assertEqual(code, 0)
        report = json.loads((self.out / "report.json").read_text())
        self.assertTrue(report["pages_production"])
        self.assertEqual(len(report["steps"]), 1)
        self.assertEqual(report["steps"][0]["name"], "build-pages-production")
        self.assertIn("unit", report["omitted_stages"])
        self.assertNotIn("Cloudflare Pages production build", report["not_performed"])
        self.assertTrue(report["limitations"])
        self.assertTrue(report["source_preserved"])

    def test_pages_option_requires_a_frontend_profile(self):
        with contextlib.redirect_stderr(io.StringIO()):
            code = verify.main(["--repo", str(self.repo), "--out", str(self.out),
                                "--profile", "backend", "--pages-production"])
        self.assertEqual(code, 2)
        self.assertFalse((self.out / "report.json").exists())

    def test_pages_profile_rejects_invalid_flags_before_building(self):
        for profile in ([], {}, verify.ENABLED | {"VITE_ENABLE_PROFILES": True},
                        verify.ENABLED | {"VITE_ENABLE_PROFILES": "yes"}):
            with self.subTest(profile=profile):
                (self.repo / "web/production-features.json").write_text(json.dumps(profile))
                with self.assertRaises(ValueError):
                    verify.make_plan(self.repo, self.out, {"frontend"}, [], pages_production=True)

    def test_pages_evidence_requires_matching_revision_and_effective_reply_gate(self):
        directory = self.out / "builds/pages-production"
        (directory / ".vite").mkdir(parents=True)
        (directory / "assets").mkdir()
        (directory / "assets/reply.js").write_text("// Compiled fixture")
        expected_revision = self.guards[self.repo]["<HEAD>"]
        for flags, included, revision, passes in (
                (verify.ENABLED, True, expected_revision, True),
                (verify.ENABLED | {"VITE_ENABLE_NOSTR_CONNECT": "false"}, False, expected_revision, True),
                (verify.OFF, False, expected_revision, True),
                (verify.ENABLED, False, expected_revision, False),
                (verify.OFF, True, expected_revision, False),
                (verify.ENABLED, True, "0" * 40, False)):
            with self.subTest(flags=flags, included=included, revision=revision):
                (directory / "index.html").write_text(
                    f'<meta content="{revision}" name="holoboard-revision">')
                manifest = {"src/components/Discussion/ReplyComposer.tsx": {
                    "file": "assets/reply.js", "isDynamicEntry": True}} if included else {}
                (directory / ".vite/manifest.json").write_text(json.dumps(manifest))
                expected = {"revision": expected_revision, "flags": flags}
                if passes:
                    evidence = verify.pages_build_evidence(directory, expected)
                    self.assertEqual(evidence, {"revision": revision, "reply_chunk_present": included})
                else:
                    with self.assertRaises(ValueError):
                        verify.pages_build_evidence(directory, expected)
        (directory / "assets/reply.js").unlink()
        (directory / "index.html").write_text(
            f'<meta name="holoboard-revision" content="{expected_revision}">')
        (directory / ".vite/manifest.json").write_text(json.dumps({
            "src/components/Discussion/ReplyComposer.tsx": {"file": "assets/reply.js", "isDynamicEntry": True}}))
        with self.assertRaises(ValueError):
            verify.pages_build_evidence(directory, {"revision": expected_revision, "flags": verify.ENABLED})

    def test_zero_exit_without_pages_artifacts_fails_and_stops_remaining_checks(self):
        plan = verify.make_plan(self.repo, self.out, {"frontend"}, [], pages_production=True)
        stage = next(step for step in plan if step["name"] == "build-pages-production")
        report = {"steps": [stage, next(step for step in plan if step["name"] == "unit")]}
        with contextlib.redirect_stdout(io.StringIO()):
            code = verify.execute(self.repo, self.out, report, self.guards, runner=lambda *args: 0)
        self.assertEqual(code, 1)
        self.assertEqual(report["steps"][0]["status"], "failed")
        self.assertEqual(report["steps"][1]["status"], "not-run")
        self.assertTrue(report["source_preserved"])


if __name__ == "__main__":
    unittest.main()
