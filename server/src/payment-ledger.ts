import { createHash } from 'node:crypto';
import type {CheckoutQueue} from './checkout-reconciliation.ts';

export type RefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
export interface PaymentEvent {
  id: string; type: string; resourceId: string; createdAt: string | null; payloadHash: string;
}
export interface PaidOrderInput {
  purchaseSessionId?: string;
  reference: string; token?: string; deviceId?: number; paymentIntentId: string | null;
  chargeId: string | null; questions: number; amountCents: number; currency: string;
  packId: string; catalogVersion: string; paidAt: string;
}
export interface RefundSnapshot {
  id: string; paymentIntentId: string | null; chargeId: string | null;
  amountCents: number; currency: string; status: RefundStatus;
}
export interface RefundClaim { event: PaymentEvent; generation: string }
export interface RefundDecision { reference: string; fingerprint: string; questions: number }
export interface RefundPolicy {
  frozen: boolean; revokeTarget: number; succeededCents: number | null; pendingCents: number | null;
  review: 'none' | 'partial' | 'integrity'; fingerprint: string;
}
export interface PaymentOrder extends Omit<PaidOrderInput, 'token' | 'deviceId'> {
  deviceId: number; policy: RefundPolicy; decision: RefundDecision | null;
  quotaAttribution: 'paid_lot' | 'legacy_unknown';
}
export interface PaymentReport {
  orders: PaymentOrder[]; refunds: RefundSnapshot[]; pendingEvents: number;
  hasMore: { orders: boolean; refunds: boolean };
}
export type PaymentReportWire = Omit<PaymentReport,'orders'|'refunds'> & {
  orders:Array<Omit<PaymentOrder,'amountCents'|'policy'>&{amountCents:string;policy:Omit<RefundPolicy,'succeededCents'|'pendingCents'>&{succeededCents:string|null;pendingCents:string|null}}>;
  refunds:Array<Omit<RefundSnapshot,'amountCents'>&{amountCents:string}>;
};
export function paymentReportWire(report:PaymentReport):PaymentReportWire {
  return {...report,orders:report.orders.map(order=>({...order,amountCents:String(order.amountCents),policy:{...order.policy,
    succeededCents:order.policy.succeededCents===null?null:String(order.policy.succeededCents),pendingCents:order.policy.pendingCents===null?null:String(order.policy.pendingCents)}})),
    refunds:report.refunds.map(refund=>({...refund,amountCents:String(refund.amountCents)}))};
}
export interface PaymentLedger {
  readonly checkouts:CheckoutQueue;
  acknowledge(event: PaymentEvent): Promise<void>;
  queueRefunds(events:PaymentEvent[]):Promise<void>;
  pay(event: PaymentEvent, order: PaidOrderInput): Promise<number | null>;
  claimRefund(event: PaymentEvent): Promise<RefundClaim | null>;
  applyRefund(claim: RefundClaim, refund: RefundSnapshot): Promise<boolean>;
  deferRefund(claim: RefundClaim): Promise<void>;
  pendingRefunds(now?: string, limit?: number): Promise<PaymentEvent[]>;
  decidePartial(orderReference: string, decision: RefundDecision): Promise<boolean>;
  report(limit?: number, orderReference?: string): Promise<PaymentReport>;
}

