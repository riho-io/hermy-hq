import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import hermy_usage_sync as u

try:
    import yaml  # noqa: F401
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

# Captured from `hermes profile list` on Argo, 2026-11-21 (Hermes v0.23.2).
PROFILE_LIST = """
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────
 ◆Argo (default)  z-ai/glm-5.3-flash           running      —            —
  Sepp (dev)      z-ai/glm-5.3-flash           running      dev          —
  Varahoidja (hoidja) z-ai/glm-5.3-flash           running      hoidja       —
  research        z-ai/glm-5.3-flash           running      research     —
  Säde (sade)     z-ai/glm-5.3-flash           stopped      sade         —
  tark            sonnet                       running      tark         —
"""

NOW = datetime(2026, 11, 21, 10, 0, tzinfo=timezone.utc)  # 12:00 Tallinn


def ts(iso):
    return datetime.fromisoformat(iso).timestamp()


def make_db(path, sessions, usage=(), with_usage_table=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, started_at REAL NOT NULL,"
        " input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,"
        " cache_write_tokens INTEGER DEFAULT 0, billing_provider TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,"
        " cost_status TEXT)"
    )
    if with_usage_table:
        c.execute(
            "CREATE TABLE session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',"
            " input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,"
            " cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,"
            " estimated_cost_usd REAL NOT NULL DEFAULT 0, actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT)"
        )
    for s in sessions:
        row = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
               "billing_provider": None, "estimated_cost_usd": None, "actual_cost_usd": None, "cost_status": None,
               "model": "deepseek/deepseek-v4-flash", "source": "cron", **s}
        c.execute(f"INSERT INTO sessions ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
    for r in usage:
        row = {"billing_provider": "nous", "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
               "cache_write_tokens": 0, "estimated_cost_usd": 0.0, "actual_cost_usd": 0.0, "cost_status": "estimated", **r}
        c.execute(f"INSERT INTO session_model_usage ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))
    c.commit()
    c.close()


class SessionParts(unittest.TestCase):
    def test_usage_rows_plus_residual_like_insights(self):
        s = {"id": "a", "model": "m1", "billing_provider": "nous", "input_tokens": 150, "output_tokens": 20,
             "cache_read_tokens": 0, "cache_write_tokens": 0, "estimated_cost_usd": 0.05, "actual_cost_usd": None,
             "cost_status": "estimated"}
        rows = [{"model": "m1", "billing_provider": "nous", "input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 0,
                 "cache_write_tokens": 0, "estimated_cost_usd": 0.03, "actual_cost_usd": 0.0, "cost_status": "estimated"}]
        parts = u.session_parts(s, rows)
        self.assertEqual([(p["model"], p["tokens"]) for p in parts], [("m1", 120), ("m1", 50)])
        self.assertAlmostEqual(sum(p["cost"] for p in parts), 0.05)

    def test_unknown_status_has_no_cost(self):
        rows = [{"model": "m1", "billing_provider": "nous", "input_tokens": 10, "output_tokens": 0, "cache_read_tokens": 0,
                 "cache_write_tokens": 0, "estimated_cost_usd": 0.0, "actual_cost_usd": 0.0, "cost_status": "unknown"}]
        s = {"id": "a", "model": "m1", "billing_provider": "nous", "input_tokens": 10, "output_tokens": 0,
             "cache_read_tokens": 0, "cache_write_tokens": 0, "estimated_cost_usd": None, "actual_cost_usd": None, "cost_status": "unknown"}
        self.assertIsNone(u.session_parts(s, rows)[0]["cost"])

    def test_actual_cost_wins_over_estimate(self):
        rows = [{"model": "m1", "billing_provider": "nous", "input_tokens": 10, "output_tokens": 0, "cache_read_tokens": 0,
                 "cache_write_tokens": 0, "estimated_cost_usd": 0.01, "actual_cost_usd": 0.02, "cost_status": "actual"}]
        s = dict(rows[0], id="a", estimated_cost_usd=0.01, actual_cost_usd=0.02)
        self.assertEqual(u.session_parts(s, rows)[0]["cost"], 0.02)

    def test_subscription_provider(self):
        self.assertTrue(u.is_subscription("claude-subscription-directsdk-experimental"))
        self.assertFalse(u.is_subscription("nous"))
        self.assertFalse(u.is_subscription(None))


class ProfileList(unittest.TestCase):
    def test_parses_real_output_including_long_names(self):
        g = u.parse_profile_list(PROFILE_LIST)
        self.assertEqual(g, {"default": "running", "dev": "running", "hoidja": "running", "research": "running",
                             "sade": "stopped", "tark": "running"})

    def test_garbage_gives_empty(self):
        self.assertEqual(u.parse_profile_list("Error: boom\n"), {})


class Collect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / ".hermes"
        self.home.mkdir()
        (self.home / "config.yaml").write_text("model:\n  default: z-ai/glm-5.3-flash\n  provider: nous\n", encoding="utf-8")
        (self.home / "profile.yaml").write_text("display_name: Argo\n", encoding="utf-8")
        (self.home / "cron").mkdir()
        (self.home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{"id": "a", "enabled": True}, {"id": "b", "enabled": False}]}), encoding="utf-8")
        (self.home / "cron" / "cost_weekly_state.json").write_text(json.dumps({"last_balance_usd": 6.4668, "last_run": "2026-11-16T06:30:39+00:00"}), encoding="utf-8")
        make_db(self.home / "state.db", [
            # 22:30 UTC on Nov 20 is 00:30 on Nov 21 in Tallinn
            {"id": "s1", "started_at": ts("2026-11-20T22:30:00+00:00"), "input_tokens": 1000, "output_tokens": 100,
             "billing_provider": "nous", "estimated_cost_usd": 0.002, "cost_status": "estimated"},
            {"id": "s2", "started_at": ts("2026-11-20T21:30:00+00:00"), "source": "telegram"},  # empty, Nov 20
            {"id": "s3", "started_at": ts("2026-11-21T08:00:00+00:00"), "input_tokens": 500, "billing_provider": "nous",
             "cost_status": "unknown"},
            {"id": "old", "started_at": ts("2026-09-01T08:00:00+00:00"), "input_tokens": 5},
            {"id": "zero", "started_at": 0.0},
        ], usage=[
            {"session_id": "s1", "model": "deepseek/deepseek-v4-flash", "input_tokens": 1000, "output_tokens": 100,
             "estimated_cost_usd": 0.002},
        ])
        tark = self.home / "profiles" / "tark"
        tark.mkdir(parents=True)
        (tark / "config.yaml").write_text("model:\n  default: sonnet\n  provider: claude-subscription-directsdk-experimental\n", encoding="utf-8")
        make_db(tark / "state.db", [
            {"id": "t1", "started_at": ts("2026-11-19T10:00:00+00:00"), "model": "sonnet", "source": "oneshot",
             "input_tokens": 300, "billing_provider": "claude-subscription-directsdk-experimental", "cost_status": "unknown"},
        ], with_usage_table=False)
        (self.home / "profiles" / "idle").mkdir()  # no state.db, no config

    def tearDown(self):
        self.tmp.cleanup()

    def payload(self):
        return u.build_payload(home=self.home, now=NOW, profile_list_text=PROFILE_LIST)

    def day(self, p, profile, day):
        return next((d for d in p["days"] if d["profile"] == profile and d["day"] == day), None)

    def test_days_are_tallinn_and_classified(self):
        p = self.payload()
        d21 = self.day(p, "default", "2026-11-21")
        self.assertEqual(d21["sessions"], 2)
        self.assertEqual(d21["unpricedSessions"], 1)
        self.assertEqual(d21["emptySessions"], 0)
        self.assertEqual(d21["inputTokens"], 1500)
        self.assertAlmostEqual(d21["costUsd"], 0.002)
        self.assertEqual(d21["platforms"], {"cron": 2})
        models = {m["model"]: m for m in d21["models"]}
        self.assertEqual(models["deepseek/deepseek-v4-flash"]["sessions"], 2)
        d20 = self.day(p, "default", "2026-11-20")
        self.assertEqual((d20["sessions"], d20["emptySessions"], d20["unpricedSessions"]), (1, 1, 0))
        self.assertIsNone(d20["costUsd"])
        self.assertEqual(d20["platforms"], {"telegram": 1})

    def test_window_excludes_old_and_zero_sessions(self):
        days = {d["day"] for d in self.payload()["days"]}
        self.assertFalse(any(day < "2026-10-18" for day in days))

    def test_subscription_is_not_unpriced_and_fallback_without_usage_table(self):
        d = self.day(self.payload(), "tark", "2026-11-19")
        self.assertEqual((d["sessions"], d["subscriptionSessions"], d["unpricedSessions"]), (1, 1, 0))
        self.assertIsNone(d["costUsd"])
        self.assertEqual(d["models"], [{"model": "sonnet", "sessions": 1, "tokens": 300, "costUsd": None, "subscription": True}])

    def test_profiles_snapshot(self):
        prof = {p["profile"]: p for p in self.payload()["profiles"]}
        self.assertEqual(set(prof), {"default", "tark", "idle"})
        self.assertEqual((prof["default"]["gateway"], prof["default"]["cronCount"], prof["default"]["cronEnabled"]), ("running", 2, 1))
        self.assertEqual(prof["tark"]["cronCount"], 0)
        self.assertIsNone(prof["idle"]["gateway"])  # not in profile list output -> unknown, not "stopped"

    @unittest.skipUnless(HAS_YAML, "PyYAML missing locally; Argo's python3 has it (checked by the dry-run)")
    def test_profiles_snapshot_yaml_fields(self):
        prof = {p["profile"]: p for p in self.payload()["profiles"]}
        self.assertEqual(prof["default"], {"profile": "default", "displayName": "Argo", "model": "z-ai/glm-5.3-flash",
                                           "provider": "nous", "subscription": False, "gateway": "running",
                                           "cronCount": 2, "cronEnabled": 1})
        self.assertTrue(prof["tark"]["subscription"])

    def test_balance(self):
        self.assertEqual(self.payload()["balance"], {"balanceUsd": 6.4668, "checkedAt": "2026-11-16T06:30:39+00:00"})

    def test_missing_balance_is_none(self):
        (self.home / "cron" / "cost_weekly_state.json").unlink()
        self.assertIsNone(self.payload()["balance"])

    def test_idempotent(self):
        self.assertEqual(self.payload(), self.payload())

    def test_corrupt_db_raises(self):
        (self.home / "profiles" / "tark" / "state.db").write_bytes(b"not a database")
        with self.assertRaises(Exception):
            self.payload()


class Main(unittest.TestCase):
    def test_dry_run_never_posts_or_writes_state(self):
        with mock.patch.object(u, "build_payload", return_value={"source": "argo", "days": [], "profiles": [], "balance": None}), \
             mock.patch.object(u, "push", side_effect=AssertionError("posted")), \
             mock.patch.object(u, "write_state", side_effect=AssertionError("state written")), \
             mock.patch.object(u, "read_secret", return_value=None), \
             mock.patch("builtins.print"):
            self.assertEqual(u.main(["--dry-run"]), 0)

    def test_missing_secret_fails_and_reports_once(self):
        with mock.patch.object(u, "read_secret", return_value=None), \
             mock.patch.object(u, "read_state", return_value={"ok": True}), \
             mock.patch.object(u, "write_state") as ws, \
             mock.patch("builtins.print") as pr:
            self.assertEqual(u.main([]), 1)
        ws.assert_called_once()
        self.assertIn("INGEST_SECRET puudub", pr.call_args[0][0])


if __name__ == "__main__":
    unittest.main()
