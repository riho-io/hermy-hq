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


if __name__ == "__main__":
    unittest.main()
