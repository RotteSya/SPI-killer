import type {
  Account, DeviceSummary, ProductEventInput, ProductEventWriteResult, ProductMetrics,
  ProductMetricsQuery, RegisteredDevice, ReserveResult, Store, StoredProductEvent,
  StoredUsageMetric, TopUpSummary,
} from './db.ts';
import { hashToken, newToken } from './db.ts';
import { aggregateProductMetrics } from './telemetry.ts';

// Pure-JS in-memory store. Used as the EPHEMERAL fallback on serverless platforms when no
// POSTGRES_URL is configured (data vanishes per instance — /healthz reports db:"memory" so a
// misconfigured production is visible at a glance), and in tests where a filesystem-free store
// keeps things fast. Same semantics as SqliteStore, including idempotent credits.

interface DeviceRecord {
  id: number;
  tokenHash: string;
  platform: string;
  appVersion: string;
  balanceQuestions: number;
  totalQuestions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cliEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  onboarded: boolean;
  hotkeyPresses: number;
}

export class MemoryStore implements Store {
  private devices = new Map<string, DeviceRecord>(); // keyed by token hash
  private topups: Array<TopUpSummary & { deviceHash: string }> = [];
  private creditedReferences = new Set<string>();
  private counters = new Map<string, number>();
  private productEvents: StoredProductEvent[] = [];
  private usageEvents: Array<StoredUsageMetric & { createdAt: string }> = [];
  private nextId = 1;

  async registerDevice(input: {
    platform: string;
    appVersion: string;
    trialQuestions: number;
  }): Promise<RegisteredDevice> {
    const token = newToken();
    const id = this.nextId++;
    // One clock read for both columns: a fresh device must satisfy updatedAt === createdAt, and
    // two separate reads can straddle a millisecond boundary and fake balance activity.
    const now = new Date().toISOString();
    this.devices.set(hashToken(token), {
      id,
      tokenHash: hashToken(token),
      platform: input.platform,
      appVersion: input.appVersion,
      balanceQuestions: input.trialQuestions,
      totalQuestions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cliEnabled: false,
      createdAt: now,
      updatedAt: now,
      onboarded: false,
      hotkeyPresses: 0,
    });
    return { token, balanceQuestions: input.trialQuestions, id };
  }

  async getAccount(token: string): Promise<Account | null> {
    const d = this.devices.get(hashToken(token));
    if (!d) return null;
    return {
      balanceQuestions: d.balanceQuestions,
      totalQuestions: d.totalQuestions,
      totalInputTokens: d.totalInputTokens,
      totalOutputTokens: d.totalOutputTokens,
      cliEnabled: d.cliEnabled,
      appVersion: d.appVersion,
      onboarded: d.onboarded,
    };
  }

  async setCliEnabled(token: string, enabled: boolean): Promise<boolean | null> {
    const d = this.devices.get(hashToken(token));
    if (!d) return null;
    d.cliEnabled = enabled;
    return enabled;
  }

  async reserveQuestions(input: { token: string; questions: number }): Promise<ReserveResult> {
    const d = this.devices.get(hashToken(input.token));
    if (!d) return { ok: false, reason: 'unknown_token' };
    // Single-threaded JS: no statement can interleave between the guard and the deduction, so
    // this matches the SQL backends' atomicity without any locking of its own.
    if (d.balanceQuestions < input.questions) return { ok: false, reason: 'insufficient_quota' };
    d.balanceQuestions -= input.questions;
    d.updatedAt = new Date().toISOString();
    return { ok: true, balanceQuestions: d.balanceQuestions };
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
    const d = this.devices.get(hashToken(input.token));
    if (!d) return;
    d.totalQuestions += input.questions;
    d.totalInputTokens += input.inputTokens;
    d.totalOutputTokens += input.outputTokens;
    d.updatedAt = new Date().toISOString();
    this.usageEvents.push({
      captureId: input.captureId ?? null, inputTokens: input.inputTokens,
      outputTokens: input.outputTokens, questions: input.questions,
      estimatedCostMicros: input.estimatedCostMicros ?? null, createdAt: new Date().toISOString(),
    });
  }

