-- v1.3.1: phone gateway uploads, push alerts, app switches in the fleet history.
-- Runs after 005 on a fresh volume; for an existing database apply it by hand as
-- home_state (deploy/README.md). Safe to re-run; the provisioning parts are skipped
-- if 004 was (no provisioning schema).

-- readings can now also come from the phone gateway
ALTER TABLE readings ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'scanner';
CREATE INDEX IF NOT EXISTS readings_address_time ON readings (address, received_at);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'provisioning') THEN
        RETURN;
    END IF;

    -- which app a deployment switched from (null when it didn't switch)
    ALTER TABLE provisioning.deployments ADD COLUMN IF NOT EXISTS from_app text;

    -- Web Push subscriptions: one per phone/browser; removed when the push service says it's gone
    CREATE TABLE IF NOT EXISTS provisioning.push_subscriptions (
        endpoint    text PRIMARY KEY,
        p256dh      text NOT NULL,
        auth        text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        client      text
    );

    -- the fleet-wide alert threshold, set from the app: append-only, the latest row wins
    CREATE TABLE IF NOT EXISTS provisioning.alert_settings (
        id             uuid PRIMARY KEY,
        threshold_c    real NOT NULL CHECK (threshold_c BETWEEN 20 AND 80),
        clear_below_c  real NOT NULL,
        changed_at     timestamptz NOT NULL DEFAULT now(),
        client         text,
        seq            bigint NOT NULL DEFAULT nextval('provisioning.seq') UNIQUE,
        CHECK (clear_below_c < threshold_c)
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'provisioning') THEN
        GRANT SELECT, INSERT, DELETE ON provisioning.push_subscriptions TO provisioning;
        GRANT SELECT, INSERT ON provisioning.alert_settings TO provisioning;
        -- gateway uploads: insert-only, and only these columns (id, source default, etc. are server-side)
        GRANT INSERT (received_at, board_id, address, name, rssi, version, counter, temp_c, uptime_s, source)
            ON readings TO provisioning;
        -- no SELECT on readings: the gateway's duplicate check reads through the dashboards role
        GRANT USAGE ON SEQUENCE readings_id_seq TO provisioning;
    END IF;
END $$;
