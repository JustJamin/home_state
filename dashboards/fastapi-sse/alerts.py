"""Temperature alerts by Web Push: one fleet-wide threshold, set from the provisioning app.

AlertEngine is a pure state machine (tested on its own): per board it alerts once
when the temperature goes above `threshold_c`, and sends "back to normal" once it
drops below `clear_below_c` (hysteresis, so a reading wobbling around the line
doesn't spam). At most one high alert per board per `min_interval_s`. The first
reading seen for a board after startup only primes its state, so restarting the
server doesn't re-alert. Changing the threshold re-arms every board: one already
above the new threshold alerts once.

Push delivery uses pywebpush with VAPID keys from the environment (k8s Secret
`webpush`). Subscriptions the push service reports as gone (404/410) are deleted.
"""

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

DEFAULT_THRESHOLD_C = 35.0
DEFAULT_CLEAR_BELOW_C = 34.0
MIN_INTERVAL_S = 600

router = APIRouter()


# ---------------- the state machine ----------------

@dataclass
class Event:
    kind: str  # "high" | "normal"
    address: str
    name: str
    temp_c: float
    threshold_c: float


@dataclass
class _Board:
    above: bool
    last_high: float | None = None


@dataclass
class AlertEngine:
    threshold_c: float = DEFAULT_THRESHOLD_C
    clear_below_c: float = DEFAULT_CLEAR_BELOW_C
    min_interval_s: float = MIN_INTERVAL_S
    clock: callable = time.monotonic
    boards: dict = field(default_factory=dict)

    def set_thresholds(self, threshold_c: float, clear_below_c: float) -> None:
        self.threshold_c, self.clear_below_c = threshold_c, clear_below_c
        for b in self.boards.values():
            b.above = False  # re-arm: re-evaluated against the new threshold on the next reading

    def observe(self, address: str, name: str, temp_c: float | None) -> list[Event]:
        if temp_c is None:
            return []
        b = self.boards.get(address)
        if b is None:  # first sighting since startup: prime silently
            self.boards[address] = _Board(above=temp_c > self.threshold_c)
            return []
        if not b.above and temp_c > self.threshold_c:
            b.above = True
            now = self.clock()
            if b.last_high is not None and now - b.last_high < self.min_interval_s:
                return []  # rate-limited
            b.last_high = now
            return [Event("high", address, name, temp_c, self.threshold_c)]
        if b.above and temp_c < self.clear_below_c:
            b.above = False
            return [Event("normal", address, name, temp_c, self.threshold_c)]
        return []


def message(e: Event) -> dict:
    if e.kind == "high":
        return {"title": f"🔥 {e.name} is {e.temp_c:.1f} °C",
                "body": f"Above the {e.threshold_c:g} °C alert threshold.", "tag": f"temp-{e.address}", "url": "/"}
    return {"title": f"✅ {e.name} back to {e.temp_c:.1f} °C",
            "body": f"Below the alert threshold again ({e.threshold_c:g} °C).", "tag": f"temp-{e.address}", "url": "/"}


# ---------------- delivery ----------------

engine = AlertEngine()
pool = None  # provisioning pool (set by app.py at startup)
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE_KEY")  # PEM or base64url raw
VAPID_PUBLIC = os.environ.get("VAPID_PUBLIC_KEY")    # base64url uncompressed point (applicationServerKey)
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.invalid")


def push_enabled() -> bool:
    return bool(pool and VAPID_PRIVATE and VAPID_PUBLIC)


