import unittest
from unittest import mock

import hermy_bills_tg as b

ITEM = {
    "id": "b1", "kind": "d3", "daysLeft": 3, "supplier": "Näidis Energia", "amount": "45,20 €",
    "dueDate": "2026-12-05", "group": "Kodu", "reference": "1234567", "iban": "EE382200221020145685",
    "payUrl": "https://naide.example/p/1",
}


class BuildMessage(unittest.TestCase):
    def test_empty_is_none(self):
        self.assertIsNone(b.build_message([]))

    def test_d3_and_due_sections(self):
        due = {**ITEM, "id": "b2", "kind": "due", "daysLeft": 0, "supplier": "Vesi OÜ"}
        msg = b.build_message([ITEM, due])
        self.assertIn("3 päeva pärast", msg)
        self.assertIn("TÄNA", msg)
        self.assertIn("Näidis Energia", msg)
        self.assertIn("05.12.2026", msg)
        self.assertIn("Kodu", msg)
        self.assertIn("1234567", msg)

    def test_overdue_says_so(self):
        msg = b.build_message([{**ITEM, "kind": "due", "daysLeft": -4}])
        self.assertIn("4 p hilinenud", msg)

    def test_markdown_specials_in_supplier_do_not_break_message(self):
        msg = b.build_message([{**ITEM, "supplier": "A_B*C[x](y)`z"}])
        self.assertNotIn("A_B*C[x](y)`z", msg)  # escaped


class Main(unittest.TestCase):
    def run_main(self, items, send_ok=True, ack_ok=True):
        with mock.patch.object(b, "get_secret", return_value="s"), \
             mock.patch.object(b, "fetch_due", return_value={"today": "2026-12-02", "items": items}), \
             mock.patch.object(b, "send_telegram", return_value=send_ok) as send, \
             mock.patch.object(b, "post_ack", return_value=ack_ok) as ack, \
             mock.patch.object(b, "telegram_cfg", return_value=("tok", "chat")):
            code = b.main(["--send"])
        return code, send, ack

    def test_nothing_due_is_silent_and_sends_nothing(self):
        code, send, ack = self.run_main([])
        self.assertEqual(code, 0)
        send.assert_not_called()
        ack.assert_not_called()

    def test_sends_then_acks_exactly_the_sent_items(self):
        code, send, ack = self.run_main([ITEM])
        self.assertEqual(code, 0)
        send.assert_called_once()
        ack.assert_called_once_with("s", [{"id": "b1", "kind": "d3"}])

    def test_failed_send_does_not_ack(self):
        code, send, ack = self.run_main([ITEM], send_ok=False)
        self.assertEqual(code, 1)
        ack.assert_not_called()

    def test_failed_ack_is_an_error_but_message_was_sent(self):
        code, send, ack = self.run_main([ITEM], ack_ok=False)
        self.assertEqual(code, 1)
        send.assert_called_once()


if __name__ == "__main__":
    unittest.main()
