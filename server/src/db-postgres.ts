import {SQLPurchaseSessions} from './purchase-session-sql.ts';
import {SQLQuotaMigration} from './quota-migration.ts';
import { randomUUID } from 'node:crypto';
import { SQLBilling, BILLING_SCHEMA, type Transaction } from './billing-sql.ts';
import { SQLPaymentLedger, PAYMENT_SCHEMA } from './payment-ledger-sql.ts';
import { SQLObservationStore, OBSERVATION_SCHEMA } from './observation-sql.ts';
import { SQLReportingStore, REPORTING_SCHEMA } from './reporting-sql.ts';
import {SQLPaymentFinance} from './payment-finance-sql.ts';
import type { RegistrationInput } from './billing.ts';
import pg from 'pg';
import type {
  Account, DeviceSummary, ProductEventInput, ProductEventWriteResult, ProductMetrics,
  ProductMetricsQuery, RegisteredDevice, ReserveResult, Store, StoredProductEvent,
  StoredUsageMetric, TopUpSummary, PurchaseSession, PurchaseSessionInput, StoredPurchaseSession,
  WebhookEventInput, PaymentAdjustmentInput,
} from './db.ts';
import { hashToken } from './db.ts';
import { aggregateProductMetrics } from './telemetry.ts';

// Production store: Postgres via the standard `pg` driver. Works with any provider (Neon,
// Supabase, RDS, …); on serverless platforms use the provider's POOLED connection string.
// Schema is created lazily on first use, so a fresh database needs no migration step.
// Semantics match SqliteStore exactly, including idempotent credits by reference.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id                  BIGSERIAL PRIMARY KEY,
  token_hash          TEXT NOT NULL UNIQUE,
  platform            TEXT,
  app_version         TEXT,
  balance_questions   BIGINT NOT NULL DEFAULT 0,
  total_questions     BIGINT NOT NULL DEFAULT 0,
  total_input_tokens  BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  cli_enabled         BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_events (
  id            BIGSERIAL PRIMARY KEY,
  device_id     BIGINT NOT NULL REFERENCES devices(id),
  questions     BIGINT NOT NULL,
  input_tokens  BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  model         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  device_id BIGINT NOT NULL REFERENCES devices(id),
  capture_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name TEXT NOT NULL,
  trigger TEXT, channel TEXT, mode TEXT, depth TEXT, context_count INTEGER,
  question_kind TEXT, result_state TEXT, parser_path TEXT, error_code TEXT, action TEXT,
  capture_ms BIGINT, first_token_ms BIGINT, total_ms BIGINT,
  app_version TEXT, config_revision TEXT, variant TEXT
);
CREATE TABLE IF NOT EXISTS topups (
  id           BIGSERIAL PRIMARY KEY,
  device_id    BIGINT NOT NULL REFERENCES devices(id),
  questions    BIGINT NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency     TEXT NOT NULL,
  provider     TEXT NOT NULL,
  reference    TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Lazy migration for databases created before the admin grant tool (Postgres supports the
-- IF NOT EXISTS guard, so this is a safe no-op once the column exists).
ALTER TABLE topups ADD COLUMN IF NOT EXISTS note TEXT;
-- Lazy migration for databases created before the per-device CLI switch.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS cli_enabled BOOLEAN NOT NULL DEFAULT false;
-- Lazy migration for databases created before client-signal reporting (onboarding completion
-- and hotkey presses), added to tell "never pressed the hotkey" apart from "pressed and it
-- silently failed" — the two are indistinguishable from usage counts alone.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS onboarded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hotkey_presses BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS capture_id TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS result_protocol TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS result_state TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS parser_path TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS estimated_cost_micros BIGINT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS pricing_version TEXT;
-- Simple named counters (e.g. download-button clicks on the public site).
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchase_sessions (
  session_id UUID PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id), purchase_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE, pack_id TEXT NOT NULL, catalog_version TEXT NOT NULL, questions BIGINT NOT NULL,
  amount_cents BIGINT NOT NULL, currency TEXT NOT NULL, lang TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  checkout_session_id TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(device_id,purchase_id)
);
CREATE TABLE IF NOT EXISTS webhook_inbox (
  provider_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event_created_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_state TEXT NOT NULL DEFAULT 'received'
);
CREATE TABLE IF NOT EXISTS payment_adjustments (
  adjustment_id BIGSERIAL PRIMARY KEY,
  provider_ref TEXT NOT NULL UNIQUE,
  order_reference TEXT NOT NULL,
  adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('refund','dispute','fee')),
  amount_cents BIGINT NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('observed','applied','ignored')),
  effective_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_device ON usage_events(device_id);
