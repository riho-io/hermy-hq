#!/usr/bin/env python3
"""Push Hermes cron state from Argo to hermy-hq (Jarvis dashboard).

Runs as a no-agent Hermes cron every 5 min. Reads, never writes, Hermes state:
  ~/.hermes/cron/jobs.json       -> full job list (snapshot)
  ~/.hermes/cron/executions.db   -> runs claimed in the last RUN_WINDOW_H hours
POSTs to {HERMY_HQ_URL}/api/ingest/hermes-cron with header x-ingest-secret.

Reports: the delivered text of every run of every job, in every profile (~/.hermes/cron and
~/.hermes/profiles/*/cron), is POSTed from <cron>/output/<job>/<run>.md to /api/ingest/hermes-report,
except jobs listed in ~/.config/hermy-hq/report_exclude (one job id per line, # comments).
Agent runs are cut to their "## Response" part (the prompt is never sent), [SILENT] runs are skipped.
Sent runs are remembered in hermy_report_state.json.

Secret: INGEST_SECRET from Doppler hermes/prd, else ~/.config/hermy-hq/ingest_secret (chmod 600).
Env: HERMY_HQ_URL (optional).

Stdout is delivered to Telegram by Hermes, so it prints ONLY when sync state flips
(ok -> failing, failing -> ok). A healthy run prints nothing.
"""
import json
import os
import re
import sqlite3
import time
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERMES_HOME = Path.home() / ".hermes"
HERMES = HERMES_HOME / "cron"
STATE_FILE = HERMES / "hermy_sync_state.json"
SECRET_FILE = Path.home() / ".config" / "hermy-hq" / "ingest_secret"
BASE_URL = os.environ.get("HERMY_HQ_URL", "https://hermy-hq-tau.vercel.app").rstrip("/")
URL = BASE_URL + "/api/ingest/hermes-cron"
REPORT_URL = BASE_URL + "/api/ingest/hermes-report"
REPORT_EXCLUDE_FILE = Path.home() / ".config" / "hermy-hq" / "report_exclude"
REPORT_STATE_FILE = HERMES / "hermy_report_state.json"
RUN_WINDOW_H = 2       # re-send recent runs so running -> completed transitions are picked up
MAX_RUNS = 500         # must match the route's limit
REPORTS_PER_POST = 20  # route accepts 50; small batches keep each POST well under its 2 MB cap
REPORTS_PER_RUN = 40   # a backlog drains over a few runs instead of one long one
MAX_REPORT_CHARS = 100_000  # route clips at the same length
MIN_AGE_S = 60         # skip output files Hermes may still be writing
TIMEOUT_S = 20

RUN_STEM = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$")
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _opt_str(v):
    return v if isinstance(v, str) and v else None


