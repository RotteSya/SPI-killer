import {createHash} from 'node:crypto';
import {hashToken,type StoredPurchaseSession} from './db.ts';
import type {PaidOrderInput,PaymentEvent,PaymentOrder} from './payment-ledger.ts';
import {isValidTokenShape} from './payments.ts';

export interface CheckoutSnapshot {
  id:string;mode:'payment'|'subscription'|'setup'|'unknown';paymentStatus:'paid'|'unpaid'|'no_payment_required'|'unknown';
  amountCents:number|null;currency:string|null;paymentIntentId:string|null;
  purchaseSessionId:string|null;packId:string|null;deviceTokenHash:string|null;metadataInvalid:boolean;
}
const checkoutID=/^cs_[A-Za-z0-9_]{1,160}$/,uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const identifier=/^[A-Za-z0-9_.:-]{1,100}$/;
export function checkoutSnapshot(raw:unknown):CheckoutSnapshot {
  const b=(raw&&typeof raw==='object'?raw:{}) as Record<string,unknown>;
  if(typeof b.id!=='string'||!checkoutID.test(b.id))throw new Error('Invalid Checkout reference');
  const metadata=(b.metadata&&typeof b.metadata==='object'&&!Array.isArray(b.metadata)?b.metadata:{}) as Record<string,unknown>;
  const purchase=metadata.purchase_session_id,pack=metadata.pack_id,token=metadata.device_token;
  const pi=typeof b.payment_intent==='string'?b.payment_intent:(b.payment_intent as {id?:unknown}|null)?.id;
  return {id:b.id,mode:typeof b.mode==='string'&&['payment','subscription','setup'].includes(b.mode)?b.mode as CheckoutSnapshot['mode']:'unknown',
    paymentStatus:typeof b.payment_status==='string'&&['paid','unpaid','no_payment_required'].includes(b.payment_status)?b.payment_status as CheckoutSnapshot['paymentStatus']:'unknown',
    amountCents:typeof b.amount_total==='number'&&Number.isSafeInteger(b.amount_total)&&b.amount_total>=0?b.amount_total:null,
    currency:typeof b.currency==='string'&&/^[a-z]{3}$/i.test(b.currency)?b.currency.toUpperCase():null,
    paymentIntentId:typeof pi==='string'&&/^pi_[A-Za-z0-9_]{1,160}$/.test(pi)?pi:null,
    purchaseSessionId:typeof purchase==='string'&&uuid.test(purchase)?purchase.toLowerCase():null,
    packId:typeof pack==='string'&&identifier.test(pack)?pack:null,
    deviceTokenHash:typeof token==='string'&&isValidTokenShape(token)?hashToken(token):null,
    metadataInvalid:(b.metadata!==undefined&&b.metadata!==null&&(typeof b.metadata!=='object'||Array.isArray(b.metadata)))||
      (purchase!==undefined&&!(typeof purchase==='string'&&uuid.test(purchase)))||
      (pack!==undefined&&!(typeof pack==='string'&&identifier.test(pack)))||
      (token!==undefined&&!(typeof token==='string'&&isValidTokenShape(token)))};
}
export function validateCheckoutSnapshot(s:CheckoutSnapshot):void {
  if(Object.keys(s).sort().join(',')!==['id','mode','paymentStatus','amountCents','currency','paymentIntentId','purchaseSessionId','packId','deviceTokenHash','metadataInvalid'].sort().join(','))throw new Error('Invalid Checkout evidence fields');
  if(typeof s.id!=='string'||!checkoutID.test(s.id)||!['payment','subscription','setup','unknown'].includes(s.mode)||
    !['paid','unpaid','no_payment_required','unknown'].includes(s.paymentStatus)||
    (s.amountCents!==null&&(!Number.isSafeInteger(s.amountCents)||s.amountCents<0))||
    (s.currency!==null&&(typeof s.currency!=='string'||!/^[A-Z]{3}$/.test(s.currency)))||
    (s.paymentIntentId!==null&&(typeof s.paymentIntentId!=='string'||!/^pi_[A-Za-z0-9_]{1,160}$/.test(s.paymentIntentId)))||
    (s.purchaseSessionId!==null&&(typeof s.purchaseSessionId!=='string'||!uuid.test(s.purchaseSessionId)))||
    (s.packId!==null&&(typeof s.packId!=='string'||!identifier.test(s.packId)))||
    (s.deviceTokenHash!==null&&(typeof s.deviceTokenHash!=='string'||!/^[a-f0-9]{64}$/.test(s.deviceTokenHash)))||typeof s.metadataInvalid!=='boolean')throw new Error('Invalid Checkout evidence');
}
export const checkoutSnapshotHash=(s:CheckoutSnapshot)=>createHash('sha256').update(JSON.stringify([
  s.id,s.mode,s.paymentStatus,s.amountCents,s.currency,s.paymentIntentId,s.purchaseSessionId,s.packId,s.deviceTokenHash,s.metadataInvalid])).digest('hex');
