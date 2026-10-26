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
        self.old = s.HERMES
        s.HERMES = Path(self.tmp.name)
        out = s.HERMES / "output" / "abc"
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

    def tearDown(self):
        s.HERMES = self.old
        self.tmp.cleanup()

    def test_oldest_first_skips_silent_unknown_and_fresh(self):
        reports, skipped = s.collect_reports(["abc", "missing"], {"abc": "Radar"}, set(), now=self.now)
        self.assertEqual([r["run"] for r in reports], ["2026-10-19_10-02-14", "2026-10-26_10-05-38"])
        self.assertEqual(skipped, ["abc/2026-10-12_10-04-19"])
        self.assertEqual(reports[0]["jobName"], "Radar")
        self.assertEqual(reports[0]["body"], "# Radar\n\n- finding")
        self.assertRegex(reports[0]["runAt"], r"^2026-10-19T10:02:14[+-]\d\d:\d\d$")

    def test_already_sent_is_not_resent(self):
        reports, _ = s.collect_reports(["abc"], {}, {"abc/2026-10-19_10-02-14"}, now=self.now)
        self.assertEqual([r["run"] for r in reports], ["2026-10-26_10-05-38"])


class ReportJobs(unittest.TestCase):
    def test_comments_and_invalid_ids_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            old = s.REPORT_JOBS_FILE
            s.REPORT_JOBS_FILE = Path(d) / "report_jobs"
            try:
                self.assertEqual(s.load_report_jobs(), [])
                s.REPORT_JOBS_FILE.write_text("abc  # radar\n\n# off\nbad id\ndef\n", encoding="utf-8")
                self.assertEqual(s.load_report_jobs(), ["abc", "def"])
            finally:
                s.REPORT_JOBS_FILE = old


if __name__ == "__main__":
    unittest.main()
