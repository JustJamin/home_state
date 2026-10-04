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
- The scanner runs as uid 10001 with only the host D-Bus socket mounted. It doesn't need `--privileged` or host networking.
