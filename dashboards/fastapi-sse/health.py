"""System health: every element of home_state checked every 30 s, shown in the Admin app's
Gateway tab, and pushed to phones when something fails (and again when it recovers).

Checks (each ok / warn / fail / unknown, with a one-line detail):
  database      the readings database answers
  admin_store   the provisioning store answers
  scanner       the scanner's heartbeat is fresh (it writes one every 30 s, migration 008)
  bluetooth     the scanner heard BLE adverts from ANY device in its last window; zero means
                lenovo's adapter has gone deaf (2026-10-15: suspended by USB power saving)
  readings      the newest stored reading is recent: fails only when no board at all reports
  boards        each board seen in the last 7 days; a quiet board is only a warning
  pods          every pod in the namespace is ready and not crash-looping (Kubernetes API)
  node          the k3s node is Ready, with no disk / memory / PID pressure
  push          push alerts are configured and at least one phone is subscribed

HealthAlerter is a pure state machine (tested on its own): a check must fail for
ALERT_AFTER_S before it pushes, so a blip (a pod rollout) doesn't page anyone; it pushes once
per episode, at most once per MIN_INTERVAL_S per check, and sends "recovered" only after a
failure it actually reported.
"""

import asyncio
import json
import os
import ssl
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter

import alerts
import names

CHECK_INTERVAL_S = 30
ALERT_AFTER_S = 180
MIN_INTERVAL_S = 1800
HEARTBEAT_STALE_S = 90       # the scanner writes one every 30 s
READINGS_WARN_S = 120        # boards report every 5 s
READINGS_FAIL_S = 300
BOARD_QUIET_S = 120
BOARDS_WINDOW = timedelta(days=7)
RESTART_RECENT_S = 3600

LABELS = {
    "database": "Readings database", "admin_store": "Admin store", "scanner": "Scanner",
    "bluetooth": "Bluetooth adapter", "readings": "Readings arriving", "boards": "Boards",
    "pods": "Kubernetes pods", "node": "Server (k3s node)", "push": "Push alerts",
}
RANK = {"ok": 0, "unknown": 1, "warn": 2, "fail": 3}

router = APIRouter()
readings_pool = None  # set by app.py
admin_pool = None


def ago(seconds: float) -> str:
    s = int(max(seconds, 0))
    if s < 90:
        return f"{s} s"
    if s < 5400:
        return f"{round(s / 60)} min"
    if s < 172800:
        return f"{s / 3600:.1f} h".replace(".0 h", " h")
    return f"{round(s / 86400)} days"


def check(id: str, status: str, detail: str, items: list | None = None) -> dict:
    c = {"id": id, "label": LABELS[id], "status": status, "detail": detail}
    if items is not None:
        c["items"] = items
    return c


# ---------------- alerting state machine ----------------

@dataclass
class _State:
    fail_since: float | None = None
    alerted: bool = False
    last_alert: float | None = None


@dataclass
class HealthAlerter:
    alert_after_s: float = ALERT_AFTER_S
    min_interval_s: float = MIN_INTERVAL_S
    clock: callable = time.monotonic
    states: dict = field(default_factory=dict)

    def observe(self, checks: list[dict]) -> list[tuple[str, dict]]:
        """Returns [("fail" | "recovered", check)] to push."""
        now, events = self.clock(), []
        for c in checks:
            s = self.states.setdefault(c["id"], _State())
            if c["status"] == "fail":
                if s.fail_since is None:
                    s.fail_since = now
                due = now - s.fail_since >= self.alert_after_s
                quiet = s.last_alert is None or now - s.last_alert >= self.min_interval_s
                if due and not s.alerted and quiet:
                    s.alerted, s.last_alert = True, now
                    events.append(("fail", c))
            elif c["status"] in ("ok", "warn"):
                s.fail_since = None
                if s.alerted:
                    s.alerted = False
                    events.append(("recovered", c))
            # "unknown" (couldn't check) changes nothing
        return events


