#!/usr/bin/env python3
"""Push the Syncthing-shared wiki graph from Argo to hermy-hq (Jarvis "Masin").

Runs as a no-agent Hermes cron every 60 min. Reads, never writes, the vault:
  ~/wiki/**/*.md  -> path, title, top folder, mtime, resolved [[links]]  (never note content)
  Syncthing REST (127.0.0.1:8384) -> per file: which device modified it last; when PC was last seen.
POSTs to {HERMY_HQ_URL}/api/ingest/wiki-graph with header x-ingest-secret.

Device mapping: Syncthing's own device = Argo; any other device = PC (the vault has exactly two).
Secret: INGEST_SECRET (Doppler hermes/prd), else ~/.config/hermy-hq/ingest_secret (chmod 600).
Env: HERMY_HQ_URL, WIKI_VAULT (optional).

Stdout is delivered by Hermes, so it prints ONLY when sync state flips. --dry-run prints counts, sends nothing.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

VAULT = Path(os.environ.get("WIKI_VAULT", str(Path.home() / "wiki"))).expanduser()
STATE_FILE = Path.home() / ".hermes" / "cron" / "wiki_graph_sync_state.json"
SECRET_FILE = Path.home() / ".config" / "hermy-hq" / "ingest_secret"
SYNCTHING_CONFIG = Path.home() / ".local" / "state" / "syncthing" / "config.xml"
SYNCTHING_URL = "http://127.0.0.1:8384"
URL = os.environ.get("HERMY_HQ_URL", "https://hermy-hq-tau.vercel.app").rstrip("/") + "/api/ingest/wiki-graph"
SKIP_DIRS = {".stversions", ".git", ".obsidian", ".trash", ".skills"}
MAX_NOTES = 3000          # must match the route's limit
MAX_LINKS_PER_NOTE = 500  # must match the route's limit
TIMEOUT_S = 30

FENCE_RE = re.compile(r"^```.*?^```", re.S | re.M)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
LINK_RE = re.compile(r"\[\[([^\]\|#\n]+)(?:#[^\]\|\n]*)?(?:\|[^\]\n]*)?\]\]")
ATTACHMENT_RE = re.compile(r"\.(png|jpe?g|gif|svg|webp|pdf|canvas|base|mp4|mp3)$", re.I)


def extract_links(text):
    """[[Target]], [[Target|alias]], [[Target#h]] -> 'Target'; code and attachments skipped; order kept, deduped."""
    text = INLINE_CODE_RE.sub("", FENCE_RE.sub("", text))
    out = []
    for m in LINK_RE.finditer(text):
        t = m.group(1).strip()
        if t and not ATTACHMENT_RE.search(t) and t not in out:
            out.append(t)
    return out


class Resolver:
    """Obsidian-style: exact vault path first, else filename (shortest path wins). Case-insensitive."""

    def __init__(self, ids):
        self.exact = {i[:-3].lower(): i for i in ids}
        self.by_name = {}
        for i in sorted(ids, key=lambda s: (s.count("/"), len(s), s)):
            self.by_name.setdefault(i[:-3].rsplit("/", 1)[-1].lower(), []).append(i)

    def resolve(self, target):
        key = target.strip().replace("\\", "/").lstrip("/")
        if key.lower().endswith(".md"):
            key = key[:-3]
        key = key.lower()
        if key in self.exact:
            return self.exact[key]
        candidates = self.by_name.get(key.rsplit("/", 1)[-1], [])
        if "/" in key:
            candidates = [c for c in candidates if c[:-3].lower().endswith("/" + key)]
        return candidates[0] if candidates else None


def list_notes(vault):
    ids = []
    for p in vault.rglob("*.md"):
        rel = p.relative_to(vault)
        if any(part in SKIP_DIRS for part in rel.parts[:-1]) or ".bak" in p.name:
            continue
        ids.append(rel.as_posix())
    return sorted(ids)


def build_graph(vault, edited_by):
    ids = list_notes(vault)[:MAX_NOTES]
    resolver = Resolver(ids)
    notes, unresolved = [], []
    for i in ids:
        path = vault / i
        text = path.read_text(encoding="utf-8", errors="replace")
        links = []
        for t in extract_links(text):
            r = resolver.resolve(t)
            if r is None:
                unresolved.append({"from": i, "target": t[:200]})
            elif r != i and r not in links:
                links.append(r)
        notes.append({
            "id": i,
            "title": i.rsplit("/", 1)[-1][:-3],
            "folder": i.split("/", 1)[0] if "/" in i else "",
            "mtime": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            "links": links[:MAX_LINKS_PER_NOTE],
            "editedBy": edited_by.get(i),
        })
    return {"notes": notes, "unresolved": unresolved[:10_000]}


def syncthing_info(ids):
    """({note_id: 'pc'|'argo'|None}, pc_last_seen_iso|None). Any Syncthing failure -> ({}, None); sync goes on."""
    try:
        root = ET.parse(SYNCTHING_CONFIG).getroot()
        key = root.findtext("gui/apikey")
        folder = next(
            f.get("id") for f in root.iter("folder")
            if Path(f.get("path", "")).expanduser().resolve() == VAULT.resolve()
        )

        def get(path):
            req = urllib.request.Request(SYNCTHING_URL + path, headers={"X-API-Key": key})
            with urllib.request.urlopen(req, timeout=5) as r:
                return json.load(r)

        me = get("/rest/system/status")["myID"]
        edited = {}
        for i in ids:
            q = urllib.parse.urlencode({"folder": folder, "file": i})
            by = get(f"/rest/db/file?{q}").get("global", {}).get("modifiedBy", "")
            edited[i] = None if not by else ("argo" if me.startswith(by) else "pc")

        conns = get("/rest/system/connections").get("connections", {})
        stats = get("/rest/stats/device")
        others = [d for d in stats if d != me]
        if any(conns.get(d, {}).get("connected") for d in others):
            pc_seen = datetime.now(timezone.utc).isoformat()
        else:
            seen = sorted(stats[d].get("lastSeen", "") for d in others)
            pc_seen = seen[-1] if seen and not seen[-1].startswith("1970") else None
        return edited, pc_seen
    except Exception:  # noqa: BLE001 — Syncthing is optional colour info, never a reason to skip the sync
        return {}, None


def read_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_state(ok, detail):
    STATE_FILE.write_text(json.dumps({"ok": ok, "detail": detail, "at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")


def read_secret():
    secret = os.environ.get("INGEST_SECRET")
    if secret:
        return secret.strip()
    try:
        return SECRET_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def push(payload, secret):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST", headers={"Content-Type": "application/json", "x-ingest-secret": secret})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        r.read()


def make_payload():
    ids = list_notes(VAULT)
    edited, pc_seen = syncthing_info(ids)
    graph = build_graph(VAULT, edited)
    return {"source": "argo", **graph, "pcLastSeenAt": pc_seen}


def main():
    if "--dry-run" in sys.argv:
        p = make_payload()
        links = sum(len(n["links"]) for n in p["notes"])
        by = {k: sum(1 for n in p["notes"] if n["editedBy"] == k) for k in ("pc", "argo", None)}
        print(f"notes={len(p['notes'])} links={links} unresolved={len(p['unresolved'])} editedBy={by} pcLastSeen={p['pcLastSeenAt']} bytes={len(json.dumps(p))}")
        return 0

    secret = read_secret()
    prev = read_state()
    try:
        if not secret:
            raise RuntimeError("INGEST_SECRET puudub")
        push(make_payload(), secret)
        ok, detail = True, None
    except urllib.error.HTTPError as e:
        ok, detail = False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — any failure is reported once, never the secret
        ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"

    if ok != prev.get("ok", True):
        print("wiki graafi sünk taastus" if ok else f"wiki graafi sünk katki: {detail}")
    write_state(ok, detail)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
