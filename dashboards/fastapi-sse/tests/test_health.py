"""v1.3.2: system health checks and their push alerts.
The state machine and the Kubernetes evaluators need no database; the rest run with tests/run.sh."""

import os
from datetime import datetime, timedelta, timezone

import pytest

import health
from health import HealthAlerter, eval_node, eval_pods

PG = os.environ.get("TEST_PG_URL")
NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)


class Clock:
    t = 0.0
    def __call__(self): return self.t


def c(id, status): return {"id": id, "label": health.LABELS[id], "status": status, "detail": f"{id} {status}"}


def kinds(evs): return [(k, x["id"]) for k, x in evs]


# ---------------- alerter (pure) ----------------

def test_alerter_waits_before_alerting_then_alerts_once_and_recovers():
    clk = Clock()
    a = HealthAlerter(180, 1800, clk)
    assert a.observe([c("bluetooth", "ok")]) == []
    clk.t = 10
    assert a.observe([c("bluetooth", "fail")]) == []           # just failed: wait (a rollout blip)
    clk.t = 100
    assert a.observe([c("bluetooth", "fail")]) == []
    clk.t = 200
    assert kinds(a.observe([c("bluetooth", "fail")])) == [("fail", "bluetooth")]
    clk.t = 400
    assert a.observe([c("bluetooth", "fail")]) == []           # once per episode
    assert a.observe([c("bluetooth", "unknown")]) == []        # couldn't check: no change
    clk.t = 500
    assert kinds(a.observe([c("bluetooth", "ok")])) == [("recovered", "bluetooth")]
    assert a.observe([c("bluetooth", "ok")]) == []


def test_alerter_blip_shorter_than_the_wait_is_silent():
    clk = Clock()
    a = HealthAlerter(180, 1800, clk)
    a.observe([c("scanner", "fail")])
    clk.t = 120
    assert a.observe([c("scanner", "ok")]) == []               # never reported, so no "recovered"


def test_alerter_rate_limits_flapping_and_skips_recovery_for_unsent():
    clk = Clock()
    a = HealthAlerter(0, 1800, clk)
    assert kinds(a.observe([c("pods", "fail")])) == [("fail", "pods")]
    clk.t = 60
    assert kinds(a.observe([c("pods", "ok")])) == [("recovered", "pods")]
    clk.t = 120
    assert a.observe([c("pods", "fail")]) == []                # within 30 min of the last alert
    clk.t = 180
    assert a.observe([c("pods", "ok")]) == []                  # that failure wasn't sent: no "recovered"
    clk.t = 2000
    assert kinds(a.observe([c("pods", "fail")])) == [("fail", "pods")]


def test_warn_never_alerts():
    a = HealthAlerter(0, 0, Clock())
    assert a.observe([c("boards", "warn"), c("push", "warn")]) == []


def test_message_lists_other_failures_and_recovery():
    checks = [c("bluetooth", "fail"), c("readings", "fail"), c("pods", "ok")]
    m = health.message([("fail", checks[0])], checks)
    assert "Bluetooth adapter failing" in m["title"] and "Readings arriving" in m["body"]
    assert m["tag"] == "health" and m["url"] == "/admin#gateway"
    m = health.message([("recovered", c("bluetooth", "ok"))], [c("bluetooth", "ok"), c("readings", "fail")])
    assert "recovered" in m["title"] and "Still failing: Readings arriving" in m["body"]
    m = health.message([("recovered", c("bluetooth", "ok"))], [c("bluetooth", "ok")])
    assert "All system checks are OK" in m["body"]


# ---------------- Kubernetes evaluation (pure) ----------------

def pod(app, ready=True, restarts=0, waiting=None, finished=None, started=NOW - timedelta(days=4), phase="Running"):
    cs = {"ready": ready, "restartCount": restarts, "state": {"waiting": {"reason": waiting}} if waiting else {"running": {}},
          "lastState": {"terminated": {"finishedAt": finished.isoformat().replace("+00:00", "Z"), "reason": "Error", "exitCode": 1}}
          if finished else {}}
    return {"metadata": {"name": f"{app}-abc", "labels": {"app": app}},
            "status": {"phase": phase, "startTime": started.isoformat().replace("+00:00", "Z"), "containerStatuses": [cs]}}


def test_pods_all_running():
    r = eval_pods([pod("postgres"), pod("scanner")], NOW)
    assert r["status"] == "ok" and r["detail"] == "2 of 2 running"
    assert [i["name"] for i in r["items"]] == ["postgres", "scanner"]


def test_pods_crash_loop_fails():
    # what 2026-10-15 looked like: the scanner exiting every ~2 min
    r = eval_pods([pod("postgres"), pod("scanner", ready=False, restarts=309, waiting="CrashLoopBackOff",
                                         finished=NOW - timedelta(minutes=3))], NOW)
    assert r["status"] == "fail" and "scanner: CrashLoopBackOff (309 restarts)" in r["detail"]


