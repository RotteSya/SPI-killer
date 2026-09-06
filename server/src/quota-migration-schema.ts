export const QUOTA_MIGRATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_migration_control (
 id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL CHECK(state IN ('active','paused')),
 revision BIGINT NOT NULL DEFAULT 0, compatibility_release TEXT, updated_at TEXT NOT NULL
);
INSERT INTO quota_migration_control(id,state,updated_at) VALUES(1,'active','1970-01-01T00:00:00.000Z') ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS quota_migration_checkpoints (
 device_id BIGINT PRIMARY KEY REFERENCES devices(id), migration_version INTEGER NOT NULL CHECK(migration_version=1),
 opening_lot_id TEXT REFERENCES quota_lots(lot_id), account_snapshot TEXT NOT NULL,
 history_snapshot TEXT NOT NULL, created_at TEXT NOT NULL, validated_balance_version TEXT
);
CREATE TABLE IF NOT EXISTS quota_migration_events (
 revision BIGINT PRIMARY KEY, state TEXT NOT NULL, compatibility_release TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_ledger_lot ON quota_ledger(lot_id);
CREATE INDEX IF NOT EXISTS idx_quota_reservations_lot_state ON quota_reservations(lot_id,state);
`;
