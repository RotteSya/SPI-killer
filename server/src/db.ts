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

export interface Store {
  registerDevice(input: {
    platform: string;
    appVersion: string;
    trialQuestions: number;
  }): Promise<RegisteredDevice>;

  /** Account snapshot for a bearer token, or null if the token is unknown/invalid. */
  getAccount(token: string): Promise<Account | null>;

  /**
   * Atomically deduct `questions`, add to lifetime totals, and append a usage row.
   * Returns the new question balance, or null if the token is invalid. The balance may go
   * negative when a capture was already in flight as it hit zero; the pre-request gate stops
   * the NEXT capture — honest accounting over silent clamping.
   */
  chargeForUsage(input: {
    token: string;
    questions: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }): Promise<number | null>;

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
