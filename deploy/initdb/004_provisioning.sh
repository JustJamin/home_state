#!/bin/sh
# Provisioning store: saved configs, profiles, deployments (fleet history).
# Runs once, on a fresh data volume; for an existing database apply it by hand (deploy/README.md).
# The entrypoint may source this file, so it uses an if-block, never `exit`.
#
# Records are immutable: the provisioning role may only SELECT and INSERT.
# Archiving is an INSERT into archives. A single sequence orders every
# record, so the phone syncs with one cursor ("give me everything after seq N").
if [ -n "${PROVISIONING_DB_PASSWORD:-}" ]; then
    psql -v ON_ERROR_STOP=1 -v pw="$PROVISIONING_DB_PASSWORD" \
        --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE provisioning LOGIN PASSWORD :'pw';
CREATE SCHEMA provisioning;
CREATE SEQUENCE provisioning.seq;

-- a saved config: a script of JSON-RPC calls for one app + version
CREATE TABLE provisioning.configs (
    id          uuid PRIMARY KEY,
    app         text NOT NULL,
    version     text NOT NULL,
    name        text NOT NULL,
    script      jsonb NOT NULL,
    created_at  timestamptz NOT NULL,
    client      text,
    seq         bigint NOT NULL DEFAULT nextval('provisioning.seq') UNIQUE
);

-- app + version + config; carries its own copy of the script so it's self-contained offline
CREATE TABLE provisioning.profiles (
    id           uuid PRIMARY KEY,
    name         text NOT NULL,
    app          text NOT NULL,
    version      text NOT NULL,
    config_id    uuid,              -- NULL = the version's default config
    config_name  text NOT NULL,
    script       jsonb NOT NULL,
    created_at   timestamptz NOT NULL,
    client       text,
    seq          bigint NOT NULL DEFAULT nextval('provisioning.seq') UNIQUE
);

-- one push of a profile to one device (the fleet record)
CREATE TABLE provisioning.deployments (
    id            uuid PRIMARY KEY,
    device_id     text NOT NULL,
    board_id      integer,
    profile_id    uuid,
    profile_name  text,
    app           text NOT NULL,
    version       text NOT NULL,
    from_version  text,
    flashed       boolean NOT NULL,
    script        jsonb NOT NULL,
    results       jsonb NOT NULL,
    ok            boolean NOT NULL,
    error         text,
    started_at    timestamptz NOT NULL,
    finished_at   timestamptz NOT NULL,
    client        text,
    seq           bigint NOT NULL DEFAULT nextval('provisioning.seq') UNIQUE
);
CREATE INDEX deployments_device ON provisioning.deployments (device_id, finished_at DESC);

-- hiding a config or profile from the pickers (never deleted)
CREATE TABLE provisioning.archives (
    id           uuid PRIMARY KEY,
    kind         text NOT NULL CHECK (kind IN ('config', 'profile')),
    record_id    uuid NOT NULL,
    archived_at  timestamptz NOT NULL,
    client       text,
    seq          bigint NOT NULL DEFAULT nextval('provisioning.seq') UNIQUE
);

GRANT USAGE ON SCHEMA provisioning TO provisioning;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA provisioning TO provisioning;
GRANT USAGE ON SEQUENCE provisioning.seq TO provisioning;
EOSQL
else
    echo "PROVISIONING_DB_PASSWORD not set; skipping provisioning schema"
fi
