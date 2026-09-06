import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RefundSnapshot, PaymentReportWire } from '../src/payment-ledger.ts';
import {checkoutSnapshot,type CheckoutSnapshot} from '../src/checkout-reconciliation.ts';

// Stripe-mode app: in-memory DB + mock provider + fake Stripe credentials. The webhook path
// is fully testable offline because signatures are just HMACs we can compute ourselves.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.QUOTA_POLICY_VERSION = 'legacy-test';
process.env.TRIAL_QUESTIONS = '0';
process.env.TRIAL_MIN_QUESTIONS = '0'; // pin min===max so the trial grant is deterministic (0)
process.env.TRIAL_MAX_QUESTIONS = '0';
process.env.CURRENCY = 'CNY'; // pin: the webhook amount/currency cross-check must match the fixture
process.env.PACKS_JSON = JSON.stringify([{ id: 'pack300', questions: 300, amount_cents: 2400 }]);
process.env.STRIPE_SECRET_KEY = 'rk_test_fake_key_for_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.ALLOW_STUB_TOPUP = '0';
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_TOKEN = 'stripe_test_admin';

const { buildApp } = await import('../src/index.ts');
const { verifyStripeSignature, buildCheckoutParams } = await import('../src/stripe.ts');

let app: FastifyInstance;
let base: string;
const refundSnapshots=new Map<string,RefundSnapshot>();
let refundReads=0;
const checkouts=new Map<string,{id:string;url:string}>(),checkoutReads=new Map<string,number>();
const checkoutFailures=new Set<string>();
const currentCheckouts=new Map<string,CheckoutSnapshot>();let canonicalCheckoutReads=0;

before(async () => {
  app = await buildApp({readStripeCheckout:async id=>{canonicalCheckoutReads++;const snapshot=currentCheckouts.get(id);if(!snapshot)throw new Error('Injected Checkout retrieval outage');return {...snapshot};},createStripeCheckout:async(_key,input)=>{
    assert.ok(input.purchaseSessionId);assert.equal(input.deviceToken,undefined);
    const id=input.purchaseSessionId;checkoutReads.set(id,(checkoutReads.get(id)??0)+1);
    if(checkoutFailures.delete(id))return {error:'injected_checkout_outage'};
    if(!checkouts.has(id))checkouts.set(id,{id:'cs_'+id.replaceAll('-',''),url:'https://checkout.stripe.com/c/pay/'+id});
    return checkouts.get(id)!;
  },readStripeFinance:async()=>{throw new Error('Isolated finance dependency unavailable');},readStripeRefund:async id=>{
    refundReads++; const snapshot=refundSnapshots.get(id);if(!snapshot) throw new Error('Injected Stripe outage');return snapshot;
  }});
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
});