def _send_one(sub: dict, payload: dict) -> int:
    """Blocking send; returns the HTTP status (or 0 on a network error)."""
    from pywebpush import WebPushException, webpush
    try:
        r = webpush({"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                    data=json.dumps(payload), vapid_private_key=VAPID_PRIVATE,
                    vapid_claims={"sub": VAPID_SUBJECT}, ttl=3600, timeout=10)
        return r.status_code
    except WebPushException as e:
        return e.response.status_code if e.response is not None else 0
    except Exception:
        return 0


async def send_all(payload: dict) -> dict:
    if not push_enabled():
        return {"sent": 0, "removed": 0, "failed": 0, "enabled": False}
    async with pool.connection() as conn:
        subs = await (await conn.execute("SELECT endpoint, p256dh, auth FROM provisioning.push_subscriptions")).fetchall()
    statuses = await asyncio.gather(*(asyncio.to_thread(_send_one, s, payload) for s in subs))
    gone = [s["endpoint"] for s, st in zip(subs, statuses) if st in (404, 410)]
    if gone:
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM provisioning.push_subscriptions WHERE endpoint = ANY(%s)", (gone,))
    ok = sum(1 for st in statuses if 200 <= st < 300)
    return {"sent": ok, "removed": len(gone), "failed": len(subs) - ok - len(gone), "enabled": True}


async def notify(events: list[Event]) -> None:
    for e in events:
        r = await send_all(message(e))
        print(f"alert {e.kind} {e.name} {e.temp_c:.1f} C -> {r}", flush=True)


async def load_settings() -> None:
    """Apply the latest stored threshold (if any) to the engine."""
    if not pool:
        return
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT threshold_c, clear_below_c FROM provisioning.alert_settings ORDER BY seq DESC LIMIT 1")).fetchone()
    if row:
        engine.set_thresholds(row["threshold_c"], row["clear_below_c"])


# ---------------- API ----------------

class AlertConfig(BaseModel):
    threshold_c: float = Field(ge=20, le=80)
    clear_below_c: float = Field(ge=0, le=80)
    client: str | None = None


class Subscription(BaseModel):
    endpoint: str = Field(pattern=r"^https://")
    keys: dict[str, str]
    client: str | None = None


@router.get("/api/alerts/config")
async def get_config() -> dict:
    changed_at = None
    if pool:
        async with pool.connection() as conn:
            row = await (await conn.execute(
                "SELECT changed_at FROM provisioning.alert_settings ORDER BY seq DESC LIMIT 1")).fetchone()
        changed_at = row["changed_at"].isoformat() if row else None
    return {"threshold_c": engine.threshold_c, "clear_below_c": engine.clear_below_c, "changed_at": changed_at,
            "vapid_public_key": VAPID_PUBLIC, "push_enabled": push_enabled()}


@router.post("/api/alerts/config")
async def set_config(body: AlertConfig) -> dict:
    if body.clear_below_c >= body.threshold_c:
        raise HTTPException(422, "'back to normal below' must be lower than the threshold")
    if not pool:
        raise HTTPException(503, "alert settings store not configured")
    async with pool.connection() as conn:
        await conn.execute("INSERT INTO provisioning.alert_settings (id, threshold_c, clear_below_c, client) VALUES (%s, %s, %s, %s)",
                           (uuid.uuid4(), body.threshold_c, body.clear_below_c, body.client))
    engine.set_thresholds(body.threshold_c, body.clear_below_c)
    return await get_config()


@router.post("/api/push/subscribe")
async def subscribe(sub: Subscription) -> dict:
    if not push_enabled():
        raise HTTPException(503, "push alerts not configured on the server (VAPID keys)")
    if not sub.keys.get("p256dh") or not sub.keys.get("auth"):
        raise HTTPException(422, "subscription keys missing")
    async with pool.connection() as conn:
        async with conn.transaction():  # replace: a re-subscription may come with new keys
            await conn.execute("DELETE FROM provisioning.push_subscriptions WHERE endpoint = %s", (sub.endpoint,))
            await conn.execute("INSERT INTO provisioning.push_subscriptions (endpoint, p256dh, auth, client) VALUES (%s, %s, %s, %s)",
                               (sub.endpoint, sub.keys["p256dh"], sub.keys["auth"], sub.client))
    return {"subscribed": True}


class Unsubscribe(BaseModel):
    endpoint: str


@router.post("/api/push/unsubscribe")
async def unsubscribe(body: Unsubscribe) -> dict:
    if not pool:
        raise HTTPException(503, "push alerts not configured")
    async with pool.connection() as conn:
        await conn.execute("DELETE FROM provisioning.push_subscriptions WHERE endpoint = %s", (body.endpoint,))
    return {"subscribed": False}


@router.post("/api/push/test")
async def test_alert() -> dict:
    return await send_all({"title": "🔔 home_state test alert",
                           "body": f"Alerts are working. Threshold: {engine.threshold_c:g} °C.", "tag": "test", "url": "/"})
