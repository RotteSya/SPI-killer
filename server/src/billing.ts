import { createHmac, randomBytes, randomUUID } from 'node:crypto';

export const FIXED_TRIAL_POLICY = { version: 'fixed30-2026-09-06', questions: 30 } as const;
export type SettlementState = 'held' | 'settled' | 'released';
export type TerminalState = 'pending' | 'usable' | 'retake' | 'no_result' | 'failed' | 'canceled';
export type LotKind = 'trial' | 'paid' | 'goodwill' | 'legacy_unknown';
export interface QuotaSnapshot {
  balanceQuestions: number; heldQuestions: number; balanceVersion: string;
  policyVersion: string; initialGrantQuestions: number | null;
  quotaBreakdown: Record<LotKind, number>;
}
export interface AccountSnapshot extends QuotaSnapshot {
  totalQuestions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cliEnabled: boolean;
}

/** These fields describe one committed device row and its lots, never separately awaited reads. */
export function combineAccountSnapshot(quota: QuotaSnapshot, totals: Pick<AccountSnapshot,
  'totalQuestions' | 'totalInputTokens' | 'totalOutputTokens' | 'cliEnabled'>): AccountSnapshot {
  for (const value of [quota.balanceQuestions, quota.heldQuestions, ...Object.values(quota.quotaBreakdown),
    totals.totalQuestions, totals.totalInputTokens, totals.totalOutputTokens]) validQuestions(value);
  if (!/^\d{1,40}$/.test(quota.balanceVersion) || typeof totals.cliEnabled !== 'boolean') {
    throw new Error('Invalid account snapshot');
  }
  return {...quota, ...totals};
}
export interface CaptureRecord {
  requestId: string; captureId: string; requestHmac: string; inputHmac: string;
  keyVersion: string; operation: 'solve' | 'explain' | 'recover'; parentCaptureId: string | null;
  profileId: string | null; profileVersion: string | null; promptVersion: string | null;
  resultProtocol: string | null; responseContract: string | null; configRevision: string;
  settlementStatus: SettlementState; terminalState: TerminalState; usableResult: boolean;
  answerHmac: string | null; resultState: string | null; questionKind: string | null;
  parserPath: string | null; terminalReason: string | null;
  /** Explanation input may be a recovered answer; entitlement/cost parent remains the paid solve. */
  answerCaptureId?: string;
  createdAt: string; expiresAt: string; finishedAt: string | null;
  explanationCaptureId?: string; recoveryCaptureId?: string;
}
export interface BeginCapture {
  token: string; captureId: string; requestHmac: string; inputHmac?: string; keyVersion?: string;
  /** Server-generated ownership marker for read-back after an uncertain begin transaction. */
  requestId?: string;
  operation?: 'solve' | 'explain' | 'recover'; parentCaptureId?: string;
  answerCaptureId?: string;
  profileId?: string; profileVersion?: string; promptVersion?: string; resultProtocol?: string;
  responseContract?: string; configRevision?: string; leaseMs?: number;
  exclusive?: boolean; legacy?: boolean;
}
export type BeginResult = { ok: true; capture: CaptureRecord; quota: QuotaSnapshot } |
  { ok: false; reason: 'unknown_token' | 'insufficient_quota' | 'idempotency_conflict' |
    'capture_in_progress' | 'capture_already_finalized' | 'device_busy' | 'service_maintenance'; capture?: CaptureRecord };
