-- Grafana is retired: drop its read-only login. A no-op on a fresh volume, which never gets one.
-- Safe to re-run.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'grafana') THEN
        REVOKE ALL ON readings FROM grafana;
        DROP ROLE grafana;
    END IF;
END $$;