export type CheckoutReason='metadata_invalid'|'unsupported_mode'|'not_paid'|'financial_mismatch'|'purchase_missing'|'purchase_mismatch'|
  'device_missing'|'catalog_mismatch'|'conflicting_events'|'provider_unavailable'|'order_conflict'|'review_changed';
export interface CheckoutDecision {
  reference:string;fingerprint:string;evidenceSha256:string;deviceId:number;questions:number;packId:string;catalogVersion:string;
}
export interface CheckoutCase {
  reference:string;event:PaymentEvent;signed:CheckoutSnapshot;observed:CheckoutSnapshot|null;
  observationSource:'signed_event'|'stripe_api'|null;conflictingEvents:boolean;
  state:'queued'|'processing'|'review'|'credited';reason:CheckoutReason|null;generation:string;attempts:number;
  retryAfter:string|null;createdAt:string;updatedAt:string;resolvedDeviceId:number|null;decision:(CheckoutDecision&{appliedAt:string})|null;
}
export const checkoutFingerprint=(c:CheckoutCase)=>createHash('sha256').update(JSON.stringify([
  c.reference,checkoutSnapshotHash(c.signed),c.observed?checkoutSnapshotHash(c.observed):null,c.observationSource,c.conflictingEvents,c.reason,c.resolvedDeviceId,c.decision,
])).digest('hex');
export function checkoutCaseWire(c:CheckoutCase) {
  const redact=(s:CheckoutSnapshot|null)=>{if(!s)return null;const {deviceTokenHash,...rest}=s;return {...rest,deviceIdentityPresent:deviceTokenHash!==null,amountCents:s.amountCents===null?null:String(s.amountCents)};};
  return {...c,signed:redact(c.signed),observed:redact(c.observed),fingerprint:checkoutFingerprint(c)};
}
export interface CheckoutClaim {reference:string;generation:string;event:PaymentEvent;signed:CheckoutSnapshot}
export interface CheckoutCatalog {currency:string;version:string;packs:Array<{id:string;questions:number;amountCents:number}>}
export interface CheckoutContext {
  purchase:StoredPurchaseSession|null;checkoutOwner:string|null;deviceId:number|null;originalDeviceId:number|null;manualDeviceExists:boolean;order:PaymentOrder|null;
  paymentOwner:string|null;topup:{deviceId:number;questions:number;amountCents:number;currency:string}|null;
}
export interface CheckoutQuery {state?:CheckoutCase['state'];before?:string;limit:number}
export interface CheckoutQueue {
  receive(event:PaymentEvent,snapshot:CheckoutSnapshot):Promise<void>;
  claim(reference:string,interactive?:boolean):Promise<CheckoutClaim|null>;
  finish(claim:CheckoutClaim,snapshot:CheckoutSnapshot,source:'signed_event'|'stripe_api',catalog:CheckoutCatalog,decision?:CheckoutDecision):Promise<'credited'|'review'|'stale'|'conflict'>;
  defer(claim:CheckoutClaim):Promise<void>;
  pending(now?:string,limit?:number):Promise<string[]>;
  get(reference:string):Promise<CheckoutCase|null>;
  list(query:CheckoutQuery):Promise<{items:CheckoutCase[];next:string|null}>;
}
export function validateCheckoutQuery(q:CheckoutQuery):void {
  if(!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>100||(q.before!==undefined&&(typeof q.before!=='string'||!checkoutID.test(q.before)))||
    (q.state!==undefined&&!['queued','processing','review','credited'].includes(q.state)))throw new Error('Invalid Checkout query');
}
export function validateCheckoutDecision(d:CheckoutDecision):void {
  if(![d.reference,d.packId,d.catalogVersion,d.fingerprint,d.evidenceSha256].every(v=>typeof v==='string')||
    !identifier.test(d.reference)||!identifier.test(d.packId)||!identifier.test(d.catalogVersion)||! /^[a-f0-9]{64}$/.test(d.fingerprint)||
    ! /^[a-f0-9]{64}$/.test(d.evidenceSha256)||!Number.isSafeInteger(d.deviceId)||d.deviceId<1||!Number.isSafeInteger(d.questions)||d.questions<1||d.questions>1_000_000)throw new Error('Invalid Checkout decision');
}
export function sameCheckoutDecision(a:CheckoutDecision,b:CheckoutDecision):boolean {
  return a.reference===b.reference&&a.fingerprint===b.fingerprint&&a.evidenceSha256===b.evidenceSha256&&a.deviceId===b.deviceId&&
    a.questions===b.questions&&a.packId===b.packId&&a.catalogVersion===b.catalogVersion;
}
export function evaluateCheckout(c:CheckoutCase,s:CheckoutSnapshot,catalog:CheckoutCatalog,context:CheckoutContext,decision?:CheckoutDecision):{reason:CheckoutReason}|{order:PaidOrderInput;linkPurchase:boolean} {
  const grant=(order:PaidOrderInput,linkPurchase:boolean):{reason:CheckoutReason}|{order:PaidOrderInput;linkPurchase:boolean}=>{
    const old=context.topup;
    if(old&&(old.deviceId!==order.deviceId||old.questions!==order.questions||old.amountCents!==order.amountCents||old.currency.toUpperCase()!==order.currency))return {reason:'order_conflict'};
    return {order,linkPurchase};
  };
  const original=c.signed;
  if(s.mode!=='payment'||(original.mode!=='unknown'&&original.mode!==s.mode))return {reason:'unsupported_mode'};
  if(s.paymentStatus!=='paid'||!s.amountCents||!s.currency)return {reason:'not_paid'};
  if(s.id!==c.reference||(original.amountCents!==null&&original.amountCents!==s.amountCents)||(original.currency!==null&&original.currency!==s.currency)||
    (original.paymentIntentId!==null&&original.paymentIntentId!==s.paymentIntentId))return {reason:'financial_mismatch'};
  if((original.purchaseSessionId!==null&&original.purchaseSessionId!==s.purchaseSessionId)||
    (context.checkoutOwner!==null&&context.checkoutOwner!==s.purchaseSessionId))return {reason:'purchase_mismatch'};
  if(context.originalDeviceId!==null&&((decision&&decision.deviceId!==context.originalDeviceId)||
    (context.deviceId!==null&&context.deviceId!==context.originalDeviceId)||
    (context.purchase&&context.purchase.deviceId!==context.originalDeviceId)))return {reason:'device_missing'};
  if(!decision&&(c.conflictingEvents||original.purchaseSessionId!==s.purchaseSessionId||original.packId!==s.packId||original.deviceTokenHash!==s.deviceTokenHash))return {reason:'conflicting_events'};
  if(!decision&&(s.metadataInvalid||original.metadataInvalid))return {reason:'metadata_invalid'};
  if(context.paymentOwner!==null&&context.paymentOwner!==s.id)return {reason:'order_conflict'};
  const existing=context.order;
  if(existing){
    if(existing.amountCents!==s.amountCents||existing.currency!==s.currency||(existing.paymentIntentId!==null&&existing.paymentIntentId!==s.paymentIntentId)||
      (!decision&&context.deviceId!==null&&context.deviceId!==existing.deviceId)||
      (decision&&(decision.deviceId!==existing.deviceId||decision.questions!==existing.questions||decision.packId!==existing.packId||decision.catalogVersion!==existing.catalogVersion)))return {reason:'order_conflict'};
    const {policy:_policy,decision:_decision,quotaAttribution:_attribution,...order}=existing;
    if(s.purchaseSessionId||existing.purchaseSessionId){
      const purchase=context.purchase;
      if(!purchase||purchase.sessionId!==s.purchaseSessionId||purchase.deviceId!==existing.deviceId||purchase.amountCents!==existing.amountCents||
        purchase.questions!==existing.questions||purchase.currency!==existing.currency||purchase.packId!==existing.packId||purchase.catalogVersion!==existing.catalogVersion||
        (purchase.checkoutSessionId!==null&&purchase.checkoutSessionId!==s.id)||(context.checkoutOwner!==null&&context.checkoutOwner!==purchase.sessionId))return {reason:'purchase_mismatch'};
      return grant({...order,purchaseSessionId:purchase.sessionId},purchase.checkoutSessionId===null);
    }
    return grant(order,false);
  }
  const purchase=context.purchase;
  if(s.purchaseSessionId&&purchase){
    if((purchase.checkoutSessionId!==null&&purchase.checkoutSessionId!==s.id)||(context.checkoutOwner!==null&&context.checkoutOwner!==purchase.sessionId)||
      purchase.consumedAt||purchase.amountCents!==s.amountCents||purchase.currency!==s.currency||s.packId!==purchase.packId||
      (decision&&(decision.deviceId!==purchase.deviceId||decision.questions!==purchase.questions||decision.packId!==purchase.packId||decision.catalogVersion!==purchase.catalogVersion)))return {reason:'purchase_mismatch'};
    return grant({reference:s.id,purchaseSessionId:purchase.sessionId,deviceId:purchase.deviceId,paymentIntentId:s.paymentIntentId,chargeId:null,
      questions:purchase.questions,amountCents:s.amountCents,currency:s.currency,packId:purchase.packId,catalogVersion:purchase.catalogVersion,
      paidAt:c.event.createdAt??c.createdAt},purchase.checkoutSessionId===null);
  }
  if(decision){
    if(!context.manualDeviceExists||(context.deviceId!==null&&context.deviceId!==decision.deviceId))return {reason:'device_missing'};
    return grant({reference:s.id,deviceId:decision.deviceId,paymentIntentId:s.paymentIntentId,chargeId:null,questions:decision.questions,
      amountCents:s.amountCents,currency:s.currency,packId:decision.packId,catalogVersion:decision.catalogVersion,paidAt:c.event.createdAt??c.createdAt},false);
  }
  if(s.purchaseSessionId)return {reason:'purchase_missing'};
  if(context.deviceId===null)return {reason:'device_missing'};
  const pack=catalog.packs.find(p=>p.id===s.packId);
  if(!pack||catalog.currency!==s.currency||pack.amountCents!==s.amountCents)return {reason:'catalog_mismatch'};
  return grant({reference:s.id,deviceId:context.deviceId,paymentIntentId:s.paymentIntentId,chargeId:null,questions:pack.questions,
    amountCents:s.amountCents,currency:s.currency,packId:pack.id,catalogVersion:'legacy-catalog',paidAt:c.event.createdAt??c.createdAt},false);
}

export function checkoutDecisionCurrent(c:CheckoutCase,s:CheckoutSnapshot,source:string,d:CheckoutDecision):boolean {
  return source==='stripe_api'&&c.observationSource==='stripe_api'&&!!c.observed&&
    checkoutSnapshotHash(c.observed)===checkoutSnapshotHash(s)&&checkoutFingerprint(c)===d.fingerprint;
}
export function checkoutReview(c:CheckoutCase,reason:CheckoutReason):void {
  c.reason=reason;c.updatedAt=new Date().toISOString();
  c.state=['purchase_missing','device_missing','provider_unavailable'].includes(reason)&&c.attempts<5?'queued':'review';
  c.retryAfter=c.state==='queued'?new Date(Date.now()+60_000).toISOString():null;
}
