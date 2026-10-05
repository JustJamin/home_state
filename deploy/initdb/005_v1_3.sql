-- v1.3.0: radio stack version on profiles/deployments, and the node's BLE address on
-- deployments (links a device ID to the scanner's readings). Runs after 004 on a fresh
-- volume; for an existing database apply it by hand as home_state (deploy/README.md).
-- Safe to re-run, and a no-op if 004 was skipped (no provisioning password set).
-- The provisioning role's table-level SELECT/INSERT grants cover the new columns.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'provisioning') THEN
        ALTER TABLE provisioning.profiles ADD COLUMN IF NOT EXISTS rf_stack text;
        ALTER TABLE provisioning.deployments ADD COLUMN IF NOT EXISTS rf_stack text;
        ALTER TABLE provisioning.deployments ADD COLUMN IF NOT EXISTS ble_address text;
    END IF;
END $$;
