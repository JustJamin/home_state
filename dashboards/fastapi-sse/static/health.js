// System health, shown in the Gateway tab. The server checks every part of home_state every
// 30 s (health.py, GET api/health) and pushes failures to phones; this adds the checks only
// the phone can make (can it reach the server, has it synced, will it be alerted), and keeps
// the last server snapshot so an offline phone still shows what it last knew.

export const RANK = { ok: 0, unknown: 1, warn: 2, fail: 3 };
export const worst = statuses => statuses.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), "ok");

/** Fetch the server's snapshot. Returns {snapshot, rttMs} or throws. */
export async function fetchHealth({ fetchFn = (...a) => fetch(...a), now = () => performance.now(), checkNow = false } = {}) {
  const t0 = now();
  const r = await fetchFn(checkNow ? "api/health/check" : "api/health", checkNow ? { method: "POST" } : {});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const snapshot = await r.json();
  return { snapshot, rttMs: Math.round(now() - t0) };
}

/**
 * The phone's own checks.
 *   reach: {ok: true, rttMs} | {ok: false, error, lastKnownAt}
 *   sync: {pending, lastSync}            alerts: {on, permission, pushEnabled}
 */
export function phoneChecks({ reach, sync, alerts }, agoFn) {
  const out = [];
  out.push(reach.ok
    ? { id: "phone_server", label: "Server connection", status: "ok", detail: `reachable (${reach.rttMs} ms)` }
    : { id: "phone_server", label: "Server connection", status: "fail",
        detail: `can't reach the server (${reach.error})` +
          (reach.lastKnownAt ? `: below is the last known status, from ${agoFn(reach.lastKnownAt)}` : "") });
  const { pending, lastSync } = sync;
  out.push({ id: "phone_sync", label: "Sync", status: pending ? "warn" : lastSync ? "ok" : "unknown",
             detail: (pending ? `${pending} record${pending === 1 ? "" : "s"} waiting to sync` : "nothing waiting") +
               ` · last synced ${agoFn(lastSync)}` });
  out.push(alerts.on
    ? { id: "phone_alerts", label: "Alerts on this phone", status: "ok", detail: "on: this phone is told about failures and temperature alerts" }
    : { id: "phone_alerts", label: "Alerts on this phone", status: "warn",
        detail: alerts.permission === "denied"
          ? "notifications are blocked for this site, so this phone won't be told about problems"
          : "off: this phone won't be told about problems (turn them on with the 🔔)" });
  return out;
}

/** "All OK" / "2 failing · 1 warning" for the summary pill. */
export function summary(checks) {
  const n = s => checks.filter(c => c.status === s).length;
  const fail = n("fail"), warn = n("warn"), unknown = n("unknown");
  if (!fail && !warn && !unknown) return "All OK";
  return [fail && `${fail} failing`, warn && `${warn} warning${warn === 1 ? "" : "s"}`,
          unknown && `${unknown} unknown`].filter(Boolean).join(" · ");
}
