import io
import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path

import hermy_cron_sync as sync
import hermy_requests as r

try:
    import fcntl
except ImportError:
    fcntl = None

JOB = "bd90b36ca7b5"


class Base(unittest.TestCase):
    """Temp ~/.hermes with a default and a 'dubi' profile, fake HTTP and fake subprocess.run."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = Path(self.tmp.name)
        self.old = (sync.HERMES_HOME, sync.HERMES, r.TARGET_FILE, r.LOG_FILE, r.STATE_FILE,
                    r.get_requests, r.report, r.subprocess.run)
        sync.HERMES_HOME = home / ".hermes"
        sync.HERMES = sync.HERMES_HOME / "cron"
        for d in (sync.HERMES, sync.HERMES_HOME / "profiles" / "dubi" / "cron"):
            d.mkdir(parents=True)
            (d / "jobs.json").write_text(json.dumps({"jobs": [{"id": JOB, "name": "x"}]}), encoding="utf-8")
        r.TARGET_FILE = home / "telegram_target"
        r.TARGET_FILE.write_text("X\n", encoding="utf-8")
        r.LOG_FILE = home / "hermy_requests.log"
        r.STATE_FILE = home / "state.json"

        self.rows = []
        self.posts = []
        self.calls = []
        self.claim_code = None
        self.proc_out = ("ok\n", "")

        def fake_report(rid, status, secret, result=None, error=None):
            self.posts.append({"id": rid, "status": status, "result": result, "error": error})
            if status == "running" and self.claim_code:
                raise urllib.error.HTTPError(r.URL, self.claim_code, "Conflict", {}, None)

        def fake_run(args, **kw):
            self.calls.append((args, kw))
            return subprocess.CompletedProcess(args, 0, *self.proc_out)

        r.get_requests = lambda secret: self.rows
        r.report = fake_report
        r.subprocess.run = fake_run

    def tearDown(self):
        (sync.HERMES_HOME, sync.HERMES, r.TARGET_FILE, r.LOG_FILE, r.STATE_FILE,
         r.get_requests, r.report, r.subprocess.run) = self.old
        self.tmp.cleanup()

    def run_rows(self, *rows):
        self.rows = list(rows)
        r.process("secret")
        return self.posts[-1] if self.posts else None


class Requests(Base):
    def test_unknown_job_fails_without_command(self):
        last = self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": "000000000000", "profile": "default"}})
        self.assertEqual(self.calls, [])
        self.assertEqual((last["status"], last["error"]), ("failed", "tundmatu cron"))

    def test_deliver_raport_argv(self):
        last = self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "dubi", "preset": "raport"}})
        self.assertEqual(self.calls[0][0], ["hermes", "-p", "dubi", "cron", "edit", "--deliver", "local",
                                            "--failure-deliver", "telegram:X", "--", JOB])
        kw = self.calls[0][1]
        self.assertEqual((kw["timeout"], kw["capture_output"], kw["text"]), (60, True, True))
        self.assertNotIn("shell", kw)
        self.assertEqual([p["status"] for p in self.posts], ["running", "done"])

    def test_deliver_hoiatus_clears_failure_override(self):
        self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "default", "preset": "hoiatus"}})
        self.assertEqual(self.calls[0][0], ["hermes", "cron", "edit", "--deliver", "telegram:X",
                                            "--failure-deliver", "", "--", JOB])

    def test_deliver_without_target_fails(self):
        r.TARGET_FILE.unlink()
        last = self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "default", "preset": "raport"}})
        self.assertEqual(self.calls, [])
        self.assertEqual((last["status"], last["error"]), ("failed", "telegram_target puudub"))

    def test_unknown_kind_runs_nothing(self):
        last = self.run_rows({"id": "a", "kind": "shell.exec", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(self.calls, [])
        self.assertEqual(last["status"], "failed")

    def test_schedule_with_forbidden_char_fails(self):
        last = self.run_rows({"id": "a", "kind": "cron.schedule",
                              "payload": {"jobId": JOB, "profile": "default", "schedule": "0 9 * * *; rm -rf ~"}})
        self.assertEqual(self.calls, [])
        self.assertEqual((last["status"], last["error"]), ("failed", "invalid payload"))

    def test_schedule_is_one_argv_element(self):
        self.run_rows({"id": "a", "kind": "cron.schedule", "payload": {"jobId": JOB, "profile": "default", "schedule": "0 9 * * 1"}})
        self.assertEqual(self.calls[0][0], ["hermes", "cron", "edit", "--schedule", "0 9 * * 1", "--", JOB])

    def test_non_default_profile_adds_p(self):
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "dubi"}})
        self.assertEqual(self.calls[0][0], ["hermes", "-p", "dubi", "cron", "pause", "--", JOB])

    def test_missing_profile_dir_is_unknown(self):
        last = self.run_rows({"id": "a", "kind": "cron.run", "payload": {"jobId": JOB, "profile": "puudub"}})
        self.assertEqual(self.calls, [])
        self.assertEqual(last["error"], "tundmatu cron")

    def test_bad_profile_is_invalid(self):
        last = self.run_rows({"id": "a", "kind": "cron.run", "payload": {"jobId": JOB, "profile": "-x"}})
        self.assertEqual(self.calls, [])
        self.assertEqual(last["error"], "invalid payload")

    def test_claim_409_skips_row(self):
        self.claim_code = 409
        self.run_rows({"id": "a", "kind": "cron.resume", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(self.calls, [])
        self.assertEqual([p["status"] for p in self.posts], ["running"])

    def test_command_helper_line_stripped(self):
        self.proc_out = ("  Command helper: applied 23 secrets\nPaused job x\n", "")
        last = self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(last["result"], "Paused job x")

    def test_nonzero_exit_fails_with_output(self):
        def fail(args, **kw):
            self.calls.append((args, kw))
            return subprocess.CompletedProcess(args, 1, "  Command helper: applied 2 secrets\n", "Job not found\n" + "e" * 3000)
        r.subprocess.run = fail
        last = self.run_rows({"id": "a", "kind": "cron.run", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(last["status"], "failed")
        self.assertTrue(last["error"].startswith("Job not found"))
        self.assertEqual(len(last["error"]), 2000)

    def test_command_logged(self):
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        line = r.LOG_FILE.read_text(encoding="utf-8")
        self.assertIn('"id": "a"', line)
        self.assertIn('"exit": 0', line)
        self.assertIn(JOB, line)

    def test_log_failure_does_not_hide_outcome(self):
        def boom(*a, **k):
            raise OSError("disk full")
        old = r.log_command
        r.log_command = boom
        try:
            self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        finally:
            r.log_command = old
        self.assertEqual([p["status"] for p in self.posts], ["running", "done"])

    def test_unreadable_target_fails_without_running(self):
        r.TARGET_FILE.write_bytes(b"\xff\xfe\x00bad")
        last = self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "default", "preset": "raport"}})
        self.assertEqual(self.calls, [])
        self.assertEqual(last["status"], "failed")
        self.assertEqual(last["error"], "telegram_target loetamatu")

    def test_read_target_unicode_error_is_failed(self):
        def bad():
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "x")
        old = r.read_target
        r.read_target = bad
        try:
            last = self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "default", "preset": "raport"}})
        finally:
            r.read_target = old
        self.assertEqual(self.calls, [])
        self.assertEqual(last["status"], "failed")

    def test_unexpected_error_after_claim_ends_failed(self):
        def boom(args, **kw):
            raise RuntimeError("x")
        r.subprocess.run = boom
        last = self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual([p["status"] for p in self.posts], ["running", "failed"])
        self.assertEqual(last["error"], "RuntimeError")

    def test_failed_report_inside_catch_all_never_raises(self):
        def boom(args, **kw):
            raise RuntimeError("x")
        r.subprocess.run = boom
        base = r.report
        def flaky(rid, status, secret, result=None, error=None):
            if status == "failed":
                raise OSError("net")
            base(rid, status, secret, result, error)
        r.report = flaky
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})

    def test_timeout_text(self):
        def slow(args, **kw):
            raise subprocess.TimeoutExpired(args, 60)
        r.subprocess.run = slow
        last = self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(last["error"], "timeout 60s (mõju teadmata)")

    def test_target_and_secret_masked(self):
        r.TARGET_FILE.write_text("-100123456\n", encoding="utf-8")
        self.proc_out = ("sent to telegram:-100123456 and -100123456 key secret\n", "")
        last = self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "default", "preset": "raport"}})
        self.assertIn("telegram:-100123456", self.calls[0][0][-3])  # argv itself is untouched
        self.assertNotIn("-100123456", last["result"])
        self.assertNotIn("secret", last["result"])
        self.assertIn("telegram:***", last["result"])
        log = r.LOG_FILE.read_text(encoding="utf-8")
        self.assertNotIn("-100123456", log)
        self.assertIn("telegram:***", log)

    @unittest.skipIf(os.name == "nt", "POSIX modes")
    def test_files_are_0600(self):
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        r.write_state(True, None)
        self.assertEqual(r.LOG_FILE.stat().st_mode & 0o777, 0o600)
        self.assertEqual(r.STATE_FILE.stat().st_mode & 0o777, 0o600)

    def test_state_non_dict_tolerated(self):
        for bad in ("[]", '"x"', "3", "null"):
            r.STATE_FILE.write_text(bad, encoding="utf-8")
            self.assertEqual(r.read_state(), {"ok": True})

    def test_write_state_oserror_swallowed(self):
        r.STATE_FILE = Path(self.tmp.name) / "no" / "such" / "dir" / "state.json"
        r.write_state(True, None)


class Main(Base):
    def test_silent_when_healthy_and_prints_on_flip(self):
        r.read_secret = lambda: "secret"
        try:
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(r.main(), 0)
            self.assertEqual(out.getvalue(), "")

            def broken(secret):
                raise urllib.error.HTTPError(r.URL, 500, "x", {}, None)
            r.get_requests = broken
            with redirect_stdout(out):
                r.main()
                r.main()
            self.assertEqual(out.getvalue().count("katki"), 1)
            self.assertIn("HTTP 500", out.getvalue())

            r.get_requests = lambda secret: []
            with redirect_stdout(out):
                r.main()
            self.assertIn("taastus", out.getvalue())
        finally:
            r.read_secret = sync.read_secret


    @unittest.skipIf(fcntl is None, "needs fcntl")
    def test_second_tick_skips_while_lock_held(self):
        got, fh = r.acquire_lock()
        self.assertTrue(got)
        try:
            got2, _ = r.acquire_lock()
            self.assertFalse(got2)
            r.read_secret = lambda: (_ for _ in ()).throw(AssertionError("must not run"))
            try:
                self.assertEqual(r.main(), 0)
            finally:
                r.read_secret = sync.read_secret
        finally:
            fh.close()
        got3, fh3 = r.acquire_lock()
        self.assertTrue(got3)
        fh3.close()


if __name__ == "__main__":
    unittest.main()