CREATE INDEX IF NOT EXISTS idx_topups_device ON topups(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topups_reference ON topups(reference);
CREATE INDEX IF NOT EXISTS idx_product_received ON product_events(received_at);
CREATE INDEX IF NOT EXISTS idx_product_name_received ON product_events(event_name, received_at);
CREATE INDEX IF NOT EXISTS idx_product_variant_received ON product_events(variant, received_at);
CREATE INDEX IF NOT EXISTS idx_product_device_received ON product_events(device_id, received_at);
CREATE INDEX IF NOT EXISTS idx_product_capture ON product_events(capture_id);
ALTER TABLE purchase_sessions ADD COLUMN IF NOT EXISTS checkout_url TEXT;
ALTER TABLE purchase_sessions ADD COLUMN IF NOT EXISTS consumed_at TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quota_policy_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS initial_grant_questions BIGINT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_internal INTEGER NOT NULL DEFAULT 0 CHECK(is_internal IN (0,1));
ALTER TABLE devices ADD COLUMN IF NOT EXISTS balance_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS registration_key_hash TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS registration_key_version TEXT;
ALTER TABLE product_events ADD COLUMN IF NOT EXISTS extensions TEXT;
${BILLING_SCHEMA}
ALTER TABLE quota_lots ADD COLUMN IF NOT EXISTS refund_frozen INTEGER NOT NULL DEFAULT 0 CHECK(refund_frozen IN (0,1));
ALTER TABLE quota_lots ADD COLUMN IF NOT EXISTS refund_revoked BIGINT NOT NULL DEFAULT 0 CHECK(refund_revoked>=0);
ALTER TABLE quota_lots ADD COLUMN IF NOT EXISTS refund_target BIGINT NOT NULL DEFAULT 0 CHECK(refund_target>=0);
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS resource_generation BIGINT;
ALTER TABLE webhook_inbox ADD COLUMN IF NOT EXISTS retry_after TEXT;
${PAYMENT_SCHEMA}
ALTER TABLE checkout_deliveries ADD COLUMN IF NOT EXISTS recorded_at TEXT;
${OBSERVATION_SCHEMA}
${REPORTING_SCHEMA}
ALTER TABLE report_expense_allocations ADD COLUMN IF NOT EXISTS source_group TEXT;
ALTER TABLE report_expense_allocations ADD COLUMN IF NOT EXISTS policy_version TEXT;
ALTER TABLE report_expense_allocations ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
ALTER TABLE payment_refunds ADD COLUMN IF NOT EXISTS charge_id TEXT;
CREATE INDEX IF NOT EXISTS idx_refunds_payment_intent ON payment_refunds(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_charge ON payment_refunds(charge_id);
ALTER TABLE attempt_budget_holds ADD COLUMN IF NOT EXISTS device_id BIGINT REFERENCES devices(id);
UPDATE attempt_budget_holds SET device_id=(SELECT device_id FROM model_attempts WHERE model_attempts.attempt_id=attempt_budget_holds.attempt_id) WHERE device_id IS NULL;
`;

interface DeviceRow {
  id: string;
  app_version: string | null;
  onboarded: boolean;
  balance_questions: string;
  total_questions: string;
  total_input_tokens: string;
  total_output_tokens: string;
  cli_enabled: boolean;
}

// Admin-view row shapes. pg returns BIGINT as a string (precision safety) and TIMESTAMPTZ as a
// Date, so both are normalized on the way out.
interface DeviceSummaryRow {
  id: string;
  platform: string | null;
  app_version: string | null;
  balance_questions: string;
  total_questions: string;
  created_at: Date;
  updated_at: Date;
  onboarded: boolean;
  hotkey_presses: string;
}

interface TopUpSummaryRow {
  id: string;
  device_id: string;
  questions: string;
  amount_cents: string;
  currency: string;
  provider: string;
  reference: string | null;
  note: string | null;
  created_at: Date;
  platform: string | null;
  app_version: string | null;
  device_created_at: Date;
  device_total_questions: string;
}

/** The pg `ssl` option: `false` = plaintext, otherwise a Node TLS options subset. */
export type PgSSLConfig = false | { rejectUnauthorized: boolean; ca?: string };

/**
 * Decide the TLS option for the billing-DB connection. SECURE BY DEFAULT: the server's
 * certificate is verified unless the operator explicitly opts out. `rejectUnauthorized: false`
 * (encrypt but do NOT authenticate — a man-in-the-middle hole on a payments database) is now
 * reachable only via `mode: 'require'`, never the default. Pure, so it is unit-tested.
 *   'disable' (or `sslmode=disable` in the URL) → false                     (no TLS; local/dev)
 *   'require'                                    → { rejectUnauthorized:false } (TLS, unverified)
 *   'verify-full' or unset (default)             → { rejectUnauthorized:true[, ca] } (verified)
 */
export function resolvePostgresSSL(input: {
  connectionString: string;
  mode?: string;
  caCert?: string;
}): PgSSLConfig {
  const mode = (input.mode ?? '').trim().toLowerCase();
  if (mode === 'disable' || input.connectionString.includes('sslmode=disable')) return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  const ca = input.caCert?.trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

export class PostgresStore implements Store {
  private pool: pg.Pool;
  readonly billing = new SQLBilling(transaction => this.runBilling(transaction));
  readonly quotaMigration = new SQLQuotaMigration(transaction => this.runBilling(transaction, true));
  readonly payments = new SQLPaymentLedger(transaction => this.runBilling(transaction));
  readonly finance = new SQLPaymentFinance(transaction => this.runBilling(transaction));
  private readonly purchases = new SQLPurchaseSessions(transaction => this.runBilling(transaction));
  readonly observations = new SQLObservationStore(transaction => this.runBilling(transaction));
  readonly reporting = new SQLReportingStore((transaction, options) => this.runBilling(transaction, false, options?.readOnlySnapshot),true);
  private ready: Promise<void> | null = null;

  constructor(connectionString: string, ssl: PgSSLConfig = { rejectUnauthorized: true }) {
    this.pool = new pg.Pool({
      connectionString,
      max: 5, // serverless-friendly; use the provider's pooled URL for real concurrency
      ssl,
    });
  }

  /**
   * Lazily create the schema once per process; all public methods await this. A FAILED attempt
   * must not be cached: a warm serverless instance whose first request lost the connection would
   * otherwise hold a permanently rejected promise and 500 every later request — captures,
   * account reads, and Stripe webhooks alike — until the platform happened to recycle it.
   */
  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = this.tx(async client => {
        // Serialize expand DDL across cold instances in this schema; retry the whole transaction.
        await client.query("SELECT pg_advisory_xact_lock(7342291, hashtext(current_schema()))");
        await client.query(SCHEMA);
      }).then(
        () => undefined,
        (err: unknown) => {
          this.ready = null; // let the next caller retry
          throw err;
        },
      );
    }
    return this.ready;
  }

  private async runBilling<T>(transaction: Transaction<T>, migration = false, readOnlySnapshot = false): Promise<T> {
    await this.ensureSchema();
    return this.tx(async client => {
      // Isolation must be set before any query. The database prevents snapshot readers from
      // writing; they need no admission lock and retain the report's coherent MVCC snapshot.
      if (readOnlySnapshot) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Readers coexist. Pause/resume takes the exclusive lock before touching any device.
      if (!migration && !readOnlySnapshot && !(await client.query('SELECT id FROM quota_migration_control WHERE id=1 FOR SHARE')).rows.length) throw new Error('Quota migration control unavailable');
      let step = transaction.next();
      while (!step.done) {
        let position = 0;
        const sql = step.value.sql.replace(/\?/g, () => '$' + (++position));
        const result = await client.query(sql, step.value.args);
        step = transaction.next(result.rows);
      }
      return step.value;
    });
  }

  async registerDevice(input: RegistrationInput): Promise<RegisteredDevice> {
    return this.billing.register(input);
  }

  async getAccount(token: string): Promise<Account | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<DeviceRow>(
      `SELECT id, app_version, onboarded, balance_questions, total_questions, total_input_tokens,
              total_output_tokens, cli_enabled
       FROM devices WHERE token_hash = $1`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      balanceQuestions: Number(row.balance_questions),
      totalQuestions: Number(row.total_questions),
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      cliEnabled: row.cli_enabled === true,
      appVersion: row.app_version,
      onboarded: row.onboarded === true,
    };
  }

  async setCliEnabled(token: string, enabled: boolean): Promise<boolean | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ cli_enabled: boolean }>(
      `UPDATE devices SET cli_enabled = $1, updated_at = now()
       WHERE token_hash = $2 RETURNING cli_enabled`,
      [enabled, hashToken(token)],
    );
    return rows[0] ? rows[0].cli_enabled === true : null;
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
    await this.ensureSchema();
    const result = await this.pool.query(`INSERT INTO webhook_inbox
      (provider_event_id,event_type,resource_id,event_created_at,processing_state)
      VALUES ($1,$2,$3,$4,'received') ON CONFLICT(provider_event_id) DO NOTHING`,
      [input.providerEventId, input.eventType, input.resourceId, input.eventCreatedAt]);
    return (result.rowCount ?? 0) === 1;
  }

  async recordPaymentAdjustment(input: PaymentAdjustmentInput): Promise<boolean> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) throw new Error('Invalid adjustment amount');
    const result = await this.pool.query(`INSERT INTO payment_adjustments
      (provider_ref,order_reference,adjustment_type,amount_cents,currency,status,effective_at,recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider_ref) DO NOTHING`,
      [input.providerRef, input.orderReference, input.type, input.amountCents, input.currency, input.status, input.effectiveAt,new Date().toISOString()]);
    return (result.rowCount ?? 0) === 1;
  }

  async getProductMetrics(input: ProductMetricsQuery): Promise<ProductMetrics> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT device_id, event_id, capture_id, occurred_at, received_at, event_name, trigger,
              channel, mode, depth, context_count, question_kind, result_state, parser_path,
              error_code, action, capture_ms, first_token_ms, total_ms, app_version,
              config_revision, variant, extensions
       FROM product_events WHERE received_at >= $1 AND received_at < $2`, [input.from, input.to],
    );
    const mapped: StoredProductEvent[] = rows.map((r) => ({
      deviceId: Number(r.device_id), eventId: String(r.event_id),
      captureId: r.capture_id as string | null, occurredAt: new Date(r.occurred_at as string).toISOString(),
      receivedAt: new Date(r.received_at as string).toISOString(), eventName: String(r.event_name),
      trigger: r.trigger as string | null, channel: r.channel as string | null,
      mode: r.mode as string | null, depth: r.depth as string | null,
      contextCount: r.context_count === null ? null : Number(r.context_count),
      questionKind: r.question_kind as string | null, resultState: r.result_state as string | null,
      parserPath: r.parser_path as string | null, errorCode: r.error_code as string | null,
      action: r.action as string | null, captureMs: r.capture_ms === null ? null : Number(r.capture_ms),
      firstTokenMs: r.first_token_ms === null ? null : Number(r.first_token_ms),
      totalMs: r.total_ms === null ? null : Number(r.total_ms), appVersion: r.app_version as string | null,
      configRevision: r.config_revision as string | null, variant: r.variant as string | null, extensions: r.extensions ? JSON.parse(String(r.extensions)) : undefined,
    }));
    const usageResult = await this.pool.query<{
      device_id:string; capture_id: string | null; input_tokens: string; output_tokens: string;
      questions: string; estimated_cost_micros: string | null;
    }>(
      `SELECT device_id, capture_id, input_tokens, output_tokens, questions, estimated_cost_micros
       FROM usage_events WHERE created_at >= $1 AND created_at < $2`, [input.from, input.to],
    );
    const usage: StoredUsageMetric[] = usageResult.rows.map((row) => ({
      deviceId:Number(row.device_id),captureId: row.capture_id, inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens), questions: Number(row.questions),
      estimatedCostMicros: row.estimated_cost_micros === null ? null : Number(row.estimated_cost_micros),
    }));
    return aggregateProductMetrics(mapped, input, usage);
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
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE devices SET app_version = $1 WHERE token_hash = $2`,
      [appVersion, hashToken(token)],
    );
  }

  async markOnboarded(token: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE devices SET onboarded = true WHERE token_hash = $1`,
      [hashToken(token)],
    );
  }

  async recordHotkeyPress(token: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE devices SET hotkey_presses = hotkey_presses + 1 WHERE token_hash = $1`,
      [hashToken(token)],
    );
  }

  async listRecentDevices(limit: number): Promise<DeviceSummary[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<DeviceSummaryRow>(
      `SELECT id, platform, app_version, balance_questions, total_questions, created_at,
              updated_at, onboarded, hotkey_presses
       FROM devices ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      platform: r.platform,
      appVersion: r.app_version,
      balanceQuestions: Number(r.balance_questions),
      totalQuestions: Number(r.total_questions),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      onboarded: r.onboarded === true,
      hotkeyPresses: Number(r.hotkey_presses),
    }));
  }

  async listRecentTopups(limit: number): Promise<TopUpSummary[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<TopUpSummaryRow>(
      `SELECT t.id, t.device_id, t.questions, t.amount_cents, t.currency, t.provider,
              t.reference, t.note, t.created_at,
              d.platform, d.app_version, d.created_at AS device_created_at,
              d.total_questions AS device_total_questions
       FROM topups t JOIN devices d ON d.id = t.device_id
       ORDER BY t.id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      deviceId: Number(r.device_id),
      questions: Number(r.questions),
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      provider: r.provider,
      reference: r.reference,
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
      devicePlatform: r.platform,
      deviceAppVersion: r.app_version,
      deviceCreatedAt: new Date(r.device_created_at).toISOString(),
      deviceTotalQuestions: Number(r.device_total_questions),
    }));
  }

  async bumpCounter(name: string): Promise<number> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ value: string }>(
      `INSERT INTO counters (name, value) VALUES ($1, 1)
       ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
       RETURNING value`,
      [name],
    );
    return Number(rows[0]?.value ?? 0);
  }

  async getCounter(name: string): Promise<number> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ value: string }>(
      `SELECT value FROM counters WHERE name = $1`,
      [name],
    );
    return Number(rows[0]?.value ?? 0);
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
