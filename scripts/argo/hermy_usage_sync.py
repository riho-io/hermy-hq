#!/usr/bin/env python3
"""Push Hermes usage (sessions, tokens, cost per profile per day) from Argo to hermy-hq /kulu.

Runs as a no-agent Hermes cron, hourly. Read-only on Hermes:
  - <profile>/state.db: sessions + session_model_usage (opened with mode=ro)
  - <profile>/config.yaml, profile.yaml, cron/jobs.json: model, display name, cron count
  - `hermes profile list`: gateway state (the only reliable source; liveness involves the multiplexer)
  - ~/.hermes/cron/cost_weekly_state.json: last account balance (written by cost_weekly.py)

Every run recomputes the last DAYS days (Europe/Tallinn) and the route upserts them by
(source, profile, day), so re-running is safe. A session is counted on the day it started.

Cost follows Hermes' own stored values (as `hermes insights` does): session_model_usage rows plus the
residual of the session aggregate. A part with tokens but cost_status unknown/missing is "unpriced";
zero-token sessions are "empty" (insights counts those as unknown too, but they cost nothing).
Providers named claude-subscription-* are a subscription, not paid API: never "unpriced", and their
notional estimate is kept apart from the paid cost.

Secret: INGEST_SECRET from env (Doppler hermes/prd), else ~/.config/hermy-hq/ingest_secret.
Never logged. Stdout only on a health flip (Hermes delivers stdout). --dry-run prints a summary,
posts nothing and writes no state.
"""

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERMES_HOME = Path.home() / ".hermes"
STATE_FILE = HERMES_HOME / "cron" / "hermy_usage_state.json"
SECRET_FILE = Path.home() / ".config" / "hermy-hq" / "ingest_secret"
BASE_URL = os.environ.get("HERMY_HQ_URL", "https://hermy-hq-tau.vercel.app").rstrip("/")
URL = BASE_URL + "/api/ingest/hermes-usage"
TZ = ZoneInfo("Europe/Tallinn")
DAYS = 35          # route keeps what it gets; 35 covers the page's 30-day view with margin
TIMEOUT_S = 30
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
PLATFORM_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
KNOWN_COST = {"estimated", "actual", "included"}


def is_subscription(provider):
    return isinstance(provider, str) and provider.startswith("claude-subscription")


def _cost(row):
    """USD of one usage row, or None when Hermes has no pricing for it."""
    if row.get("cost_status") not in KNOWN_COST:
        return None
    actual = float(row.get("actual_cost_usd") or 0.0)
    return actual if actual > 0 else float(row.get("estimated_cost_usd") or 0.0)


def _part(model, provider, counts, cost):
    return {"model": (model or "unknown")[:100], "provider": provider or None,
            **{k: int(counts.get(k) or 0) for k in TOKEN_KEYS},
            "tokens": sum(int(counts.get(k) or 0) for k in TOKEN_KEYS), "cost": cost}


def session_parts(session, usage_rows):
    """Per-model parts of one session: its session_model_usage rows plus what the aggregate row
    holds beyond them (legacy sessions, interrupted writes), mirroring agent/insights.py."""
    parts = [_part(r["model"], r.get("billing_provider"), r, _cost(r)) for r in usage_rows]
    totals = {k: sum(int(r.get(k) or 0) for r in usage_rows) for k in TOKEN_KEYS}
    residual = {k: max(0, int(session.get(k) or 0) - totals[k]) for k in TOKEN_KEYS}
    used_cost = sum(float(r.get("estimated_cost_usd") or 0.0) for r in usage_rows)
    residual_cost = max(0.0, float(session.get("estimated_cost_usd") or 0.0) - used_cost)
    if any(residual.values()) or residual_cost:
        known = session.get("cost_status") in KNOWN_COST
        actual = float(session.get("actual_cost_usd") or 0.0)
        cost = (actual if actual > 0 and not usage_rows else residual_cost) if known else None
        parts.append(_part(session.get("model"), session.get("billing_provider"), residual, cost))
    return parts


def read_db(db_path, since_ts):
    """(sessions, usage rows by session id) started at or after since_ts. Missing DB -> empty."""
    if not db_path.exists():
        return [], {}
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        sessions = [dict(r) for r in conn.execute(
            "SELECT id, source, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
            " billing_provider, estimated_cost_usd, actual_cost_usd, cost_status"
            " FROM sessions WHERE started_at >= ?", (since_ts,))]
        usage = {}
        has_usage = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_model_usage'").fetchone()
        if has_usage:
            for r in conn.execute(
                    "SELECT u.session_id, u.model, u.billing_provider, u.input_tokens, u.output_tokens,"
                    " u.cache_read_tokens, u.cache_write_tokens, u.estimated_cost_usd, u.actual_cost_usd, u.cost_status"
                    " FROM session_model_usage u JOIN sessions s ON s.id = u.session_id WHERE s.started_at >= ?",
                    (since_ts,)):
                usage.setdefault(r["session_id"], []).append(dict(r))
        return sessions, usage
    finally:
        conn.close()


