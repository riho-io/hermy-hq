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
                    r.get_requests, r.report, r.subprocess.run, sync.push, sync.load_runs)
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

        self.jobs_pushes = []

        def fake_push(url, payload, secret):
            self.jobs_pushes.append((url, payload, secret))
            return 200

        r.get_requests = lambda secret: self.rows
        r.report = fake_report
        r.subprocess.run = fake_run
        sync.push = fake_push
        sync.load_runs = lambda: [{"id": 1}]

    def tearDown(self):
        (sync.HERMES_HOME, sync.HERMES, r.TARGET_FILE, r.LOG_FILE, r.STATE_FILE,
         r.get_requests, r.report, r.subprocess.run, sync.push, sync.load_runs) = self.old
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
        last = self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(last["status"], "failed")
        self.assertTrue(last["error"].startswith("Job not found"))
        self.assertEqual(len(last["error"]), 2000)

    def _fake_popen(self):
        popens = []
        class P:
            def __init__(s2, args, **kw):
                popens.append((args, kw))
            def wait(s2, *a, **k):
                raise AssertionError("must not wait")
            communicate = wait
        old = r.subprocess.Popen
        r.subprocess.Popen = P
        self.addCleanup(setattr, r.subprocess, "Popen", old)
        return popens

    def test_cron_run_is_detached(self):
        popens = self._fake_popen()
        last = self.run_rows({"id": "a", "kind": "cron.run", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(self.calls, [])  # subprocess.run not used
        self.assertEqual(len(popens), 1)
        args, kw = popens[0]
        self.assertEqual(args[-3:], ["run", "--", JOB])
        self.assertTrue(kw["start_new_session"])
        self.assertEqual((kw["stdin"], kw["stdout"], kw["stderr"]), (subprocess.DEVNULL,) * 3)
        self.assertEqual((last["status"], last["result"]), ("done", "käivitatud taustal; tulemus tuleb raportite lehele"))
        self.assertEqual(len(self.jobs_pushes), 1)  # counts as a successful command
        self.assertIn('"detached"', r.LOG_FILE.read_text(encoding="utf-8"))

    def test_cron_run_popen_oserror_fails(self):
        def boom(*a, **k):
            raise FileNotFoundError("hermes")
        old = r.subprocess.Popen
        r.subprocess.Popen = boom
        self.addCleanup(setattr, r.subprocess, "Popen", old)
        last = self.run_rows({"id": "a", "kind": "cron.run", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(last["status"], "failed")
        self.assertEqual(self.jobs_pushes, [])

    def test_pause_still_uses_run(self):
        popens = self._fake_popen()
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(popens, [])

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
            with self.assertRaises(RuntimeError):
                self.run_rows({"id": "a", "kind": "cron.deliver", "payload": {"jobId": JOB, "profile": "default", "preset": "raport"}})
        finally:
            r.read_target = old
        last = self.posts[-1]
        self.assertEqual(self.calls, [])
        self.assertEqual(last["status"], "failed")

    def test_unexpected_error_after_claim_ends_failed(self):
        def boom(args, **kw):
            raise RuntimeError("x")
        r.subprocess.run = boom
        with self.assertRaises(RuntimeError):
            self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual([p["status"] for p in self.posts], ["running", "failed"])
        self.assertEqual(self.posts[-1]["error"], "RuntimeError")

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
        with self.assertRaises(RuntimeError):
            self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})

    def test_done_post_failure_reports_command_outcome_then_raises(self):
        base = r.report
        def flaky(rid, status, secret, result=None, error=None):
            if status == "done":
                raise urllib.error.URLError("net")
            base(rid, status, secret, result, error)
        r.report = flaky
        with self.assertRaises(RuntimeError):
            self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual([p["status"] for p in self.posts], ["running", "failed"])
        self.assertEqual(self.posts[-1]["error"], "käsk täideti (exit 0), tulemuse saatmine ebaõnnestus: URLError")

    def test_batch_continues_after_reporting_error(self):
        base = r.report
        def flaky(rid, status, secret, result=None, error=None):
            if status == "done" and rid == "a":
                raise urllib.error.URLError("net")
            base(rid, status, secret, result, error)
        r.report = flaky
        pay = {"jobId": JOB, "profile": "default"}
        with self.assertRaises(RuntimeError) as cm:
            self.run_rows({"id": "a", "kind": "cron.pause", "payload": pay}, {"id": "b", "kind": "cron.pause", "payload": pay})
        self.assertIn("1", str(cm.exception))
        self.assertIn(("b", "done"), [(p["id"], p["status"]) for p in self.posts])

    def test_successful_batch_pushes_jobs_once(self):
        pay = {"jobId": JOB, "profile": "default"}
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": pay}, {"id": "b", "kind": "cron.resume", "payload": pay})
        self.assertEqual(len(self.jobs_pushes), 1)
        url, payload, secret = self.jobs_pushes[0]
        self.assertEqual(url, sync.URL)
        self.assertEqual((payload["source"], payload["runs"], secret), ("argo", [{"id": 1}], "secret"))
        self.assertEqual([(j["id"], j["profile"]) for j in payload["jobs"]], [(JOB, "default")])

    def test_no_successful_command_no_jobs_push(self):
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": "000000000000", "profile": "default"}})
        self.assertEqual(self.jobs_pushes, [])
        r.subprocess.run = lambda args, **kw: subprocess.CompletedProcess(args, 1, "", "nope")
        self.run_rows({"id": "b", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(self.posts[-1]["status"], "failed")
        self.assertEqual(self.jobs_pushes, [])
        self.claim_code = 409
        self.run_rows({"id": "c", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertEqual(self.jobs_pushes, [])

    def test_jobs_push_failure_flips_health_but_rows_stay_done(self):
        def broken(url, payload, secret):
            raise urllib.error.HTTPError(url, 500, "x", {}, None)
        sync.push = broken
        with self.assertRaises(RuntimeError) as cm:
            self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})
        self.assertIn("500", str(cm.exception))
        self.assertEqual([p["status"] for p in self.posts], ["running", "done"])

    def test_claim_409_does_not_raise(self):
        self.claim_code = 409
        self.run_rows({"id": "a", "kind": "cron.pause", "payload": {"jobId": JOB, "profile": "default"}})

    def test_bare_target_masked(self):
        r.TARGET_FILE.write_text("-100123456\n", encoding="utf-8")
        self.assertEqual(r.mask("-100123456"), "***")
        self.assertEqual(r.mask("a telegram:-100123456 b -100123456"), "a telegram:*** b ***")

    def test_health_detail_masked(self):
        r.read_secret = lambda: "sekret123"
        try:
            def broken(secret):
                raise RuntimeError("bad sekret123 here")
            r.get_requests = broken
            out = io.StringIO()
            with redirect_stdout(out):
                r.main()
            self.assertNotIn("sekret123", out.getvalue())
            self.assertNotIn("sekret123", r.STATE_FILE.read_text(encoding="utf-8"))
        finally:
            r.read_secret = sync.read_secret

    @unittest.skipIf(os.name == "nt", "POSIX modes")
    def test_lock_file_is_0600(self):
        got, fh = r.acquire_lock()
        try:
            self.assertEqual((sync.HERMES / "hermy_requests.lock").stat().st_mode & 0o777, 0o600)
        finally:
            if fh:
                fh.close()

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
