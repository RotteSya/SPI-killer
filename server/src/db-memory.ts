import type { Account, DeviceSummary, RegisteredDevice, Store, TopUpSummary } from './db.ts';
import { hashToken, newToken } from './db.ts';

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
}

export class MemoryStore implements Store {
  private devices = new Map<string, DeviceRecord>(); // keyed by token hash
  private topups: Array<TopUpSummary & { deviceHash: string }> = [];
  private creditedReferences = new Set<string>();
  private counters = new Map<string, number>();
  private nextId = 1;

  async registerDevice(input: {
    platform: string;
    appVersion: string;
    trialQuestions: number;
  }): Promise<RegisteredDevice> {
    const token = newToken();
    const id = this.nextId++;
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
      createdAt: new Date().toISOString(),
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
    };
  }

  async setCliEnabled(token: string, enabled: boolean): Promise<boolean | null> {
    const d = this.devices.get(hashToken(token));
    if (!d) return null;
    d.cliEnabled = enabled;
    return enabled;
  }

  async chargeForUsage(input: {
    token: string;
    questions: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
  }): Promise<number | null> {
    const d = this.devices.get(hashToken(input.token));
    if (!d) return null;
    d.balanceQuestions -= input.questions;
    d.totalQuestions += input.questions;
    d.totalInputTokens += input.inputTokens;
    d.totalOutputTokens += input.outputTokens;
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
