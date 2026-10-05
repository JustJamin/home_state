-- v1.3.1: names people give devices in the fleet (e.g. "rack-3-top"). The device doesn't
-- know its name; it's the fleet's label for its device ID. Append-only: each rename is a
-- row and the latest row per device wins (name NULL = cleared). Uniqueness (ignoring
-- capitals) among the current names is enforced by the API. Safe to re-run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'provisioning') THEN
        RETURN;
    END IF;
    CREATE TABLE IF NOT EXISTS provisioning.device_names (
        id          uuid PRIMARY KEY,
        device_id   text NOT NULL CHECK (device_id ~ '^[0-9a-f]{12}$'),
        name        text CHECK (name ~ '^[A-Za-z0-9._-]{1,20}$'),
        changed_at  timestamptz NOT NULL DEFAULT now(),
        client      text,
        seq         bigint NOT NULL DEFAULT nextval('provisioning.seq') UNIQUE
    );
    CREATE INDEX IF NOT EXISTS device_names_device ON provisioning.device_names (device_id, seq DESC);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'provisioning') THEN
        GRANT SELECT, INSERT ON provisioning.device_names TO provisioning;
    END IF;
END $$;
