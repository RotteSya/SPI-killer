import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { MemoryBilling } from './billing-memory.ts';
import { MemoryPaymentLedger } from './payment-ledger-memory.ts';
import {MemoryPaymentFinance} from './payment-finance-memory.ts';
import { MemoryObservationStore } from './observation.ts';
import { MemoryReportingStore } from './reporting-memory.ts';
import type { ReportAdjustment } from './reporting.ts';
import {receiptIdentity} from './reporting-receipts.ts';
import { validQuestions, type RegistrationInput } from './billing.ts';
import type {
  Account, DeviceSummary, ProductEventInput, ProductEventWriteResult, ProductMetrics,
  ProductMetricsQuery, RegisteredDevice, ReserveResult, Store, StoredProductEvent,
  StoredUsageMetric, TopUpSummary, PaymentAdjustmentInput,
} from './db.ts';
import { hashToken, newToken, type PurchaseSession, type PurchaseSessionInput, type StoredPurchaseSession } from './db.ts';
import { aggregateProductMetrics } from './telemetry.ts';
import {purchaseSecretHash,purchaseHandoff,reusablePurchase,validatePurchase,validateCheckoutAttachment} from './purchase-session.ts';

// Pure-JS in-memory store. Used as the EPHEMERAL fallback on serverless platforms when no
// POSTGRES_URL is configured (data vanishes per instance — /healthz reports db:"memory" so a
// misconfigured production is visible at a glance), and in tests where a filesystem-free store
// keeps things fast. Same semantics as SqliteStore, including idempotent credits.

