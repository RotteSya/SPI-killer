import { isLinked, refundPolicy, sameEvent, sameOrder, sameRefundIdentity, validDecision, validateEvent, validateOrder, validateRefund,
  type PaymentEvent, type PaidOrderInput, type PaymentOrder, type PaymentLedger, type PaymentReport,
  type RefundClaim, type RefundDecision, type RefundSnapshot, type RefundPolicy } from './payment-ledger.ts';
import type { ReportOrder, ReportRefund } from './reporting.ts';
import type {StoredPurchaseSession} from './db.ts';
import {validatePurchaseOrder} from './purchase-session.ts';
import {MemoryCheckoutQueue} from './checkout-memory.ts';
import type {CheckoutContext,CheckoutSnapshot,CheckoutDecision} from './checkout-reconciliation.ts';
import {ReportLimitError} from './reporting.ts';
import type {ReportReceipt} from './reporting-receipts.ts';

interface Receipt { event: PaymentEvent; done: boolean; generation: string | null; retryAfter: string | null }
export interface MemoryPaymentQuota {
  device(input: PaidOrderInput): number | null;
  credit(input: PaidOrderInput, deviceId: number): void;
  balance(deviceId: number): number;
  policy(deviceId: number, reference: string, policy: RefundPolicy): void;
  purchase(id:string):StoredPurchaseSession|null;
  consume(id:string,at:string):void;
  checkoutContext(snapshot:CheckoutSnapshot,original:CheckoutSnapshot,decision?:CheckoutDecision):Omit<CheckoutContext,'order'|'paymentOwner'>;
  bindPaidPurchase(id:string,reference:string):()=>void;
  receiptIdentity(snapshot:CheckoutSnapshot,receivedAt:string):{deviceId:number|null;identityConflict:boolean};
}
/** No await inside a mutation: quota and financial facts change in one JS turn. */
export class MemoryPaymentLedger implements PaymentLedger {
  private quota: MemoryPaymentQuota;
  private inbox=new Map<string,Receipt>();
  private orders=new Map<string,PaymentOrder>();
  financeOrders(){return [...this.orders.values()].map(o=>({reference:o.reference,deviceId:o.deviceId,paymentIntentId:o.paymentIntentId,chargeId:o.chargeId,amountMinor:String(o.amountCents),currency:o.currency}));}
  private orderRecordedAt=new Map<string,string>();
  private refundRevisions:ReportRefund[]=[];
  private refunds=new Map<string,RefundSnapshot>();
  private generations=new Map<string,bigint>();
  private decisions=new Map<string,{orderReference:string;decision:RefundDecision}>();
  readonly checkouts:MemoryCheckoutQueue;
  constructor(quota:MemoryPaymentQuota) {
    this.quota=quota;this.checkouts=new MemoryCheckoutQueue({
      receipt:event=>{this.receipt(event);},completeEvent:event=>{this.receipt(event).done=true;},
      complete:reference=>{for(const receipt of this.inbox.values())if(receipt.event.resourceId===reference)receipt.done=true;},
      context:(snapshot,original,decision)=>({...this.quota.checkoutContext(snapshot,original,decision),order:this.orders.get(snapshot.id)??null,
        paymentOwner:snapshot.paymentIntentId?[...this.orders.values()].find(o=>o.paymentIntentId===snapshot.paymentIntentId)?.reference??null:null}),
      credit:(event,order)=>this.payNow(event,order),bind:(id,reference)=>this.quota.bindPaidPurchase(id,reference),
    });
  }
  private receipt(event:PaymentEvent):Receipt {
    validateEvent(event);
    const existing=this.inbox.get(event.id);
    if(existing) {
      if(!sameEvent(existing.event,event)) throw new Error('Payment event identity conflict');
      return existing;
    }
    const receipt:Receipt={event:{...event},done:false,generation:null,retryAfter:null};
    this.inbox.set(event.id,receipt); return receipt;
  }
  private refresh(order:PaymentOrder):void {
    order.policy=refundPolicy(order,[...this.refunds.values()],order.decision);
    this.quota.policy(order.deviceId,order.reference,order.policy);
  }
  async acknowledge(event:PaymentEvent):Promise<void> { this.receipt(event).done=true; }
  async pay(event:PaymentEvent,input:PaidOrderInput):Promise<number|null> {return this.payNow(event,input);}
  private payNow(event:PaymentEvent,input:PaidOrderInput):number|null {
    validateOrder(input); validateEvent(event);
    if(event.resourceId!==input.reference) throw new Error('Payment resource mismatch');
    const oldReceipt=this.inbox.get(event.id);
    if(oldReceipt&&!sameEvent(oldReceipt.event,event)) throw new Error('Payment event identity conflict');
    const deviceId=this.quota.device(input); if(deviceId===null) return null;
    if(input.purchaseSessionId)validatePurchaseOrder(this.quota.purchase(input.purchaseSessionId),input,deviceId);
    let order=this.orders.get(input.reference);
    if(order) {
      if(!sameOrder(order,input,deviceId)) throw new Error('Paid order identity conflict');
      if(input.purchaseSessionId)order.purchaseSessionId??=input.purchaseSessionId;
    } else {
      if([...this.orders.values()].some(o=>(input.paymentIntentId&&o.paymentIntentId===input.paymentIntentId)||(input.chargeId&&o.chargeId===input.chargeId))) throw new Error('Payment resource already owned');
      this.quota.credit(input,deviceId);
      const {token:_token,deviceId:_deviceId,...snapshot}=input;
      order={...snapshot,deviceId,decision:null,policy:refundPolicy(input,[],null),quotaAttribution:'paid_lot'};
      this.orders.set(order.reference,order);
      this.orderRecordedAt.set(order.reference,new Date().toISOString());
    }
    this.refresh(order); this.receipt(event).done=true;
    if(input.purchaseSessionId)this.quota.consume(input.purchaseSessionId,new Date().toISOString());
    return this.quota.balance(deviceId);
  }
  async queueRefunds(events:PaymentEvent[]):Promise<void>{
    if(events.length>100)throw new Error('Too many refund rechecks');
    for(const event of events){validateEvent(event);if(!/^re_[A-Za-z0-9_]{1,160}$/.test(event.resourceId))throw new Error('Invalid refund id');}
    for(const event of events)this.receipt(event);
  }
  async claimRefund(event:PaymentEvent):Promise<RefundClaim|null> {
    if(!/^re_[A-Za-z0-9_]{1,160}$/.test(event.resourceId)) throw new Error('Invalid refund id');
    const receipt=this.receipt(event); if(receipt.done) return null;
    const generation=(this.generations.get(event.resourceId)??0n)+1n;
    this.generations.set(event.resourceId,generation); receipt.generation=String(generation);
    receipt.retryAfter=new Date(Date.now()+60_000).toISOString(); return {event:{...event},generation:String(generation)};
  }
  async applyRefund(claim:RefundClaim,snapshot:RefundSnapshot):Promise<boolean> {
    validateRefund(snapshot);
    if(snapshot.id!==claim.event.resourceId) throw new Error('Refund resource mismatch');
    const receipt=this.inbox.get(claim.event.id);
    if(!receipt||receipt.done||receipt.generation!==claim.generation||String(this.generations.get(snapshot.id))!==claim.generation) return false;
    const previous=this.refunds.get(snapshot.id);
    if(previous&&!sameRefundIdentity(previous,snapshot)) throw new Error('Refund financial identity conflict');
    this.refunds.set(snapshot.id,{...snapshot});
    this.refundRevisions.push({snapshot:{...snapshot},generation:claim.generation,recordedAt:new Date().toISOString()});
    for(const order of this.orders.values()) if(isLinked(order,snapshot)) this.refresh(order);
    for(const value of this.inbox.values()) if(value.event.resourceId===snapshot.id) { value.done=true;value.retryAfter=null; }
    return true;
  }
  async deferRefund(claim:RefundClaim):Promise<void> {
    const receipt=this.inbox.get(claim.event.id);
    if(receipt&&!receipt.done&&receipt.generation===claim.generation) receipt.retryAfter=new Date(Date.now()+60_000).toISOString();
  }
  reportFacts(ids:Set<number>,asOf:string,from:string):{orders:ReportOrder[];refunds:ReportRefund[];receipts:ReportReceipt[]} {
    const deliveries=this.checkouts.reportReceipts(from,asOf);if(deliveries.length>200000)throw new ReportLimitError('Receipt window exceeds row limit');
    const recorded=[...this.orders.values()].filter(o=>this.orderRecordedAt.get(o.reference)!<=asOf),byReference=new Map(recorded.map(o=>[o.reference,o])),byIntent=new Map(recorded.filter(o=>o.paymentIntentId).map(o=>[o.paymentIntentId,o]));
    const receipts:ReportReceipt[]=deliveries.map(r=>{
      const s=r.snapshot,matched=[byReference.get(s.id),s.paymentIntentId?byIntent.get(s.paymentIntentId):undefined].filter((o):o is PaymentOrder=>o!==undefined);
      return {eventId:r.event.id,checkoutReference:s.id,paymentIntentId:s.paymentIntentId,mode:s.mode,amountMinor:s.amountCents===null?null:String(s.amountCents),currency:s.currency,
        paidAt:r.event.createdAt,recordedAt:r.recordedAt,recordedTimeKnown:true,...this.quota.receiptIdentity(s,r.recordedAt),isInternal:false,
        matchedOrders:[...new Map(matched.map(o=>[o.reference,o])).values()].map(o=>({reference:o.reference,deviceId:o.deviceId,paymentIntentId:o.paymentIntentId,amountMinor:String(o.amountCents),currency:o.currency}))};
    });
    const orders=[...this.orders.values()].filter(o=>ids.has(o.deviceId)&&this.orderRecordedAt.get(o.reference)!<=asOf).map(o=>({
      reference:o.reference,deviceId:o.deviceId,paymentIntentId:o.paymentIntentId,chargeId:o.chargeId,amountMinor:String(o.amountCents),currency:o.currency,
      paidAt:o.paidAt,recordedAt:this.orderRecordedAt.get(o.reference)!}));
    return {orders,refunds:this.refundRevisions.filter(r=>r.recordedAt<=asOf&&orders.some(o=>isLinked(o,r.snapshot))).map(r=>structuredClone(r)),receipts};
  }
  async pendingRefunds(now=new Date().toISOString(),limit=10):Promise<PaymentEvent[]> {
    return [...this.inbox.values()].filter(r=>!r.done&&['refund.created','refund.updated','refund.failed','charge.refund.updated','finance.refund.reconcile'].includes(r.event.type)&&(!r.retryAfter||r.retryAfter<=now))
      .slice(0,Math.max(1,Math.min(100,limit))).map(r=>({...r.event}));
  }
  async decidePartial(reference:string,decision:RefundDecision):Promise<boolean> {
    const order=this.orders.get(reference); if(!order) return false;
    const previous=this.decisions.get(decision.reference);
    if(previous) return previous.orderReference===reference&&previous.decision.fingerprint===decision.fingerprint&&previous.decision.questions===decision.questions;
    if(!validDecision(order,decision)) return false;
    order.decision={...decision};this.decisions.set(decision.reference,{orderReference:reference,decision:{...decision}});this.refresh(order);return true;
  }
  async report(limit=100,reference?:string):Promise<PaymentReport> {
    const bounded=Math.max(1,Math.min(1000,limit)),orders=[...this.orders.values()].reverse().filter(o=>!reference||o.reference===reference);
    const snapshots=[...this.refunds.values()].reverse().filter(r=>!reference||orders.some(o=>isLinked(o,r)));
    return structuredClone({orders:orders.slice(0,bounded),refunds:snapshots.slice(0,1000),
      pendingEvents:[...this.inbox.values()].filter(r=>!r.done).length,hasMore:{orders:orders.length>bounded,refunds:snapshots.length>1000}});
  }
}
