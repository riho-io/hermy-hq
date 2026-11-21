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

    def test_supplier_with_markdown_specials_appears_verbatim(self):
        msg = b.build_message([{**ITEM, "supplier": "A_B*C[x](y)`z"}])
        self.assertIn("A_B*C[x](y)`z", msg)
        self.assertNotIn("\_", msg)

    def test_d3_label_for_1_or_2_days_is_soon(self):
        for d in (1, 2):
            msg = b.build_message([{**ITEM, "daysLeft": d}])
            self.assertIn("peagi", msg)
            self.assertNotIn("3 päeva pärast", msg)

    def test_d3_label_for_3_days(self):
        msg = b.build_message([{**ITEM, "daysLeft": 3}])
        self.assertIn("3 päeva pärast", msg)
        self.assertNotIn("peagi", msg)


class SendTelegram(unittest.TestCase):
    def test_request_has_no_parse_mode(self):
        captured = {}

        class Resp:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake(req, timeout=None):
            captured["data"] = req.data.decode()
            return Resp()

        with mock.patch.object(b.urllib.request, "urlopen", side_effect=fake):
            self.assertTrue(b.send_telegram("A_B*C", "tok", "chat"))
        self.assertNotIn("parse_mode", captured["data"])
        self.assertIn("chat_id=chat", captured["data"])


def many(n, kind="d3", days=3):
    return [{**ITEM, "id": f"b{i}", "kind": kind, "daysLeft": days} for i in range(n)]


class Chunking(unittest.TestCase):
    def test_chunks_respect_count_and_length(self):
        items = many(40) + [{**ITEM, "id": "x", "supplier": "Y" * 300}] * 20
        chunks = b.chunk_items(items)
        self.assertEqual(sum(len(c) for c in chunks), 60)
        for c in chunks:
            self.assertLessEqual(len(c), 15)
            self.assertLessEqual(len(b.build_message(c)), 3500)

    def test_mixed_kinds_label_correct_per_chunk(self):
        items = many(15, "due", 0) + many(2, "d3", 1)
        chunks = b.chunk_items(items)
        self.assertGreater(len(chunks), 1)
        msg = b.build_message(chunks[-1])
        self.assertIn("peagi", msg)
        self.assertNotIn("3 päeva pärast", msg)


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

    def test_dry_run_prints_and_neither_sends_nor_acks(self):
        with mock.patch.object(b, "get_secret", return_value="s"),              mock.patch.object(b, "fetch_due", return_value={"items": [ITEM]}),              mock.patch.object(b, "send_telegram") as send,              mock.patch.object(b, "post_ack") as ack,              mock.patch("builtins.print") as pr:
            code = b.main([])
        self.assertEqual(code, 0)
        send.assert_not_called()
        ack.assert_not_called()
        pr.assert_called()

    def test_40_items_multiple_sends_acks_equal_sent(self):
        items = many(40)
        code, send, ack = self.run_main(items)
        self.assertEqual(code, 0)
        self.assertGreaterEqual(send.call_count, 3)
        self.assertEqual(send.call_count, ack.call_count)
        acked = [a["id"] for c in ack.call_args_list for a in c.args[1]]
        self.assertEqual(sorted(acked), sorted(i["id"] for i in items))
        for c in ack.call_args_list:
            self.assertLessEqual(len(c.args[1]), 15)
        for c in send.call_args_list:
            self.assertLessEqual(len(c.args[0]), 3500)

    def test_failure_on_chunk_2_acks_chunk_1_only(self):
        with mock.patch.object(b, "get_secret", return_value="s"),              mock.patch.object(b, "fetch_due", return_value={"items": many(40)}),              mock.patch.object(b, "send_telegram", side_effect=[True, False]) as send,              mock.patch.object(b, "post_ack", return_value=True) as ack,              mock.patch.object(b, "telegram_cfg", return_value=("tok", "chat")):
            code = b.main(["--send"])
        self.assertEqual(code, 1)
        self.assertEqual(send.call_count, 2)
        ack.assert_called_once()
        self.assertEqual(len(ack.call_args.args[1]), 15)

    def test_failed_ack_is_an_error_but_message_was_sent(self):
        code, send, ack = self.run_main([ITEM], ack_ok=False)
        self.assertEqual(code, 1)
        send.assert_called_once()


if __name__ == "__main__":
    unittest.main()