def test_pods_recent_restart_warns_and_new_pod_is_starting():
    r = eval_pods([pod("scanner", restarts=1, finished=NOW - timedelta(minutes=10))], NOW)
    assert r["status"] == "warn" and "restarted 10 min ago" in r["detail"]
    r = eval_pods([pod("scanner", ready=False, started=NOW - timedelta(seconds=30))], NOW)
    assert r["status"] == "warn" and "starting" in r["detail"]
    r = eval_pods([pod("job", phase="Succeeded")], NOW)
    assert r["status"] == "ok" and r["items"] == []


def test_node_conditions():
    def node(**conds):
        return {"metadata": {"name": "lenovo"}, "status": {"conditions": [{"type": k, "status": v} for k, v in conds.items()]}}
    assert eval_node([node(Ready="True", DiskPressure="False")])["status"] == "ok"
    r = eval_node([node(Ready="True", DiskPressure="True")])
    assert r["status"] == "fail" and "DiskPressure" in r["detail"]
    assert eval_node([node(Ready="False")])["status"] == "fail"
    assert eval_node([])["status"] == "unknown"


# ---------------- against the database ----------------

needs_pg = pytest.mark.skipif(not PG, reason="needs TEST_PG_URL (tests/run.sh)")


@pytest.fixture
def db():
    import psycopg
    with psycopg.connect(PG, autocommit=True) as conn:
        conn.execute("DELETE FROM scanner_heartbeat")
        yield conn
        conn.execute("DELETE FROM scanner_heartbeat")


def heartbeat(conn, age_s=5, adverts=120, readings=6, last_advert_s=0.1):
    conn.execute("""INSERT INTO scanner_heartbeat (id, at, started_at, window_s, adverts, readings, last_advert_s)
                    VALUES (1, now() - make_interval(secs => %s), now() - interval '2 hours', 30, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET at = excluded.at, adverts = excluded.adverts,
                        readings = excluded.readings, last_advert_s = excluded.last_advert_s""",
                 (age_s, adverts, readings, last_advert_s))


def by_id(snap): return {x["id"]: x for x in snap["checks"]}


@needs_pg
def test_health_endpoint_shape(app_client, db):
    heartbeat(db)
    snap = app_client.post("/api/health/check").json()
    assert set(by_id(snap)) == set(health.LABELS)
    for x in snap["checks"]:
        assert x["status"] in ("ok", "warn", "fail", "unknown") and x["detail"] and x["since"]
    assert by_id(snap)["database"]["status"] == "ok"
    assert by_id(snap)["admin_store"]["status"] == "ok"
    assert by_id(snap)["pods"]["status"] == "unknown"           # not in a cluster here
    assert app_client.get("/api/health").json()["checked_at"]


@needs_pg
def test_scanner_and_bluetooth_from_the_heartbeat(app_client, db):
    def snap():
        health.monitor._last_run = 0
        return by_id(app_client.post("/api/health/check").json())

    s = snap()
    assert s["scanner"]["status"] == "fail" and "no heartbeat" in s["scanner"]["detail"]

    heartbeat(db, adverts=143)
    s = snap()
    assert s["scanner"]["status"] == "ok" and s["bluetooth"]["status"] == "ok"
    assert "143 adverts" in s["bluetooth"]["detail"]

    heartbeat(db, adverts=0, readings=0, last_advert_s=95)       # the adapter has gone deaf
    s = snap()
    assert s["scanner"]["status"] == "ok" and s["bluetooth"]["status"] == "fail"
    assert "suspended" in s["bluetooth"]["detail"]

    heartbeat(db, age_s=600)                                     # the scanner stopped writing
    s = snap()
    assert s["scanner"]["status"] == "fail" and "10 min" in s["scanner"]["detail"]
    assert s["bluetooth"]["status"] == "unknown"


@needs_pg
def test_readings_and_boards(app_client, db):
    db.execute("""INSERT INTO readings (received_at, board_id, address, rssi, version, counter, temp_c, uptime_s)
                  VALUES (now() - interval '20 minutes', 41, 'AA:00:00:00:00:41', -60, 1, 1, 30, 1),
                         (now() - interval '10 seconds', 42, 'AA:00:00:00:00:42', -60, 1, 1, 30, 1)""")
    try:
        health.monitor.last_seen.clear()
        app_client.portal.call(health.monitor.load_boards)  # what the monitor does at startup
        health.monitor._last_run = 0
        s = by_id(app_client.post("/api/health/check").json())
        assert s["readings"]["status"] == "ok"
        boards = {i["name"]: i for i in s["boards"]["items"]}
        assert boards["hs-42"]["status"] == "ok" and boards["hs-41"]["status"] == "warn"
        assert s["boards"]["status"] == "warn" and "quiet: hs-41" in s["boards"]["detail"]
    finally:
        db.execute("DELETE FROM readings WHERE address LIKE 'AA:00:00:00:00:4_'")
