# scripts/argo/test_argo_kriitiline.py
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock
from datetime import datetime, timezone

import argo_kriitiline as k


class EvaluateTest(unittest.TestCase):
    def test_all_ok(self):
        self.assertEqual(k.evaluate(True, True, 12.5), set())

    def test_gateway_down(self):
        self.assertEqual(k.evaluate(False, True, 12.5), {"gateway"})

    def test_logged_out_hides_balance(self):
        # Välja logituna saldot ei teata — see pole siis teada.
        self.assertEqual(k.evaluate(True, False, None), {"nous_login"})

    def test_low_balance(self):
        self.assertEqual(k.evaluate(True, True, 0.4), {"nous_balance"})

    def test_unknown_balance_is_not_alarm(self):
        self.assertEqual(k.evaluate(True, True, None), set())


class TransitionsTest(unittest.TestCase):
    def test_no_change_no_message(self):
        self.assertEqual(k.transitions({"gateway"}, {"gateway"}), [])

    def test_new_problem(self):
        msgs = k.transitions(set(), {"nous_login"})
        self.assertEqual(len(msgs), 1)
        self.assertIn("🚨 Argo ei tööta", msgs[0])
        self.assertIn("hermes model", msgs[0])

    def test_recovery(self):
        msgs = k.transitions({"nous_login"}, set())
        self.assertEqual(msgs, ["✅ Argo taastus: Nousi sisselogimine korras"])


class PayloadTest(unittest.TestCase):
    def test_shape(self):
        now = datetime(2026, 11, 13, 20, 0, tzinfo=timezone.utc)
        self.assertEqual(
            k.health_payload(True, False, None, now),
            {"source": "argo", "checkedAt": "2026-11-13T20:00:00+00:00",
             "gatewayOk": True, "nousLoggedIn": False, "nousBalance": None},
        )


class UnknownGatewayTest(unittest.TestCase):
    def test_unknown_gateway_is_not_alarm(self):
        self.assertEqual(k.evaluate(None, True, 12.5), set())

    def test_payload_unknown_gateway_counts_ok(self):
        now = datetime(2026, 11, 13, 20, 0, tzinfo=timezone.utc)
        self.assertIs(k.health_payload(None, True, 1.0, now)["gatewayOk"], True)
        self.assertIs(k.health_payload(False, True, 1.0, now)["gatewayOk"], False)


