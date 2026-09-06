import {stripeReference} from './stripe.ts';
import {validateFinanceSnapshot,type FinanceOrder,type FinanceSnapshot,type FinanceTransaction,type FinanceRefund,type FinanceDispute} from './payment-finance.ts';

type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Stripe finance object');return value as ObjectValue;};
const minor=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value))throw new Error('Invalid Stripe money');return String(value);};
const currency=(value:unknown)=>{if(typeof value!=='string'||!/^[a-z]{3}$/i.test(value))throw new Error('Invalid Stripe currency');return value.toUpperCase();};
const reference=(value:unknown,prefix:string)=>{const id=stripeReference(value);if(!id||!new RegExp('^'+prefix+'_[A-Za-z0-9_]{1,160}$').test(id))throw new Error('Invalid Stripe resource id');return id;};

/** Three bounded account reads share one deadline. Missing pages are never accepted as totals. */
export async function retrieveStripeFinance(key:string,order:FinanceOrder):Promise<FinanceSnapshot>{
  const controller=new AbortController(),signal=AbortSignal.any([AbortSignal.timeout(8_000),controller.signal]);
  try{
  const read=async(path:string,params:URLSearchParams)=>{
    const res=await fetch('https://api.stripe.com/v1/'+path+'?'+params,{headers:{Authorization:'Bearer '+key},signal,redirect:'error'});
    if(!res.ok||!res.body||!/^application\/json\b/i.test(res.headers.get('content-type')??'')){await res.body?.cancel();throw new Error('Stripe finance retrieval unavailable');}
    const chunks:Uint8Array[]=[];let size=0;
    for await(const chunk of res.body){size+=chunk.byteLength;if(size>1024*1024)throw new Error('Stripe finance response exceeds limit');chunks.push(chunk);}
    return object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
  };
  if(!order.paymentIntentId&&!order.chargeId)throw new Error('Order lacks Stripe resource binding');
  if(order.paymentIntentId)reference(order.paymentIntentId,'pi');else reference(order.chargeId,'ch');
  const list=async(path:string,expansions:string[])=>{
    const params=new URLSearchParams({limit:'100',[order.paymentIntentId?'payment_intent':'charge']:order.paymentIntentId??order.chargeId!});
    for(const value of expansions)params.append('expand[]',value);
    const result=await read(path,params);
    if(result.object!=='list'||result.has_more!==false||!Array.isArray(result.data)||result.data.length>100)throw new Error('Stripe finance list incomplete');
    return result.data.map(object);
  };
  const [charges,refunds,disputes]=await Promise.all([
    order.paymentIntentId?list('charges',['data.balance_transaction']):read('charges/'+encodeURIComponent(order.chargeId!),new URLSearchParams({'expand[]':'balance_transaction'})).then(c=>[c]),
    list('refunds',['data.balance_transaction','data.failure_balance_transaction']),list('disputes',[]),
  ]);
  const transactions=new Map<string,FinanceTransaction>();
  const balance=(raw:unknown):string|null=>{
    if(raw===null)return null;
    const b=object(raw),id=reference(b.id,'txn');
    if(b.object!=='balance_transaction'||typeof b.created!=='number'||!Number.isSafeInteger(b.created)||b.created<0||b.created>8_640_000_000_000)throw new Error('Invalid Stripe balance transaction');
    const value:FinanceTransaction={id,sourceId:b.source===null?null:stripeReference(b.source),currency:currency(b.currency),amountMinor:minor(b.amount),feeMinor:minor(b.fee),netMinor:minor(b.net),
      createdAt:new Date(b.created*1000).toISOString(),category:typeof b.reporting_category==='string'?b.reporting_category:''};
    if(b.source!==null&&value.sourceId===null)throw new Error('Stripe transaction source missing');
    const old=transactions.get(id);if(old&&JSON.stringify(old)!==JSON.stringify(value))throw new Error('Conflicting balance transaction');transactions.set(id,value);return id;
  };
  const snapshot:FinanceSnapshot={charges:charges.map(c=>{
    if(c.object!=='charge'||typeof c.paid!=='boolean')throw new Error('Invalid Stripe charge');
    return {id:reference(c.id,'ch'),paymentIntentId:c.payment_intent===null?null:reference(c.payment_intent,'pi'),currency:currency(c.currency),capturedMinor:minor(c.amount_captured),paid:c.paid,transactionId:balance(c.balance_transaction)};
  }),refunds:refunds.map(r=>{
    if(r.object!=='refund')throw new Error('Invalid Stripe refund');
    return {id:reference(r.id,'re'),paymentIntentId:r.payment_intent===null?null:reference(r.payment_intent,'pi'),chargeId:reference(r.charge,'ch'),amountCents:Number(minor(r.amount)),currency:currency(r.currency),
      status:r.status as FinanceRefund['status'],transactionId:balance(r.balance_transaction),failureTransactionId:balance(r.failure_balance_transaction??null)};
  }),disputes:disputes.map(d=>{
    if(d.object!=='dispute'||!Array.isArray(d.balance_transactions)||d.balance_transactions.length>10)throw new Error('Invalid Stripe dispute');
    return {id:reference(d.id,'(?:du|dp)'),chargeId:reference(d.charge,'ch'),paymentIntentId:d.payment_intent===null?null:reference(d.payment_intent,'pi'),currency:currency(d.currency),amountMinor:minor(d.amount),
      status:d.status as FinanceDispute['status'],transactionIds:d.balance_transactions.map(b=>{const id=balance(b);if(!id)throw new Error('Missing dispute transaction');return id;})};
  }),transactions:[]};
  snapshot.transactions=[...transactions.values()].sort((a,b)=>a.id.localeCompare(b.id));
  for(const values of [snapshot.charges,snapshot.refunds,snapshot.disputes])values.sort((a,b)=>a.id.localeCompare(b.id));
  validateFinanceSnapshot(order,snapshot);return snapshot;
  }finally{controller.abort();}
}