def _empty_day(profile, day):
    return {"profile": profile, "day": day, "sessions": 0, "emptySessions": 0, "unpricedSessions": 0,
            "subscriptionSessions": 0, "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
            "cacheWriteTokens": 0, "costUsd": None, "subscriptionCostUsd": None, "models": {}, "platforms": {}}


def _add(a, b):
    return b if a is None else a + b


def aggregate(profile, sessions, usage):
    days = {}
    for s in sessions:
        day = datetime.fromtimestamp(float(s["started_at"]), TZ).date().isoformat()
        d = days.setdefault(day, _empty_day(profile, day))
        parts = session_parts(s, usage.get(s["id"], []))
        d["sessions"] += 1
        src = (s.get("source") or "unknown").lower()
        src = src if PLATFORM_RE.match(src) else "other"
        d["platforms"][src] = d["platforms"].get(src, 0) + 1
        tokens = sum(p["tokens"] for p in parts)
        if tokens == 0:
            d["emptySessions"] += 1
            continue
        sub = any(is_subscription(p["provider"]) for p in parts) or is_subscription(s.get("billing_provider"))
        if sub:
            d["subscriptionSessions"] += 1
        if any(p["tokens"] > 0 and p["cost"] is None and not is_subscription(p["provider"]) for p in parts):
            d["unpricedSessions"] += 1
        for key, k in (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens"),
                       ("cacheReadTokens", "cache_read_tokens"), ("cacheWriteTokens", "cache_write_tokens")):
            d[key] += sum(p[k] for p in parts)
        seen = set()
        for p in parts:
            if p["tokens"] == 0 and not p["cost"]:
                continue
            psub = is_subscription(p["provider"])
            if p["cost"] is not None:
                if psub:
                    d["subscriptionCostUsd"] = _add(d["subscriptionCostUsd"], p["cost"])
                else:
                    d["costUsd"] = _add(d["costUsd"], p["cost"])
            m = d["models"].setdefault(p["model"], {"model": p["model"], "sessions": 0, "tokens": 0,
                                                     "costUsd": None, "subscription": psub})
            if p["model"] not in seen:
                m["sessions"] += 1
                seen.add(p["model"])
            m["tokens"] += p["tokens"]
            m["subscription"] = m["subscription"] or psub
            if p["cost"] is not None and not psub:
                m["costUsd"] = _add(m["costUsd"], p["cost"])
    out = []
    for day in sorted(days):
        d = days[day]
        d["models"] = sorted(d["models"].values(), key=lambda m: (-m["tokens"], m["model"]))
        for k in ("costUsd", "subscriptionCostUsd"):
            d[k] = round(d[k], 6) if d[k] is not None else None
        for m in d["models"]:
            m["costUsd"] = round(m["costUsd"], 6) if m["costUsd"] is not None else None
        out.append(d)
    return out


def profile_dirs(home):
    out = [("default", home)]
    pdir = home / "profiles"
    if pdir.is_dir():
        out += [(p.name, p) for p in sorted(pdir.iterdir()) if p.is_dir() and PROFILE_RE.match(p.name)]
    return out


def _yaml(path):
    try:
        import yaml  # PyYAML is on Argo's system python; without it the fields stay None
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 — a missing/odd file only blanks presentation fields
        return {}


def _jobs(path):
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    jobs = d.get("jobs") if isinstance(d, dict) else d
    return [j for j in jobs if isinstance(j, dict)] if isinstance(jobs, list) else []


def parse_profile_list(text):
    """{profile: gateway state} from `hermes profile list`. Columns are space-padded but a long
    label can touch the model column, so parse from the right: ... model gateway alias distribution."""
    out = {}
    for line in (text or "").splitlines():
        toks = line.replace("◆", " ").split()
        if len(toks) < 5 or toks[0] == "Profile" or toks[0].startswith("─"):
            continue
        label = " ".join(toks[:-4])
        m = re.search(r"\(([^()]+)\)\s*$", label)
        name = (m.group(1) if m else label).strip()
        if PROFILE_RE.match(name):
            out[name] = toks[-3][:32]
    return out


