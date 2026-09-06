import { randomUUID } from 'node:crypto';
import { hashToken, newToken, type RegisteredDevice } from './db.ts';
import { applyRefundLot } from './payment-ledger-sql.ts';
import {checkpointQuota} from './quota-migration.ts';
import {QUOTA_MIGRATION_SCHEMA} from './quota-migration-schema.ts';
import { combineAccountSnapshot, duplicateCapture, isRecoveredAnswerFor, newCapture, validQuestions, type AccountSnapshot, type Attempt, type BeginCapture, type BeginResult,
  type BillingStore, type CaptureRecord, type CreditInput, type FinishCapture, type QuotaSnapshot,
  type RegistrationInput } from './billing.ts';

// Generators describe one transaction. SQLite runs every step synchronously, without yielding
// its connection; Postgres awaits each query on a dedicated, row-locked transaction connection.
export interface Statement { sql: string; args: Array<string | number | null> }
export type Row = Record<string, unknown>;
export type Transaction<T> = Generator<Statement, T, Row[]>;
export type RunTransaction = <T>(transaction: Transaction<T>, options?: {readOnlySnapshot?: boolean}) => Promise<T>;
export function* query(sql: string, ...args: Statement['args']): Transaction<Row[]> { return yield { sql, args }; }

export const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_lots (
 lot_id TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id), kind TEXT NOT NULL,
 granted BIGINT NOT NULL CHECK(granted>=0), remaining BIGINT NOT NULL CHECK(remaining>=0),
 held BIGINT NOT NULL DEFAULT 0 CHECK(held>=0 AND held<=remaining AND remaining<=granted),
 source_ref TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(device_id, source_ref),
 CHECK(kind IN ('trial','paid','goodwill','legacy_unknown'))
);
CREATE TABLE IF NOT EXISTS capture_requests (
 request_id TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id),
 client_capture_id TEXT NOT NULL, request_hmac TEXT NOT NULL, metadata TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('held','settled','released')), legacy INTEGER NOT NULL,
 lease_expires_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(device_id, client_capture_id)
);
CREATE INDEX IF NOT EXISTS idx_capture_lease ON capture_requests(state,lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_capture_device ON capture_requests(device_id,state);
CREATE TABLE IF NOT EXISTS quota_reservations (
 reservation_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES capture_requests(request_id),
 device_id BIGINT NOT NULL REFERENCES devices(id), lot_id TEXT NOT NULL REFERENCES quota_lots(lot_id),
 questions INTEGER NOT NULL CHECK(questions=1), state TEXT NOT NULL CHECK(state IN ('held','settled','released')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT
);
CREATE TABLE IF NOT EXISTS quota_ledger (
 entry_id TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id),
 lot_id TEXT NOT NULL REFERENCES quota_lots(lot_id), reservation_id TEXT,
 event TEXT NOT NULL CHECK(event IN ('grant','hold','settle','release','credit','revoke')),
 available_delta BIGINT NOT NULL, held_delta BIGINT NOT NULL, reference TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(device_id,reference,event)
);
CREATE TABLE IF NOT EXISTS explanation_requests (
 parent_request_id TEXT PRIMARY KEY REFERENCES capture_requests(request_id),
 explanation_request_id TEXT NOT NULL UNIQUE REFERENCES capture_requests(request_id)
);
CREATE TABLE IF NOT EXISTS recovery_requests (
 parent_request_id TEXT PRIMARY KEY REFERENCES capture_requests(request_id),
 recovery_request_id TEXT NOT NULL UNIQUE REFERENCES capture_requests(request_id)
);
CREATE TABLE IF NOT EXISTS model_attempts (
 attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES capture_requests(request_id),
 device_id BIGINT NOT NULL REFERENCES devices(id), ordinal INTEGER NOT NULL,
 metadata TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(request_id,ordinal)
);
CREATE TABLE IF NOT EXISTS attempt_costs (
 attempt_id TEXT NOT NULL REFERENCES model_attempts(attempt_id), revision INTEGER NOT NULL,
 currency TEXT NOT NULL, cost_micros TEXT, pricing_version TEXT NOT NULL, source TEXT NOT NULL,
 calculated_at TEXT NOT NULL, PRIMARY KEY(attempt_id,revision)
);
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
 scope_hash TEXT NOT NULL, window_start TEXT NOT NULL, count BIGINT NOT NULL,
 expires_at TEXT NOT NULL, PRIMARY KEY(scope_hash,window_start)
);
CREATE TABLE IF NOT EXISTS budget_windows (
 scope TEXT NOT NULL, window_start TEXT NOT NULL, currency TEXT NOT NULL,
 limit_micros BIGINT NOT NULL CHECK(limit_micros>0), spent_micros BIGINT NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
 held_micros BIGINT NOT NULL DEFAULT 0 CHECK(held_micros>=0), expires_at TEXT NOT NULL,
 PRIMARY KEY(scope,window_start,currency)
);
CREATE TABLE IF NOT EXISTS attempt_budget_holds (
 attempt_id TEXT PRIMARY KEY, device_id BIGINT REFERENCES devices(id), scope TEXT NOT NULL, window_start TEXT NOT NULL, currency TEXT NOT NULL,
 reserved_upper_micros BIGINT NOT NULL CHECK(reserved_upper_micros>0), state TEXT NOT NULL CHECK(state IN ('held','released','settled')),
 actual_micros BIGINT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_key ON devices(registration_key_hash);
${QUOTA_MIGRATION_SCHEMA}
`;

export function* ledger(device: number, lot: string, event: string, available: number, held: number,
  reference: string, reservation: string | null = null): Transaction<void> {
  yield* query(`INSERT INTO quota_ledger
    (entry_id,device_id,lot_id,reservation_id,event,available_delta,held_delta,reference,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, randomUUID(), device, lot, reservation, event, available, held, reference, new Date().toISOString());
}
function* device(token: string): Transaction<Row | undefined> {
  return (yield* query('SELECT * FROM devices WHERE token_hash=? FOR UPDATE', hashToken(token)))[0];
}
export function* opening(d: Row): Transaction<void> {
  const lots = yield* query('SELECT lot_id FROM quota_lots WHERE device_id=? LIMIT 1', Number(d.id));
  if (lots.length) return;
  const balance = Number(d.balance_questions);
  validQuestions(balance);
  const id = randomUUID();
  yield* query(`INSERT INTO quota_lots (lot_id,device_id,kind,granted,remaining,source_ref,created_at)
    VALUES (?,?,?,?,?,?,?)`, id, Number(d.id), 'legacy_unknown', balance, balance, 'opening_balance', new Date().toISOString());
  yield* ledger(Number(d.id), id, 'grant', balance, 0, 'opening_balance');
  yield* checkpointQuota(d, id);
}
function* quotaFor(d: Row): Transaction<QuotaSnapshot> {
  yield* opening(d);
  const lots = yield* query('SELECT kind,remaining,held,refund_frozen FROM quota_lots WHERE device_id=?', Number(d.id));
  const quota: QuotaSnapshot = { balanceQuestions: Number(d.balance_questions), heldQuestions: 0,
    balanceVersion: String(d.balance_version), policyVersion: String(d.quota_policy_version),
    initialGrantQuestions: d.initial_grant_questions === null ? null : Number(d.initial_grant_questions),
    quotaBreakdown: { trial: 0, paid: 0, goodwill: 0, legacy_unknown: 0 } };
  for (const lot of lots) {
    quota.heldQuestions += Number(lot.held);
    quota.quotaBreakdown[lot.kind as keyof QuotaSnapshot['quotaBreakdown']] += Number(lot.refund_frozen)===1 ? 0 : Number(lot.remaining) - Number(lot.held);
  }
  if (Object.values(quota.quotaBreakdown).reduce((a,b) => a+b, 0) !== quota.balanceQuestions) {
    throw new Error('Quota ledger balance mismatch');
  }
  return quota;
}
function* accountFor(d: Row): Transaction<AccountSnapshot> {
  // Device counters and quota lots share the caller's transaction and device lock.
  const cli = d.cli_enabled;
  if (![true, false, 0, 1, 0n, 1n].includes(cli as boolean | number | bigint)) {
    throw new Error('Invalid account permission');
  }
  return combineAccountSnapshot(yield* quotaFor(d), {totalQuestions: Number(d.total_questions),
    totalInputTokens: Number(d.total_input_tokens), totalOutputTokens: Number(d.total_output_tokens),
    cliEnabled: cli === true || cli === 1 || cli === 1n});
}
function* readCapture(d: Row, captureId?: string): Transaction<CaptureRecord | null> {
  const rows = captureId
    ? yield* query('SELECT metadata FROM capture_requests WHERE device_id=? AND client_capture_id=?', Number(d.id), captureId)
    : yield* query("SELECT metadata FROM capture_requests WHERE device_id=? AND legacy=1 AND state='held' ORDER BY created_at,request_id LIMIT 1", Number(d.id));
  return rows[0] ? JSON.parse(String(rows[0].metadata)) as CaptureRecord : null;
}

