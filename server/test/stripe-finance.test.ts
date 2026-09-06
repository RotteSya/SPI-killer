import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retrieveStripeFinance} from '../src/stripe-finance.ts';
import {financeTotals,type FinanceOrder} from '../src/payment-finance.ts';

const order:FinanceOrder={reference:'cs_transport',deviceId:1,paymentIntentId:'pi_transport',chargeId:null,amountMinor:'1000',currency:'USD'};
const transaction=(id='txn_transport',amount=1000,fee=30,category='charge',source='ch_transport')=>({id,object:'balance_transaction',currency:'usd',amount,fee,net:amount-fee,created:1000,reporting_category:category,source});
const charge=()=>({id:'ch_transport',object:'charge',paid:true,amount_captured:1000,currency:'usd',payment_intent:{id:'pi_transport'},balance_transaction:transaction(),billing_details:{name:'PRIVATE_CUSTOMER'},metadata:{device_token:'PRIVATE_TOKEN'}});
const list=(data:unknown[])=>({object:'list',has_more:false,data});
test('Stripe finance uses only bounded GETs, freezes normalized resources and excludes customer/evidence contents',async t=>{
  const calls:Array<{url:URL;init?:RequestInit}>=[];
  t.mock.method(globalThis,'fetch',async(raw:unknown,init?:RequestInit)=>{const url=new URL(String(raw));calls.push({url,init});
    if(url.pathname==='/v1/charges')return Response.json(list([charge()]));
    if(url.pathname==='/v1/refunds')return Response.json(list([]));
    return Response.json(list([{id:'du_transport',object:'dispute',amount:1000,currency:'usd',charge:{id:'ch_transport'},payment_intent:'pi_transport',status:'lost',evidence:{customer_name:'PRIVATE_EVIDENCE'},balance_transactions:[transaction('txn_dispute',-1000,1500,'dispute','du_transport')]}]));
  });
  const snapshot=await retrieveStripeFinance('test_credential_only',order);
  assert.equal(calls.length,3);for(const {url,init} of calls){assert.equal(url.origin,'https://api.stripe.com');assert.equal(url.searchParams.get('payment_intent'),'pi_transport');assert.equal(url.searchParams.get('limit'),'100');assert.equal(init?.method??'GET','GET');assert.equal(init?.redirect,'error');assert.equal(init?.signal?.aborted,true);}
  assert.deepEqual(calls[0]!.url.searchParams.getAll('expand[]'),['data.balance_transaction']);
  assert.deepEqual(calls[1]!.url.searchParams.getAll('expand[]'),['data.balance_transaction','data.failure_balance_transaction']);
  assert.equal(financeTotals(snapshot,'USD').fees[0]!.amountMinor,'1530');assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE|billing|evidence|metadata|token/i);
});
test('Stripe finance rejects partial pages, binding and amount drift, bad JSON, oversized bodies and non-JSON failures',async t=>{
  let mode='partial';const signals:AbortSignal[]=[];
  t.mock.method(globalThis,'fetch',async(raw:unknown,init?:RequestInit)=>{if(init?.signal)signals.push(init.signal);const path=new URL(String(raw)).pathname;
    if(path!=='/v1/charges')return Response.json(list([]));
    if(mode==='partial')return Response.json({...list([charge()]),has_more:true});
    if(mode==='amount')return Response.json(list([{...charge(),amount_captured:999}]));
    if(mode==='binding')return Response.json(list([{...charge(),payment_intent:'pi_other'}]));
    if(mode==='oversized')return new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'application/json'}});
    if(mode==='utf8')return new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}});
    if(mode==='json')return new Response('{invalid',{headers:{'content-type':'application/json'}});
    return new Response('private failure',{status:403});
  });
  for(const value of ['partial','amount','binding','oversized','utf8','json','failure']){mode=value;await assert.rejects(retrieveStripeFinance('test_credential_only',order));assert.ok(signals.every(s=>s.aborted));}
  const count=signals.length;await assert.rejects(retrieveStripeFinance('test_credential_only',{...order,paymentIntentId:'../private'}));assert.equal(signals.length,count);
});
test('Stripe finance reads charge-bound legacy orders and captures refund reversal fees exactly once',async t=>{
  const reverse=transaction('txn_failure',200,-2,'refund_failure','re_transport');
  t.mock.method(globalThis,'fetch',async(raw:unknown)=>{const url=new URL(String(raw));
    if(url.pathname==='/v1/charges/ch_transport')return Response.json(charge());
    assert.equal(url.searchParams.get('charge'),'ch_transport');assert.equal(url.searchParams.has('payment_intent'),false);
    if(url.pathname==='/v1/disputes')return Response.json(list([]));
    return Response.json(list([{id:'re_transport',object:'refund',amount:200,currency:'usd',status:'failed',charge:'ch_transport',payment_intent:'pi_transport',balance_transaction:transaction('txn_refund',-200,2,'refund','re_transport'),failure_balance_transaction:reverse}]));
  });
  const snapshot=await retrieveStripeFinance('test_credential_only',{...order,paymentIntentId:null,chargeId:'ch_transport'});assert.equal(snapshot.refunds[0]!.status,'failed');assert.equal(financeTotals(snapshot,'USD').fees[0]!.amountMinor,'30');
});