def message(events: list[tuple[str, dict]], checks: list[dict]) -> dict:
    failing = [c for c in checks if c["status"] == "fail"]
    new_fail = [c for kind, c in events if kind == "fail"]
    recovered = [c for kind, c in events if kind == "recovered"]
    if new_fail:
        first = new_fail[0]
        title = f"⚠️ home_state: {first['label']} failing"
        body = first["detail"]
        others = [c["label"] for c in failing if c is not first]
        if others:
            body += f" · also failing: {', '.join(others)}"
    elif failing:
        title = f"✅ home_state: {', '.join(c['label'] for c in recovered)} recovered"
        body = f"Still failing: {', '.join(c['label'] for c in failing)}"
    else:
        title = f"✅ home_state: {', '.join(c['label'] for c in recovered)} recovered"
        body = "Nothing is failing now."
    # one tag: the latest system notification replaces the last one on the phone
    return {"title": title, "body": body, "tag": "health", "url": "/admin#gateway"}


# ---------------- Kubernetes (read-only service account) ----------------

SA = Path("/var/run/secrets/kubernetes.io/serviceaccount")


def k8s_available() -> bool:
    return (SA / "token").exists() and "KUBERNETES_SERVICE_HOST" in os.environ


def _k8s_get(path: str) -> dict:
    host, port = os.environ["KUBERNETES_SERVICE_HOST"], os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    req = urllib.request.Request(f"https://{host}:{port}{path}",
                                 headers={"Authorization": f"Bearer {(SA / 'token').read_text()}"})
    ctx = ssl.create_default_context(cafile=str(SA / "ca.crt"))
    with urllib.request.urlopen(req, context=ctx, timeout=5) as r:
        return json.load(r)


