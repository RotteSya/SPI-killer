import {SQLPurchaseSessions} from './purchase-session-sql.ts';
import {SQLQuotaMigration} from './quota-migration.ts';
import { randomUUID } from 'node:crypto';
import { SQLBilling, BILLING_SCHEMA, type Transaction } from './billing-sql.ts';
import { SQLPaymentLedger, PAYMENT_SCHEMA } from './payment-ledger-sql.ts';
import { SQLObservationStore, OBSERVATION_SCHEMA } from './observation-sql.ts';
import { SQLReportingStore, REPORTING_SCHEMA } from './reporting-sql.ts';
import {SQLPaymentFinance} from './payment-finance-sql.ts';
import { validQuestions, type RegistrationInput } from './billing.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Account, DeviceSummary, ProductEventInput, ProductEventWriteResult, ProductMetrics,
  ProductMetricsQuery, RegisteredDevice, ReserveResult, Store, StoredProductEvent,
  StoredUsageMetric, TopUpSummary, PurchaseSession, PurchaseSessionInput, StoredPurchaseSession,
  WebhookEventInput, PaymentAdjustmentInput,
} from './db.ts';
import { hashToken } from './db.ts';
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
CREATE TABLE IF NOT EXISTS purchase_sessions (
  session_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id), purchase_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE, pack_id TEXT NOT NULL, catalog_version TEXT NOT NULL, questions INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, lang TEXT NOT NULL, expires_at TEXT NOT NULL,
  checkout_session_id TEXT UNIQUE, created_at TEXT NOT NULL, UNIQUE(device_id,purchase_id)
);
CREATE TABLE IF NOT EXISTS webhook_inbox (
  provider_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event_created_at TEXT,
  received_at TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'received'
);
CREATE TABLE IF NOT EXISTS payment_adjustments (
  adjustment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_ref TEXT NOT NULL UNIQUE,
  order_reference TEXT NOT NULL,
  adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('refund','dispute','fee')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('observed','applied','ignored')),
  effective_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
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
  readonly billing = new SQLBilling(transaction => this.runBilling(transaction));
  readonly quotaMigration = new SQLQuotaMigration(transaction => this.runBilling(transaction, true));
  readonly payments = new SQLPaymentLedger(transaction => this.runBilling(transaction));
  readonly finance = new SQLPaymentFinance(transaction => this.runBilling(transaction));
  private readonly purchases = new SQLPurchaseSessions(transaction => this.runBilling(transaction));
  readonly observations = new SQLObservationStore(transaction => this.runBilling(transaction));
  readonly reporting = new SQLReportingStore(transaction => this.runBilling(transaction));

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
    this.enableWAL();
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.tx(() => {
    this.db.exec(SCHEMA);
    // Lazy migrations: databases created before the admin grant tool lack topups.note, and ones
    // before the per-device CLI switch lack devices.cli_enabled. SQLite's ADD COLUMN has no
    // IF NOT EXISTS, so probe the schema first (idempotent on every boot).
    this.ensureColumn('topups', 'note', 'TEXT');
    this.ensureColumn('purchase_sessions','checkout_url','TEXT');
    this.ensureColumn('purchase_sessions','consumed_at','TEXT');
    this.ensureColumn('devices', 'cli_enabled', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('devices', 'onboarded', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('devices', 'hotkey_presses', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('usage_events', 'capture_id', 'TEXT');
    this.ensureColumn('usage_events', 'result_protocol', 'TEXT');
    this.ensureColumn('usage_events', 'result_state', 'TEXT');
    this.ensureColumn('usage_events', 'parser_path', 'TEXT');
    this.ensureColumn('usage_events', 'estimated_cost_micros', 'INTEGER');
    this.ensureColumn('usage_events', 'pricing_version', 'TEXT');
    this.ensureColumn('devices', 'quota_policy_version', "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn('devices', 'initial_grant_questions', "BIGINT");
    this.ensureColumn('devices', 'balance_version', "BIGINT NOT NULL DEFAULT 0");
    this.ensureColumn('devices', 'registration_key_hash', "TEXT");
    this.ensureColumn('devices', 'registration_key_version', "TEXT");
    this.ensureColumn('product_events', 'extensions', 'TEXT');
    this.db.exec(BILLING_SCHEMA);
    this.ensureColumn('quota_lots','refund_frozen','INTEGER NOT NULL DEFAULT 0 CHECK(refund_frozen IN (0,1))');
    this.ensureColumn('quota_lots','refund_revoked','BIGINT NOT NULL DEFAULT 0 CHECK(refund_revoked>=0)');
    this.ensureColumn('quota_lots','refund_target','BIGINT NOT NULL DEFAULT 0 CHECK(refund_target>=0)');
    this.ensureColumn('webhook_inbox','payload_hash','TEXT');
    this.ensureColumn('webhook_inbox','resource_generation','BIGINT');
    this.ensureColumn('webhook_inbox','retry_after','TEXT');
    this.db.exec(PAYMENT_SCHEMA);
    this.ensureColumn('checkout_deliveries','recorded_at','TEXT');
    this.db.exec(OBSERVATION_SCHEMA);
    this.ensureColumn('devices','is_internal','INTEGER NOT NULL DEFAULT 0 CHECK(is_internal IN (0,1))');
    this.db.exec(REPORTING_SCHEMA);
    this.ensureColumn('report_expense_allocations','source_group','TEXT');
    this.ensureColumn('report_expense_allocations','policy_version','TEXT');
    this.ensureColumn('report_expense_allocations','revision','BIGINT NOT NULL DEFAULT 0');
    this.ensureColumn('payment_refunds','payment_intent_id','TEXT');
    this.ensureColumn('payment_refunds','charge_id','TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_refunds_payment_intent ON payment_refunds(payment_intent_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_refunds_charge ON payment_refunds(charge_id)');
    this.ensureColumn('attempt_budget_holds', 'device_id', 'BIGINT REFERENCES devices(id)');
    this.db.exec('UPDATE attempt_budget_holds SET device_id=(SELECT device_id FROM model_attempts WHERE model_attempts.attempt_id=attempt_budget_holds.attempt_id) WHERE device_id IS NULL');
    }); } catch (error) { this.db.close(); throw error; }
  }

  private enableWAL(): void {
    // Changing journal mode can return SQLITE_BUSY without invoking SQLite's busy
    // handler. Retry only this idempotent, pre-transaction operation within one
    // monotonic deadline; normal writes retain their existing busy timeout.
    this.db.exec('PRAGMA busy_timeout=0');
    const deadline = performance.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try { this.db.exec('PRAGMA journal_mode = WAL'); return; }
      catch (error) {
        const remaining = deadline - performance.now();
        if (!(error instanceof Error) || !('errcode' in error) || error.errcode !== 5 || remaining <= 0) throw error;
        Atomics.wait(pause, 0, 0, Math.min(25, remaining));
      }
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private async runBilling<T>(transaction: Transaction<T>, migration = false): Promise<T> {
    return this.tx(() => {
      // BEGIN IMMEDIATE serializes SQLite writers; Postgres uses a shared control-row lock.
      if (!migration && !this.db.prepare('SELECT id FROM quota_migration_control WHERE id=1').get()) throw new Error('Quota migration control unavailable');
      let step = transaction.next();
      while (!step.done) {
        const statement = this.db.prepare(step.value.sql.replace(/ FOR (?:UPDATE|SHARE)/g, ''));
        statement.setReadBigInts(true);
        step = transaction.next(statement.all(...step.value.args));
      }
      return step.value;
    });
  }

  async registerDevice(input: RegistrationInput): Promise<RegisteredDevice> {
    return this.billing.register(input);
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
    if (input.questions !== 1) throw new Error('A capture reserves exactly one question');
    const id = randomUUID();
    const result = await this.billing.begin({ token: input.token, captureId: id, requestHmac: id, legacy: true });
    if (result.ok) return { ok: true, balanceQuestions: result.quota.balanceQuestions };
    if (result.reason === 'unknown_token' || result.reason === 'insufficient_quota') return { ok: false, reason: result.reason };
    throw new Error('Legacy reservation conflict');
  }

  async settleReservation(input: Parameters<Store['settleReservation']>[0]): Promise<void> {
    if (input.questions !== 1) throw new Error('A capture settles exactly one question');
    await this.billing.finish({ ...input, captureId: undefined, usageCaptureId: input.captureId, charge: true, terminalState: 'usable' });
  }

  async recordProductEvents(token: string, events: ProductEventInput[]): Promise<ProductEventWriteResult> {
    return this.observations.events(token,events);
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<boolean> {
    const result = this.db.prepare(`INSERT OR IGNORE INTO webhook_inbox
      (provider_event_id,event_type,resource_id,event_created_at,received_at,processing_state)
      VALUES (?,?,?,?,?,'received')`).run(input.providerEventId, input.eventType, input.resourceId,
      input.eventCreatedAt, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  async recordPaymentAdjustment(input: PaymentAdjustmentInput): Promise<boolean> {
    validQuestions(input.amountCents);
    const result = this.db.prepare(`INSERT OR IGNORE INTO payment_adjustments
      (provider_ref,order_reference,adjustment_type,amount_cents,currency,status,effective_at,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(input.providerRef, input.orderReference, input.type, input.amountCents,
      input.currency, input.status, input.effectiveAt, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  async getProductMetrics(input: ProductMetricsQuery): Promise<ProductMetrics> {
    const rows = this.db.prepare(
      `SELECT device_id, event_id, capture_id, occurred_at, received_at, event_name, trigger,
              channel, mode, depth, context_count, question_kind, result_state, parser_path,
              error_code, action, capture_ms, first_token_ms, total_ms, app_version,
              config_revision, variant, extensions
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
      variant: r.variant as string | null, extensions: r.extensions ? JSON.parse(String(r.extensions)) : undefined,
    }));
    const usage = this.db.prepare(
      `SELECT device_id, capture_id, input_tokens, output_tokens, questions, estimated_cost_micros
       FROM usage_events WHERE created_at >= ? AND created_at < ?`,
    ).all(input.from, input.to) as Array<{
      device_id:number; capture_id: string | null; input_tokens: number; output_tokens: number;
      questions: number; estimated_cost_micros: number | null;
    }>;
    const usageMetrics: StoredUsageMetric[] = usage.map((row) => ({
      deviceId:row.device_id,captureId: row.capture_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      questions: row.questions, estimatedCostMicros: row.estimated_cost_micros,
    }));
    return aggregateProductMetrics(mapped, input, usageMetrics);
  }

  async pruneProductEvents(before: string): Promise<number> {
    return this.observations.prune(before);
  }

  async releaseReservation(input: { token: string; questions: number }): Promise<number | null> {
    if (input.questions !== 1) throw new Error('A capture releases exactly one question');
    return (await this.billing.finish({ token: input.token, charge: false, terminalState: 'failed' }))?.balanceQuestions ?? null;
  }

  async credit(input: Parameters<Store['credit']>[0]): Promise<number | null> {
    return this.billing.credit(input);
  }

  createPurchaseSession(input:PurchaseSessionInput):Promise<PurchaseSession|null> { return this.purchases.create(input); }
  getPurchaseSession(sessionId:string,secret:string):Promise<StoredPurchaseSession|null> { return this.purchases.get(sessionId,secret); }
  getPurchaseSessionByCheckout(id:string):Promise<StoredPurchaseSession|null> { return this.purchases.byCheckout(id); }
  attachPurchaseCheckout(sessionId:string,id:string,url?:string):Promise<boolean> { return this.purchases.attach(sessionId,id,url); }
  async creditDevice(input:{deviceId:number;questions:number;amountCents:number;currency:string;provider:string;reference:string;note?:string}):Promise<number|null> {
    return this.billing.creditDevice(input.deviceId,input);
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
    this.db.exec('BEGIN IMMEDIATE');
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
