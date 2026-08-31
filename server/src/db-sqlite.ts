import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Account, DeviceSummary, ProductEventInput, ProductEventWriteResult, ProductMetrics,
  ProductMetricsQuery, RegisteredDevice, ReserveResult, Store, StoredProductEvent,
  StoredUsageMetric, TopUpSummary,
} from './db.ts';
import { hashToken, newToken } from './db.ts';
import { aggregateProductMetrics } from './telemetry.ts';

// Local/self-hosted store: SQLite via the Node built-in driver. Kept in its own module so
// platforms without node:sqlite (or with a read-only filesystem) never load it — the storage
// factory imports implementations dynamically.

const SCHEMA = `
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
`;

interface DeviceRow {
  id: number;
  app_version: string | null;
  onboarded: number;
  balance_questions: number;
  total_questions: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cli_enabled: number;
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Lazy migrations: databases created before the admin grant tool lack topups.note, and ones
    // before the per-device CLI switch lack devices.cli_enabled. SQLite's ADD COLUMN has no
    // IF NOT EXISTS, so probe the schema first (idempotent on every boot).
    this.ensureColumn('topups', 'note', 'TEXT');
    this.ensureColumn('devices', 'cli_enabled', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('devices', 'onboarded', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('devices', 'hotkey_presses', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('usage_events', 'capture_id', 'TEXT');
    this.ensureColumn('usage_events', 'result_protocol', 'TEXT');
    this.ensureColumn('usage_events', 'result_state', 'TEXT');
    this.ensureColumn('usage_events', 'parser_path', 'TEXT');
    this.ensureColumn('usage_events', 'estimated_cost_micros', 'INTEGER');
    this.ensureColumn('usage_events', 'pricing_version', 'TEXT');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  async registerDevice(input: {
    platform: string;
    appVersion: string;
    trialQuestions: number;
  }): Promise<RegisteredDevice> {
    const token = newToken();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO devices (token_hash, platform, app_version, balance_questions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), input.platform, input.appVersion, input.trialQuestions, now, now);
    return {
      token,
      balanceQuestions: input.trialQuestions,
      id: Number(result.lastInsertRowid),
    };
  }

  private deviceByToken(token: string): DeviceRow | null {
    const row = this.db
      .prepare(
        `SELECT id, app_version, onboarded, balance_questions, total_questions, total_input_tokens,
                total_output_tokens, cli_enabled
         FROM devices WHERE token_hash = ?`,
      )
      .get(hashToken(token)) as DeviceRow | undefined;
    return row ?? null;
  }

  async getAccount(token: string): Promise<Account | null> {
    const row = this.deviceByToken(token);
    if (!row) return null;
    return {
      balanceQuestions: row.balance_questions,
      totalQuestions: row.total_questions,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      cliEnabled: row.cli_enabled === 1,
      appVersion: row.app_version,
      onboarded: row.onboarded === 1,
    };
  }

  async setCliEnabled(token: string, enabled: boolean): Promise<boolean | null> {
    const dev = this.deviceByToken(token);
    if (!dev) return null;
    this.db
      .prepare(`UPDATE devices SET cli_enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), dev.id);
    return enabled;
  }

  async reserveQuestions(input: { token: string; questions: number }): Promise<ReserveResult> {
    // Test and deduct in one statement (same contract as PostgresStore): a balance guard in the
    // WHERE clause is what makes concurrent captures on a balance of 1 produce one winner.
    const row = this.db
      .prepare(
        `UPDATE devices SET balance_questions = balance_questions - ?, updated_at = ?
         WHERE token_hash = ? AND balance_questions >= ?
         RETURNING balance_questions`,
      )
      .get(input.questions, new Date().toISOString(), hashToken(input.token), input.questions) as
      | { balance_questions: number }
      | undefined;
    if (row) return { ok: true, balanceQuestions: row.balance_questions };
    const exists = this.deviceByToken(input.token) !== null;
    return { ok: false, reason: exists ? 'insufficient_quota' : 'unknown_token' };
  }

  async settleReservation(input: {
    token: string;
    questions: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    captureId?: string;
    resultProtocol?: string;
    resultState?: string;
    parserPath?: string;
    estimatedCostMicros?: number;
    pricingVersion?: string;
  }): Promise<void> {
    this.tx(() => {
      const dev = this.deviceByToken(input.token);
      if (!dev) return;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE devices SET total_questions = total_questions + ?,
             total_input_tokens = total_input_tokens + ?,
             total_output_tokens = total_output_tokens + ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(input.questions, input.inputTokens, input.outputTokens, now, dev.id);
      this.db
        .prepare(
          `INSERT INTO usage_events
           (device_id, questions, input_tokens, output_tokens, model, created_at, capture_id,
            result_protocol, result_state, parser_path, estimated_cost_micros, pricing_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(dev.id, input.questions, input.inputTokens, input.outputTokens, input.model, now,
          input.captureId ?? null, input.resultProtocol ?? null, input.resultState ?? null,
          input.parserPath ?? null, input.estimatedCostMicros ?? null, input.pricingVersion ?? null);
    });
  }

  async recordProductEvents(token: string, events: ProductEventInput[]): Promise<ProductEventWriteResult> {
    const dev = this.deviceByToken(token);
    if (!dev) return { accepted: 0, duplicate: 0 };
    return this.tx(() => {
      const statement = this.db.prepare(
        `INSERT OR IGNORE INTO product_events
         (event_id, device_id, capture_id, occurred_at, received_at, event_name, trigger, channel,
          mode, depth, context_count, question_kind, result_state, parser_path, error_code, action,
          capture_ms, first_token_ms, total_ms, app_version, config_revision, variant)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const receivedAt = new Date().toISOString();
      let accepted = 0;
      for (const event of events) {
        const result = statement.run(
          event.eventId, dev.id, event.captureId, event.occurredAt, receivedAt, event.eventName,
          event.trigger, event.channel, event.mode, event.depth, event.contextCount,
          event.questionKind, event.resultState, event.parserPath, event.errorCode, event.action,
          event.captureMs, event.firstTokenMs, event.totalMs, event.appVersion,
          event.configRevision, event.variant,
        );
        accepted += Number(result.changes);
      }
      return { accepted, duplicate: events.length - accepted };
    });
  }

  async getProductMetrics(input: ProductMetricsQuery): Promise<ProductMetrics> {
    const rows = this.db.prepare(
      `SELECT device_id, event_id, capture_id, occurred_at, received_at, event_name, trigger,
              channel, mode, depth, context_count, question_kind, result_state, parser_path,
              error_code, action, capture_ms, first_token_ms, total_ms, app_version,
              config_revision, variant
       FROM product_events WHERE received_at >= ? AND received_at < ?`,
    ).all(input.from, input.to) as Array<Record<string, unknown>>;
    const mapped: StoredProductEvent[] = rows.map((r) => ({
      deviceId: Number(r.device_id), eventId: String(r.event_id), captureId: r.capture_id as string | null,
      occurredAt: String(r.occurred_at), receivedAt: String(r.received_at), eventName: String(r.event_name),
      trigger: r.trigger as string | null, channel: r.channel as string | null, mode: r.mode as string | null,
      depth: r.depth as string | null, contextCount: r.context_count as number | null,
      questionKind: r.question_kind as string | null, resultState: r.result_state as string | null,
      parserPath: r.parser_path as string | null, errorCode: r.error_code as string | null,
      action: r.action as string | null, captureMs: r.capture_ms as number | null,
      firstTokenMs: r.first_token_ms as number | null, totalMs: r.total_ms as number | null,
      appVersion: r.app_version as string | null, configRevision: r.config_revision as string | null,
      variant: r.variant as string | null,
    }));
    const usage = this.db.prepare(
      `SELECT capture_id, input_tokens, output_tokens, questions, estimated_cost_micros
       FROM usage_events WHERE created_at >= ? AND created_at < ?`,
    ).all(input.from, input.to) as Array<{
      capture_id: string | null; input_tokens: number; output_tokens: number;
      questions: number; estimated_cost_micros: number | null;
    }>;
    const usageMetrics: StoredUsageMetric[] = usage.map((row) => ({
      captureId: row.capture_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      questions: row.questions, estimatedCostMicros: row.estimated_cost_micros,
    }));
    return aggregateProductMetrics(mapped, input, usageMetrics);
  }

  async pruneProductEvents(before: string): Promise<number> {
    return Number(this.db.prepare(`DELETE FROM product_events WHERE received_at < ?`).run(before).changes);
  }

  async releaseReservation(input: { token: string; questions: number }): Promise<number | null> {
    const row = this.db
      .prepare(
        `UPDATE devices SET balance_questions = balance_questions + ?, updated_at = ?
         WHERE token_hash = ? RETURNING balance_questions`,
      )
      .get(input.questions, new Date().toISOString(), hashToken(input.token)) as
      | { balance_questions: number }
      | undefined;
    return row ? row.balance_questions : null;
  }

  async credit(input: {
    token: string;
    questions: number;
    amountCents: number;
    currency: string;
    provider: string;
    reference: string;
    note?: string;
  }): Promise<number | null> {
    return this.tx(() => {
      const dev = this.deviceByToken(input.token);
      if (!dev) return null;
      // Idempotency: a reference that was already credited (retried webhook delivery)
      // must not credit twice. Return the current balance unchanged.
      const dup = this.db
        .prepare(`SELECT id FROM topups WHERE reference = ?`)
        .get(input.reference);
      if (dup) return dev.balance_questions;

      const now = new Date().toISOString();
      const newBalance = dev.balance_questions + input.questions;
      this.db
        .prepare(`UPDATE devices SET balance_questions = ?, updated_at = ? WHERE id = ?`)
        .run(newBalance, now, dev.id);
      this.db
        .prepare(
          `INSERT INTO topups (device_id, questions, amount_cents, currency, provider, reference, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(dev.id, input.questions, input.amountCents, input.currency, input.provider, input.reference, input.note ?? null, now);
      return newBalance;
    });
  }

  async updateAppVersion(token: string, appVersion: string): Promise<void> {
    this.db
      .prepare(`UPDATE devices SET app_version = ? WHERE token_hash = ?`)
      .run(appVersion, hashToken(token));
  }

  async markOnboarded(token: string): Promise<void> {
    this.db.prepare(`UPDATE devices SET onboarded = 1 WHERE token_hash = ?`).run(hashToken(token));
  }

  async recordHotkeyPress(token: string): Promise<void> {
    this.db
      .prepare(`UPDATE devices SET hotkey_presses = hotkey_presses + 1 WHERE token_hash = ?`)
      .run(hashToken(token));
  }

  async listRecentDevices(limit: number): Promise<DeviceSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT id, platform, app_version, balance_questions, total_questions, created_at,
                updated_at, onboarded, hotkey_presses
         FROM devices ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      platform: string | null;
      app_version: string | null;
      balance_questions: number;
      total_questions: number;
      created_at: string;
      updated_at: string;
      onboarded: number;
      hotkey_presses: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      appVersion: r.app_version,
      balanceQuestions: r.balance_questions,
      totalQuestions: r.total_questions,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      onboarded: r.onboarded === 1,
      hotkeyPresses: r.hotkey_presses,
    }));
  }

