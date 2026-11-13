# scripts/argo/test_argo_kriitiline.py
import unittest
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


if __name__ == "__main__":
    unittest.main()
