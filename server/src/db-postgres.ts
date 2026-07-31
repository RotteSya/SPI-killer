import pg from 'pg';
import type {
  Account, DeviceSummary, RegisteredDevice, ReserveResult, Store, TopUpSummary,
} from './db.ts';
import { hashToken, newToken } from './db.ts';

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
-- Simple named counters (e.g. download-button clicks on the public site).
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_device ON usage_events(device_id);
CREATE INDEX IF NOT EXISTS idx_topups_device ON topups(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topups_reference ON topups(reference);
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
      this.ready = this.pool.query(SCHEMA).then(
        () => undefined,
        (err: unknown) => {
          this.ready = null; // let the next caller retry
          throw err;
        },
      );
    }
    return this.ready;
  }

  async registerDevice(input: {
    platform: string;
    appVersion: string;
    trialQuestions: number;
  }): Promise<RegisteredDevice> {
    await this.ensureSchema();
    const token = newToken();
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO devices (token_hash, platform, app_version, balance_questions)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [hashToken(token), input.platform, input.appVersion, input.trialQuestions],
    );
    return { token, balanceQuestions: input.trialQuestions, id: Number(rows[0]?.id ?? 0) };
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
    await this.ensureSchema();
    // One statement does the test and the deduction, so concurrent captures serialize on the
    // row lock and only those with enough balance succeed. No read-modify-write window.
    const { rows } = await this.pool.query<{ balance_questions: string }>(
      `UPDATE devices SET balance_questions = balance_questions - $1, updated_at = now()
       WHERE token_hash = $2 AND balance_questions >= $1
       RETURNING balance_questions`,
      [input.questions, hashToken(input.token)],
    );
    const row = rows[0];
    if (row) return { ok: true, balanceQuestions: Number(row.balance_questions) };
    // Zero rows means either an unknown token or an empty balance; only the cold path pays for
    // telling them apart, and the client needs the distinction (401 re-register vs 402 top-up).
    const probe = await this.pool.query(`SELECT 1 FROM devices WHERE token_hash = $1`, [
      hashToken(input.token),
    ]);
    return { ok: false, reason: (probe.rowCount ?? 0) > 0 ? 'insufficient_quota' : 'unknown_token' };
  }

  async settleReservation(input: {
    token: string;
    questions: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }): Promise<void> {
    await this.ensureSchema();
    await this.tx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE devices SET total_questions = total_questions + $1,
           total_input_tokens = total_input_tokens + $2,
           total_output_tokens = total_output_tokens + $3,
           updated_at = now()
         WHERE token_hash = $4 RETURNING id`,
        [input.questions, input.inputTokens, input.outputTokens, hashToken(input.token)],
      );
      const dev = rows[0];
      if (!dev) return;
      await client.query(
        `INSERT INTO usage_events (device_id, questions, input_tokens, output_tokens, model)
         VALUES ($1, $2, $3, $4, $5)`,
        [dev.id, input.questions, input.inputTokens, input.outputTokens, input.model],
      );
    });
  }

  async releaseReservation(input: { token: string; questions: number }): Promise<number | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ balance_questions: string }>(
      `UPDATE devices SET balance_questions = balance_questions + $1, updated_at = now()
       WHERE token_hash = $2 RETURNING balance_questions`,
      [input.questions, hashToken(input.token)],
    );
    return rows[0] ? Number(rows[0].balance_questions) : null;
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
    await this.ensureSchema();
    return this.tx(async (client) => {
      const { rows } = await client.query<DeviceRow>(
        `SELECT id, balance_questions FROM devices WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(input.token)],
      );
      const dev = rows[0];
      if (!dev) return null;
      // Idempotency: the unique index on reference is the hard guarantee; this check makes
      // a retried webhook delivery a clean no-op instead of a unique-violation rollback.
      const dup = await client.query(`SELECT 1 FROM topups WHERE reference = $1`, [input.reference]);
      if ((dup.rowCount ?? 0) > 0) return Number(dev.balance_questions);

      const newBalance = Number(dev.balance_questions) + input.questions;
      await client.query(
        `UPDATE devices SET balance_questions = $1, updated_at = now() WHERE id = $2`,
        [newBalance, dev.id],
      );
      await client.query(
        `INSERT INTO topups (device_id, questions, amount_cents, currency, provider, reference, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [dev.id, input.questions, input.amountCents, input.currency, input.provider, input.reference, input.note ?? null],
      );
      return newBalance;
    });
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
