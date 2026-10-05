# deploy

## Docker Compose

Needs Docker + Compose on lenovo (tracked in `~/repo/sysadmin/TODO.md`).

```sh
cd deploy
cp .env.example .env        # then set a real POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs -f scanner
docker compose exec db psql -U home_state -c \
  "SELECT received_at, board_id, counter, temp_c, rssi FROM readings ORDER BY id DESC LIMIT 10;"
```

- `initdb/` creates the schema only when the `pgdata` volume is first created. If you change it, run `docker compose down -v`, which **deletes all data**.
- Postgres is published on `127.0.0.1:5432` only. Docker-published ports bypass ufw, so never bind it to 0.0.0.0.
- The scanner runs as `nobody` (uid 65534) with only the host D-Bus socket mounted.
  The uid must exist on the host, because the host dbus-daemon resets connections from unknown uids. It doesn't need `--privileged` or host networking.

## k3s

Needs k3s and the local registry on `127.0.0.1:5000` (both tracked in `~/repo/sysadmin/TODO.md`). Set `KUBECONFIG=~/.kube/config`.
Host-side k3s settings (`config.yaml`, graceful node shutdown, start-after-Docker) are in [`k3s/`](k3s/README.md). Apply them with `sudo sh deploy/k3s/apply.sh`.

```sh
# one-time: namespace + DB password (the Secret is never committed)
kubectl apply -f deploy/k8s/namespace.yaml
kubectl -n home-state create secret generic postgres --from-literal=password="$(openssl rand -hex 24)"

kubectl apply -k deploy                 # Postgres StatefulSet, scanner Deployment, NetworkPolicies
deploy/push-scanner.sh                  # build, push to localhost:5000, restart the scanner
kubectl -n home-state logs -f deploy/scanner
kubectl -n home-state exec postgres-0 -- psql -U home_state -c \
  "SELECT received_at, board_id, counter, temp_c, rssi FROM readings ORDER BY id DESC LIMIT 10;"
```

- `kustomization.yaml` lives in `deploy/` so k3s and Compose share `initdb/`.
- Postgres data is in the `data-postgres-0` PVC (`local-path`, 2Gi). Deleting the StatefulSet keeps the data, but `kubectl delete pvc` deletes it permanently.
- NetworkPolicies only let `app: scanner` pods reach Postgres on 5432, and nothing can connect to the scanner. Postgres isn't exposed outside the cluster.
- The scanner uses the `Recreate` strategy, so two scanners never run at once. It's pinned to `lenovo` (the BLE adapter) and runs as `nobody` with a read-only root filesystem and no capabilities.
- Run only one of Compose and k3s at a time. Both would scan and store every reading twice.

### Grafana dashboard

Open **http://100.79.164.117:30300** (lenovo's Tailscale IP) from any tailnet device. Port 30300 isn't reachable from the LAN, because k3s binds NodePorts only to 127.0.0.1 and the Tailscale IP. Anyone who can reach it can view without logging in. Editing needs the admin login, and because the dashboard is provisioned from `grafana/home_state.json`, edits made in the UI aren't saved. To change it, edit the JSON and run `kubectl apply -k deploy`.

```sh
# one-time, before `kubectl apply -k deploy`: Grafana admin + read-only DB passwords
kubectl -n home-state create secret generic grafana \
  --from-literal=admin-password="$(openssl rand -base64 18)" \
  --from-literal=db-password="$(openssl rand -hex 24)"

# only if the Postgres volume already existed before Grafana was added
# (initdb/002_grafana_role.sh runs by itself on a fresh volume)
kubectl -n home-state exec -i postgres-0 -- env POSTGRES_USER=home_state POSTGRES_DB=home_state \
  sh -s < deploy/initdb/002_grafana_role.sh

# admin password
kubectl -n home-state get secret grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

- Grafana connects as the `grafana` Postgres role, which has `SELECT` on `readings` only.
- Grafana's own database is an `emptyDir`. Everything is provisioned from `deploy/grafana/`, so a pod restart loses nothing.
- The "Missed updates" panel counts gaps in each board's counter, so a board reboot also shows up as a gap.

### Demo dashboards (ports 30301–30304)

Streamlit, Dash, NiceGUI and FastAPI+SSE, side by side with Grafana. See `dashboards/README.md`.

```sh
# one-time, before `kubectl apply -k deploy`
kubectl -n home-state create secret generic dashboards --from-literal=db-password="$(openssl rand -hex 24)"
# only if the Postgres volume already existed (initdb/003_dashboards_role.sh runs by itself on a fresh one)
kubectl -n home-state exec -i postgres-0 -- env POSTGRES_USER=home_state POSTGRES_DB=home_state \
  sh -s < deploy/initdb/003_dashboards_role.sh

