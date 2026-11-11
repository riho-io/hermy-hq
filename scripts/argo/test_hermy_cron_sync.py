import json
import os
import tempfile
import unittest
from pathlib import Path

import hermy_cron_sync as s

AGENT = """# Cron Job: radar

**Job ID:** abc
**Run Time:** 2026-10-26 10:05:38

## Prompt

Do the radar.

## Your previous run's output

## Response

old report quoted inside the prompt

**Response Characters:** 20
## Response

# Radar

- finding
"""

SCRIPT = """# Cron Job: weekly

**Job ID:** def
**Mode:** no_agent (script)

---

line one
---
line two
"""


class ExtractBody(unittest.TestCase):
    def test_agent_takes_reply_after_response_marker(self):
        self.assertEqual(s.extract_body(AGENT), "# Radar\n\n- finding")

    def test_script_takes_stdout_after_first_rule(self):
        self.assertEqual(s.extract_body(SCRIPT), "line one\n---\nline two")

    def test_silent_and_missing_reply_are_none(self):
        self.assertIsNone(s.extract_body(AGENT.replace("# Radar\n\n- finding", "[SILENT]")))
        self.assertIsNone(s.extract_body("# Cron Job: x\n\n## Prompt\n\nonly a prompt\n"))

    def test_clipped(self):
        long = AGENT.replace("- finding", "x" * (s.MAX_REPORT_CHARS + 50))
        self.assertEqual(len(s.extract_body(long)), s.MAX_REPORT_CHARS)


class CollectReports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        out = Path(self.tmp.name) / "output" / "abc"
        out.mkdir(parents=True)
        (out / "2026-10-26_10-05-38.md").write_text(AGENT, encoding="utf-8")
        (out / "2026-10-19_10-02-14.md").write_text(AGENT, encoding="utf-8")
        (out / "2026-10-12_10-04-19.md").write_text(AGENT.replace("# Radar\n\n- finding", "[SILENT]"), encoding="utf-8")
        (out / "notes.md").write_text(AGENT, encoding="utf-8")
        self.fresh = out / "2026-10-27_10-00-00.md"
        self.fresh.write_text(AGENT, encoding="utf-8")
        old = 1_700_000_000
        for p in out.iterdir():
            if p != self.fresh:
                os.utime(p, (old, old))
        self.now = old + 3600
        os.utime(self.fresh, (self.now - 5, self.now - 5))
        self.sources = {"abc": (out, "Radar"), "missing": (Path(self.tmp.name) / "output" / "missing", "Gone")}

    def tearDown(self):
        self.tmp.cleanup()

    def test_oldest_first_skips_silent_unknown_and_fresh(self):
        reports, skipped = s.collect_reports(self.sources, set(), now=self.now)
        self.assertEqual([r["run"] for r in reports], ["2026-10-19_10-02-14", "2026-10-26_10-05-38"])
        self.assertEqual(skipped, ["abc/2026-10-12_10-04-19"])
        self.assertEqual(reports[0]["jobName"], "Radar")
        self.assertEqual(reports[0]["body"], "# Radar\n\n- finding")
        self.assertRegex(reports[0]["runAt"], r"^2026-10-19T10:02:14[+-]\d\d:\d\d$")

    def test_already_sent_is_not_resent(self):
        reports, _ = s.collect_reports(self.sources, {"abc/2026-10-19_10-02-14"}, now=self.now)
        self.assertEqual([r["run"] for r in reports], ["2026-10-26_10-05-38"])


def _jobs_json(path, jobs):
    path.mkdir(parents=True, exist_ok=True)
    (path / "jobs.json").write_text(json.dumps({"jobs": jobs}), encoding="utf-8")


