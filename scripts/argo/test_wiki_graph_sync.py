import tempfile
import unittest
from pathlib import Path

import wiki_graph_sync as w


class ExtractLinks(unittest.TestCase):
    def test_forms(self):
        text = "[[A]] [[b|alias]] [[C#Heading]] [[dir/D]] [[A]] [[img.png]]"
        self.assertEqual(w.extract_links(text), ["A", "b", "C", "dir/D"])

    def test_skips_code(self):
        text = "x\n```\n[[InFence]]\n```\n`[[Inline]]` [[Real]]"
        self.assertEqual(w.extract_links(text), ["Real"])


class Resolve(unittest.TestCase):
    ids = ["projects/aim/aim.md", "aim.md", "concepts/RLS.md", "deep/x/RLS.md"]

    def test_exact_path_wins(self):
        self.assertEqual(w.Resolver(self.ids).resolve("projects/aim/aim"), "projects/aim/aim.md")

    def test_basename_shortest_path(self):
        self.assertEqual(w.Resolver(self.ids).resolve("aim"), "aim.md")
        self.assertEqual(w.Resolver(self.ids).resolve("rls"), "concepts/RLS.md")

    def test_partial_path_suffix(self):
        self.assertEqual(w.Resolver(self.ids).resolve("x/RLS"), "deep/x/RLS.md")

    def test_missing(self):
        self.assertIsNone(w.Resolver(self.ids).resolve("Nope"))


class BuildGraph(unittest.TestCase):
    def test_vault(self):
        with tempfile.TemporaryDirectory() as d:
            v = Path(d)
            (v / "projects").mkdir()
            (v / ".stversions").mkdir()
            (v / "projects" / "p.md").write_text("[[root]] [[Ghost]]", encoding="utf-8")
            (v / "root.md").write_text("[[p]]", encoding="utf-8")
            (v / ".stversions" / "old.md").write_text("[[root]]", encoding="utf-8")
            (v / "NEXT.md.bak").write_text("[[root]]", encoding="utf-8")
            g = w.build_graph(v, {"root.md": "argo"})
        ids = [n["id"] for n in g["notes"]]
        self.assertEqual(sorted(ids), ["projects/p.md", "root.md"])
        p = next(n for n in g["notes"] if n["id"] == "projects/p.md")
        self.assertEqual(p["folder"], "projects")
        self.assertEqual(p["title"], "p")
        self.assertEqual(p["links"], ["root.md"])
        self.assertIsNone(p["editedBy"])
        root = next(n for n in g["notes"] if n["id"] == "root.md")
        self.assertEqual(root["folder"], "")
        self.assertEqual(root["editedBy"], "argo")
        self.assertEqual(g["unresolved"], [{"from": "projects/p.md", "target": "Ghost"}])


class ValidId(unittest.TestCase):
    def test_rejects_and_accepts(self):
        self.assertTrue(w.valid_id("projects/a.md"))
        self.assertFalse(w.valid_id("a\\b.md"))
        self.assertFalse(w.valid_id("a\tb.md"))
        self.assertFalse(w.valid_id("a\udcffb.md"))
        self.assertFalse(w.valid_id("/a.md"))
        self.assertFalse(w.valid_id("x/../a.md"))
        self.assertFalse(w.valid_id(".md"))


class ListNotes(unittest.TestCase):
    def test_skips_invalid_ids(self):
        with tempfile.TemporaryDirectory() as d:
            v = Path(d)
            (v / ".md").write_text("x", encoding="utf-8")
            (v / "ok.md").write_text("x", encoding="utf-8")
            long_dir = v / ("d" * 150) / ("e" * 150)
            long_dir.mkdir(parents=True)
            (long_dir / "n.md").write_text("x", encoding="utf-8")
            ids = w.list_notes(v)
        self.assertEqual(ids, ["ok.md"])


class WriteState(unittest.TestCase):
    def test_creates_missing_dir(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "nope" / "cron" / "state.json"
            old = w.STATE_FILE
            w.STATE_FILE = f
            try:
                w.write_state(True, None)
                self.assertTrue(f.exists())
            finally:
                w.STATE_FILE = old


class PushNoRedirect(unittest.TestCase):
    def test_redirect_not_followed(self):
        import http.server
        import threading
        import urllib.error

        seen = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append(self.path)
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(302)
                self.send_header("Location", "/elsewhere")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        old = w.URL
        w.URL = f"http://127.0.0.1:{srv.server_port}/ingest"
        try:
            with self.assertRaises(urllib.error.HTTPError) as cm:
                w.push({"a": 1}, "s")
            self.assertEqual(cm.exception.code, 302)
            self.assertEqual(seen, ["/ingest"])
        finally:
            w.URL = old
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