export class SQLBilling implements BillingStore {
  private run: RunTransaction;
  constructor(run: RunTransaction) { this.run = run; }
  register(input: RegistrationInput): Promise<RegisteredDevice> {
    return this.run((function* (): Transaction<RegisteredDevice> {
      validQuestions(input.trialQuestions);
      const token = input.token ?? newToken();
      const now = new Date().toISOString();
      // Both token_hash and registration_key_hash are unique. A concurrent replay may
      // encounter either index first; handle both, then verify the existing token binding.
      const inserted = yield* query(`INSERT INTO devices
        (token_hash,platform,app_version,balance_questions,created_at,updated_at,quota_policy_version,
         initial_grant_questions,balance_version,registration_key_hash,registration_key_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`,
        hashToken(token), input.platform, input.appVersion, input.trialQuestions, now, now,
        input.policyVersion ?? 'legacy', input.trialQuestions, 1, input.registrationKeyHash ?? null, input.registrationKeyVersion ?? null);
      const d = yield* device(token);
      if (!d || (input.registrationKeyHash !== undefined && d.registration_key_hash !== input.registrationKeyHash)) {
        throw new Error('Registration identity conflict');
      }
      if (inserted.length) {
        const lot = randomUUID();
        yield* query(`INSERT INTO quota_lots (lot_id,device_id,kind,granted,remaining,source_ref,created_at)
          VALUES (?,?,?,?,?,?,?)`, lot, Number(d.id), 'trial', input.trialQuestions, input.trialQuestions, 'initial_grant', now);
        yield* ledger(Number(d.id), lot, 'grant', input.trialQuestions, 0, 'initial_grant');
        yield* checkpointQuota(d, null);
      }
      return { token, id: Number(d.id), balanceQuestions: Number(d.balance_questions) };
    })());
  }
  quota(token: string): Promise<QuotaSnapshot | null> {
    return this.run((function* (): Transaction<QuotaSnapshot | null> {
      const d = yield* device(token); return d ? yield* quotaFor(d) : null;
    })());
  }
  accountSnapshot(token: string): Promise<AccountSnapshot | null> {
    return this.run((function* (): Transaction<AccountSnapshot | null> {
      const d = yield* device(token);
      return d ? yield* accountFor(d) : null;
    })());
  }
  capture(token: string, captureId: string): Promise<CaptureRecord | null> {
    return this.run((function* (): Transaction<CaptureRecord | null> {
      const d = yield* device(token); if (!d) return null;
      const capture = yield* readCapture(d, captureId);
      if (capture && Date.now() - Date.parse(capture.createdAt) >= 900_000 && capture.answerHmac !== null) {
        capture.answerHmac = null;
        yield* query('UPDATE capture_requests SET metadata=? WHERE request_id=?', JSON.stringify(capture), capture.requestId);
      }
      return capture;
    })());
  }
  begin(input: BeginCapture): Promise<BeginResult> {
    return this.run((function* (): Transaction<BeginResult> {
      const admission = (yield* query('SELECT state FROM quota_migration_control WHERE id=1'))[0];
      if (!admission || admission.state !== 'active') return {ok: false, reason: 'service_maintenance'};
      const d = yield* device(input.token);
      if (!d) return { ok: false, reason: 'unknown_token' };
      yield* opening(d);
      const existing = yield* readCapture(d, input.captureId);
      if (existing) return duplicateCapture(existing, input);
      if (input.exclusive) {
        const running = yield* query("SELECT request_id FROM capture_requests WHERE device_id=? AND state='held' LIMIT 1", Number(d.id));
        if (running.length) return { ok: false, reason: 'device_busy' };
      }
      if (input.operation && input.operation !== 'solve') {
        const parent = input.parentCaptureId ? yield* readCapture(d, input.parentCaptureId) : null;
        if (!parent || parent.operation !== 'solve' || parent.settlementStatus !== 'settled' || !parent.usableResult ||
            Date.now() - Date.parse(parent.createdAt) >= 900_000) return { ok: false, reason: 'idempotency_conflict' };
        if (input.answerCaptureId && input.answerCaptureId !== parent.captureId) {
          const answer = yield* readCapture(d, input.answerCaptureId);
          if (input.operation !== 'explain' || !answer || !isRecoveredAnswerFor(parent, answer)) {
            return {ok: false, reason: 'idempotency_conflict'};
          }
        }
        const property = input.operation === 'explain' ? 'explanationCaptureId' : 'recoveryCaptureId';
        if (parent[property]) return { ok: false, reason: 'capture_already_finalized' };
        const capture = newCapture(input);
        yield* query(`INSERT INTO capture_requests
          (request_id,device_id,client_capture_id,request_hmac,metadata,state,legacy,lease_expires_at,created_at)
          VALUES (?,?,?,?,?,'held',0,?,?)`, capture.requestId, Number(d.id), capture.captureId, capture.requestHmac,
          JSON.stringify(capture), capture.expiresAt, capture.createdAt);
        const table = input.operation === 'explain' ? 'explanation_requests' : 'recovery_requests';
        const column = input.operation === 'explain' ? 'explanation_request_id' : 'recovery_request_id';
        yield* query(`INSERT INTO ${table} (parent_request_id,${column}) VALUES (?,?)`, parent.requestId, capture.requestId);
        parent[property] = capture.captureId;
        yield* query('UPDATE capture_requests SET metadata=? WHERE request_id=?', JSON.stringify(parent), parent.requestId);
        return { ok: true, capture, quota: yield* quotaFor(d) };
      }
      if (Number(d.balance_questions) < 1) return { ok: false, reason: 'insufficient_quota' };
      const lot = (yield* query(`SELECT lot_id FROM quota_lots WHERE device_id=? AND remaining>held AND refund_frozen=0
        ORDER BY CASE kind WHEN 'trial' THEN 0 WHEN 'legacy_unknown' THEN 1 WHEN 'goodwill' THEN 2 ELSE 3 END,created_at,lot_id LIMIT 1`, Number(d.id)))[0];
      if (!lot) throw new Error('Quota source unavailable');
      const capture = newCapture(input), reservation = randomUUID();
      yield* query(`INSERT INTO capture_requests
        (request_id,device_id,client_capture_id,request_hmac,metadata,state,legacy,lease_expires_at,created_at)
        VALUES (?,?,?,?,?,'held',?,?,?)`, capture.requestId, Number(d.id), capture.captureId, capture.requestHmac,
        JSON.stringify(capture), input.legacy ? 1 : 0, capture.expiresAt, capture.createdAt);
      yield* query(`INSERT INTO quota_reservations
        (reservation_id,request_id,device_id,lot_id,questions,state,created_at,expires_at)
        VALUES (?,?,?,?,1,'held',?,?)`, reservation, capture.requestId, Number(d.id), String(lot.lot_id), capture.createdAt, capture.expiresAt);
      yield* query('UPDATE quota_lots SET held=held+1 WHERE lot_id=?', String(lot.lot_id));
      yield* query('UPDATE devices SET balance_questions=balance_questions-1,balance_version=balance_version+1,updated_at=? WHERE id=?', capture.createdAt, Number(d.id));
      yield* ledger(Number(d.id), String(lot.lot_id), 'hold', -1, 1, capture.requestId, reservation);
      return { ok: true, capture, quota: yield* quotaFor((yield* device(input.token))!) };
    })());
  }
  finish(input: FinishCapture): Promise<AccountSnapshot | null> {
    return this.run((function* (): Transaction<AccountSnapshot | null> {
      const d = yield* device(input.token);
      if (!d) return null;
      yield* finishForDevice(d, input);
      return yield* accountFor((yield* device(input.token))!);
    })());
  }
  credit(input: CreditInput): Promise<number | null> {
    return this.run((function* (): Transaction<number | null> {
      validQuestions(input.questions); validQuestions(input.amountCents);
      const d = yield* device(input.token);
      if (!d) return null;
      yield* opening(d);
      const now = new Date().toISOString();
      const inserted = yield* query(`INSERT INTO topups (device_id,questions,amount_cents,currency,provider,reference,note,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING RETURNING id`, Number(d.id), input.questions,
        input.amountCents, input.currency, input.provider, input.reference, input.note ?? null, now);
      if (!inserted.length) return Number(d.balance_questions);
      const lot = randomUUID();
      yield* query(`INSERT INTO quota_lots (lot_id,device_id,kind,granted,remaining,source_ref,created_at)
        VALUES (?,?,?,?,?,?,?)`, lot, Number(d.id), input.amountCents > 0 ? 'paid' : 'goodwill',
        input.questions, input.questions, 'credit:' + input.reference, now);
      yield* query('UPDATE devices SET balance_questions=balance_questions+?,balance_version=balance_version+1,updated_at=? WHERE id=?', input.questions, now, Number(d.id));
      yield* ledger(Number(d.id), lot, 'credit', input.questions, 0, 'credit:' + input.reference);
      return Number(d.balance_questions) + input.questions;
    })());
  }
  creditDevice(deviceId: number, input: Omit<CreditInput, 'token'>): Promise<number | null> {
    return this.run((function* (): Transaction<number | null> {
      validQuestions(input.questions); validQuestions(input.amountCents);
      const d = (yield* query('SELECT * FROM devices WHERE id=? FOR UPDATE', deviceId))[0]; if (!d) return null;
      yield* opening(d);
      const now = new Date().toISOString();
      const inserted = yield* query(`INSERT INTO topups (device_id,questions,amount_cents,currency,provider,reference,note,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING RETURNING id`, deviceId, input.questions,
        input.amountCents, input.currency, input.provider, input.reference, input.note ?? null, now);
      if (!inserted.length) return Number(d.balance_questions);
      const lot = randomUUID();
      yield* query(`INSERT INTO quota_lots (lot_id,device_id,kind,granted,remaining,source_ref,created_at)
        VALUES (?,?,?,?,?,?,?)`, lot, deviceId, input.amountCents > 0 ? 'paid' : 'goodwill', input.questions, input.questions, 'credit:' + input.reference, now);
      yield* query('UPDATE devices SET balance_questions=balance_questions+?,balance_version=balance_version+1,updated_at=? WHERE id=?', input.questions, now, deviceId);
      yield* ledger(deviceId, lot, 'credit', input.questions, 0, 'credit:' + input.reference);
      return Number(d.balance_questions) + input.questions;
    })());
  }
  reap(now = new Date().toISOString()): Promise<number> {
    return this.run((function* (): Transaction<number> {
      const expired = yield* query("SELECT device_id,client_capture_id FROM capture_requests WHERE state='held' AND lease_expires_at<=? ORDER BY device_id LIMIT 100", now);
      let count = 0;
      for (const row of expired) {
        const d = (yield* query('SELECT * FROM devices WHERE id=? FOR UPDATE', Number(row.device_id)))[0];
        if (!d) continue;
        const capture = yield* readCapture(d, String(row.client_capture_id));
        if (!capture || capture.settlementStatus !== 'held' || capture.expiresAt > now) continue;
        yield* finishForDevice(d, { token: '', captureId: capture.captureId, charge: false, terminalState: 'failed',
          terminalReason: 'lease_expired', compensateGoodwill: capture.operation === 'recover' });
        const attempts = yield* query('SELECT attempt_id,metadata FROM model_attempts WHERE request_id=? AND status=\'running\'', capture.requestId);
        for (const attempt of attempts) {
          const previous = JSON.parse(String(attempt.metadata)) as Attempt;
          const finishedAt = new Date().toISOString();
          const unknown: Attempt = { ...previous, status: 'unknown', inputTokens: null, outputTokens: null, costMicros: null, finishedAt };
          yield* query('UPDATE model_attempts SET metadata=?,status=\'unknown\' WHERE attempt_id=?', JSON.stringify(unknown), String(attempt.attempt_id));
          yield* query(`INSERT INTO attempt_costs (attempt_id,revision,currency,cost_micros,pricing_version,source,calculated_at)
            VALUES (?,2,?,NULL,?,'unknown',?) ON CONFLICT(attempt_id,revision) DO NOTHING`, String(attempt.attempt_id), previous.currency, previous.pricingVersion, finishedAt);
        }
        count++;
      }
      yield* query('DELETE FROM rate_limit_buckets WHERE expires_at<?', now);
      return count;
    })());
  }
  startAttempt(token: string, input: Omit<Attempt,'status'|'inputTokens'|'outputTokens'|'costMicros'|'startedAt'|'finishedAt'>): Promise<boolean> {
    return this.run((function* (): Transaction<boolean> {
      const d = yield* device(token), capture = d ? yield* readCapture(d, input.captureId) : null;
      if (!d || !capture || capture.settlementStatus !== 'held') return false;
      const attempt: Attempt = { ...input, status: 'running', inputTokens: null, outputTokens: null,
        costMicros: null, startedAt: new Date().toISOString(), finishedAt: null };
      const rows = yield* query(`INSERT INTO model_attempts (attempt_id,request_id,device_id,ordinal,metadata,status)
        VALUES (?,?,?,1,?,'running') ON CONFLICT(request_id,ordinal) DO NOTHING RETURNING attempt_id`,
        input.attemptId, capture.requestId, Number(d.id), JSON.stringify(attempt));
      if (!rows.length) return false;
      yield* query(`INSERT INTO attempt_costs (attempt_id,revision,currency,cost_micros,pricing_version,source,calculated_at)
        VALUES (?,1,?,NULL,?,'unknown',?)`, input.attemptId, input.currency, input.pricingVersion, attempt.startedAt);
      return true;
    })());
  }
  finishAttempt(token: string, attemptId: string, input: Pick<Attempt,'status'|'inputTokens'|'outputTokens'|'costMicros'>): Promise<void> {
    return this.run((function* (): Transaction<void> {
      const d = yield* device(token); if (!d) return;
      const row = (yield* query('SELECT metadata FROM model_attempts WHERE attempt_id=? AND device_id=?', attemptId, Number(d.id)))[0];
      if (!row) return;
      const previous = JSON.parse(String(row.metadata)) as Attempt;
      if (previous.status !== 'running') return;
      const attempt: Attempt = { ...previous, ...input, finishedAt: new Date().toISOString() };
      yield* query('UPDATE model_attempts SET metadata=?,status=? WHERE attempt_id=?', JSON.stringify(attempt), attempt.status, attemptId);
      yield* query(`INSERT INTO attempt_costs (attempt_id,revision,currency,cost_micros,pricing_version,source,calculated_at)
        VALUES (?,2,?,?,?,?,?)`, attemptId, attempt.currency, attempt.costMicros, attempt.pricingVersion,
        attempt.costMicros === null ? 'unknown' : 'estimated', attempt.finishedAt);
    })());
  }
  reserveBudget(token: string, attemptId: string, scope: string, currency: string, reservedUpperMicros: number,
    limitMicros: number, windowMs = 86_400_000, now = Date.now()): Promise<boolean> {
    if (limitMicros <= 0 || reservedUpperMicros <= 0) return Promise.resolve(true);
    return this.run((function* (): Transaction<boolean> {
      const d = yield* device(token); if (!d) return false;
      const start = Math.floor(now / windowMs) * windowMs;
      const windowStart = new Date(start).toISOString(), expiresAt = new Date(start + windowMs).toISOString();
      yield* query(`INSERT INTO budget_windows(scope,window_start,currency,limit_micros,expires_at)
        VALUES (?,?,?,?,?) ON CONFLICT(scope,window_start,currency) DO NOTHING`, scope, windowStart, currency, limitMicros, expiresAt);
      const existing = yield* query('SELECT state,device_id FROM attempt_budget_holds WHERE attempt_id=?', attemptId);
      if (existing.length) return Number(existing[0]!.device_id)===Number(d.id)
        && (String(existing[0]!.state) === 'held' || String(existing[0]!.state) === 'settled');
      const row = (yield* query('SELECT spent_micros,held_micros,limit_micros FROM budget_windows WHERE scope=? AND window_start=? AND currency=? FOR UPDATE', scope, windowStart, currency))[0];
      if (!row || Number(row.spent_micros) + Number(row.held_micros) + reservedUpperMicros > Number(row.limit_micros)) return false;
      yield* query(`INSERT INTO attempt_budget_holds(attempt_id,device_id,scope,window_start,currency,reserved_upper_micros,state,created_at)
        VALUES (?,?,?,?,?,?,'held',?)`, attemptId, Number(d.id), scope, windowStart, currency, reservedUpperMicros, new Date().toISOString());
      yield* query('UPDATE budget_windows SET held_micros=held_micros+? WHERE scope=? AND window_start=? AND currency=?', reservedUpperMicros, scope, windowStart, currency);
      return true;
    })());
  }
  releaseBudget(token: string, attemptId: string): Promise<void> {
    return this.run((function* (): Transaction<void> {
      const d = yield* device(token); if (!d) return;
      const hold = (yield* query("SELECT * FROM attempt_budget_holds WHERE attempt_id=? AND device_id=? AND state='held' FOR UPDATE", attemptId, Number(d.id)))[0]; if (!hold) return;
      yield* query("UPDATE attempt_budget_holds SET state='released' WHERE attempt_id=?", attemptId);
      yield* query('UPDATE budget_windows SET held_micros=held_micros-? WHERE scope=? AND window_start=? AND currency=?', Number(hold.reserved_upper_micros), String(hold.scope), String(hold.window_start), String(hold.currency));
    })());
  }
  settleBudget(token: string, attemptId: string, actualMicros: number | null): Promise<void> {
    return this.run((function* (): Transaction<void> {
      const d = yield* device(token); if (!d) return;
      const hold = (yield* query("SELECT * FROM attempt_budget_holds WHERE attempt_id=? AND device_id=? AND state='held' FOR UPDATE", attemptId, Number(d.id)))[0]; if (!hold) return;
      // Preserve the full observed expense even when the preflight bound was too low.
      const reserved = Number(hold.reserved_upper_micros), actual = actualMicros === null || !Number.isSafeInteger(actualMicros) || actualMicros < 0 ? reserved : actualMicros;
      yield* query("UPDATE attempt_budget_holds SET state='settled',actual_micros=? WHERE attempt_id=?", actual, attemptId);
      yield* query('UPDATE budget_windows SET held_micros=held_micros-?,spent_micros=spent_micros+? WHERE scope=? AND window_start=? AND currency=?', reserved, actual, String(hold.scope), String(hold.window_start), String(hold.currency));
    })());
  }
  attempts(token: string): Promise<Attempt[]> {
    return this.run((function* (): Transaction<Attempt[]> {
      const d = yield* device(token); if (!d) return [];
      const rows = yield* query('SELECT metadata FROM model_attempts WHERE device_id=?', Number(d.id));
      return rows.map(r => JSON.parse(String(r.metadata)) as Attempt);
    })());
  }
  rateLimit(scope: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
    if (limit <= 0) return Promise.resolve(true);
    return this.run((function* (): Transaction<boolean> {
      const start = Math.floor(now/windowMs)*windowMs;
      const rows = yield* query(`INSERT INTO rate_limit_buckets (scope_hash,window_start,count,expires_at)
        VALUES (?,?,1,?) ON CONFLICT(scope_hash,window_start) DO UPDATE SET count=rate_limit_buckets.count+1 RETURNING count`,
        scope, new Date(start).toISOString(), new Date(start+windowMs).toISOString());
      return Number(rows[0]!.count) <= limit;
    })());
  }
}