interface DeviceRecord {
  id: number;
  tokenHash: string;
  registrationKeyHash: string | null;
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
  private registrationKeys = new Map<string, string>(); // registration hash -> immutable token hash
  private topups: Array<TopUpSummary & { deviceHash: string }> = [];
  private creditedReferences = new Set<string>();
  private counters = new Map<string, number>();
  private productEvents: StoredProductEvent[] = [];
  private webhookEventIds = new Set<string>();
  private paymentAdjustmentRefs = new Set<string>();
  private paymentAdjustments:ReportAdjustment[]=[];
  private usageEvents: Array<StoredUsageMetric & { createdAt: string }> = [];
  private purchaseSessions = new Map<string, StoredPurchaseSession>();
  private purchaseCreatedAt = new Map<string,string>();
  private nextId = 1;
  readonly finance = new MemoryPaymentFinance(()=>this.payments.financeOrders());
  readonly billing = new MemoryBilling(token => this.devices.get(hashToken(token)), event => this.usageEvents.push(event));
  readonly observations = new MemoryObservationStore(token=>this.devices.get(hashToken(token))?.id??null,this.productEvents);
  readonly reporting = new MemoryReportingStore(q=>{
    const devices=[...this.devices.values()].filter(d=>d.createdAt>=q.cohortFrom&&d.createdAt<q.cohortTo);
    const ids=new Set(devices.map(d=>d.id)),billing=this.billing.report(ids,q.asOf),payment=this.payments.reportFacts(ids,q.asOf,q.cohortFrom);
    for(const [index,u] of this.usageEvents.entries())if(u.deviceId!==undefined&&ids.has(u.deviceId)&&u.createdAt<=q.asOf&&
      !billing.attempts.some(a=>a.deviceId===u.deviceId&&a.captureId.toLowerCase()===u.captureId?.toLowerCase()))
      billing.attempts.push({id:'legacy_usage:'+index,deviceId:u.deviceId,captureId:u.captureId??'legacy_usage:'+index,purpose:'legacy_usage_without_currency',currency:'unknown',
        costMicros:null,upperMicros:null,revision:'1',pricingVersion:'legacy_unattributed',startedAt:u.createdAt,calculatedAt:u.createdAt,status:'unknown'});
    for(const t of this.topups)if(ids.has(t.deviceId)&&t.provider==='stripe'&&t.createdAt<=q.asOf&&!payment.orders.some(o=>o.reference===t.reference))
      payment.orders.push({reference:t.reference??'legacy_topup:'+t.id,deviceId:t.deviceId,paymentIntentId:null,chargeId:null,amountMinor:String(t.amountCents),currency:t.currency,paidAt:t.createdAt,recordedAt:t.createdAt});
    const legacyByReference=new Map(this.topups.filter(t=>t.provider==='stripe'&&t.createdAt<=q.asOf&&t.reference).map(t=>[t.reference,t]));
    for(const r of payment.receipts){const old=legacyByReference.get(r.checkoutReference);if(old&&!r.matchedOrders.some(o=>o.reference===old.reference))
      r.matchedOrders.push({reference:old.reference!,deviceId:old.deviceId,paymentIntentId:null,amountMinor:String(old.amountCents),currency:old.currency.toUpperCase()});}
    return {devices:devices.map(d=>({id:d.id,registeredAt:d.createdAt,policyVersion:billing.policies.get(d.id)??'legacy',isInternal:false})),
      sources:[],events:this.productEvents.filter(e=>ids.has(e.deviceId)&&e.receivedAt<=q.asOf&&e.occurredAt>=q.cohortFrom&&e.occurredAt<q.asOf),
      ...this.observations.report(ids,q.asOf),captures:billing.captures,attempts:billing.attempts,lots:billing.lots,...payment,finance:this.finance.facts(ids,q.asOf),
      adjustments:this.paymentAdjustments.filter(a=>a.recordedAt<=q.asOf&&payment.orders.some(o=>[o.reference,o.paymentIntentId,o.chargeId].includes(a.orderReference))),expenses:[],
      untrackedQuotaDeviceIds:devices.filter(d=>!billing.lots.some(l=>l.deviceId===d.id)).map(d=>d.id)};
  },id=>[...this.devices.values()].some(d=>d.id===id),token=>this.devices.get(hashToken(token))?.id??null);
  readonly payments = new MemoryPaymentLedger({
    device:input=>(input.token?this.devices.get(hashToken(input.token)):[...this.devices.values()].find(d=>d.id===input.deviceId))?.id??null,
    balance:id=>[...this.devices.values()].find(d=>d.id===id)!.balanceQuestions,
    credit:(input,id)=> {
      const d=[...this.devices.values()].find(d=>d.id===id)!;
      const existing=this.topups.find(t=>t.reference===input.reference);
      if(existing&&(existing.deviceId!==id||existing.questions!==input.questions||existing.amountCents!==input.amountCents||existing.currency.toUpperCase()!==input.currency)) throw new Error('Existing payment identity conflict');
      this.creditRecord(d,{...input,provider:'stripe'});
    },
    policy:(id,reference,policy)=>this.billing.refundPolicy(id,reference,policy),
    purchase:id=>this.purchaseSessions.get(id)??null,
    consume:(id,at)=>{this.purchaseSessions.get(id)!.consumedAt??=at;},
    receiptIdentity:(snapshot,at)=>{
      const purchase=snapshot.purchaseSessionId?this.purchaseSessions.get(snapshot.purchaseSessionId):undefined;
      return receiptIdentity(snapshot,at,snapshot.deviceTokenHash?this.devices.get(snapshot.deviceTokenHash)??null:null,
        purchase?{deviceId:purchase.deviceId,createdAt:this.purchaseCreatedAt.get(purchase.sessionId)!}:null);
    },
    checkoutContext:(snapshot,original,decision)=>({
      purchase:snapshot.purchaseSessionId?this.purchaseSessions.get(snapshot.purchaseSessionId)??null:null,
      checkoutOwner:[...this.purchaseSessions.values()].find(p=>p.checkoutSessionId===snapshot.id)?.sessionId??null,
      deviceId:snapshot.deviceTokenHash?this.devices.get(snapshot.deviceTokenHash)?.id??null:null,
      originalDeviceId:original.deviceTokenHash?this.devices.get(original.deviceTokenHash)?.id??null:null,
      manualDeviceExists:!!decision&&[...this.devices.values()].some(d=>d.id===decision.deviceId),
      topup:this.topups.find(t=>t.reference===snapshot.id)??null,
    }),
    bindPaidPurchase:(id,reference)=>{
      const purchase=this.purchaseSessions.get(id)!;const previous=purchase.checkoutSessionId;purchase.checkoutSessionId=reference;
      return ()=>{purchase.checkoutSessionId=previous;};
    },
  });