  async listRecentTopups(limit: number): Promise<TopUpSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.device_id, t.questions, t.amount_cents, t.currency, t.provider,
                t.reference, t.note, t.created_at,
                d.platform, d.app_version, d.created_at AS device_created_at,
                d.total_questions AS device_total_questions
         FROM topups t JOIN devices d ON d.id = t.device_id
         ORDER BY t.id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      device_id: number;
      questions: number;
      amount_cents: number;
      currency: string;
      provider: string;
      reference: string | null;
      note: string | null;
      created_at: string;
      platform: string | null;
      app_version: string | null;
      device_created_at: string;
      device_total_questions: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      questions: r.questions,
      amountCents: r.amount_cents,
      currency: r.currency,
      provider: r.provider,
      reference: r.reference,
      note: r.note,
      createdAt: r.created_at,
      devicePlatform: r.platform,
      deviceAppVersion: r.app_version,
      deviceCreatedAt: r.device_created_at,
      deviceTotalQuestions: r.device_total_questions,
    }));
  }

  async bumpCounter(name: string): Promise<number> {
    const row = this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .get(name) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  async getCounter(name: string): Promise<number> {
    const row = this.db.prepare(`SELECT value FROM counters WHERE name = ?`).get(name) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  /** Run `fn` inside a transaction; rollback on any throw. node:sqlite is synchronous. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