export interface FinishCapture {
  token: string; captureId?: string; charge: boolean; terminalState: Exclude<TerminalState, 'pending'>;
  answerHmac?: string; resultState?: string; questionKind?: string; parserPath?: string;
  terminalReason?: string; inputTokens?: number | null; outputTokens?: number | null; model?: string;
  estimatedCostMicros?: number; pricingVersion?: string; usageCaptureId?: string;
  /** Recovery failures receive one auditable goodwill question in the same transaction. */
  compensateGoodwill?: boolean;
}
export interface Attempt {
  attemptId: string; captureId: string; purpose: 'answer' | 'explain' | 'recover';
  provider: string; model: string; policyVersion: string;
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  inputTokens: number | null; outputTokens: number | null; costMicros: string | null;
  currency: string; pricingVersion: string; startedAt: string; finishedAt: string | null;
}
export interface BillingStore {
  quota(token: string): Promise<QuotaSnapshot | null>;
  accountSnapshot(token: string): Promise<AccountSnapshot | null>;
  begin(input: BeginCapture): Promise<BeginResult>;
  finish(input: FinishCapture): Promise<AccountSnapshot | null>;
  capture(token: string, captureId: string): Promise<CaptureRecord | null>;
  reap(now?: string): Promise<number>;
  startAttempt(token: string, input: Omit<Attempt, 'status' | 'inputTokens' | 'outputTokens' | 'costMicros' | 'startedAt' | 'finishedAt'>): Promise<boolean>;
  finishAttempt(token: string, attemptId: string, input: Pick<Attempt, 'status' | 'inputTokens' | 'outputTokens' | 'costMicros'>): Promise<void>;
  reserveBudget(token: string, attemptId: string, scope: string, currency: string,
    reservedUpperMicros: number, limitMicros: number, windowMs?: number, now?: number): Promise<boolean>;
  releaseBudget(token: string, attemptId: string): Promise<void>;
  settleBudget(token: string, attemptId: string, actualMicros: number | null): Promise<void>;
  creditDevice(deviceId: number, input: Omit<CreditInput, 'token'>): Promise<number | null>;
  attempts(token: string): Promise<Attempt[]>;
  rateLimit(scope: string, limit: number, windowMs: number, now?: number): Promise<boolean>;
}
export interface RegistrationInput {
  platform: string; appVersion: string; trialQuestions: number; policyVersion?: string;
  token?: string; registrationKeyHash?: string; registrationKeyVersion?: string;
}
export interface CreditInput {
  token: string; questions: number; amountCents: number; currency: string; provider: string;
  reference: string; note?: string;
}
export function validQuestions(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid question amount');
}
export function newCapture(input: BeginCapture): CaptureRecord {
  const createdAt = new Date().toISOString();
  return {
    requestId: input.requestId ?? randomUUID(), captureId: input.captureId, requestHmac: input.requestHmac,
    inputHmac: input.inputHmac ?? input.requestHmac, keyVersion: input.keyVersion ?? 'local',
    operation: input.operation ?? 'solve', parentCaptureId: input.parentCaptureId ?? null,
    ...(input.answerCaptureId ? {answerCaptureId: input.answerCaptureId} : {}),
    profileId: input.profileId ?? null, profileVersion: input.profileVersion ?? null,
    promptVersion: input.promptVersion ?? null, resultProtocol: input.resultProtocol ?? null,
    responseContract: input.responseContract ?? null, configRevision: input.configRevision ?? 'legacy',
    settlementStatus: 'held', terminalState: 'pending', usableResult: false,
    answerHmac: null, resultState: null, questionKind: null, parserPath: null, terminalReason: null,
    createdAt, expiresAt: new Date(Date.parse(createdAt) + (input.leaseMs ?? 120_000)).toISOString(), finishedAt: null,
  };
}
export function duplicateCapture(existing: CaptureRecord, input: BeginCapture): BeginResult {
  return { ok: false, reason: existing.requestHmac !== input.requestHmac
    || existing.operation !== (input.operation ?? 'solve') || existing.parentCaptureId !== (input.parentCaptureId ?? null)
    || (existing.answerCaptureId ?? existing.parentCaptureId) !== (input.answerCaptureId ?? input.parentCaptureId ?? null) ? 'idempotency_conflict'
    : existing.settlementStatus === 'held' ? 'capture_in_progress' : 'capture_already_finalized', capture: existing };
}

/** Resolve only the one committed recovery directly owned by this paid solve. No recursive
 * chain or new clock is introduced, and both records are read under the same device lock. */
export function isRecoveredAnswerFor(parent: CaptureRecord, answer: CaptureRecord): boolean {
  return parent.operation === 'solve' && parent.settlementStatus === 'settled' && parent.usableResult
    && parent.recoveryCaptureId === answer.captureId && answer.parentCaptureId === parent.captureId
    && answer.operation === 'recover' && answer.settlementStatus === 'released' && answer.terminalState === 'usable'
    && answer.usableResult && !!answer.answerHmac
    && answer.inputHmac === parent.inputHmac && answer.keyVersion === parent.keyVersion
    && answer.profileId === parent.profileId && answer.profileVersion === parent.profileVersion
    && answer.promptVersion === parent.promptVersion && answer.resultProtocol === parent.resultProtocol
    && answer.responseContract === parent.responseContract && answer.configRevision === parent.configRevision;
}

/** Versioned key ring. Production never silently generates a per-instance credential key. */
export class RequestKeys {
  readonly current: string;
  private keys: Record<string, string>;
  constructor(json: string, current: string, allowEphemeral: boolean) {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid HMAC key ring');
    this.keys = parsed as Record<string, string>;
    for (const [version, key] of Object.entries(this.keys)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(version) || typeof key !== 'string' || Buffer.from(key, 'base64').length < 32) {
        throw new Error('HMAC keys require a bounded version and at least 256 bits');
      }
    }
    this.current = current;
    if (!this.keys[current]) {
      if (!allowEphemeral) throw new Error('Persistent REQUEST_HMAC_KEYS_JSON is required');
      this.keys[current] = randomBytes(32).toString('base64');
    }
  }
  digest(purpose: string, value: string, version = this.current): string {
    const key = this.keys[version];
    if (!key) throw new Error('HMAC key version unavailable');
    return createHmac('sha256', Buffer.from(key, 'base64')).update(purpose + '\0' + value).digest('hex');
  }
  registration(attempt: string, version = this.current) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(attempt) || Buffer.from(attempt, 'base64url').length !== 32) {
      throw new Error('Invalid registration credential');
    }
    return { token: 'dev_' + this.digest('registration-token', attempt, version),
      registrationKeyHash: this.digest('registration-key', attempt, version), registrationKeyVersion: version };
  }
  versions(): string[] { return Object.keys(this.keys); }
}
