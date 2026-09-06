import {createHash} from 'node:crypto';
import {validateEvent,type PaymentEvent,type PaymentOrder,type PaymentLedger,type RefundSnapshot,validateRefund,sameRefundIdentity} from './payment-ledger.ts';

export interface FinanceOrder {reference:string;deviceId:number;paymentIntentId:string|null;chargeId:string|null;amountMinor:string;currency:string}
export function financeOrder(order:PaymentOrder):FinanceOrder{return {reference:order.reference,deviceId:order.deviceId,paymentIntentId:order.paymentIntentId,chargeId:order.chargeId,amountMinor:String(order.amountCents),currency:order.currency};}
export interface FinanceTransaction {id:string;sourceId:string|null;currency:string;amountMinor:string;feeMinor:string;netMinor:string;createdAt:string;category:string}
export interface FinanceCharge {id:string;paymentIntentId:string|null;currency:string;capturedMinor:string;paid:boolean;transactionId:string|null}
export interface FinanceRefund extends RefundSnapshot {transactionId:string|null;failureTransactionId:string|null}
export interface FinanceDispute {id:string;chargeId:string;paymentIntentId:string|null;currency:string;amountMinor:string;status:string;transactionIds:string[]}
/** Only normalized money/resource facts; no Stripe customer, evidence, address or card data. */
export interface FinanceSnapshot {charges:FinanceCharge[];refunds:FinanceRefund[];disputes:FinanceDispute[];transactions:FinanceTransaction[]}
export interface FinanceNotice {event:PaymentEvent;resources:string[]}
export interface FinanceClaim {order:FinanceOrder;generation:string;watermark:string;startedAt:string;leaseUntil:string}
export interface FinanceRevision {orderReference:string;generation:string;watermark:string;startedAt:string;recordedAt:string;digest:string;snapshot:FinanceSnapshot;dirty:boolean}
export interface FinanceJob {orderReference:string;generation:string;watermark:string;leaseUntil:string;nextAt:string;attempts:number;status:'pending'|'reading'|'verified'|'review'}
export interface PaymentFinance {
  observe(notice:FinanceNotice):Promise<void>;
  pending(now?:string,limit?:number):Promise<string[]>;
  claim(reference:string,force?:boolean):Promise<FinanceClaim|null>;
  finish(claim:FinanceClaim,snapshot:FinanceSnapshot):Promise<boolean>;
  defer(claim:FinanceClaim):Promise<void>;
  inspect(reference:string):Promise<{job:FinanceJob|null;revision:FinanceRevision|null}>;
}
export const financeResource=(s:unknown):s is string=>typeof s==='string'&&/^(?:cs|pi|ch|re|du|dp)_[A-Za-z0-9_]{1,160}$/.test(s);
export function validateFinanceNotice(notice:FinanceNotice) {
  validateEvent(notice.event);
  if(!Array.isArray(notice.resources)||!notice.resources.length||notice.resources.length>4||notice.resources.some(r=>!financeResource(r))||!notice.resources.includes(notice.event.resourceId))throw new Error('Invalid finance notice');
}
export function financeResources(order:FinanceOrder,snapshot?:FinanceSnapshot):string[] {
  return [...new Set([order.reference,order.paymentIntentId,order.chargeId,...(snapshot?.charges.map(c=>c.id)??[]),...(snapshot?.refunds.map(r=>r.id)??[]),...(snapshot?.disputes.map(d=>d.id)??[]),...(snapshot?.transactions.map(t=>t.id)??[])].filter((r):r is string=>r!==null))];
}
const integer=(s:unknown,signed=false)=>typeof s==='string'&&(signed?/^-?(?:0|[1-9]\d{0,18})$/:/^(?:0|[1-9]\d{0,18})$/).test(s);
const currency=(s:unknown)=>typeof s==='string'&&/^[A-Z]{3}$/.test(s);
const txID=(s:unknown):s is string=>typeof s==='string'&&/^txn_[A-Za-z0-9_]{1,160}$/.test(s);
const nullableTx=(s:unknown)=>s===null||txID(s);
export function validateFinanceSnapshot(order:FinanceOrder,s:FinanceSnapshot):void {
  if(!s||!Array.isArray(s.charges)||!Array.isArray(s.refunds)||!Array.isArray(s.disputes)||!Array.isArray(s.transactions)||
    s.charges.length<1||s.charges.length>100||s.refunds.length>100||s.disputes.length>100||s.transactions.length>500)throw new Error('Invalid finance resource set');
  const identities=new Set<string>(),transactions=new Map<string,FinanceTransaction>();
  const unique=(id:string)=>{if(identities.has(id))throw new Error('Duplicate finance resource');identities.add(id);};
  let captured=0n;
  for(const c of s.charges){
    if(!/^ch_[A-Za-z0-9_]{1,160}$/.test(c.id)||!currency(c.currency)||!integer(c.capturedMinor)||typeof c.paid!=='boolean'||!nullableTx(c.transactionId)||
      (order.paymentIntentId!==null&&c.paymentIntentId!==order.paymentIntentId)||(order.paymentIntentId===null&&c.id!==order.chargeId))throw new Error('Finance charge binding mismatch');
    unique(c.id);if(c.paid){if(c.currency!==order.currency)throw new Error('Finance charge currency mismatch');captured+=BigInt(c.capturedMinor);}
  }
  if(captured!==BigInt(order.amountMinor))throw new Error('Finance captured amount mismatch');
  const chargeIDs=new Set(s.charges.map(c=>c.id));
  for(const r of s.refunds){validateRefund(r);unique(r.id);if(!r.chargeId||!chargeIDs.has(r.chargeId)||!nullableTx(r.transactionId)||!nullableTx(r.failureTransactionId)||(r.transactionId!==null&&r.transactionId===r.failureTransactionId)||
    (r.paymentIntentId!==null&&order.paymentIntentId!==null&&r.paymentIntentId!==order.paymentIntentId))throw new Error('Finance refund binding mismatch');}
  for(const d of s.disputes){
    if(!/^(?:du|dp)_[A-Za-z0-9_]{1,160}$/.test(d.id)||!chargeIDs.has(d.chargeId)||!currency(d.currency)||!integer(d.amountMinor)||
      !['warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented'].includes(d.status)||
      !Array.isArray(d.transactionIds)||d.transactionIds.length>10||d.transactionIds.some(id=>!txID(id))||new Set(d.transactionIds).size!==d.transactionIds.length||
      (d.paymentIntentId!==null&&order.paymentIntentId!==null&&d.paymentIntentId!==order.paymentIntentId))throw new Error('Invalid finance dispute');
    unique(d.id);
  }
  for(const t of s.transactions){
    if(!txID(t.id)||transactions.has(t.id)||!currency(t.currency)||!integer(t.amountMinor,true)||!integer(t.feeMinor,true)||!integer(t.netMinor,true)||
      BigInt(t.amountMinor)-BigInt(t.feeMinor)!==BigInt(t.netMinor)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t.createdAt)||!Number.isFinite(Date.parse(t.createdAt))||
      typeof t.category!=='string'||!/^[a-z_]{1,80}$/.test(t.category)||(t.sourceId!==null&&!financeResource(t.sourceId)))throw new Error('Invalid balance transaction');
    transactions.set(t.id,t);
  }
  const referenced=new Map<string,string>();
  const bind=(id:string|null,resource:string,charge:string)=>{if(id===null)return;const t=transactions.get(id);
    if(!t||(t.sourceId!==null&&t.sourceId!==resource&&t.sourceId!==charge)||(referenced.has(id)&&referenced.get(id)!==resource))throw new Error('Balance transaction binding mismatch');referenced.set(id,resource);};
  for(const c of s.charges)bind(c.transactionId,c.id,c.id);
  for(const r of s.refunds){bind(r.transactionId,r.id,r.chargeId!);bind(r.failureTransactionId,r.id,r.chargeId!);}
  for(const d of s.disputes)for(const id of d.transactionIds)bind(id,d.id,d.chargeId);
  if(referenced.size!==transactions.size)throw new Error('Unbound balance transaction');
}
export function financeDigest(snapshot:FinanceSnapshot){return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');}
export function financeTotals(snapshot:FinanceSnapshot,orderCurrency:string) {
  const transactions=new Map(snapshot.transactions.map(t=>[t.id,t]));
  const fees=new Map<string,bigint>();for(const t of transactions.values())fees.set(t.currency,(fees.get(t.currency)??0n)+BigInt(t.feeMinor)-(t.category==='fee'?BigInt(t.amountMinor):0n));
  let complete=snapshot.charges.every(c=>!c.paid||c.transactionId!==null),loss=0n,disputesUnknown=false;
  for(const c of snapshot.charges){const t=c.transactionId?transactions.get(c.transactionId):undefined;if(t&&(t.category!=='charge'||(t.currency===c.currency&&BigInt(t.amountMinor)!==BigInt(c.capturedMinor))))complete=false;}
  for(const r of snapshot.refunds){
    if(r.status==='pending'||r.status==='requires_action'||(r.status==='succeeded'&&r.transactionId===null)||
      (r.status==='failed'&&r.transactionId!==null&&r.failureTransactionId===null))complete=false;
  }
  for(const d of snapshot.disputes){
    const ts=d.transactionIds.map(id=>transactions.get(id)!);
    if(!['lost','won','warning_closed','prevented'].includes(d.status))disputesUnknown=true;
    if(d.currency!==orderCurrency||ts.some(t=>t.currency!==orderCurrency))disputesUnknown=true;
    if(ts.some(t=>!['dispute','dispute_reversal','fee'].includes(t.category)))disputesUnknown=true;
    const principal=ts.filter(t=>t.category==='dispute'||t.category==='dispute_reversal');
    const withdrawn=-principal.reduce((sum,t)=>sum+BigInt(t.amountMinor),0n);
    if(d.status==='lost'){
      if(!principal.length||withdrawn<0n||d.currency!==orderCurrency||ts.some(t=>t.currency!==orderCurrency))disputesUnknown=true;
      else loss+=withdrawn;
    }else if(['won','warning_closed','prevented'].includes(d.status)&&withdrawn!==0n)disputesUnknown=true;
    if(disputesUnknown)complete=false;
  }
  return {fees:[...fees].sort(([a],[b])=>a.localeCompare(b)).map(([currency,amount])=>({currency,amountMinor:amount.toString()})),
    feesComplete:complete,disputeLossMinor:loss.toString(),disputesUnknown};
}
export async function reconcilePaymentFinance(store:PaymentFinance,reference:string,read:(order:FinanceOrder)=>Promise<FinanceSnapshot>,force=false,ledger?:PaymentLedger){
  const claim=await store.claim(reference,force);if(!claim)return false;
  try{
    const snapshot=await read(claim.order);validateFinanceSnapshot(claim.order,snapshot);
    if(ledger){
      const known=await ledger.report(100,reference),byID=new Map(known.refunds.map(r=>[r.id,r])),rechecks:PaymentEvent[]=[];
      for(const r of snapshot.refunds){const prior=byID.get(r.id);if(prior&&sameRefundIdentity(prior,r)&&prior.status===r.status)continue;
        const payloadHash=createHash('sha256').update(JSON.stringify([reference,claim.generation,r.id,r.status])).digest('hex');
        // Explicit local recheck request, not a purported signed Stripe event. The refund
        // worker claims a new generation BEFORE re-reading the current provider resource.
        rechecks.push({id:'evt_finance_'+payloadHash,type:'finance.refund.reconcile',resourceId:r.id,createdAt:null,payloadHash});
      }
      if(rechecks.length)await ledger.queueRefunds(rechecks);
    }
    return await store.finish(claim,snapshot);
  }catch{await store.defer(claim);throw new Error('Payment finance reconciliation unavailable');}
}