def load_jobs():
    """Jobs of every profile (default first; the first profile wins a duplicate id).

    A broken or half-written jobs.json is skipped like in load_report_sources, but when no
    profile could be read at all this raises: the route deletes jobs missing from the snapshot,
    so an empty list from a read failure would wipe the dashboard.
    """
    out = []
    seen = set()
    read_any = False
    for d in cron_dirs():
        try:
            data = json.loads((d / "jobs.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        jobs = data.get("jobs", []) if isinstance(data, dict) else data
        if isinstance(jobs, dict):
            jobs = list(jobs.values())
        if not isinstance(jobs, list):
            continue
        read_any = True
        profile = "default" if d == HERMES else d.parent.name
        for j in jobs:
            jid = j.get("id") if isinstance(j, dict) else None
            if not (isinstance(jid, str) and JOB_ID.match(jid)) or jid in seen:
                continue
            seen.add(jid)
            sched = j.get("schedule")
            out.append({
                "id": jid,
                "name": j.get("name") or jid,
                "schedule": j.get("schedule_display") or (sched.get("display") if isinstance(sched, dict) else str(sched or "")),
                "state": j.get("state") or "unknown",
                "enabled": bool(j.get("enabled", True)),
                "noAgent": bool(j.get("no_agent", False)),
                "lastRunAt": j.get("last_run_at"),
                "lastStatus": j.get("last_status"),
                "lastError": j.get("last_error"),
                "failureStreak": int(j.get("failure_streak") or 0),
                "nextRunAt": j.get("next_run_at"),
                "profile": profile,
                "deliver": _opt_str(j.get("deliver")),
                "failureDeliver": _opt_str(j.get("failure_deliver")),
            })
    if not read_any:
        raise FileNotFoundError("no readable jobs.json in any profile")
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


def extract_body(text):
    """The delivered part of an output file, or None when there is nothing to show.

    Agent run: header, "## Prompt" (which embeds the previous run's output), "## Response", reply.
    Script run: header with "**Mode:** no_agent", a "---" line, then stdout.
    """
    lines = text.splitlines()
    if any(l.startswith("**Mode:** no_agent") for l in lines[:10]):
        try:
            start = lines.index("---") + 1
        except ValueError:
            return None
    else:
        # The reply starts at the first "## Response" after "**Response Characters:**"; the prompt above
        # may quote older reports, so a heading search from the top could land inside it.
        marker = next((i for i, l in enumerate(lines) if l.startswith("**Response Characters:**")), -1)
        start = next((i + 1 for i in range(marker + 1, len(lines)) if lines[i].strip() == "## Response"), None)
        if start is None:
            return None
    body = "\n".join(lines[start:]).strip()
    if not body or body == "[SILENT]":
        return None
    return body[:MAX_REPORT_CHARS]


def cron_dirs():
    """Default profile first, then every named profile that has a cron folder."""
    return [HERMES] + sorted(p for p in (HERMES_HOME / "profiles").glob("*/cron") if p.is_dir())


def load_report_sources():
    """{job_id: (output folder, job name)} across all profiles; the first profile wins a duplicate id."""
    out = {}
    for d in cron_dirs():
        try:
            data = json.loads((d / "jobs.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # a profile without crons, or a half-written file: skip it, never fail the sync
        jobs = data.get("jobs", []) if isinstance(data, dict) else data
        if isinstance(jobs, dict):
            jobs = list(jobs.values())
        if not isinstance(jobs, list):
            continue  # valid JSON of the wrong shape: skip this profile too
        for j in jobs:
            jid = j.get("id") if isinstance(j, dict) else None
            if isinstance(jid, str) and JOB_ID.match(jid) and jid not in out:
                out[jid] = (d / "output" / jid, j.get("name") or jid)
    return out


def load_report_exclude():
    try:
        raw = REPORT_EXCLUDE_FILE.read_text(encoding="utf-8")
    except OSError:
        return set()
    ids = (l.split("#", 1)[0].strip() for l in raw.splitlines())
    return {i for i in ids if JOB_ID.match(i)}


def collect_reports(sources, sent, now=None):
    """(reports to send, run keys to mark as handled without sending), oldest first, capped per run."""
    now = now or time.time()
    reports, skipped = [], []
    for job_id, (folder, name) in sources.items():
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.md")):
            key = f"{job_id}/{path.stem}"
            if key in sent or not RUN_STEM.match(path.stem) or now - path.stat().st_mtime < MIN_AGE_S:
                continue
            body = extract_body(path.read_text(encoding="utf-8", errors="replace"))
            if body is None:
                skipped.append(key)
                continue
            # The stem is Argo's local time; astimezone() attaches the server's offset (Europe/Tallinn).
            run_at = datetime.strptime(path.stem, "%Y-%m-%d_%H-%M-%S").astimezone()
            reports.append({
                "key": key,
                "jobId": job_id,
                "run": path.stem,
                "jobName": name,
                "runAt": run_at.isoformat(),
                "body": body,
            })
    reports.sort(key=lambda r: r["runAt"])
    return reports[:REPORTS_PER_RUN], skipped


def read_report_state():
    try:
        return set(json.loads(REPORT_STATE_FILE.read_text(encoding="utf-8")).get("sent", []))
    except (OSError, ValueError):
        return set()


def write_report_state(sent):
    REPORT_STATE_FILE.write_text(json.dumps({"sent": sorted(sent)}), encoding="utf-8")


def sync_reports(secret):
    exclude = load_report_exclude()
    sources = {k: v for k, v in load_report_sources().items() if k not in exclude}
    sent = read_report_state()
    reports, skipped = collect_reports(sources, sent)
    sent.update(skipped)
    try:
        for i in range(0, len(reports), REPORTS_PER_POST):
            batch = reports[i:i + REPORTS_PER_POST]
            push(REPORT_URL, {"source": "argo", "reports": [{k: v for k, v in r.items() if k != "key"} for r in batch]}, secret)
            sent.update(r["key"] for r in batch)
    finally:
        # Save progress even when a later batch fails, so the next run resumes instead of re-sending.
        write_report_state(sent)
    return len(reports)


def push(url, payload, secret):
    req = urllib.request.Request(
        url,
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
    except (OSError, ValueError):  # ValueError covers UnicodeDecodeError
        return None


def main():
    secret = read_secret()
    prev = read_state()
    try:
        if not secret:
            raise RuntimeError("INGEST_SECRET puudub")
        jobs = load_jobs()
        push(URL, {"source": "argo", "jobs": jobs, "runs": load_runs()}, secret)
        sync_reports(secret)
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
