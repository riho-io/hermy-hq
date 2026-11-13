#!/usr/bin/env python3
"""Argo kriitiline valvur — Telegrami AINULT siis, kui Argo ise ei tööta.

Jookseb kasutaja crontabist (mitte Hermese cronist): kui gateway on maas, ei jookse
ükski Hermese cron, seega peab see valvur olema gateway'st sõltumatu.
Teatab ainult oleku muutusel (katki / taastus), mitte igal jooksul.
Lisaks push'ib tervise hermy-hq-sse (terviseriba). Push'i rike pole kriitiline:
hermy-hq sünki valvur (c51d63388b48) ja riba „VPS vaikib“ katavad selle.

Kutse (crontab): doppler run --project hermes --config prd -- python3 argo_kriitiline.py
"""
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
STATE_FILE = HOME / ".hermes" / "cron" / "argo_kriitiline_state.json"
SECRET_FILE = HOME / ".config" / "hermy-hq" / "ingest_secret"
HEALTH_URL = os.environ.get(
    "ARGO_HEALTH_URL", "https://hermy-hq-tau.vercel.app/api/ingest/argo-health")
CHAT_ID = "8113335732"
NOUS_BALANCE_MIN = 1.0

FIX = {
    "gateway": "Hermese gateway ei jookse. Paranda: ssh hermes → "
               "systemctl --user restart hermes-secrets hermes-gateway",
    "nous_login": "Nous on välja logitud. Paranda: ssh hermes → hermes model → Nous",
    "nous_balance": "Nousi saldo on otsas. Täienda: https://portal.nousresearch.com/billing",
}
OK_LABEL = {
    "gateway": "gateway jookseb",
    "nous_login": "Nousi sisselogimine korras",
    "nous_balance": "Nousi saldo korras",
}


def evaluate(gateway_ok, nous_logged_in, balance):
    bad = set()
    if not gateway_ok:
        bad.add("gateway")
    if not nous_logged_in:
        bad.add("nous_login")
    elif balance is not None and balance < NOUS_BALANCE_MIN:
        bad.add("nous_balance")
    return bad


def transitions(prev, cur):
    msgs = [f"🚨 Argo ei tööta — {FIX[k]}" for k in sorted(cur - prev)]
    msgs += [f"✅ Argo taastus: {OK_LABEL[k]}" for k in sorted(prev - cur)]
    return msgs


def health_payload(gateway_ok, nous_logged_in, balance, now):
    return {"source": "argo", "checkedAt": now.isoformat(),
            "gatewayOk": gateway_ok, "nousLoggedIn": nous_logged_in,
            "nousBalance": balance}


def _run(cmd, timeout=40):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout + r.stderr
    except Exception as e:  # noqa: BLE001 — rike = "ei tööta", mitte krahh
        return str(e)


def check_gateway():
    return _run(["systemctl", "--user", "is-active", "hermes-gateway"]).strip() == "active"


def check_nous_login():
    return "nous: logged in" in _run([str(HOME / ".local" / "bin" / "hermes"),
                                      "auth", "status", "nous"])


def check_nous_balance():
    sys.path.insert(0, str(HOME / ".hermes" / "scripts"))
    try:
        from konto_check import nous_balance
        return nous_balance()[0]
    except Exception:  # noqa: BLE001 — teadmata saldo pole häire
        return None


def load_state():
    try:
        return set(json.loads(STATE_FILE.read_text(encoding="utf-8")).get("bad", []))
    except (OSError, ValueError):
        return set()


def save_state(bad):
    STATE_FILE.write_text(json.dumps({"bad": sorted(bad)}), encoding="utf-8")


def send_telegram(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN puudub (kas doppler run?)")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": CHAT_ID, "text": text}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20):
        pass


def push_health(payload):
    try:
        secret = os.environ.get("INGEST_SECRET") or SECRET_FILE.read_text(encoding="utf-8").strip()
        req = urllib.request.Request(
            HEALTH_URL, data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-ingest-secret": secret},
            method="POST")
        with urllib.request.urlopen(req, timeout=60):
            pass
    except Exception as e:  # noqa: BLE001 — ainult logi, mitte Telegram
        print(f"push ebaõnnestus: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)


def main():
    gateway_ok = check_gateway()
    logged_in = check_nous_login()
    balance = check_nous_balance() if logged_in else None
    cur = evaluate(gateway_ok, logged_in, balance)
    prev = load_state()
    msgs = transitions(prev, cur)
    if msgs:
        # Saatmise rike -> olekut ei salvestata, järgmine jooks proovib uuesti.
        send_telegram("\n".join(msgs))
    save_state(cur)
    push_health(health_payload(gateway_ok, logged_in, balance, datetime.now(timezone.utc)))
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"{stamp} bad={sorted(cur)} teateid={len(msgs)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
