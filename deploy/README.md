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