deploy/push-dashboards.sh          # build + push all four images, restart them
kubectl apply -k deploy
```

- They connect as the `dashboards` role (`SELECT` on `readings` only). The NetworkPolicy lets pods labelled `role: dashboard` reach Postgres.
- Each runs as `nobody` with a read-only root filesystem and an `emptyDir` on `/tmp`.

### Provisioning store (v1.2.0)

The provisioning app's configs, profiles and fleet history live in schema `provisioning`, written through role `provisioning`. That role can only SELECT and INSERT, so records are immutable.

```sh
kubectl -n home-state create secret generic provisioning --from-literal=db-password="$(openssl rand -hex 24)"
# only if the Postgres volume already existed (initdb/004_provisioning.sh runs by itself on a fresh one)
kubectl -n home-state exec -i postgres-0 -- env POSTGRES_USER=home_state POSTGRES_DB=home_state \
  PROVISIONING_DB_PASSWORD="$(kubectl -n home-state get secret provisioning -o jsonpath='{.data.db-password}' | base64 -d)" \
  sh -s < deploy/initdb/004_provisioning.sh
```

`dash-fastapi-sse` gets `PROVISIONING_DATABASE_URL`. If it's unset, `/api/sync` and `/api/fleet` return 503 and the phone stays offline-only.

#### v1.3.0 migration

`initdb/005_v1_3.sql` adds `rf_stack` to profiles and deployments, and `ble_address` to deployments. It runs by itself on a fresh volume. For the existing database:

```sh
kubectl -n home-state exec -i postgres-0 -- psql -U home_state -v ON_ERROR_STOP=1 < deploy/initdb/005_v1_3.sql
```

#### v1.3.1: migration 006 and push keys

`initdb/006_v1_3_1.sql` adds:
- `readings.source` (`scanner` or `gateway`) and an index;
- `deployments.from_app`;
- `push_subscriptions` and `alert_settings` (append-only, the latest row wins);
- INSERT-only access to `readings` for the provisioning role, for gateway uploads. It gets no read access.

```sh
kubectl -n home-state exec -i postgres-0 -- psql -U home_state -v ON_ERROR_STOP=1 < deploy/initdb/006_v1_3_1.sql
```

Temperature alerts use Web Push, which needs a VAPID key pair in the Secret `webpush`, generated once:

```sh
python3 -c "
import base64; from cryptography.hazmat.primitives import serialization as s; from py_vapid import Vapid02
v = Vapid02(); v.generate_keys(); b = lambda x: base64.urlsafe_b64encode(x).rstrip(b'=').decode()
print(b(v.private_key.private_bytes(s.Encoding.DER, s.PrivateFormat.PKCS8, s.NoEncryption())))
print(b(v.public_key.public_bytes(s.Encoding.X962, s.PublicFormat.UncompressedPoint)))"
kubectl -n home-state create secret generic webpush --from-literal=private-key=<first line> \
  --from-literal=public-key=<second line> --from-literal=subject=https://lenovo.tailc2dfa5.ts.net
```

The `subject` is sent to the push service as the contact for these alerts. It's the app's URL, not a personal email. The dashboard pod must reach the push services (FCM); pod egress is open.