function sign(payload: string, secret = 'whsec_testsecret', at = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

async function register(): Promise<string> {
  const res = await fetch(`${base}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: '2.0' }),
  });
  const body = (await res.json()) as { device_token: string };
  return body.device_token;
}

function checkoutEvent(
  token: string,
  type: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: (overrides.event_id as string) ?? 'evt_'+randomUUID().replaceAll('-',''),
    type,
    data: {
      object: {
        id: (overrides.session_id as string) ?? 'cs_test_ok_1',
        payment_status: 'paid',
        mode: 'payment',
        amount_total: 2400,
        currency: 'cny',
        metadata: { device_token: token, pack_id: 'pack300' },
        ...overrides,
      },
    },
  });
}

function checkoutCompletedEvent(token: string, overrides: Record<string, unknown> = {}): string {
  return checkoutEvent(token, 'checkout.session.completed', overrides);
}

// ---- pure signature verification --------------------------------------------------------

test('verifyStripeSignature accepts a valid header and rejects tampering', () => {
  const payload = '{"hello":"world"}';
  const now = 1_700_000_000;
  const header = sign(payload, 'whsec_x', now);
  assert.ok(verifyStripeSignature(payload, header, 'whsec_x', now));
  assert.ok(!verifyStripeSignature(payload + ' ', header, 'whsec_x', now), 'payload tamper');
  assert.ok(!verifyStripeSignature(payload, header, 'whsec_y', now), 'wrong secret');
  assert.ok(!verifyStripeSignature(payload, 't=123,v1=deadbeef', 'whsec_x', now), 'bogus mac');
  assert.ok(!verifyStripeSignature(payload, '', 'whsec_x', now), 'empty header');
});

test('verifyStripeSignature rejects stale timestamps (replay defense)', () => {
  const payload = '{}';
  const old = 1_700_000_000;
  const header = sign(payload, 'whsec_x', old);
  assert.ok(!verifyStripeSignature(payload, header, 'whsec_x', old + 301));
  assert.ok(verifyStripeSignature(payload, header, 'whsec_x', old + 299));
});

test('verifyStripeSignature accepts any matching v1 among several', () => {
  const payload = '{}';
  const now = 1_700_000_000;
  const mac = createHmac('sha256', 'whsec_x').update(`${now}.${payload}`).digest('hex');
  const header = `t=${now},v1=0000,v1=${mac}`;
  assert.ok(verifyStripeSignature(payload, header, 'whsec_x', now));
});

// ---- checkout params ---------------------------------------------------------------------

test('buildCheckoutParams builds a dynamic-payment-method session (no payment_method_types)', () => {
  const p = buildCheckoutParams({
    pack: { id: 'pack300', questions: 300, amountCents: 2400 },
    deviceToken: 'dev_abc',
    currency: 'CNY',
    publicBaseURL: 'https://api.example.com',
    lang: 'zh',
  });
  const s = p.toString();
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'cny');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '2400');
  assert.equal(p.get('metadata[device_token]'), 'dev_abc');
  assert.equal(p.get('metadata[pack_id]'), 'pack300');
  assert.match(p.get('success_url') ?? '', /paid=1/);
  assert.match(p.get('cancel_url') ?? '', /canceled=1/);
  assert.ok(!s.includes('payment_method_types'), 'must not pin payment method types');
});

test('new purchase sessions expose only a short secret and bind the catalog snapshot', async () => {
  const token=await register();
  const created=await fetch(`${base}/v1/purchase-sessions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({pack_id:'pack300',catalog_version:'pricing-v1',purchase_id:'11111111-1111-4111-8111-111111111111',lang:'zh'})});
  assert.equal(created.status,201);
  const body=await created.json() as {purchase_url:string;expires_at:string;amount_minor:number};
  assert.equal(body.amount_minor,2400);
  assert.match(body.purchase_url,/\/purchase\?session=[0-9a-f-]+\.[A-Za-z0-9_-]{40,}$/);
  assert.ok(!body.purchase_url.includes(token),'long device bearer must not appear in the browser URL');
  const purchaseURL=new URL(body.purchase_url); purchaseURL.protocol='http:'; purchaseURL.host=new URL(base).host;
  const page=await fetch(purchaseURL); assert.equal(page.status,200); const html=await page.text(); assert.match(html,/继续支付/); assert.ok(!html.includes(token));
  const duplicate=await fetch(`${base}/v1/purchase-sessions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({pack_id:'pack300',catalog_version:'pricing-v1',purchase_id:'11111111-1111-4111-8111-111111111111',lang:'zh'})});
  assert.equal(duplicate.status,201);
  const reissued=await duplicate.json() as {purchase_url:string;expires_at:string};
  assert.equal(reissued.expires_at,body.expires_at);assert.notEqual(reissued.purchase_url,body.purchase_url);
  assert.equal(new URL(reissued.purchase_url).searchParams.get('session')?.split('.')[0],purchaseURL.searchParams.get('session')?.split('.')[0]);
  assert.equal((await fetch(purchaseURL)).status,410,'authenticated reissue invalidates the old handoff');
});

// ---- webhook integration ------------------------------------------------------------------

test('purchase retries recover Checkout; a redirect alone never credits and only paid webhook consumes the link',async()=>{
  const token=await register(),purchaseId=randomUUID();
  const created=await app.inject({method:'POST',url:'/v1/purchase-sessions',headers:{authorization:'Bearer '+token},
    payload:{pack_id:'pack300',catalog_version:'pricing-v1',purchase_id:purchaseId,lang:'en'}});
  const handoff=new URL(created.json().purchase_url).searchParams.get('session') as string,id=handoff.split('.')[0]!;
  const page=await app.inject({url:'/purchase?session='+handoff});
  assert.match(page.payload,/¥24 CNY/);assert.match(page.payload,/Continue to payment/);
  const script=/<script>([\s\S]*)<\/script>/.exec(page.payload)![1]!;
  assert.ok(String(page.headers['content-security-policy']).includes('sha256-'+createHash('sha256').update(script).digest('base64')));
  assert.equal(page.headers['referrer-policy'],'no-referrer');assert.equal(created.headers['cache-control'],'no-store');
  checkoutFailures.add(id);
  const post=()=>app.inject({method:'POST',url:'/purchase/checkout',payload:{session:handoff}});
  assert.equal((await post()).statusCode,502);
  const attempts=await Promise.all(Array.from({length:6},post));
  for(const response of attempts){assert.equal(response.statusCode,200);assert.equal(response.json().url,checkouts.get(id)!.url);}
  const reads=checkoutReads.get(id);assert.equal((await post()).json().url,checkouts.get(id)!.url);
  assert.equal(checkoutReads.get(id),reads,'persisted URL recovers a lost response without another Stripe call');
  const complete=await app.inject({url:'/purchase/complete?lang=en&paid=1&session='+id});
  assert.equal(complete.statusCode,200);assert.match(complete.payload,/does not confirm/);assert.doesNotMatch(complete.payload,new RegExp(id+'|'+token));
  const balance=async()=>(await app.inject({url:'/v1/account',headers:{authorization:'Bearer '+token}})).json().balance_questions;
  assert.equal(await balance(),0);
  const deliver=(type:string,status:string)=>{const payload=checkoutEvent(token,type,{session_id:checkouts.get(id)!.id,payment_status:status,
    payment_intent:'pi_'+id.replaceAll('-',''),metadata:{purchase_session_id:id,pack_id:'pack300'}});
    return app.inject({method:'POST',url:'/webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':sign(payload)},payload});};
  assert.equal((await deliver('checkout.session.completed','unpaid')).statusCode,200);assert.equal(await balance(),0);
  assert.equal((await post()).statusCode,200);
  assert.equal((await deliver('checkout.session.async_payment_succeeded','paid')).statusCode,200);
  assert.equal((await deliver('checkout.session.completed','paid')).statusCode,200);
  assert.equal(await balance(),300);assert.equal((await post()).statusCode,410);
  assert.equal((await app.inject({url:'/purchase?session='+handoff})).statusCode,410);
});

test('purchase completion is localized and payment return URLs carry no purchase credential or identity',async()=>{
  for(const [lang,expected] of [['zh','请在 App 中确认到账'],['ja','アプリで残高を確認してください'],['en','Confirm your balance in the app']] as const){
    const page=await app.inject({url:'/purchase/complete?lang='+lang+'&canceled=1'});assert.equal(page.statusCode,200);assert.ok(page.payload.includes(expected));
    const params=buildCheckoutParams({pack:{id:'p',questions:10,amountCents:800},purchaseSessionId:'00000000-0000-4000-8000-000000000000',currency:'CNY',publicBaseURL:'https://example.com',lang});
    assert.equal(params.get('success_url'),'https://example.com/purchase/complete?lang='+lang+'&paid=1');
    assert.equal(params.get('cancel_url'),'https://example.com/purchase/complete?lang='+lang+'&canceled=1');
  }
});

test('signed checkout.session.async_payment_succeeded credits a delayed session; redelivery is a no-op', async () => {
  const token = await register();
  const sessionId = 'cs_test_async_1';
  const unpaid = checkoutCompletedEvent(token, { session_id: sessionId, payment_status: 'unpaid' });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(unpaid) },
    body: unpaid,
  })).status, 200);
  const before = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(before.balance_questions, 0, 'unpaid completed must not credit');

  const payload = checkoutEvent(token, 'checkout.session.async_payment_succeeded', {
    event_id: 'evt_async_1',
    session_id: sessionId,
  });
  const deliver = () => fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });
  assert.equal((await deliver()).status, 200);
  const acct1 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct1.balance_questions, 300);
  assert.equal((await deliver()).status, 200);
  const acct2 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct2.balance_questions, 300);
});

test('async_payment_succeeded after a paid completed event does not double-credit', async () => {
  const token = await register();
  const sessionId = 'cs_test_both_1';
  const completed = checkoutCompletedEvent(token, { session_id: sessionId });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(completed) },
    body: completed,
  })).status, 200);
  const asyncPaid = checkoutEvent(token, 'checkout.session.async_payment_succeeded', {
    event_id: 'evt_both_async',
    session_id: sessionId,
  });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(asyncPaid) },
    body: asyncPaid,
  })).status, 200);
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 300);
});

test('signed checkout.session.completed credits the pack; redelivery is a no-op', async () => {
  const token = await register();
  const payload = checkoutCompletedEvent(token, { session_id: 'cs_test_credit_1' });

  const deliver = () => fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });

  const first = await deliver();
  assert.equal(first.status, 200);
  const acct1 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct1.balance_questions, 300);

  const second = await deliver(); // Stripe redelivers; must not double-credit
  assert.equal(second.status, 200);
  const acct2 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct2.balance_questions, 300);
});

test('webhook with a bad signature is rejected and credits nothing', async () => {
  const token = await register();
  const payload = checkoutCompletedEvent(token, { session_id: 'cs_test_badsig' });
  const res = await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bogus' },
    body: payload,
  });
  assert.equal(res.status, 400);
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 0);
});

test('paid amount mismatching the catalog is retained for review without crediting', async () => {
  const token = await register();
  const payload = checkoutCompletedEvent(token, { session_id: 'cs_test_wrongamt', amount_total: 1 });
  const res = await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });
  assert.equal(res.status, 200); // durable review takes ownership of subsequent reconciliation
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 0);
  const path='/admin/payments/checkouts/cs_test_wrongamt',headers={'x-admin-token':'stripe_test_admin'};
  const reviewed=(await app.inject({url:path,headers})).json();
  assert.equal((await deliverSigned(payload)).status,200);
  assert.equal((await app.inject({url:path,headers})).json().attempts,reviewed.attempts,'redelivery cannot bypass a held review');
});

test('abnormal paid Checkout review requires admin authentication, fresh evidence and an exact idempotent decision',async()=>{
  const token=await register(),id='cs_manual_'+randomUUID().replaceAll('-','');
  const payload=checkoutCompletedEvent(token,{session_id:id,amount_total:2399,payment_intent:'pi_'+id.slice(3)});
  const delivered=await app.inject({method:'POST',url:'/webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':sign(payload)},payload});assert.equal(delivered.statusCode,200);
  const path='/admin/payments/checkouts/'+id,admin={'x-admin-token':'stripe_test_admin'};
  assert.equal((await app.inject({url:path})).statusCode,401);assert.equal((await app.inject({method:'POST',url:path+'/recheck'})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:path+'/decision',payload:{}})).statusCode,401);
  assert.equal((await app.inject({url:'/admin/payments/checkouts?before=cs_a&before=cs_b',headers:admin})).statusCode,400);
  let read=await app.inject({url:path,headers:admin});assert.equal(read.statusCode,200);assert.equal(read.headers['cache-control'],'no-store');
  assert.equal(read.json().state,'review');assert.equal(read.json().reason,'catalog_mismatch');assert.equal(read.json().signed.amountCents,'2399');
  assert.ok(read.json().resolvedDeviceId>0);assert.doesNotMatch(read.payload,/deviceTokenHash|dev_/);
  const page=await app.inject({url:'/admin/payments/checkouts?state=review',headers:admin});assert.ok(page.json().items.some((c:{reference:string})=>c.reference===id));
  for(const invalid of ['false','[]','"text"'])assert.equal((await app.inject({method:'POST',url:path+'/recheck',headers:{...admin,'content-type':'application/json'},payload:invalid})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:path+'/recheck',headers:admin})).statusCode,503);
  currentCheckouts.set(id,checkoutSnapshot(JSON.parse(payload).data.object));
  read=await app.inject({method:'POST',url:path+'/recheck',headers:admin});assert.equal(read.statusCode,200);assert.equal(read.json().observationSource,'stripe_api');
  const decision={review_reference:'review_'+randomUUID(),fingerprint:read.json().fingerprint,evidence_sha256:'b'.repeat(64),device_id:read.json().resolvedDeviceId,
    questions:300,pack_id:'pack300',catalog_version:'reviewed-catalog'};
  const decide=(body:unknown)=>app.inject({method:'POST',url:path+'/decision',headers:admin,payload:body as object});
  assert.equal((await decide({...decision,review_reference:['invalid-array']})).statusCode,400);
  assert.equal((await decide({...decision,fingerprint:'0'.repeat(64)})).statusCode,409);
  read=await app.inject({method:'POST',url:path+'/recheck',headers:admin});decision.fingerprint=read.json().fingerprint;
  assert.equal((await decide(decision)).statusCode,200);const reads=canonicalCheckoutReads;
  assert.equal((await decide(decision)).statusCode,200);assert.equal(canonicalCheckoutReads,reads,'confirmed decision replay needs no new provider read');
  const account=await app.inject({url:'/v1/account',headers:{authorization:'Bearer '+token}});assert.equal(account.json().balance_questions,300);
  const orders=await app.inject({url:'/admin/payments?order_reference='+id,headers:admin});assert.equal(orders.json().orders[0].amountCents,'2399');
  assert.equal((await app.inject({url:path,headers:admin})).json().decision.reference,decision.review_reference);
});

test('paid unsupported Checkout modes remain reviewable and cannot be turned into pack credit by an admin decision',async()=>{
  const token=await register(),id='cs_subscription_'+randomUUID().replaceAll('-','');
  const payload=checkoutCompletedEvent(token,{session_id:id,mode:'subscription'}),admin={'x-admin-token':'stripe_test_admin'},path='/admin/payments/checkouts/'+id;
  assert.equal((await app.inject({method:'POST',url:'/webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':sign(payload)},payload})).statusCode,200);
  currentCheckouts.set(id,checkoutSnapshot(JSON.parse(payload).data.object));
  const checked=await app.inject({method:'POST',url:path+'/recheck',headers:admin});assert.equal(checked.json().reason,'unsupported_mode');
  const decision={review_reference:'review_'+randomUUID(),fingerprint:checked.json().fingerprint,evidence_sha256:'a'.repeat(64),device_id:checked.json().resolvedDeviceId,
    questions:300,pack_id:'pack300',catalog_version:'reviewed-catalog'};
  assert.equal((await app.inject({method:'POST',url:path+'/decision',headers:admin,payload:decision})).statusCode,409);
  currentCheckouts.set(id,{...currentCheckouts.get(id)!,mode:'payment'});
  const changed=await app.inject({method:'POST',url:path+'/recheck',headers:admin});
  assert.equal(changed.json().reason,'unsupported_mode','canonical evidence cannot silently rewrite a known signed mode');
  assert.equal((await app.inject({method:'POST',url:path+'/decision',headers:admin,payload:{...decision,fingerprint:changed.json().fingerprint}})).statusCode,409);
  assert.equal((await app.inject({url:'/v1/account',headers:{authorization:'Bearer '+token}})).json().balance_questions,0);
});

test('unpaid or irrelevant events are acknowledged without crediting', async () => {
  const token = await register();
  const unpaid = checkoutCompletedEvent(token, { session_id: 'cs_test_unpaid', payment_status: 'unpaid' });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(unpaid) },
    body: unpaid,
  })).status, 200);
  const other = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(other) },
    body: other,
  })).status, 200);
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 0);
});

test('refund and dispute events are recorded separately from quota crediting', async () => {
  const token = await register();
  const payload = JSON.stringify({
    id: 'evt_refund_1', created: Math.floor(Date.now() / 1000), type: 'charge.refunded',
    data: { object: { id: 'ch_refund_1', amount_refunded: 2400, currency: 'jpy', payment_intent: 'pi_refund_1' } },
  });
  const deliver = () => fetch(`${base}/webhooks/stripe`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) }, body: payload,
  });
  assert.equal((await deliver()).status, 200);
  assert.equal((await deliver()).status, 200);
  const account = await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json() as { balance_questions: number };
  assert.equal(account.balance_questions, 0);
});

async function deliverSigned(payload:string):Promise<Response> {
  return fetch(`${base}/webhooks/stripe`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':sign(payload)},body:payload});
}
async function balance(token:string):Promise<number> {
  return ((await (await fetch(`${base}/v1/account`,{headers:{authorization:'Bearer '+token}})).json()) as {balance_questions:number}).balance_questions;
}
function refundNotification(id:string,type='refund.updated'):string {
  // Event payload deliberately carries an old status and a different amount. Only the current
  // retrieved provider object may determine financial or quota effects.
  return JSON.stringify({id:'evt_'+randomUUID().replaceAll('-',''),created:1700000000,type,
    data:{object:{id,status:'pending',amount:1,currency:'jpy'}}});
}
test('refund webhook uses the current provider resource; retryable outage does not lose the event',async()=>{
  const token=await register();const paymentIntent='pi_http_refund';
  assert.equal((await deliverSigned(checkoutCompletedEvent(token,{session_id:'cs_http_refund',payment_intent:paymentIntent}))).status,200);
  const notice=refundNotification('re_http_refund','refund.created');
  assert.equal((await deliverSigned(notice)).status,503);
  assert.equal(await balance(token),300);
  const snapshot:RefundSnapshot={id:'re_http_refund',paymentIntentId:paymentIntent,chargeId:'ch_http_refund',amountCents:2400,currency:'CNY',status:'pending'};
  refundSnapshots.set(snapshot.id,snapshot);
  assert.equal((await deliverSigned(notice)).status,200);assert.equal(await balance(token),0);
  const reads=refundReads;assert.equal((await deliverSigned(notice)).status,200);assert.equal(refundReads,reads,'processed delivery must not issue another provider read');
  refundSnapshots.set(snapshot.id,{...snapshot,status:'failed'});
  assert.equal((await deliverSigned(refundNotification(snapshot.id,'refund.failed'))).status,200);
  assert.equal(await balance(token),300);
  refundSnapshots.set(snapshot.id,{...snapshot,status:'succeeded'});
  assert.equal((await deliverSigned(refundNotification(snapshot.id))).status,200);assert.equal(await balance(token),0);
  const report=await (await fetch(`${base}/admin/payments`,{headers:{'x-admin-token':'stripe_test_admin'}})).json() as PaymentReportWire;
  assert.equal(report.orders.find(o=>o.reference==='cs_http_refund')?.policy.succeededCents,'2400');
});
test('partial refund quantity is available only through authenticated, version-bound owner review',async()=>{
  const token=await register();const pi='pi_http_partial';
  assert.equal((await deliverSigned(checkoutCompletedEvent(token,{session_id:'cs_http_partial',payment_intent:pi}))).status,200);
  const snapshot:RefundSnapshot={id:'re_http_partial',paymentIntentId:pi,chargeId:null,amountCents:1200,currency:'CNY',status:'succeeded'};
  refundSnapshots.set(snapshot.id,snapshot);assert.equal((await deliverSigned(refundNotification(snapshot.id))).status,200);
  assert.equal((await fetch(`${base}/admin/payments`)).status,401);
  const report=await (await fetch(`${base}/admin/payments`,{headers:{'x-admin-token':'stripe_test_admin'}})).json() as PaymentReportWire;
  const order=report.orders.find(o=>o.reference==='cs_http_partial')!;assert.equal(order.policy.review,'partial');
  const decision={order_reference:order.reference,fingerprint:order.policy.fingerprint,questions:70,decision_reference:'owner_http_partial'};
  const submit=(body:unknown,authorized=true)=>fetch(`${base}/admin/payments/refund-decision`,{method:'POST',headers:{'content-type':'application/json',...(authorized?{'x-admin-token':'stripe_test_admin'}:{})},body:JSON.stringify(body)});
  assert.equal((await submit(decision,false)).status,401);assert.equal(await balance(token),0);
  assert.equal((await submit({...decision,fingerprint:'0'.repeat(64)})).status,409);
  assert.equal((await submit({...decision,questions:'70'})).status,400);
  assert.equal((await submit(decision)).status,200);assert.equal(await balance(token),230);
  assert.equal((await submit(decision)).status,200);assert.equal(await balance(token),230);
});

test('stub endpoint is OFF in stripe mode; checkout rejects junk tokens and packs', async () => {
  assert.equal((await fetch(`${base}/topup/stub-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: 'dev_x', pack_id: 'pack300' }),
  })).status, 404);

  assert.equal((await fetch(`${base}/topup/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: '</script>', pack_id: 'pack300' }),
  })).status, 400);

  assert.equal((await fetch(`${base}/topup/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: 'dev_unknown_token', pack_id: 'pack300' }),
  })).status, 401);

  const token = await register();
  assert.equal((await fetch(`${base}/topup/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: token, pack_id: 'nope' }),
  })).status, 400);
});

test('top-up page renders stripe mode with live buttons and no stub warning', async () => {
  const token = await register();
  const html = await (await fetch(`${base}/topup?device=${token}&lang=zh`)).text();
  assert.match(html, /data-pack="pack300"/);
  assert.match(html, /topup\/checkout/);
  assert.ok(!html.includes('stub-complete'), 'stripe page must not wire the stub endpoint');
  assert.ok(!html.includes('支付桩'), 'no dev warning in stripe mode');
});

test('healthz reports stripe payments and webhook configured', async () => {
  const h = (await (await fetch(`${base}/healthz`)).json()) as Record<string, string>;
  assert.equal(h.payments, 'stripe');
  assert.equal(h.webhook, 'configured');
});