def _ts(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def eval_pods(pods: list[dict], now: datetime) -> dict:
    items = []
    for p in pods:
        meta, status = p["metadata"], p.get("status", {})
        if status.get("phase") == "Succeeded":
            continue
        name = meta.get("labels", {}).get("app") or meta["name"]
        started = _ts(status.get("startTime"))
        age = (now - started).total_seconds() if started else 0
        st, detail = "ok", f"running · up {ago(age)}"
        for cs in status.get("containerStatuses", []):
            restarts = cs.get("restartCount", 0)
            waiting = (cs.get("state") or {}).get("waiting") or {}
            last = (cs.get("lastState") or {}).get("terminated") or {}
            finished = _ts(last.get("finishedAt"))
            if waiting.get("reason") in ("CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError"):
                st, detail = "fail", f"{waiting['reason']} ({restarts} restarts)"
            elif not cs.get("ready"):
                st, detail = ("warn", "starting") if age < 120 else ("fail", f"not ready ({restarts} restarts)")
            elif finished and (now - finished).total_seconds() < RESTART_RECENT_S:
                st, detail = "warn", (f"restarted {ago((now - finished).total_seconds())} ago"
                                      f" ({last.get('reason', 'exit')} {last.get('exitCode', '')}".rstrip() + f"; {restarts} restarts)")
        if not status.get("containerStatuses") and age >= 120:
            st, detail = "fail", status.get("phase", "pending").lower()
        items.append({"name": name, "status": st, "detail": detail})
    items.sort(key=lambda i: i["name"])
    worst = max((i["status"] for i in items), key=RANK.get, default="ok")
    bad = [i for i in items if i["status"] != "ok"]
    detail = (f"{len(items)} of {len(items)} running" if not bad
              else "; ".join(f"{i['name']}: {i['detail']}" for i in bad))
    return check("pods", worst, detail, items)


def eval_node(nodes: list[dict]) -> dict:
    items, worst = [], "ok"
    for n in nodes:
        conds = {c["type"]: c["status"] for c in n.get("status", {}).get("conditions", [])}
        problems = [t for t in ("DiskPressure", "MemoryPressure", "PIDPressure") if conds.get(t) == "True"]
        if conds.get("Ready") != "True":
            problems.insert(0, "not Ready")
        st = "fail" if problems else "ok"
        worst = max(worst, st, key=RANK.get)
        items.append({"name": n["metadata"]["name"], "status": st,
                      "detail": ", ".join(problems) if problems else "Ready · no disk, memory or PID pressure"})
    if not items:
        return check("node", "unknown", "no nodes listed")
    return check("node", worst, "; ".join(f"{i['name']}: {i['detail']}" for i in items), items)


# ---------------- the checks ----------------

class Monitor:
    def __init__(self) -> None:
        self.alerter = HealthAlerter()
        self.snapshot: dict | None = None
        self.since: dict[str, str] = {}  # check id -> when its status last changed
        self.last_seen: dict[str, tuple[str, datetime]] = {}  # address -> (board label, newest reading)
        self.started = time.monotonic()
        self._lock = asyncio.Lock()
        self._last_run = 0.0
        self._tasks: set = set()

    def observe_reading(self, address: str, label: str, received_at: datetime) -> None:
        """Called by the Broadcaster for every new row, so per-board last-seen needs no query."""
        self.last_seen[address] = (label, received_at)

    async def load_boards(self) -> None:
        async with readings_pool.connection() as conn:
            rows = await (await conn.execute(
                """SELECT DISTINCT ON (address) address, 'hs-' || lpad(board_id::text, 2, '0') AS board, received_at
                   FROM readings WHERE received_at > now() - %s ORDER BY address, received_at DESC""",
                (BOARDS_WINDOW,))).fetchall()
        for r in rows:
            self.last_seen.setdefault(r["address"], (names.label(r["address"], r["board"]), r["received_at"]))

    async def _db_checks(self, now: datetime) -> list[dict]:
        out = []
        newest = hb = None
        try:
            t0 = time.monotonic()
            async with readings_pool.connection() as conn:
                newest = (await (await conn.execute("SELECT max(received_at) AS t FROM readings")).fetchone())["t"]
                ms = (time.monotonic() - t0) * 1000
                try:
                    hb = await (await conn.execute("SELECT * FROM scanner_heartbeat WHERE id = 1")).fetchone()
                except Exception:
                    hb = "missing"
            out.append(check("database", "ok", f"answering ({ms:.0f} ms)"))
        except Exception as e:
            out.append(check("database", "fail", f"not answering: {e}"[:200]))
            for id in ("scanner", "bluetooth", "readings"):
                out.append(check(id, "unknown", "can't check: the database isn't answering"))
            return out

        if hb == "missing":
            out.append(check("scanner", "unknown", "no heartbeat table yet (migration 008 not applied)"))
            out.append(check("bluetooth", "unknown", "no heartbeat table yet (migration 008 not applied)"))
        elif hb is None:
            out.append(check("scanner", "fail", "no heartbeat ever: the scanner hasn't run since v1.3.2"))
            out.append(check("bluetooth", "unknown", "no scanner heartbeat"))
        else:
            age = (now - hb["at"]).total_seconds()
            up = ago((now - hb["started_at"]).total_seconds())
            if age > HEARTBEAT_STALE_S:
                out.append(check("scanner", "fail", f"not running: last heartbeat {ago(age)} ago"))
                out.append(check("bluetooth", "unknown", f"no scanner heartbeat for {ago(age)}"))
            else:
                out.append(check("scanner", "ok", f"running · up {up} · {hb['readings']} new readings in {hb['window_s']:.0f} s"))
                if hb["adverts"] == 0:
                    out.append(check("bluetooth", "fail",
                                     f"heard nothing from any Bluetooth device for {ago(hb['last_advert_s'])}: "
                                     "lenovo's adapter may be suspended or reset"))
                else:
                    out.append(check("bluetooth", "ok", f"heard {hb['adverts']} adverts from nearby devices in {hb['window_s']:.0f} s"))

        if newest is None:
            out.append(check("readings", "fail", "no readings stored yet"))
        else:
            age = (now - newest).total_seconds()
            st = "ok" if age < READINGS_WARN_S else "warn" if age < READINGS_FAIL_S else "fail"
            out.append(check("readings", st, f"newest {ago(age)} ago" if st == "ok"
                             else f"nothing stored from any board for {ago(age)}"))
        return out

    def _boards(self, now: datetime) -> dict:
        items = []
        for address, (label, t) in sorted(self.last_seen.items(), key=lambda x: x[1][0]):
            age = (now - t).total_seconds()
            if age > BOARDS_WINDOW.total_seconds():
                continue
            label = names.label(address, label)
            items.append({"name": label, "status": "ok" if age < BOARD_QUIET_S else "warn",
                          "detail": f"last reading {ago(age)} ago"})
        if not items:
            return check("boards", "warn", "no board has reported in the last 7 days", items)
        quiet = [i["name"] for i in items if i["status"] != "ok"]
        if not quiet:
            return check("boards", "ok", f"all {len(items)} reporting", items)
        return check("boards", "warn", f"{len(items) - len(quiet)} of {len(items)} reporting · quiet: {', '.join(quiet)}", items)

    async def _admin_store(self) -> dict:
        if admin_pool is None:
            return check("admin_store", "unknown", "not configured (PROVISIONING_DATABASE_URL)")
        try:
            async with admin_pool.connection() as conn:
                await conn.execute("SELECT 1")
            return check("admin_store", "ok", "answering")
        except Exception as e:
            return check("admin_store", "fail", f"not answering: {e}"[:200])

    async def _push(self) -> dict:
        if not alerts.push_enabled():
            return check("push", "warn", "not configured on the server (VAPID keys)")
        try:
            async with admin_pool.connection() as conn:
                n = (await (await conn.execute(
                    "SELECT count(*) AS n FROM provisioning.push_subscriptions")).fetchone())["n"]
        except Exception as e:
            return check("push", "unknown", f"can't read subscriptions: {e}"[:200])
        if n == 0:
            return check("push", "warn", "no phone has alerts turned on: nobody would be told about a problem")
        detail = f"{n} phone{'s' if n != 1 else ''} subscribed"
        d = alerts.last_delivery
        if d:
            when = ago(time.time() - d["at"])
            if d["sent"] == 0 and d["failed"]:
                return check("push", "warn", f"{detail} · the last alert ({when} ago) reached no phone")
            detail += f" · last alert delivered {when} ago"
        return check("push", "ok", detail)

    async def _k8s(self, now: datetime) -> list[dict]:
        if not k8s_available():
            return [check("pods", "unknown", "no Kubernetes access (not running in the cluster)"),
                    check("node", "unknown", "no Kubernetes access (not running in the cluster)")]
        ns = (SA / "namespace").read_text().strip()
        out = []
        try:
            pods = await asyncio.to_thread(_k8s_get, f"/api/v1/namespaces/{ns}/pods")
            out.append(eval_pods(pods["items"], now))
        except Exception as e:
            out.append(check("pods", "unknown", f"can't list pods: {e}"[:200]))
        try:
            nodes = await asyncio.to_thread(_k8s_get, "/api/v1/nodes")
            out.append(eval_node(nodes["items"]))
        except Exception as e:
            out.append(check("node", "unknown", f"can't read the node: {e}"[:200]))
        return out

    async def run_checks(self) -> dict:
        async with self._lock:
            now = datetime.now(timezone.utc)
            db, admin, push, k8s = await asyncio.gather(
                self._db_checks(now), self._admin_store(), self._push(), self._k8s(now))
            checks = [*db[:1], admin, *db[1:], self._boards(now), *k8s, push]
            order = list(LABELS)
            checks.sort(key=lambda c: order.index(c["id"]))
            iso = now.isoformat()
            prev = {c["id"]: c["status"] for c in (self.snapshot or {}).get("checks", [])}
            for c in checks:
                if prev.get(c["id"]) != c["status"] or c["id"] not in self.since:
                    self.since[c["id"]] = iso
                c["since"] = self.since[c["id"]]
            self.snapshot = {
                "checked_at": iso, "interval_s": CHECK_INTERVAL_S,
                "status": max((c["status"] for c in checks), key=RANK.get),
                "server_uptime_s": round(time.monotonic() - self.started),
                "checks": checks,
            }
            self._last_run = time.monotonic()
            events = self.alerter.observe(checks)
            if events:
                alerts.background(self._notify(events, checks))
            return self.snapshot

    async def _notify(self, events, checks) -> None:
        r = await alerts.send_all(message(events, checks))
        print(f"health {[(k, c['id']) for k, c in events]} -> {r}", flush=True)

    async def run(self) -> None:
        try:
            await self.load_boards()
        except Exception as e:
            print(f"health: boards not loaded: {e}", flush=True)
        while True:
            try:
                await self.run_checks()
            except Exception as e:  # never let the monitor die
                print(f"health check failed: {e!r}", flush=True)
            await asyncio.sleep(CHECK_INTERVAL_S)


monitor = Monitor()


@router.get("/api/health")
async def get_health() -> dict:
    return monitor.snapshot or await monitor.run_checks()


@router.post("/api/health/check")
async def check_now() -> dict:
    """Run the checks now (the app's "Check now"); at most once every 5 s."""
    if monitor.snapshot and time.monotonic() - monitor._last_run < 5:
        return monitor.snapshot
    return await monitor.run_checks()