function* finishForDevice(d: Row, input: FinishCapture): Transaction<void> {
  const capture = yield* readCapture(d, input.captureId);
  if (!capture || capture.settlementStatus !== 'held') return;
  if (capture.operation !== 'solve') {
    capture.settlementStatus = 'released'; capture.terminalState = input.terminalState;
    capture.finishedAt = new Date().toISOString(); capture.terminalReason = input.terminalReason ?? null;
    capture.usableResult = input.terminalState === 'usable';
    capture.answerHmac = capture.usableResult ? input.answerHmac ?? null : null;
    capture.resultState = input.resultState ?? null; capture.questionKind = input.questionKind ?? null;
    capture.parserPath = input.parserPath ?? null;
    if (capture.operation === 'recover' && input.compensateGoodwill && capture.parentCaptureId) {
      const reference = 'recovery:' + capture.parentCaptureId;
      const existing = yield* query('SELECT lot_id FROM quota_lots WHERE device_id=? AND source_ref=?', Number(d.id), 'credit:' + reference);
      if (!existing.length) {
        const lot = randomUUID();
        yield* query(`INSERT INTO quota_lots (lot_id,device_id,kind,granted,remaining,source_ref,created_at)
          VALUES (?,?,?,?,?,?,?)`, lot, Number(d.id), 'goodwill', 1, 1, 'credit:' + reference, capture.finishedAt);
        yield* query('UPDATE devices SET balance_questions=balance_questions+1,balance_version=balance_version+1,updated_at=? WHERE id=?', capture.finishedAt, Number(d.id));
        yield* ledger(Number(d.id), lot, 'credit', 1, 0, 'credit:' + reference);
      }
    }
    yield* query("UPDATE capture_requests SET state='released',metadata=? WHERE request_id=?", JSON.stringify(capture), capture.requestId);
    return;
  }
  const reservation = (yield* query('SELECT * FROM quota_reservations WHERE request_id=?', capture.requestId))[0]!;
  const lot = (yield* query('SELECT refund_frozen FROM quota_lots WHERE lot_id=?',String(reservation.lot_id)))[0]!;
  const now = new Date().toISOString();
  // An expired lease cannot be revived by a delayed vendor callback, even before the worker runs.
  const charge = input.charge && capture.expiresAt > now;
  const state = charge ? 'settled' : 'released';
  capture.settlementStatus = state;
  capture.terminalState = input.charge && !charge ? 'failed' : input.terminalState;
  capture.usableResult = charge && input.terminalState === 'usable';
  capture.answerHmac = charge ? input.answerHmac ?? null : null;
  capture.resultState = input.resultState ?? null; capture.questionKind = input.questionKind ?? null;
  capture.parserPath = input.parserPath ?? null; capture.terminalReason = input.terminalReason ?? null; capture.finishedAt = now;
  yield* query('UPDATE capture_requests SET state=?,metadata=? WHERE request_id=?', state, JSON.stringify(capture), capture.requestId);
  yield* query('UPDATE quota_reservations SET state=?,settled_at=? WHERE request_id=?', state, now, capture.requestId);
  yield* query('UPDATE quota_lots SET held=held-1,remaining=remaining-? WHERE lot_id=?', charge ? 1 : 0, String(reservation.lot_id));
  yield* query(`UPDATE devices SET balance_questions=balance_questions+?,balance_version=balance_version+1,
    total_questions=total_questions+?,total_input_tokens=total_input_tokens+?,total_output_tokens=total_output_tokens+?,updated_at=? WHERE id=?`,
    charge || Number(lot.refund_frozen)===1 ? 0 : 1, charge ? 1 : 0, input.inputTokens ?? 0, input.outputTokens ?? 0, now, Number(d.id));
  yield* ledger(Number(d.id), String(reservation.lot_id), charge ? 'settle' : 'release', charge || Number(lot.refund_frozen)===1 ? 0 : 1, -1, capture.requestId, String(reservation.reservation_id));
  yield* applyRefundLot(String(reservation.lot_id));
  yield* query(`INSERT INTO usage_events
    (device_id,questions,input_tokens,output_tokens,model,created_at,capture_id,result_protocol,result_state,parser_path,estimated_cost_micros,pricing_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, Number(d.id), charge ? 1 : 0, input.inputTokens ?? 0,
    input.outputTokens ?? 0, input.model ?? null, now, input.usageCaptureId ?? capture.captureId,
    capture.resultProtocol, capture.resultState, capture.parserPath, input.estimatedCostMicros ?? null, input.pricingVersion ?? null);
}
