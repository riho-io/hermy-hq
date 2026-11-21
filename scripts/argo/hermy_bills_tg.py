#!/usr/bin/env python3
"""Hermy HQ arved -> Telegram (Argo). No-agent Hermes cron, daily.

Asks hermy-hq which unpaid bills need a message today (3 days before / on or after the due date),
sends ONE Telegram message, then acknowledges exactly the items that were sent so each kind fires once.
Silent (prints nothing, exits 0) when nothing is due. The decision lives in the app, not here.

Secrets: INGEST_SECRET from env, else ~/.config/hermy-hq/ingest_secret. TELEGRAM_BOT_TOKEN and
TELEGRAM_HOME_CHANNEL from ~/.hermes/.env. Never logged.
  hermy_bills_tg.py          -> prints the message (dry run)
  hermy_bills_tg.py --send   -> sends to Telegram and acks
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = os.environ.get("HERMY_HQ_URL", "https://hermy-hq-tau.vercel.app").rstrip("/")
SECRET_FILE = Path.home() / ".config" / "hermy-hq" / "ingest_secret"
HERMES_ENV = Path.home() / ".hermes" / ".env"
TIMEOUT_S = 30


def load_env(path):
    out = {}
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


def get_secret():
    if os.environ.get("INGEST_SECRET"):
        return os.environ["INGEST_SECRET"]
    try:
        return SECRET_FILE.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def telegram_cfg():
    env = load_env(HERMES_ENV)
    return env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_HOME_CHANNEL")


def _req(method, path, secret, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE_URL + path, data=data, method=method,
        headers={"x-ingest-secret": secret, "Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read())


def fetch_due(secret):
    return _req("GET", "/api/ingest/bills-due", secret)


def post_ack(secret, ack):
    try:
        return _req("POST", "/api/ingest/bills-notified", secret, {"ack": ack}).get("ok") is True
    except Exception as e:  # noqa: BLE001
        print(f"Kinnitamine ebaõnnestus: {type(e).__name__}", file=sys.stderr)
        return False


def esc(s):
    """Telegram legacy Markdown: neutralise the characters that open entities."""
    out = str(s)
    for ch in ("\\", "_", "*", "`", "[", "]", "(", ")"):
        out = out.replace(ch, "\\" + ch)
    return out


def fmt_date(iso):
    return f"{iso[8:10]}.{iso[5:7]}.{iso[0:4]}"


def line(it):
    bits = [f"*{esc(it['supplier'])}* · {esc(it['amount'])} · {esc(it['group'])}",
            f"   tähtaeg {fmt_date(it['dueDate'])}"]
    if it.get("daysLeft", 0) < 0:
        bits[-1] += f" ({-it['daysLeft']} p hilinenud)"
    if it.get("reference"):
        bits.append(f"   viide {esc(it['reference'])}")
    if it.get("iban"):
        bits.append(f"   {esc(it['iban'])}")
    return "\n".join(bits)


def build_message(items):
    if not items:
        return None
    d3 = [i for i in items if i["kind"] == "d3"]
    due = [i for i in items if i["kind"] == "due"]
    parts = []
    if due:
        parts.append("🔴 *Arve tähtaeg TÄNA / möödas*\n\n" + "\n\n".join(line(i) for i in due))
    if d3:
        days = sorted({i["daysLeft"] for i in d3})
        label = "3 päeva pärast" if days == [3] else "peagi (kuni 3 päeva)"
        parts.append(f"🟠 *Arve tähtaeg {label}*\n\n" + "\n\n".join(line(i) for i in d3))
    return "\n\n".join(parts)


def send_telegram(text, token, chat_id):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method="POST"), timeout=TIMEOUT_S) as r:
            return r.status == 200
    except Exception as e:  # noqa: BLE001
        # Exception type only: urllib errors can embed the URL, which contains the bot token.
        print(f"Telegrami saatmine ebaõnnestus: {type(e).__name__}", file=sys.stderr)
        return False


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true")
    args = ap.parse_args(argv)

    secret = get_secret()
    if not secret:
        print("INGEST_SECRET puudub", file=sys.stderr)
        return 1
    try:
        data = fetch_due(secret)
    except Exception as e:  # noqa: BLE001
        print(f"Arvete lugemine ebaõnnestus: {type(e).__name__}", file=sys.stderr)
        return 1

    items = data.get("items", [])
    msg = build_message(items)
    if not msg:
        return 0
    if not args.send:
        print(msg)
        return 0

    token, chat = telegram_cfg()
    if not token or not chat:
        print("Telegrami võtmed puuduvad", file=sys.stderr)
        return 1
    if not send_telegram(msg, token, chat):
        return 1
    return 0 if post_ack(secret, [{"id": i["id"], "kind": i["kind"]} for i in items]) else 1


if __name__ == "__main__":
    sys.exit(main())
