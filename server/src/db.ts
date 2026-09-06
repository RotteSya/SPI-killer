import type { BillingStore, RegistrationInput } from './billing.ts';
import { createHash, randomBytes } from 'node:crypto';

// Data access is behind this interface so the SQLite implementation can be swapped for
// Postgres (production) or the in-memory store (ephemeral fallback) without touching routes.
// The account balance is an integer number of QUESTIONS (题数额度制); token counts are kept
// for internal cost accounting only. Money (integer cents) appears only on top-up records.
// Time is ISO-8601 UTC.
//
// The interface is ASYNC (Promise-returning) because the Postgres implementation must be;
// the SQLite/memory implementations simply resolve immediately.

export interface Account {
  balanceQuestions: number;
  totalQuestions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Per-device switch for the retired CLI channel; flipped manually by the operator. */
  cliEnabled: boolean;
  /** Client build last seen on this device. Written at registration, refreshed on upgrade. */
  appVersion: string | null;
  /** Whether this device ever finished the onboarding flow (reported by the client). */
  onboarded: boolean;
}

export interface RegisteredDevice {
  token: string; // plaintext, returned ONCE at registration
  balanceQuestions: number;
  /** Row id — never sent to the client; logged so a registration burst can be traced. */
  id: number;
}

// The admin activity view. Deliberately token-free: rows carry the row id, never the bearer
// credential (nor its hash), so the operator can read the log without gaining the ability to
// spend somebody's balance.

export interface DeviceSummary {
  id: number;
  platform: string | null;
  appVersion: string | null;
  balanceQuestions: number;
  totalQuestions: number;
  createdAt: string; // ISO-8601 UTC
  /** Last balance-changing event (spend, credit, CLI flip). Equals createdAt if never used. */
  updatedAt: string;
  onboarded: boolean;
  /**
   * How many times the hotkey was pressed on this device. Counted from the client's pre-capture
   * warm-up ping, which fires BEFORE the screenshot and before the quota gate — so it counts
   * presses that never became questions. `hotkeyPresses > 0` with `totalQuestions === 0` is the
   * signature of a client-side dead end (dead hotkey is the one case this cannot see: a press
   * that never reaches the app sends nothing).
   */
  hotkeyPresses: number;
}

export interface TopUpSummary {
  id: number;
  deviceId: number;
  questions: number;
  amountCents: number;
  currency: string;
  provider: string;
  reference: string | null;
  note: string | null;
  createdAt: string; // ISO-8601 UTC
  // Denormalized device columns — what the buyer is running, and how much they had used
  // before paying. The whole point of the view is not needing a second lookup.
  devicePlatform: string | null;
  deviceAppVersion: string | null;
  deviceCreatedAt: string;
  deviceTotalQuestions: number;
}

export interface PurchaseSessionInput {
  token: string;
  purchaseId: string;
  packId: string;
  catalogVersion: string;
  questions: number;
  amountCents: number;
  currency: string;
  lang: string;
}

/** Short-lived browser handoff. `secret` is returned once and only its hash is persisted. */
export interface PurchaseSession {
  sessionId: string;
  secret: string;
  deviceId: number;
  packId: string;
  catalogVersion: string;
  questions: number;
  amountCents: number;
  currency: string;
  lang: string;
  expiresAt: string;
  checkoutSessionId: string | null;
  checkoutURL: string | null;
  consumedAt: string | null;
}

export interface StoredPurchaseSession extends Omit<PurchaseSession, 'secret'> {
  secretHash: string;
  purchaseId: string;
  deviceToken?: string;
}

/**
 * Outcome of a quota hold. `balanceQuestions` is the balance AFTER the hold, which is exactly
 * what the client's `usage` event reports — no second read, so no window for it to drift.
 */
export type ReserveResult =
  | { ok: true; balanceQuestions: number }
  | { ok: false; reason: 'unknown_token' | 'insufficient_quota' };

export interface ProductEventInput {
  extensions?: Record<string, unknown>;
  eventId: string;
  captureId: string | null;
  occurredAt: string;
  eventName: string;
  trigger: string | null;
  channel: string | null;
  mode: string | null;
  depth: string | null;
  contextCount: number | null;
  questionKind: string | null;
  resultState: string | null;
  parserPath: string | null;
  errorCode: string | null;
  action: string | null;
  captureMs: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  appVersion: string | null;
  configRevision: string | null;
  variant: string | null;
}

export interface StoredProductEvent extends ProductEventInput {
  deviceId: number;
  receivedAt: string;
}

export interface ProductEventWriteResult {
  accepted: number;
  duplicate: number;
  rejected?: number;
}

export interface WebhookEventInput {
  providerEventId: string;
  eventType: string;
  resourceId: string;
  eventCreatedAt: string | null;
}

export type PaymentAdjustmentType = 'refund' | 'dispute' | 'fee';
export interface PaymentAdjustmentInput {
  providerRef: string;
  orderReference: string;
  type: PaymentAdjustmentType;
  amountCents: number;
  currency: string;
  status: 'observed' | 'applied' | 'ignored';
  effectiveAt: string;
}

export interface ProductMetricsQuery { from: string; to: string; variant?: string }

export interface ProductMetricVariant {
  variant: string;
  captures_started: number;
  captures_completed: number;
  usable_results: number;
  capture_success_rate: number;
  protocol_valid_rate: number;
  legacy_fallback_rate: number;
  result_states: Record<string, number>;
  depths: Record<string, number>;
  actions: Record<string, number>;
  latency_ms: { p50: number | null; p95: number | null };
  tokens: { avg_input: number | null; avg_output: number | null };
  estimated_cost_micros: { total: number | null; known_subtotal: number; unknown_count: number; avg_per_charged_capture: number | null };
}

