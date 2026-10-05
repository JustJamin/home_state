"""v1.3.1: temperature alert engine + endpoints, and the phone gateway upload.
Run with tests/run.sh (throwaway Postgres); the engine tests need no database."""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
PG = os.environ.get("TEST_PG_URL")
os.environ.setdefault("DATABASE_URL", PG or "postgresql://unused")
if PG:
    os.environ["PROVISIONING_DATABASE_URL"] = PG.replace("home_state:test@", "provisioning:test@")
os.environ.setdefault("VAPID_PRIVATE_KEY", "test-private")
os.environ.setdefault("VAPID_PUBLIC_KEY", "test-public")

import alerts  # noqa: E402
from alerts import AlertEngine  # noqa: E402


# ---------------- engine (pure) ----------------

class Clock:
    t = 0.0
    def __call__(self): return self.t


def kinds(evs): return [e.kind for e in evs]


def test_engine_primes_silently_then_alerts_once_with_hysteresis():
    clk = Clock()
    e = AlertEngine(35, 34, 600, clk)
    assert e.observe("A", "hs-01", 36) == []            # first sighting after startup: silent, even if hot
    assert e.observe("A", "hs-01", 36.5) == []          # still above: no repeat
    assert kinds(e.observe("A", "hs-01", 34.5)) == []   # between clear and threshold: stays "above"
    assert kinds(e.observe("A", "hs-01", 33.9)) == ["normal"]
    clk.t = 700
    evs = e.observe("A", "hs-01", 35.2)
    assert kinds(evs) == ["high"] and evs[0].temp_c == 35.2 and evs[0].threshold_c == 35
    assert e.observe("A", "hs-01", 35.0) == []          # not "above" is strictly greater
    assert e.observe("A", "hs-01", None) == []          # no reading


def test_engine_rate_limits_high_alerts_per_board():
    clk = Clock()
    e = AlertEngine(35, 34, 600, clk)
    e.observe("A", "a", 30)
    clk.t = 10
    assert kinds(e.observe("A", "a", 36)) == ["high"]
    assert kinds(e.observe("A", "a", 33)) == ["normal"]
    clk.t = 100
    assert e.observe("A", "a", 36) == []                # within 10 min of the last high: suppressed
    assert kinds(e.observe("A", "a", 33)) == ["normal"]
    clk.t = 700
    assert kinds(e.observe("A", "a", 36)) == ["high"]
    # boards are independent
    e.observe("B", "b", 30)
    assert kinds(e.observe("B", "b", 36)) == ["high"]


def test_engine_threshold_change_rearms():
    clk = Clock()
    e = AlertEngine(35, 34, 0, clk)
    e.observe("A", "a", 31)
    assert e.observe("A", "a", 32) == []
    e.set_thresholds(30, 29)                            # lowered below the current temperature
    evs = e.observe("A", "a", 32)
    assert kinds(evs) == ["high"] and evs[0].threshold_c == 30
    assert e.observe("A", "a", 32) == []


def test_messages():
    hi = alerts.message(alerts.Event("high", "AA", "hs-02", 36.04, 35))
    assert hi["title"] == "🔥 hs-02 is 36.0 °C" and hi["url"] == "/" and hi["tag"] == "temp-AA"
    lo = alerts.message(alerts.Event("normal", "AA", "hs-02", 33.2, 35))
    assert "back to 33.2 °C" in lo["title"]


# ---------------- endpoints + gateway (Postgres) ----------------

needs_pg = pytest.mark.skipif(not PG, reason="TEST_PG_URL not set (use tests/run.sh)")


@pytest.fixture(scope="module")
def client(app_client):
    if not PG:
        pytest.skip("TEST_PG_URL not set")
    return app_client


@needs_pg
def test_alert_config_roundtrip_and_validation(client):
    c = client
    cfg = c.get("/api/alerts/config").json()
    assert cfg["threshold_c"] == 35 and cfg["clear_below_c"] == 34 and cfg["push_enabled"] is True
    assert c.post("/api/alerts/config", json={"threshold_c": 40, "clear_below_c": 41}).status_code == 422
    assert c.post("/api/alerts/config", json={"threshold_c": 10, "clear_below_c": 5}).status_code == 422
    r = c.post("/api/alerts/config", json={"threshold_c": 33.5, "clear_below_c": 32, "client": "pytest"}).json()
    assert r["threshold_c"] == 33.5 and r["clear_below_c"] == 32 and r["changed_at"]
    assert alerts.engine.threshold_c == 33.5
    # history is kept; the latest row is what a restart loads
    c.post("/api/alerts/config", json={"threshold_c": 35, "clear_below_c": 34})
    import psycopg
    with psycopg.connect(PG) as conn:
        rows = conn.execute("SELECT threshold_c FROM provisioning.alert_settings ORDER BY seq").fetchall()
    assert [r[0] for r in rows][-2:] == [33.5, 35]