export function validateEvent(event: PaymentEvent): void {
  if (!/^evt_[A-Za-z0-9_]{1,160}$/.test(event.id) || !/^[a-z_.]{1,120}$/.test(event.type) ||
      !/^[A-Za-z0-9_]{1,180}$/.test(event.resourceId) || !/^[a-f0-9]{64}$/.test(event.payloadHash) ||
      (event.createdAt !== null && !Number.isFinite(Date.parse(event.createdAt)))) throw new Error('Invalid payment event');
}
export function validateOrder(order: PaidOrderInput): void {
  if (!/^cs_[A-Za-z0-9_]{1,160}$/.test(order.reference) ||
      !Number.isSafeInteger(order.questions) || order.questions <= 0 ||
      !Number.isSafeInteger(order.amountCents) || order.amountCents <= 0 ||
      !/^[A-Z]{3}$/.test(order.currency) || !Number.isFinite(Date.parse(order.paidAt)) ||
      (order.paymentIntentId !== null && !/^pi_[A-Za-z0-9_]{1,160}$/.test(order.paymentIntentId)) ||
      (order.chargeId !== null && !/^ch_[A-Za-z0-9_]{1,160}$/.test(order.chargeId))) throw new Error('Invalid paid order');
  if(order.purchaseSessionId!==undefined&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(order.purchaseSessionId))throw new Error('Invalid paid purchase session');
}
export function validateRefund(refund: RefundSnapshot): void {
  if (!/^re_[A-Za-z0-9_]{1,160}$/.test(refund.id) ||
      !Number.isSafeInteger(refund.amountCents) || refund.amountCents <= 0 || !/^[A-Z]{3}$/.test(refund.currency) ||
      !['pending','requires_action','succeeded','failed','canceled'].includes(refund.status) ||
      (!refund.paymentIntentId && !refund.chargeId) ||
      (refund.paymentIntentId !== null && !/^pi_[A-Za-z0-9_]{1,160}$/.test(refund.paymentIntentId)) ||
      (refund.chargeId !== null && !/^ch_[A-Za-z0-9_]{1,160}$/.test(refund.chargeId))) throw new Error('Invalid refund snapshot');
}
export function sameEvent(a: PaymentEvent, b: PaymentEvent): boolean {
  return a.id === b.id && a.type === b.type && a.resourceId === b.resourceId && a.payloadHash === b.payloadHash;
}
export function sameOrder(a: PaymentOrder, b: PaidOrderInput, deviceId: number): boolean {
  return a.reference === b.reference && a.deviceId === deviceId && a.questions === b.questions &&
    a.amountCents === b.amountCents && a.currency === b.currency && a.paymentIntentId === b.paymentIntentId &&
    a.chargeId === b.chargeId && a.packId === b.packId && a.catalogVersion === b.catalogVersion &&
    (!a.purchaseSessionId||a.purchaseSessionId===b.purchaseSessionId);
}
export function isLinked(order: Pick<PaidOrderInput,'paymentIntentId'|'chargeId'>, refund: RefundSnapshot): boolean {
  return !!((order.paymentIntentId && order.paymentIntentId === refund.paymentIntentId) ||
    (order.chargeId && order.chargeId === refund.chargeId));
}
export function sameRefundIdentity(a:RefundSnapshot,b:RefundSnapshot):boolean {
  return a.id===b.id&&a.paymentIntentId===b.paymentIntentId&&a.chargeId===b.chargeId&&a.amountCents===b.amountCents&&a.currency===b.currency;
}

/** Cash facts and question policy are separate. Partial refunds never imply a prorated grant. */
export function refundPolicy(order: PaidOrderInput, refunds: RefundSnapshot[], decision: RefundDecision | null): RefundPolicy {
  const linked = refunds.filter(refund => isLinked(order, refund)).sort((a,b) => a.id.localeCompare(b.id));
  const fingerprint = createHash('sha256').update(JSON.stringify(linked.map(r=>[r.id,r.paymentIntentId,r.chargeId,r.amountCents,r.currency,r.status]))).digest('hex');
  let succeeded = 0n, pending = 0n, integrity = false;
  for (const refund of linked) {
    if (refund.currency !== order.currency ||
        (refund.paymentIntentId && order.paymentIntentId && refund.paymentIntentId !== order.paymentIntentId) ||
        (refund.chargeId && order.chargeId && refund.chargeId !== order.chargeId)) integrity = true;
    if(refund.currency!==order.currency) continue;
    if (refund.status === 'succeeded') succeeded += BigInt(refund.amountCents);
    if (refund.status === 'pending' || refund.status === 'requires_action') pending += BigInt(refund.amountCents);
  }
  integrity ||= succeeded + pending > BigInt(order.amountCents);
  const succeededCents=succeeded>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(succeeded);
  const pendingCents=pending>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(pending);
  const full = succeeded === BigInt(order.amountCents);
  const partial = succeeded > 0n && !full;
  const approved = decision?.fingerprint === fingerprint;
  return { frozen: integrity || pending > 0n || full || (partial && !approved),
    revokeTarget: integrity ? 0 : full ? order.questions : partial && approved ? decision.questions : 0,
    succeededCents, pendingCents, review: integrity ? 'integrity' : partial && !approved ? 'partial' : 'none', fingerprint };
}
export function validDecision(order: PaymentOrder, decision: RefundDecision): boolean {
  return order.policy.review === 'partial' && order.policy.fingerprint === decision.fingerprint &&
    Number.isSafeInteger(decision.questions) && decision.questions >= 0 && decision.questions <= order.questions &&
    /^[A-Za-z0-9_-]{1,100}$/.test(decision.reference);
}

export interface RefundLot { remaining: number; held: number; revoked: number; frozen: boolean; target: number }
/** Existing capture holds may finish; released holds are revoked before becoming spendable. */
export function applyLotPolicy(lot: RefundLot, frozen: boolean, target: number): { availableDelta: number; revokedDelta: number } {
  const before = lot.frozen ? 0 : lot.remaining - lot.held;
  const unspent = lot.remaining + lot.revoked;
  const revoked = Math.min(target, unspent - lot.held);
  const revokedDelta = revoked - lot.revoked;
  lot.remaining = unspent - revoked; lot.revoked = revoked; lot.frozen = frozen; lot.target = target;
  return { availableDelta: (frozen ? 0 : lot.remaining - lot.held) - before, revokedDelta };
}