  async recordProductEvents(token: string, events: ProductEventInput[]): Promise<ProductEventWriteResult> {
    const device = this.devices.get(hashToken(token));
    if (!device) return { accepted: 0, duplicate: 0 };
    const known = new Set(this.productEvents.map((event) => event.eventId));
    let accepted = 0;
    let duplicate = 0;
    const receivedAt = new Date().toISOString();
    for (const event of events) {
      if (known.has(event.eventId)) { duplicate += 1; continue; }
      known.add(event.eventId);
      this.productEvents.push({ ...event, deviceId: device.id, receivedAt });
      accepted += 1;
    }
    if (this.productEvents.length > 10_000) {
      this.productEvents.splice(0, this.productEvents.length - 10_000);
    }
    return { accepted, duplicate };
  }

  async getProductMetrics(input: ProductMetricsQuery): Promise<ProductMetrics> {
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    const events = this.productEvents.filter((event) => {
      const at = Date.parse(event.receivedAt);
      return at >= from && at < to;
    });
    const usage = this.usageEvents.filter((event) => {
      const at = Date.parse(event.createdAt);
      return at >= from && at < to;
    });
    return aggregateProductMetrics(events, input, usage);
  }

  async pruneProductEvents(before: string): Promise<number> {
    const cutoff = Date.parse(before);
    const previous = this.productEvents.length;
    this.productEvents = this.productEvents.filter((event) => Date.parse(event.receivedAt) >= cutoff);
    return previous - this.productEvents.length;
  }

  async releaseReservation(input: { token: string; questions: number }): Promise<number | null> {
    const d = this.devices.get(hashToken(input.token));
    if (!d) return null;
    d.balanceQuestions += input.questions;
    d.updatedAt = new Date().toISOString();
    return d.balanceQuestions;
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
    const d = this.devices.get(hashToken(input.token));
    if (!d) return null;
    if (this.creditedReferences.has(input.reference)) return d.balanceQuestions;
    this.creditedReferences.add(input.reference);
    d.balanceQuestions += input.questions;
    this.topups.push({
      deviceHash: d.tokenHash,
      id: this.topups.length + 1,
      deviceId: d.id,
      questions: input.questions,
      amountCents: input.amountCents,
      currency: input.currency,
      provider: input.provider,
      reference: input.reference,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
      // Filled in at read time from the live device record, so lifetime usage stays current.
      devicePlatform: null,
      deviceAppVersion: null,
      deviceCreatedAt: d.createdAt,
      deviceTotalQuestions: 0,
    });
    return d.balanceQuestions;
  }

  async updateAppVersion(token: string, appVersion: string): Promise<void> {
    const d = this.devices.get(hashToken(token));
    if (!d) return;
    d.appVersion = appVersion;
  }

  async markOnboarded(token: string): Promise<void> {
    const d = this.devices.get(hashToken(token));
    if (d) d.onboarded = true;
  }

  async recordHotkeyPress(token: string): Promise<void> {
    const d = this.devices.get(hashToken(token));
    if (d) d.hotkeyPresses += 1;
  }

  async listRecentDevices(limit: number): Promise<DeviceSummary[]> {
    return [...this.devices.values()]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((d) => ({
        id: d.id,
        platform: d.platform,
        appVersion: d.appVersion,
        balanceQuestions: d.balanceQuestions,
        totalQuestions: d.totalQuestions,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        onboarded: d.onboarded,
        hotkeyPresses: d.hotkeyPresses,
      }));
  }

  async listRecentTopups(limit: number): Promise<TopUpSummary[]> {
    return this.topups
      .slice()
      .reverse()
      .slice(0, limit)
      .map(({ deviceHash, ...t }) => {
        const d = this.devices.get(deviceHash);
        return {
          ...t,
          devicePlatform: d?.platform ?? null,
          deviceAppVersion: d?.appVersion ?? null,
          deviceCreatedAt: d?.createdAt ?? t.deviceCreatedAt,
          deviceTotalQuestions: d?.totalQuestions ?? 0,
        };
      });
  }

  async bumpCounter(name: string): Promise<number> {
    const value = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, value);
    return value;
  }

  async getCounter(name: string): Promise<number> {
    return this.counters.get(name) ?? 0;
  }

  async close(): Promise<void> {}
}