export interface ProductMetrics {
  metric_definition_version: string;
  from: string;
  to: string;
  variants: ProductMetricVariant[];
}

export interface StoredUsageMetric {
  deviceId?:number;
  captureId: string | null;
  inputTokens: number;
  outputTokens: number;
  questions: number;
  estimatedCostMicros: number | null;
}

export interface Store {
  readonly finance: import('./payment-finance.ts').PaymentFinance;
  readonly reporting: import('./reporting.ts').ReportingStore;
  readonly observations: import('./observation.ts').ObservationStore;
  readonly payments: import('./payment-ledger.ts').PaymentLedger;
  readonly billing: BillingStore;
  registerDevice(input: RegistrationInput): Promise<RegisteredDevice>;

  /** Account snapshot for a bearer token, or null if the token is unknown/invalid. */
  getAccount(token: string): Promise<Account | null>;

  /**
   * Place a HOLD on `questions` before the answer is generated — a single atomic statement that
   * both tests the balance and deducts it, so N concurrent captures on a balance of 1 produce
   * exactly one winner. Reading the balance and deducting it separately (the previous design)
   * let every racer pass the same stale check and drove the balance negative once per racer.
   *
   * A hold is provisional: `settleReservation` makes it permanent, `releaseReservation` gives
   * it back. Exactly one of the two must run for every successful reservation.
   */
  reserveQuestions(input: { token: string; questions: number }): Promise<ReserveResult>;

  /**
   * Turn a hold into a permanent charge: accumulate lifetime totals and append the usage row.
   * The balance already moved at reservation time, so this never touches it.
   */
  settleReservation(input: {
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
  }): Promise<void>;

  recordProductEvents(token: string, events: ProductEventInput[]): Promise<ProductEventWriteResult>;
  /** Persist the small, normalized webhook receipt used for replay diagnostics. */
  recordWebhookEvent(input: WebhookEventInput): Promise<boolean>;
  /** Store refund/dispute/fee facts separately from quota goodwill credits. */
  recordPaymentAdjustment(input: PaymentAdjustmentInput): Promise<boolean>;
  getProductMetrics(input: ProductMetricsQuery): Promise<ProductMetrics>;
  pruneProductEvents(before: string): Promise<number>;

  /**
   * Return an unused hold to the balance (the vendor failed, or produced no answer). Returns the
   * restored balance, or null if the token is unknown. Never charges — "失败不扣题" is enforced
   * here rather than by declining to charge, so the refund is auditable.
   */
  releaseReservation(input: { token: string; questions: number }): Promise<number | null>;

  /**
   * Credit a purchased question pack — IDEMPOTENT on `reference`: a second call with the same
   * reference (e.g. a retried Stripe webhook delivery) is a no-op that returns the current
   * balance. Returns null if the token is invalid. `note` is an optional free-text memo stored
   * on the top-up record (used by the admin grant tool for audit).
   */
  credit(input: {
    token: string;
    questions: number;
    amountCents: number;
    currency: string;
    provider: string;
    reference: string;
    note?: string;
  }): Promise<number | null>;
  createPurchaseSession(input: PurchaseSessionInput): Promise<PurchaseSession | null>;
  getPurchaseSession(sessionId: string, secret: string): Promise<StoredPurchaseSession | null>;
  getPurchaseSessionByCheckout(checkoutSessionId: string): Promise<StoredPurchaseSession | null>;
  attachPurchaseCheckout(sessionId: string, checkoutSessionId: string, checkoutURL?: string): Promise<boolean>;
  creditDevice(input: {
    deviceId: number; questions: number; amountCents: number; currency: string;
    provider: string; reference: string; note?: string;
  }): Promise<number | null>;

  /**
   * Flip the per-device CLI switch (admin console only — the same manual flow as grants).
   * Returns the value now stored, or null if the token is unknown/invalid. Idempotent.
   */
  setCliEnabled(token: string, enabled: boolean): Promise<boolean | null>;

  /**
   * Record the client build a device is now running. `app_version` used to be written once at
   * registration and never again, which made the admin view lie about long-lived devices (a
   * machine that registered on 2.0.1 and upgraded to 2.6 still read as 2.0.1). Callers only
   * invoke this when the reported build actually differs, so it is a no-op on the hot path.
   */
  updateAppVersion(token: string, appVersion: string): Promise<void>;

  /** Record that this device finished onboarding. Callers invoke only on the false→true edge. */
  markOnboarded(token: string): Promise<void>;

  /** Count one hotkey press (the client's pre-capture warm-up ping). */
  recordHotkeyPress(token: string): Promise<void>;

  /**
   * Most recent device registrations, newest first (admin console only). Exists to answer one
   * question: is a burst of registrations one machine re-registering (a client-side credential
   * bug) or somebody farming the free grant? `totalQuestions` per row separates the two.
   */
  listRecentDevices(limit: number): Promise<DeviceSummary[]>;

  /** Most recent top-ups, newest first, with the paying device's columns joined in. */
  listRecentTopups(limit: number): Promise<TopUpSummary[]>;

  /** Atomically increment a named counter (created at 0 if absent) and return the new value. */
  bumpCounter(name: string): Promise<number>;

  /** Read a named counter's current value; 0 if it has never been bumped. */
  getCounter(name: string): Promise<number>;

  close(): Promise<void>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  // Opaque, URL-safe bearer credential. "dev_" prefix matches the client's expectation.
  return 'dev_' + randomBytes(24).toString('base64url');
}
