-- Runs once, when the Postgres data volume is first created.
CREATE TABLE readings (
    id          bigserial PRIMARY KEY,
    received_at timestamptz NOT NULL,
    board_id    smallint    NOT NULL,
    address     text        NOT NULL,
    name        text,
    rssi        smallint,
    version     smallint    NOT NULL,
    counter     integer     NOT NULL,
    temp_c      real,
    uptime_s    integer
);

CREATE INDEX readings_board_time ON readings (board_id, received_at DESC);
