import {createHash} from 'node:crypto';
import type {PurchaseSession,PurchaseSessionInput,StoredPurchaseSession} from './db.ts';
import type {PaidOrderInput} from './payment-ledger.ts';

export const purchaseSecretHash=(secret:string)=>createHash('sha256').update(secret).digest('hex');
export function validatePurchase(input:PurchaseSessionInput):void {
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(input.purchaseId)||!Number.isSafeInteger(input.questions)||input.questions<=0||
    !Number.isSafeInteger(input.amountCents)||input.amountCents<=0||! /^[A-Z]{3}$/.test(input.currency)||
    !['zh','ja','en'].includes(input.lang)||![input.packId,input.catalogVersion].every(s=>/^[A-Za-z0-9_.:-]{1,100}$/.test(s)))throw new Error('Invalid purchase snapshot');
}
export function reusablePurchase(s:StoredPurchaseSession,input:PurchaseSessionInput,now=Date.now()):boolean {
  return !s.consumedAt&&Date.parse(s.expiresAt)>now&&s.packId===input.packId&&s.catalogVersion===input.catalogVersion&&
    s.questions===input.questions&&s.amountCents===input.amountCents&&s.currency===input.currency&&s.lang===input.lang;
}
export function purchaseHandoff(s:StoredPurchaseSession,secret:string):PurchaseSession {
  const {secretHash:_hash,purchaseId:_purchase,deviceToken:_token,...publicFields}=s;return {...publicFields,secret};
}
export function validateCheckoutAttachment(id:string,url?:string):void {
  if(! /^cs_[A-Za-z0-9_]{1,160}$/.test(id))throw new Error('Invalid Checkout identity');
  if(url!==undefined){const parsed=new URL(url);if(url.length>4096||parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('Invalid Checkout redirect');}
}
export function validatePurchaseOrder(s:StoredPurchaseSession|null,order:PaidOrderInput,deviceId:number):void {
  if(!s||s.deviceId!==deviceId||s.sessionId!==order.purchaseSessionId||s.checkoutSessionId!==order.reference||
    s.questions!==order.questions||s.amountCents!==order.amountCents||s.currency!==order.currency||s.packId!==order.packId||
    s.catalogVersion!==order.catalogVersion)throw new Error('Paid purchase snapshot mismatch');
  // An already-created Checkout may settle after the browser handoff has expired.
}
