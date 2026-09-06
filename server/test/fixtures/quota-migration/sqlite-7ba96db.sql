-- Extracted from 7ba96db7408b8e203adfb133947535a604806fb0:server/src/db-sqlite.ts
-- Source SHA-256 24230faf861c85f8490aec5bab0fd46a5e9caab07d2ee458837f6ea281a23506

CREATE TABLE IF NOT EXISTS devices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash          TEXT NOT NULL UNIQUE,
  platform            TEXT,
  app_version         TEXT,
  balance_questions   INTEGER NOT NULL DEFAULT 0,
  total_questions     INTEGER NOT NULL DEFAULT 0,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  cli_enabled         INTEGER NOT NULL DEFAULT 0,
  onboarded           INTEGER NOT NULL DEFAULT 0,
  hotkey_presses      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER NOT NULL REFERENCES devices(id),
  questions     INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  model         TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  capture_id TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  event_name TEXT NOT NULL,
  trigger TEXT, channel TEXT, mode TEXT, depth TEXT, context_count INTEGER,
  question_kind TEXT, result_state TEXT, parser_path TEXT, error_code TEXT, action TEXT,
  capture_ms INTEGER, first_token_ms INTEGER, total_ms INTEGER,
  app_version TEXT, config_revision TEXT, variant TEXT
);
CREATE TABLE IF NOT EXISTS topups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id    INTEGER NOT NULL REFERENCES devices(id),
  questions    INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  provider     TEXT NOT NULL,
  reference    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_device ON usage_events(device_id);
CREATE INDEX IF NOT EXISTS idx_topups_device ON topups(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topups_reference ON topups(reference);
CREATE INDEX IF NOT EXISTS idx_product_received ON product_events(received_at);
CREATE INDEX IF NOT EXISTS idx_product_name_received ON product_events(event_name, received_at);
CREATE INDEX IF NOT EXISTS idx_product_variant_received ON product_events(variant, received_at);
CREATE INDEX IF NOT EXISTS idx_product_device_received ON product_events(device_id, received_at);
CREATE INDEX IF NOT EXISTS idx_product_capture ON product_events(capture_id);

ALTER TABLE usage_events ADD COLUMN capture_id TEXT;
ALTER TABLE usage_events ADD COLUMN result_protocol TEXT;
ALTER TABLE usage_events ADD COLUMN result_state TEXT;
ALTER TABLE usage_events ADD COLUMN parser_path TEXT;
ALTER TABLE usage_events ADD COLUMN estimated_cost_micros INTEGER;
ALTER TABLE usage_events ADD COLUMN pricing_version TEXT;