def hermes_profile_list():
    exe = os.environ.get("HERMES_BIN") or shutil.which("hermes") or str(Path.home() / ".local" / "bin" / "hermes")
    try:
        r = subprocess.run([exe, "profile", "list"], capture_output=True, text=True, timeout=90)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def profile_snapshot(name, path, gateways):
    model_cfg = _yaml(path / "config.yaml").get("model")
    model = provider = None
    if isinstance(model_cfg, str):
        model = model_cfg
    elif isinstance(model_cfg, dict):
        model, provider = model_cfg.get("default") or model_cfg.get("model"), model_cfg.get("provider")
    display = str(_yaml(path / "profile.yaml").get("display_name") or "").strip() or None
    jobs = _jobs(path / "cron" / "jobs.json")
    return {"profile": name, "displayName": display[:64] if display else None,
            "model": str(model)[:100] if model else None, "provider": str(provider)[:100] if provider else None,
            "subscription": is_subscription(provider), "gateway": gateways.get(name),
            "cronCount": len(jobs), "cronEnabled": sum(1 for j in jobs if j.get("enabled", True))}


def read_balance(home):
    try:
        d = json.loads((home / "cron" / "cost_weekly_state.json").read_text(encoding="utf-8"))
        bal = d.get("last_balance_usd")
        if isinstance(bal, (int, float)) and not isinstance(bal, bool):
            at = d.get("last_run")
            return {"balanceUsd": round(float(bal), 4), "checkedAt": at if isinstance(at, str) else None}
    except (OSError, ValueError, AttributeError):
        pass
    return None


def build_payload(home=HERMES_HOME, now=None, profile_list_text=None):
    now = now or datetime.now(timezone.utc)
    start_day = now.astimezone(TZ).date() - timedelta(days=DAYS - 1)
    since = datetime(start_day.year, start_day.month, start_day.day, tzinfo=TZ).timestamp()
    gateways = parse_profile_list(hermes_profile_list() if profile_list_text is None else profile_list_text)
    days, profiles = [], []
    for name, path in profile_dirs(home):
        sessions, usage = read_db(path / "state.db", since)  # a broken DB raises: skip the push, report the flip
        days += aggregate(name, sessions, usage)
        profiles.append(profile_snapshot(name, path, gateways))
    return {"source": "argo", "days": days, "profiles": profiles, "balance": read_balance(home)}


def summary(payload, now=None):
    today = (now or datetime.now(timezone.utc)).astimezone(TZ).date()
    lines = []
    for label, n in (("täna", 1), ("7 päeva", 7), ("30 päeva", 30)):
        first = (today - timedelta(days=n - 1)).isoformat()
        lines.append(f"== {label} (alates {first})")
        for p in payload["profiles"]:
            rows = [d for d in payload["days"] if d["profile"] == p["profile"] and d["day"] >= first]
            tok = sum(d["inputTokens"] + d["outputTokens"] + d["cacheReadTokens"] + d["cacheWriteTokens"] for d in rows)
            cost = sum(d["costUsd"] or 0 for d in rows)
            sub = sum(d["subscriptionCostUsd"] or 0 for d in rows)
            lines.append(
                f"  {p['profile']:<9} sess={sum(d['sessions'] for d in rows):>4} tühjad={sum(d['emptySessions'] for d in rows):>4}"
                f" hinnata={sum(d['unpricedSessions'] for d in rows):>3} tellimus={sum(d['subscriptionSessions'] for d in rows):>3}"
                f" tokenid={tok:>10,} kulu=${cost:.4f}" + (f" (tellimus ~${sub:.4f})" if sub else ""))
    lines.append("== profiilid")
    for p in payload["profiles"]:
        lines.append(f"  {p['profile']:<9} {p['displayName'] or '—':<11} {p['model'] or '—':<22} {p['provider'] or '—':<44}"
                     f" gateway={p['gateway'] or '?'} cronid={p['cronEnabled']}/{p['cronCount']}")
    lines.append(f"== saldo {payload['balance']}")
    lines.append(f"== päevaridu {len(payload['days'])}, payload {len(json.dumps(payload)):,} baiti")
    return "\n".join(lines)


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
    secret = os.environ.get("INGEST_SECRET")
    if secret:
        return secret.strip()
    try:
        return SECRET_FILE.read_text(encoding="utf-8").strip() or None
    except (OSError, ValueError):
        return None


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--dry-run" in argv:
        print(summary(build_payload()))
        return 0
    secret = read_secret()
    prev = read_state()
    try:
        if not secret:
            raise RuntimeError("INGEST_SECRET puudub")
        push(URL, build_payload(), secret)
        ok, detail = True, None
    except urllib.error.HTTPError as e:
        ok, detail = False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001 — any failure is reported once, never the secret
        ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}"
    if ok != prev.get("ok", True):
        print("hermy-hq kulu sünk taastus" if ok else f"hermy-hq kulu sünk katki: {detail}")
    write_state(ok, detail)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
