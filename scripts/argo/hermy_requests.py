#!/usr/bin/env python3
"""Narrow executor: runs cron actions queued on hermy-hq (pull, never push into the server).

  GET  {BASE_URL}/api/ingest/hermes-requests   -> [{id, kind, payload}]
  POST same URL {id, status: running|done|failed, result?, error?}

Each row is claimed (running) before anything runs; 409 means another run owns it, so it is skipped.
The website validates payloads too, but this script trusts nothing from it: every payload is checked
again here (same rules as src/lib/hermes-actions.ts), the profile must be an existing cron folder and
the job id must exist in that profile's jobs.json. Commands are argv lists, never a shell string.

Silent when healthy; prints one line only when its own health flips (cron mails/delivers stdout).
"""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

import hermy_cron_sync as sync

URL = sync.BASE_URL + "/api/ingest/hermes-requests"
STATE_FILE = sync.HERMES / "hermy_requests_state.json"
LOG_FILE = sync.HERMES_HOME / "logs" / "hermy_requests.log"
# Telegram chat for deliver presets. Kept on the server only: the repo is public.
TARGET_FILE = sync.SECRET_FILE.parent / "telegram_target"
CMD_TIMEOUT_S = 60
MAX_RESULT = 4000
MAX_ERROR = 2000

read_secret = sync.read_secret

# Copy of src/lib/hermes-actions.ts. Keep both in step.
KINDS = {"cron.pause", "cron.resume", "cron.run", "cron.deliver", "cron.schedule"}
JOB_ID = re.compile(r"[0-9a-f]{12}")
PROFILE = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")  # starts alphanumeric: never read as a flag
PRESETS = {"raport", "hoiatus", "vait"}
SCHEDULE = re.compile(r"[0-9a-z*/,][0-9a-z*/, -]*")


class Reject(Exception):
    """Row cannot run; the message is what the website shows."""


def get_requests(secret):
    req = urllib.request.Request(URL, headers={"x-ingest-secret": secret}, method="GET")
    with urllib.request.urlopen(req, timeout=sync.TIMEOUT_S) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    if not isinstance(rows, list):
        raise ValueError("GET did not return a list")
    return rows


def report(rid, status, secret, result=None, error=None):
    payload = {"id": rid, "status": status}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    sync.push(URL, payload, secret)


def validate(row):
    """(kind, jobId, profile, extra) or Reject. fullmatch = JS ^...$ without the trailing-newline gap."""
    kind = row.get("kind")
    if kind not in KINDS:
        raise Reject("unknown kind")
    p = row.get("payload")
    if not isinstance(p, dict):
        raise Reject("invalid payload")
    job, profile = p.get("jobId"), p.get("profile")
    if not (isinstance(job, str) and JOB_ID.fullmatch(job) and isinstance(profile, str) and PROFILE.fullmatch(profile)):
        raise Reject("invalid payload")
    extra = None
    if kind == "cron.deliver":
        extra = p.get("preset")
        if extra not in PRESETS:
            raise Reject("invalid payload")
    elif kind == "cron.schedule":
        extra = p.get("schedule")
        if not (isinstance(extra, str) and 1 <= len(extra) <= 64 and SCHEDULE.fullmatch(extra)):
            raise Reject("invalid payload")
    return kind, job, profile, extra


def job_ids(profile):
    """Job ids of an existing profile; None when the profile has no cron folder."""
    d = sync.HERMES if profile == "default" else sync.HERMES_HOME / "profiles" / profile / "cron"
    if d not in sync.cron_dirs():
        return None
    try:
        data = json.loads((d / "jobs.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    if isinstance(jobs, dict):
        jobs = list(jobs.values())
    if not isinstance(jobs, list):
        return set()
    return {j.get("id") for j in jobs if isinstance(j, dict) and isinstance(j.get("id"), str)}


def read_target():
    try:
        return TARGET_FILE.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def build_args(kind, job, profile, extra):
    ids = job_ids(profile)
    if not ids or job not in ids:
        raise Reject("tundmatu cron")
    base = ["hermes"] + (["-p", profile] if profile != "default" else []) + ["cron"]
    if kind in ("cron.pause", "cron.resume", "cron.run"):
        opts = [kind.split(".")[1]]
    elif kind == "cron.schedule":
        opts = ["edit", "--schedule", extra]  # one argv element, spaces and all
    else:  # cron.deliver
        if extra == "vait":
            opts = ["edit", "--deliver", "local", "--failure-deliver", "local"]
        else:
            t = read_target()
            if not t:
                raise Reject("telegram_target puudub")
            tg = "telegram:" + t
            # '' clears the failure override, so failures follow --deliver.
            opts = (["edit", "--deliver", "local", "--failure-deliver", tg] if extra == "raport"
                    else ["edit", "--deliver", tg, "--failure-deliver", ""])
    # "--" is accepted by the CLI (argparse, checked 2026-11-11); the id is validated anyway.
    return base + opts + ["--", job]


def clean_output(stdout, stderr):
    text = "\n".join(x for x in (stdout or "", stderr or "") if x)
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("Command helper:")]
    return "\n".join(lines).strip()


def log_command(rid, args, code):
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"at": datetime.now(timezone.utc).isoformat(), "id": rid, "argv": args, "exit": code}) + "\n")


def run_row(row, secret):
    rid = row.get("id")
    if not isinstance(rid, str):
        return
    try:
        report(rid, "running", secret)
    except urllib.error.HTTPError as e:
        if e.code == 409:
            return  # someone else claimed it, or it is no longer runnable
        raise
    try:
        args = build_args(*validate(row))
    except Reject as e:
        report(rid, "failed", secret, error=str(e))
        return
    try:
        proc = subprocess.run(args, timeout=CMD_TIMEOUT_S, capture_output=True, text=True)
    except subprocess.TimeoutExpired:
        log_command(rid, args, "timeout")
        report(rid, "failed", secret, error=f"timeout {CMD_TIMEOUT_S}s")
        return
    except OSError as e:
        log_command(rid, args, "oserror")
        report(rid, "failed", secret, error=f"{type(e).__name__}: {str(e)[:200]}")
        return
    log_command(rid, args, proc.returncode)
    out = clean_output(proc.stdout, proc.stderr)
    if proc.returncode == 0:
        report(rid, "done", secret, result=out[:MAX_RESULT])
    else:
        report(rid, "failed", secret, error=(out or f"exit {proc.returncode}")[:MAX_ERROR])


def process(secret):
    for row in get_requests(secret):
        if isinstance(row, dict):
            run_row(row, secret)


def read_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"ok": True}


def write_state(ok, detail):
    STATE_FILE.write_text(json.dumps({"ok": ok, "detail": detail, "at": datetime.now(timezone.utc).isoformat()}), encoding="utf-8")


def main():
    secret = read_secret()
    prev = read_state()
    try:
        if not secret:
            raise RuntimeError("INGEST_SECRET puudub")
        process(secret)
        ok, detail = True, None
    except urllib.error.HTTPError as e:
        ok, detail = False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — reported once, never the secret
        ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"

    if ok != prev.get("ok", True):
        print("hermy-hq täitja taastus" if ok else f"hermy-hq täitja katki: {detail}")
    write_state(ok, detail)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
