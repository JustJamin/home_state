"""Device names: validation, fleet-wide uniqueness ignoring capitals, history, labels on readings."""
import os
from datetime import datetime, timezone

import pytest

import names

PG = os.environ.get("TEST_PG_URL")
needs_pg = pytest.mark.skipif(not PG, reason="TEST_PG_URL not set (use tests/run.sh)")


def test_device_id_for_address():
    # BT MAC = factory MAC + 2 (both real boards)
    assert names.device_id_for("58:E6:C5:13:03:3E") == "58e6c513033c"
    assert names.device_id_for("58:E6:C5:19:50:8A") == "58e6c5195088"
    assert names.device_id_for("00:00:00:00:01:01") == "0000000000ff"
    assert names.device_id_for("nope") is None


@pytest.fixture(scope="module")
def client(app_client):
    if not PG:
        pytest.skip("TEST_PG_URL not set")
    return app_client


@needs_pg
def test_rename_rules(client):
    c = client
    a, b = "aaaaaaaaaa01", "aaaaaaaaaa02"
    assert c.post(f"/api/devices/{a}/name", json={"name": "rack-3.top_1"}).json() == {"device_id": a, "name": "rack-3.top_1"}
    for bad in ("has space", "x" * 21, "émoji", "a/b"):
        r = c.post(f"/api/devices/{a}/name", json={"name": bad})
        assert r.status_code == 422, bad
    assert c.post("/api/devices/NOTHEX/name", json={"name": "x"}).status_code == 422
    # unique in the fleet, ignoring capitals
    r = c.post(f"/api/devices/{b}/name", json={"name": "RACK-3.TOP_1"})
    assert r.status_code == 409 and a in r.json()["detail"]
    # the same device may change the capitals of its own name
    assert c.post(f"/api/devices/{a}/name", json={"name": "Rack-3.Top_1"}).status_code == 200
    # clearing frees the name for another device
    assert c.post(f"/api/devices/{a}/name", json={"name": ""}).json()["name"] is None
    assert c.post(f"/api/devices/{b}/name", json={"name": "rack-3.top_1"}).status_code == 200
    current = {x["device_id"]: x["name"] for x in c.get("/api/devices/names").json()}
    assert current.get(b) == "rack-3.top_1" and a not in current


@needs_pg
def test_names_label_readings_and_keep_history(client):
    import psycopg
    c = client
    dev, addr = "58e6c5195088", "58:E6:C5:19:50:8A"
    with psycopg.connect(PG, autocommit=True) as conn:
        conn.execute("INSERT INTO readings (received_at, board_id, address, name, rssi, version, counter, temp_c, uptime_s) "
                     "VALUES (%s, 2, %s, 'hs-02', -50, 1, 77, 30, 385)", (datetime.now(timezone.utc), addr))
    label = lambda: next(r["label"] for r in c.get("/api/readings?minutes=5").json() if r["address"] == addr)
    assert label() == "hs-02", "no name yet: hs-NN"
    c.post(f"/api/devices/{dev}/name", json={"name": "server-room-2", "client": "pytest"})
    assert label() == "server-room-2"
    c.post(f"/api/devices/{dev}/name", json={"name": "rack-7"})
    assert label() == "rack-7"
    with psycopg.connect(PG) as conn:
        hist = [r[0] for r in conn.execute("SELECT name FROM provisioning.device_names WHERE device_id = %s ORDER BY seq", (dev,))]
    assert hist[-2:] == ["server-room-2", "rack-7"], "every rename kept"
    with psycopg.connect(os.environ["PROVISIONING_DATABASE_URL"], autocommit=True) as conn:
        for sql in ("UPDATE provisioning.device_names SET name = 'x'", "DELETE FROM provisioning.device_names"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql)