  async registerDevice(input: RegistrationInput): Promise<RegisteredDevice> {
    validQuestions(input.trialQuestions);
    const token = input.token ?? newToken();
    const tokenHash = hashToken(token), key = input.registrationKeyHash;
    const existing = this.devices.get(tokenHash);
    if ((key !== undefined && this.registrationKeys.has(key) && this.registrationKeys.get(key) !== tokenHash) ||
        (existing && key !== undefined && existing.registrationKeyHash !== key)) {
      throw new Error('Registration identity conflict');
    }
    if (existing) return { token, id: existing.id, balanceQuestions: existing.balanceQuestions };
    const id = this.nextId++;
    // One clock read for both columns: a fresh device must satisfy updatedAt === createdAt, and
    // two separate reads can straddle a millisecond boundary and fake balance activity.
    const now = new Date().toISOString();
    this.devices.set(hashToken(token), {
      id,
      tokenHash: hashToken(token),
      registrationKeyHash: key ?? null,
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
    this.billing.register(this.devices.get(hashToken(token))!, input.policyVersion ?? 'legacy', input.trialQuestions);
    if (key !== undefined) this.registrationKeys.set(key, tokenHash);
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

  async recordWebhookEvent(input: import('./db.ts').WebhookEventInput): Promise<boolean> {
    if (this.webhookEventIds.has(input.providerEventId)) return false;
    this.webhookEventIds.add(input.providerEventId);
    return true;
  }

  async recordPaymentAdjustment(input: PaymentAdjustmentInput): Promise<boolean> {
    if (this.paymentAdjustmentRefs.has(input.providerRef)) return false;
    validQuestions(input.amountCents);
    this.paymentAdjustmentRefs.add(input.providerRef);
    if(input.type!=='refund')this.paymentAdjustments.push({reference:input.providerRef,orderReference:input.orderReference,type:input.type,
      amountMinor:String(input.amountCents),currency:input.currency,status:input.status,effectiveAt:input.effectiveAt,recordedAt:new Date().toISOString()});
    return true;
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
    return this.observations.prune(before);
  }

  async releaseReservation(input: { token: string; questions: number }): Promise<number | null> {
    if (input.questions !== 1) throw new Error('A capture releases exactly one question');
    return (await this.billing.finish({ token: input.token, charge: false, terminalState: 'failed' }))?.balanceQuestions ?? null;
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
    return this.creditRecord(d,input);
  }

  private creditRecord(d:DeviceRecord,input:{questions:number;amountCents:number;currency:string;provider:string;reference:string;note?:string}):number {
    validQuestions(input.questions); validQuestions(input.amountCents);
    if (this.creditedReferences.has(input.reference)) return d.balanceQuestions;
    this.creditedReferences.add(input.reference);
    this.billing.credit(d, input.questions, input.amountCents > 0 ? 'paid' : 'goodwill',input.reference);
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

  async createPurchaseSession(input: PurchaseSessionInput): Promise<PurchaseSession | null> {
    validatePurchase(input);
    const d=this.devices.get(hashToken(input.token)); if(!d) return null;
    const existing=[...this.purchaseSessions.values()].find(s=>s.deviceId===d.id&&s.purchaseId===input.purchaseId);
    const sessionId=randomUUID(),secret=randomBytes(32).toString('base64url'),now=Date.now();
    if(existing){if(!reusablePurchase(existing,input,now))return null;existing.secretHash=purchaseSecretHash(secret);return purchaseHandoff(existing,secret);}
    const stored:StoredPurchaseSession={sessionId,secretHash:createHash('sha256').update(secret).digest('hex'),deviceId:d.id,
      purchaseId:input.purchaseId,packId:input.packId,catalogVersion:input.catalogVersion,questions:input.questions,
      amountCents:input.amountCents,currency:input.currency,lang:input.lang,expiresAt:new Date(now+600_000).toISOString(),checkoutSessionId:null,checkoutURL:null,consumedAt:null};
    this.purchaseSessions.set(sessionId,stored);
    this.purchaseCreatedAt.set(sessionId,new Date().toISOString());
    return purchaseHandoff(stored,secret);
  }
  async getPurchaseSession(sessionId:string,secret:string):Promise<StoredPurchaseSession|null> {
    const s=this.purchaseSessions.get(sessionId); if(!s||s.consumedAt||s.secretHash!==purchaseSecretHash(secret)||Date.parse(s.expiresAt)<=Date.now()) return null;
    return {...s};
  }
  async getPurchaseSessionByCheckout(checkoutSessionId:string):Promise<StoredPurchaseSession|null> {
    const s=[...this.purchaseSessions.values()].find(v=>v.checkoutSessionId===checkoutSessionId); return s?{...s}:null;
  }
  async attachPurchaseCheckout(sessionId:string,checkoutSessionId:string,checkoutURL?:string):Promise<boolean> {
    validateCheckoutAttachment(checkoutSessionId,checkoutURL);
    const s=this.purchaseSessions.get(sessionId); if(!s||s.consumedAt||Date.parse(s.expiresAt)<=Date.now()) return false;
    if((s.checkoutSessionId&&s.checkoutSessionId!==checkoutSessionId)||(s.checkoutURL&&s.checkoutURL!==checkoutURL)) return false;
    if([...this.purchaseSessions.values()].some(v=>v.sessionId!==sessionId&&v.checkoutSessionId===checkoutSessionId))return false;
    s.checkoutSessionId=checkoutSessionId;s.checkoutURL??=checkoutURL??null;return true;
  }
  async creditDevice(input:{deviceId:number;questions:number;amountCents:number;currency:string;provider:string;reference:string;note?:string}):Promise<number|null> {
    const d=[...this.devices.values()].find(v=>v.id===input.deviceId); if(!d) return null;
    return this.creditRecord(d,input);
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
