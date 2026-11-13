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
    if gateway_ok is False:  # None = teadmata (nt bus-viga), pole häire
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


def step(prev, bad_now):
    """Debounce: häire alles 2. järjestikusel halval jooksul; taastumine kohe.

    prev = (kinnitatud, nähtud eelmisel jooksul). Tagastab (kinnitatud, nähtud, teated).
    """
    prev_bad, prev_seen = prev
    confirmed = {k for k in bad_now if k in prev_seen or k in prev_bad}
    if "nous_login" in bad_now and "nous_balance" in prev_bad:
        # Välja logituna on saldo teadmata — ära teata "taastus".
        confirmed.add("nous_balance")
    seen = set(bad_now)
    if "nous_balance" in confirmed:
        seen.add("nous_balance")
    return confirmed, seen, transitions(prev_bad, confirmed)


def health_payload(gateway_ok, nous_logged_in, balance, now):
    # zod skeemis on gatewayOk boolean: teadmata (None) loetakse payload'is korras olevaks.
    return {"source": "argo", "checkedAt": now.isoformat(),
            "gatewayOk": gateway_ok is not False, "nousLoggedIn": nous_logged_in,
            "nousBalance": balance}


def _run(cmd, timeout=40):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout + r.stderr
    except Exception as e:  # noqa: BLE001 — rike = "ei tööta", mitte krahh
        return str(e)


def check_gateway():
    if not os.environ.get("XDG_RUNTIME_DIR"):  # cron'is puudub; ilma selleta pole user-bus'i
        os.environ["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"
    out = _run(["systemctl", "--user", "is-active", "hermes-gateway"])
    if "Failed to connect to bus" in out:
        return None
    return out.strip() == "active"


def check_nous_login():
    return "nous: logged in" in _run([str(HOME / ".local" / "bin" / "hermes"),
                                      "auth", "status", "nous"])


def check_nous_balance():
    scripts = str(HOME / ".hermes" / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    try:
        from konto_check import nous_balance
        value = nous_balance()[0]
    except KeyboardInterrupt:
        raise
    except BaseException:  # noqa: BLE001 — konto_check võib sys.exit'ida; teadmata saldo pole häire
        return None
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def load_state():
    """Tagastab (kinnitatud, nähtud). Vana formaat {"bad": [...]} -> seen = bad."""
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return set(), set()
        bad = set(data.get("bad", []))
        return bad, set(data.get("seen", bad))
    except (OSError, ValueError, TypeError):
        return set(), set()


def save_state(bad, seen):
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(
            json.dumps({"bad": sorted(bad), "seen": sorted(seen)}), encoding="utf-8")
    except OSError as e:
        print(f"olekut ei salvestatud: {type(e).__name__}", file=sys.stderr)


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
    bad_now = evaluate(gateway_ok, logged_in, balance)
    cur, seen, msgs = step(load_state(), bad_now)
    sent = True
    if msgs:
        try:
            send_telegram("\n".join(msgs))
        except Exception as e:  # noqa: BLE001 - token on URL-is, trüki ainult tüüp
            print(f"telegram ebaõnnestus: {type(e).__name__}", file=sys.stderr)
            sent = False
    if sent:  # saatmise rike -> olekut ei salvestata, järgmine jooks proovib uuesti
        save_state(cur, seen)
    push_health(health_payload(gateway_ok, logged_in, balance, datetime.now(timezone.utc)))
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"{stamp} bad={sorted(cur)} teateid={len(msgs)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
