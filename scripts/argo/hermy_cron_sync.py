#!/usr/bin/env python3
"""Push Hermes cron state from Argo to hermy-hq (Jarvis dashboard).

Runs as a no-agent Hermes cron every 5 min. Reads, never writes, Hermes state:
  ~/.hermes/cron/jobs.json       -> full job list (snapshot)
  ~/.hermes/cron/executions.db   -> runs claimed in the last RUN_WINDOW_H hours
POSTs to {HERMY_HQ_URL}/api/ingest/hermes-cron with header x-ingest-secret.

Secret: INGEST_SECRET from Doppler hermes/prd, else ~/.config/hermy-hq/ingest_secret (chmod 600).
Env: HERMY_HQ_URL (optional).

Stdout is delivered to Telegram by Hermes, so it prints ONLY when sync state flips
(ok -> failing, failing -> ok). A healthy run prints nothing.
"""
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERMES = Path.home() / ".hermes" / "cron"
STATE_FILE = HERMES / "hermy_sync_state.json"
SECRET_FILE = Path.home() / ".config" / "hermy-hq" / "ingest_secret"
URL = os.environ.get("HERMY_HQ_URL", "https://hermy-hq-tau.vercel.app").rstrip("/") + "/api/ingest/hermes-cron"
RUN_WINDOW_H = 2       # re-send recent runs so running -> completed transitions are picked up
MAX_RUNS = 500         # must match the route's limit
TIMEOUT_S = 20


def load_jobs():
    data = json.loads((HERMES / "jobs.json").read_text(encoding="utf-8"))
    jobs = data["jobs"] if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    out = []
    for j in jobs:
        sched = j.get("schedule")
        out.append({
            "id": j["id"],
            "name": j.get("name") or j["id"],
            "schedule": j.get("schedule_display") or (sched.get("display") if isinstance(sched, dict) else str(sched or "")),
            "state": j.get("state") or "unknown",
            "enabled": bool(j.get("enabled", True)),
            "noAgent": bool(j.get("no_agent", False)),
            "lastRunAt": j.get("last_run_at"),
            "lastStatus": j.get("last_status"),
            "lastError": j.get("last_error"),
            "failureStreak": int(j.get("failure_streak") or 0),
            "nextRunAt": j.get("next_run_at"),
        })
    return out


def load_runs():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=RUN_WINDOW_H)
    con = sqlite3.connect(f"file:{HERMES / 'executions.db'}?mode=ro", uri=True)
    try:
        # claimed_at is ISO with offset; compare on parsed instants in Python, not as strings.
        rows = con.execute(
            "select id, job_id, status, claimed_at, started_at, finished_at, error, delivery_outcome "
            "from executions order by claimed_at desc limit ?", (MAX_RUNS,)
        ).fetchall()
    finally:
        con.close()
    out = []
    for rid, job_id, status, claimed, started, finished, error, outcome in rows:
        if datetime.fromisoformat(claimed) < cutoff:
            continue
        out.append({
            "id": rid,
            "jobId": job_id,
            "status": status,
            "startedAt": started or claimed,
            "finishedAt": finished,
            "error": error,
            "deliveryOutcome": outcome,
        })
    return out


def push(payload, secret):
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "x-ingest-secret": secret},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return resp.status


def read_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": True}


def write_state(ok, detail):
    STATE_FILE.write_text(json.dumps({"ok": ok, "detail": detail, "at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")


def read_secret():
    # Doppler first; fallback file (chmod 600) until the key is moved into Doppler.
    secret = os.environ.get("INGEST_SECRET")
    if secret:
        return secret.strip()
    try:
        return SECRET_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def main():
    secret = read_secret()
    prev = read_state()
    try:
        if not secret:
            raise RuntimeError("INGEST_SECRET puudub")
        payload = {"source": "argo", "jobs": load_jobs(), "runs": load_runs()}
        push(payload, secret)
        ok, detail = True, None
    except urllib.error.HTTPError as e:
        ok, detail = False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — any failure is reported once, never the secret
        ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"

    if ok != prev.get("ok", True):
        print("hermy-hq sünk taastus" if ok else f"hermy-hq sünk katki: {detail}")
    write_state(ok, detail)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