class ReportSources(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = (s.HERMES_HOME, s.HERMES)
        s.HERMES_HOME = Path(self.tmp.name)
        s.HERMES = s.HERMES_HOME / "cron"
        _jobs_json(s.HERMES, [{"id": "aaa", "name": "Uudised"}, {"id": "bad id", "name": "x"}])
        _jobs_json(s.HERMES_HOME / "profiles" / "dubi" / "cron", [{"id": "bbb", "name": "Radar"}, {"id": "aaa", "name": "Dup"}])
        _jobs_json(s.HERMES_HOME / "profiles" / "tark" / "cron", [{"id": "ccc"}])
        (s.HERMES_HOME / "profiles" / "empty").mkdir(parents=True)  # profile without cron folder
        bad = s.HERMES_HOME / "profiles" / "broken" / "cron"
        bad.mkdir(parents=True)
        (bad / "jobs.json").write_text("{not json", encoding="utf-8")
        for name, raw in [("jnull", "null"), ("jnum", "42"), ("jjobsnull", '{"jobs": null}'),
                          ("jmixed", '{"jobs": ["str", {"id": "ddd", "name": "D"}]}')]:
            wrong = s.HERMES_HOME / "profiles" / name / "cron"
            wrong.mkdir(parents=True)
            (wrong / "jobs.json").write_text(raw, encoding="utf-8")

    def tearDown(self):
        s.HERMES_HOME, s.HERMES = self.old
        self.tmp.cleanup()

    def test_all_profiles_first_wins_invalid_dropped(self):
        src = s.load_report_sources()
        self.assertEqual(sorted(src), ["aaa", "bbb", "ccc", "ddd"])
        self.assertEqual(src["aaa"], (s.HERMES / "output" / "aaa", "Uudised"))
        self.assertEqual(src["bbb"], (s.HERMES_HOME / "profiles" / "dubi" / "cron" / "output" / "bbb", "Radar"))
        self.assertEqual(src["ccc"][1], "ccc")  # name falls back to id

    def test_cron_dirs_default_first(self):
        self.assertEqual(s.cron_dirs()[0], s.HERMES)
        self.assertNotIn(s.HERMES_HOME / "profiles" / "empty" / "cron", s.cron_dirs())


class SyncReportsExclude(unittest.TestCase):
    PATCHED = ("load_report_sources", "load_report_exclude", "read_report_state", "write_report_state", "push")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = {n: getattr(s, n) for n in self.PATCHED}
        root = Path(self.tmp.name)
        sources = {}
        for jid in ("keep", "drop"):
            folder = root / jid
            folder.mkdir()
            f = folder / "2026-10-19_10-02-14.md"
            f.write_text("# Cron Job\n\n**Mode:** no_agent (script)\n\n---\n\nhello\n", encoding="utf-8")
            old = f.stat().st_mtime - 10 * s.MIN_AGE_S
            os.utime(f, (old, old))
            sources[jid] = (folder, jid.upper()[0])
        self.pushed = []
        s.load_report_sources = lambda: sources
        s.load_report_exclude = lambda: {"drop"}
        s.read_report_state = lambda: set()
        s.write_report_state = lambda sent: None
        s.push = lambda url, payload, secret: self.pushed.append(payload)

    def tearDown(self):
        for n, v in self.saved.items():
            setattr(s, n, v)
        self.tmp.cleanup()

    def test_excluded_job_not_pushed(self):
        self.assertEqual(s.sync_reports("x"), 1)
        reports = [r for p in self.pushed for r in p["reports"]]
        self.assertEqual([r["jobId"] for r in reports], ["keep"])


class ReportExclude(unittest.TestCase):
    def test_comments_and_invalid_ids_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            old = s.REPORT_EXCLUDE_FILE
            s.REPORT_EXCLUDE_FILE = Path(d) / "report_exclude"
            try:
                self.assertEqual(s.load_report_exclude(), set())  # missing file = exclude nothing
                s.REPORT_EXCLUDE_FILE.write_text("abc  # mustandid\n\n# off\nbad id\ndef\n", encoding="utf-8")
                self.assertEqual(s.load_report_exclude(), {"abc", "def"})
            finally:
                s.REPORT_EXCLUDE_FILE = old


class ReadSecret(unittest.TestCase):
    def test_non_utf8_secret_file_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            old = (s.SECRET_FILE, os.environ.pop("INGEST_SECRET", None))
            s.SECRET_FILE = Path(d) / "secret"
            s.SECRET_FILE.write_bytes(b"\xff\xfe\x00bad")
            try:
                self.assertIsNone(s.read_secret())
            finally:
                s.SECRET_FILE = old[0]
                if old[1] is not None:
                    os.environ["INGEST_SECRET"] = old[1]


if __name__ == "__main__":
    unittest.main()
