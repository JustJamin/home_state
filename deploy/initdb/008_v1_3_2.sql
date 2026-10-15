-- v1.3.2: the scanner's heartbeat, for the Server Temp app's health checks. One row, replaced
-- every 30 s by the scanner: how many BLE adverts it heard from ANY device (so an adapter that
-- has gone deaf shows up even when no board is in range) and how many new readings. Safe to re-run.
CREATE TABLE IF NOT EXISTS scanner_heartbeat (
    id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    at            timestamptz NOT NULL,
    started_at    timestamptz NOT NULL,  -- when this scanner process started
    window_s      real NOT NULL,         -- the period the counts cover
    adverts       int NOT NULL,          -- adverts from any BLE device in the window
    readings      int NOT NULL,          -- new home_state readings in the window
    last_advert_s real NOT NULL          -- seconds since the last advert of any kind
);

-- the health checks also look up each board's newest reading, across all boards by time
CREATE INDEX IF NOT EXISTS readings_received_at ON readings (received_at);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboards') THEN
        GRANT SELECT ON scanner_heartbeat TO dashboards;
    END IF;
END $$;