@needs_pg
def test_subscribe_test_alert_and_cleanup(client, monkeypatch):
    c = client
    sent = []

    def fake_send(sub, payload):
        sent.append((sub["endpoint"], payload["title"]))
        return 410 if "gone" in sub["endpoint"] else 201

    monkeypatch.setattr(alerts, "_send_one", fake_send)
    for ep in ("https://push.example/live", "https://push.example/gone"):
        assert c.post("/api/push/subscribe", json={"endpoint": ep, "keys": {"p256dh": "k", "auth": "a"}}).json() == {"subscribed": True}
    # re-subscribing the same endpoint replaces it (no duplicate)
    c.post("/api/push/subscribe", json={"endpoint": "https://push.example/live", "keys": {"p256dh": "k2", "auth": "a2"}})
    assert c.post("/api/push/subscribe", json={"endpoint": "http://insecure", "keys": {"p256dh": "k", "auth": "a"}}).status_code == 422
    r = c.post("/api/push/test").json()
    assert r == {"sent": 1, "removed": 1, "failed": 0, "enabled": True}
    assert sorted(e for e, _ in sent) == ["https://push.example/gone", "https://push.example/live"]
    sent.clear()
    assert c.post("/api/push/test").json()["sent"] == 1 and len(sent) == 1, "the 410 subscription was removed"
    c.post("/api/push/unsubscribe", json={"endpoint": "https://push.example/live"})
    sent.clear()
    assert c.post("/api/push/test").json()["sent"] == 0 and sent == []


def reading(addr, counter, at, temp=30.0):
    return {"address": addr, "board_id": 2, "name": "hs-02", "counter": counter, "temp_c": temp, "uptime_s": counter * 5,
            "received_at": at.isoformat()}


@needs_pg
def test_gateway_upload_dedupes_against_scanner_and_itself(client):
    import psycopg
    c = client
    addr = "AA:BB:CC:00:00:02"
    t0 = datetime.now(timezone.utc) - timedelta(minutes=5)
    with psycopg.connect(PG, autocommit=True) as conn:  # the scanner already heard counter 10
        conn.execute("INSERT INTO readings (received_at, board_id, address, name, rssi, version, counter, temp_c, uptime_s) "
                     "VALUES (%s, 2, %s, 'hs-02', -50, 1, 10, 30, 50)", (t0 + timedelta(seconds=2), addr))
    batch = [reading(addr, n, t0 + timedelta(seconds=(n - 10) * 5)) for n in range(10, 15)]
    batch.append(reading(addr, 12, t0 + timedelta(seconds=11)))  # duplicate inside the same upload
    r = c.post("/api/gateway/readings", json={"readings": batch, "client": "pytest"}).json()
    assert r == {"inserted": 4, "duplicates": 2}
    assert c.post("/api/gateway/readings", json={"readings": batch}).json() == {"inserted": 0, "duplicates": 6}, "re-upload is a no-op"
    # same counter much later = after a reboot / wrap: a new reading
    assert c.post("/api/gateway/readings", json={"readings": [reading(addr, 10, t0 + timedelta(hours=2))]}).json()["inserted"] == 1
    with psycopg.connect(PG) as conn:
        rows = conn.execute("SELECT source, count(*) FROM readings WHERE address = %s GROUP BY 1 ORDER BY 1", (addr,)).fetchall()
    assert rows == [("gateway", 5), ("scanner", 1)]
    assert c.post("/api/gateway/readings", json={"readings": [{**batch[0], "address": "nope"}]}).status_code == 422
    m = next(x for x in c.get("/api/fleet/metrics?hours=24").json() if x["address"] == addr)
    assert m["readings"] == 6, "metrics include gateway rows"


@needs_pg
def test_provisioning_role_insert_only_on_readings():
    import psycopg
    with psycopg.connect(os.environ["PROVISIONING_DATABASE_URL"], autocommit=True) as conn:
        for sql in ("SELECT count(*) FROM readings", "UPDATE readings SET temp_c = 0", "DELETE FROM readings",
                    "UPDATE provisioning.alert_settings SET threshold_c = 50", "DELETE FROM provisioning.alert_settings"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql)
