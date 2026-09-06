import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutSession, retrieveStripeRefund, retrieveStripeCheckout } from '../src/stripe.ts';

test('refund retrieval is read-only, bounded and normalizes expanded provider references',async()=>{
  const request=mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
    assert.equal(url,'https://api.stripe.com/v1/refunds/re_transport');
    assert.equal(init?.method??'GET','GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    return Response.json({id:'re_transport',amount:800,currency:'cny',status:'requires_action',
      payment_intent:{id:'pi_transport'},charge:'ch_transport'});
  });
  try {
    assert.deepEqual(await retrieveStripeRefund('test_transport_credential','re_transport'),{
      id:'re_transport',amountCents:800,currency:'CNY',status:'requires_action',paymentIntentId:'pi_transport',chargeId:'ch_transport',
    });
  }finally{request.mock.restore();}
});

test('Checkout retrieval uses a bounded read-only request and returns only the reconciliation allowlist',async()=>{
  let response=Response.json({id:'cs_transport',mode:'payment',payment_status:'paid',amount_total:800,currency:'cny',payment_intent:{id:'pi_transport'},
    metadata:{device_token:'dev_private_bearer',pack_id:'small',question:'private'},customer_email:'private@example.invalid'});
  const request=mock.method(globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
    assert.equal(url,'https://api.stripe.com/v1/checkout/sessions/cs_transport');assert.equal(init?.method??'GET','GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);return response;
  });
  try{
    const snapshot=await retrieveStripeCheckout('test_transport_credential','cs_transport');assert.equal(snapshot.paymentIntentId,'pi_transport');assert.equal(snapshot.amountCents,800);
    assert.doesNotMatch(JSON.stringify(snapshot),/dev_private|question|customer_email|private@example/);
    response=Response.json({id:'cs_different'});await assert.rejects(retrieveStripeCheckout('test_transport_credential','cs_transport'),/resource mismatch/);
    response=new Response('x'.repeat(256*1024+1));await assert.rejects(retrieveStripeCheckout('test_transport_credential','cs_transport'),/exceeds limit/);
    response=new Response('private provider error',{status:503});await assert.rejects(retrieveStripeCheckout('test_transport_credential','cs_transport'),/unavailable/);
    const count=request.mock.calls.length;await assert.rejects(retrieveStripeCheckout('test_transport_credential','../secret'));assert.equal(request.mock.calls.length,count);
  }finally{request.mock.restore();}
});
test('refund retrieval rejects malformed or mismatched resources without applying guessed state',async()=>{
  let body:unknown={id:'re_another',amount:800,currency:'cny',status:'succeeded',charge:'ch_transport'};
  const request=mock.method(globalThis,'fetch',async()=>Response.json(body));
  try {
    await assert.rejects(retrieveStripeRefund('test_transport_credential','re_transport'),/resource mismatch/);
    body={id:'re_transport',amount:'800',currency:'cny',status:'succeeded',charge:'ch_transport'};
    await assert.rejects(retrieveStripeRefund('test_transport_credential','re_transport'),/Invalid refund/);
    body={id:'re_transport',amount:800,currency:'cny',status:['succeeded'],charge:'ch_transport'};
    await assert.rejects(retrieveStripeRefund('test_transport_credential','re_transport'),/Invalid refund/);
    await assert.rejects(retrieveStripeRefund('test_transport_credential','../../secrets'),/Invalid refund id/);
  }finally{request.mock.restore();}
});
test('checkout retries retain their idempotency key and do not expose provider errors or unsafe URLs',async()=>{
  const input={pack:{id:'pack',questions:10,amountCents:800},purchaseSessionId:'purchase_transport',currency:'CNY',publicBaseURL:'https://notch.example',lang:'zh' as const};
  const bodies:string[]=[],keys:string[]=[];
  let result=new Response(JSON.stringify({id:'cs_transport',url:'https://checkout.stripe.com/c/pay/cs_transport'}),{status:200});
  const request=mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
    keys.push(new Headers(init?.headers).get('Idempotency-Key')??'');bodies.push(String(init?.body));
    assert.ok(init?.signal);assert.equal(init?.redirect,'error');return result.clone();
  });
  try {
    assert.deepEqual(await createCheckoutSession('test_transport_credential',input),{id:'cs_transport',url:'https://checkout.stripe.com/c/pay/cs_transport'});
    await createCheckoutSession('test_transport_credential',input);
    assert.equal(keys[0],keys[1]);assert.equal(bodies[0],bodies[1]);assert.ok(keys[0]);
    result=Response.json({error:{message:'private vendor detail'}},{status:401});
    assert.deepEqual(await createCheckoutSession('test_transport_credential',input),{error:'stripe_http_401'});
    result=Response.json({id:'cs_transport',url:'javascript:alert(1)'});
    assert.deepEqual(await createCheckoutSession('test_transport_credential',input),{error:'stripe_invalid_redirect'});
  }finally{request.mock.restore();}
});