class CheckGatewayTest(unittest.TestCase):
    def test_sets_xdg_runtime_dir(self):
        env = {k_: v for k_, v in os.environ.items() if k_ != "XDG_RUNTIME_DIR"}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(k.os, "getuid", create=True, return_value=1000), \
                mock.patch.object(k, "_run", return_value="active\n"):
            self.assertTrue(k.check_gateway())
            self.assertEqual(os.environ["XDG_RUNTIME_DIR"], "/run/user/1000")

    @mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/run/user/1000"})
    def test_bus_error_is_unknown(self):
        with mock.patch.object(k, "_run", return_value="Failed to connect to bus: No medium found"):
            self.assertIsNone(k.check_gateway())

    @mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": "/run/user/1000"})
    def test_inactive_is_false(self):
        with mock.patch.object(k, "_run", return_value="inactive\n"):
            self.assertIs(k.check_gateway(), False)


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = Path(self.tmp.name) / "sub" / "state.json"
        p = mock.patch.object(k, "STATE_FILE", self.file)
        p.start()
        self.addCleanup(p.stop)

    def test_save_creates_parent(self):
        k.save_state({"gateway"}, {"gateway", "nous_login"})
        data = json.loads(self.file.read_text(encoding="utf-8"))
        self.assertEqual(data, {"bad": ["gateway"], "seen": ["gateway", "nous_login"]})

    def test_save_oserror_is_logged_not_raised(self):
        err = io.StringIO()
        with mock.patch.object(Path, "write_text", side_effect=OSError("x")), redirect_stderr(err):
            k.save_state({"gateway"}, {"gateway"})
        self.assertIn("olekut ei salvestatud", err.getvalue())

    def test_load_non_dict_is_empty(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text("[1, 2]", encoding="utf-8")
        self.assertEqual(k.load_state(), (set(), set()))

    def test_load_old_format_seen_equals_bad(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text('{"bad": ["gateway"]}', encoding="utf-8")
        self.assertEqual(k.load_state(), ({"gateway"}, {"gateway"}))

    def test_load_missing_is_empty(self):
        self.assertEqual(k.load_state(), (set(), set()))


class StepTest(unittest.TestCase):
    def test_first_bad_run_is_not_confirmed(self):
        confirmed, seen, msgs = k.step((set(), set()), {"gateway"})
        self.assertEqual((confirmed, seen, msgs), (set(), {"gateway"}, []))

    def test_second_bad_run_alerts(self):
        confirmed, seen, msgs = k.step((set(), {"gateway"}), {"gateway"})
        self.assertEqual(confirmed, {"gateway"})
        self.assertEqual(len(msgs), 1)

    def test_third_bad_run_silent(self):
        confirmed, _, msgs = k.step(({"gateway"}, {"gateway"}), {"gateway"})
        self.assertEqual((confirmed, msgs), ({"gateway"}, []))

    def test_recovery_immediate(self):
        confirmed, seen, msgs = k.step(({"gateway"}, {"gateway"}), set())
        self.assertEqual((confirmed, seen), (set(), set()))
        self.assertEqual(msgs, ["✅ Argo taastus: gateway jookseb"])

    def test_blip_never_alerts(self):
        s1 = k.step((set(), set()), {"gateway"})
        s2 = k.step((s1[0], s1[1]), set())
        self.assertEqual(s2[2], [])

    def test_login_loss_does_not_emit_balance_recovery(self):
        confirmed, seen, msgs = k.step(({"nous_balance"}, {"nous_balance"}), {"nous_login"})
        self.assertIn("nous_balance", confirmed)
        self.assertFalse(any("saldo korras" in m for m in msgs))


class MainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.file = Path(self.tmp.name) / "state.json"
        self.file.write_text('{"bad": [], "seen": ["gateway"]}', encoding="utf-8")
        for name, rv in [("STATE_FILE", self.file)]:
            p = mock.patch.object(k, name, rv)
            p.start()
            self.addCleanup(p.stop)
        for name, rv in [("check_gateway", False), ("check_nous_login", True),
                         ("check_nous_balance", 5.0)]:
            p = mock.patch.object(k, name, return_value=rv)
            p.start()
            self.addCleanup(p.stop)

    def test_telegram_failure_keeps_state_and_hides_message(self):
        err = io.StringIO()
        with mock.patch.object(k, "send_telegram", side_effect=RuntimeError("bot123:SECRET")), \
                mock.patch.object(k, "push_health") as ph, \
                redirect_stderr(err), redirect_stdout(io.StringIO()):
            rc = k.main()
        self.assertEqual(rc, 0)
        self.assertIn("RuntimeError", err.getvalue())
        self.assertNotIn("SECRET", err.getvalue())
        self.assertEqual(json.loads(self.file.read_text(encoding="utf-8"))["bad"], [])
        ph.assert_called_once()


class BalanceTest(unittest.TestCase):
    def _with_module(self, fn):
        import sys
        import types
        mod = types.ModuleType("konto_check")
        mod.nous_balance = fn
        return mock.patch.dict(sys.modules, {"konto_check": mod})

    def test_sys_exit_is_none(self):
        def boom():
            raise SystemExit(1)
        with self._with_module(boom):
            self.assertIsNone(k.check_nous_balance())

    def test_non_float_is_none(self):
        with self._with_module(lambda: ("n/a", 1)):
            self.assertIsNone(k.check_nous_balance())

    def test_float_ok(self):
        with self._with_module(lambda: (3.5, 1)):
            self.assertEqual(k.check_nous_balance(), 3.5)

    def test_keyboard_interrupt_propagates(self):
        def boom():
            raise KeyboardInterrupt
        with self._with_module(boom), self.assertRaises(KeyboardInterrupt):
            k.check_nous_balance()


if __name__ == "__main__":
    unittest.main()
