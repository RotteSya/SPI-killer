import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import Fastify from 'fastify';
import {config} from '../src/config.ts';
import {registerRoutes} from '../src/routes.ts';
import {MockProvider} from '../src/providers/mock.ts';
import {StripePaymentProvider} from '../src/stripe.ts';
import {MemoryStore} from '../src/db-memory.ts';
import {SqliteStore} from '../src/db-sqlite.ts';
import type {Store} from '../src/db.ts';
import type {PaymentEvent} from '../src/payment-ledger.ts';
import {checkoutSnapshot,checkoutFingerprint,checkoutCaseWire,validateCheckoutDecision,validateCheckoutQuery,type CheckoutSnapshot,type CheckoutDecision} from '../src/checkout-reconciliation.ts';
import {reconcileCheckout} from '../src/checkout-service.ts';
const factories:Array<[string,()=>Store|Promise<Store>]>=[['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')]];
if(process.env.TEST_POSTGRES_URL){
  const original=new URL(process.env.TEST_POSTGRES_URL);if(!/test/i.test(original.pathname))throw new Error('Isolated test database required');
  const {PostgresStore,resolvePostgresSSL}=await import('../src/db-postgres.ts');const pg=(await import('pg')).default;
  factories.push(['postgres',async()=>{
    const admin=new pg.Pool({connectionString:original.toString(),ssl:resolvePostgresSSL({connectionString:original.toString()})});
    const schema='checkout_test_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
    const url=new URL(original);url.searchParams.set('options','-c search_path='+schema);
    const store=new PostgresStore(url.toString(),resolvePostgresSSL({connectionString:url.toString()})),close=store.close.bind(store);
    store.close=async()=>{await close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();};return store;
  }]);
}
const catalog={currency:'CNY',version:'pricing-v1',packs:[{id:'small',questions:10,amountCents:800}]};
function event(id:string):PaymentEvent{const key='evt_'+randomUUID().replaceAll('-','');return {id:key,type:'checkout.session.completed',resourceId:id,createdAt:new Date().toISOString(),payloadHash:createHash('sha256').update(key).digest('hex')};}
async function prepare(store:Store,amount=800){
  const device=await store.registerDevice({platform:'macos',appVersion:'test',trialQuestions:0}),id='cs_'+randomUUID().replaceAll('-','');
  const snapshot=checkoutSnapshot({id,mode:'payment',payment_status:'paid',amount_total:amount,currency:'cny',payment_intent:'pi_'+id.slice(3),
    metadata:{device_token:device.token,pack_id:'small',private_question:'must not persist'}});
  const receipt=event(id);return {device,snapshot,receipt};
}
async function receive(store:Store,snapshot:CheckoutSnapshot,receipt=event(snapshot.id),source:'signed_event'|'stripe_api'='signed_event'){
  const q=store.payments.checkouts;await q.receive(receipt,snapshot);const claim=await q.claim(snapshot.id);assert.ok(claim);
  return q.finish(claim,snapshot,source,catalog);
}
async function review(store:Store,snapshot:CheckoutSnapshot,deviceId:number,reference= 'review_'+randomUUID()):Promise<CheckoutDecision>{
  await reconcileCheckout(store.payments.checkouts,snapshot.id,catalog,async()=>snapshot,undefined,true);
  const current=await store.payments.checkouts.get(snapshot.id);assert.ok(current);
  return {reference,fingerprint:checkoutFingerprint(current),evidenceSha256:'a'.repeat(64),deviceId,questions:10,packId:'small',catalogVersion:'reviewed-catalog'};
}

test('Checkout evidence drops arbitrary provider metadata and decision/query validators reject structured values',()=>{
  const snapshot=checkoutSnapshot({id:'cs_shape',mode:'payment',payment_status:'paid',amount_total:800,currency:'cny',metadata:{device_token:'dev_test',pack_id:'small',email:'private',question:'private'}});
  assert.doesNotMatch(JSON.stringify(snapshot),/dev_test|email|question/);assert.equal(snapshot.deviceTokenHash?.length,64);
  const decision={reference:'review',fingerprint:'a'.repeat(64),evidenceSha256:'b'.repeat(64),deviceId:1,questions:10,packId:'small',catalogVersion:'v1'};
  assert.throws(()=>validateCheckoutDecision({...decision,reference:['review']} as unknown as CheckoutDecision));
  assert.throws(()=>validateCheckoutQuery({limit:10,before:['cs_shape']} as never));
});

for(const [name,make] of factories){
  test(`${name}: signed paid receipt commits first, concurrent processing and event redelivery credit only once`,async()=>{
    const store=await make();try{
      const {device,snapshot,receipt}=await prepare(store),q=store.payments.checkouts;
      await Promise.all(Array.from({length:8},()=>q.receive(receipt,snapshot)));
      assert.equal((await q.get(snapshot.id))?.state,'queued');assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      const claims=await Promise.all(Array.from({length:8},()=>q.claim(snapshot.id))),claim=claims.find(Boolean)!;assert.equal(claims.filter(Boolean).length,1);
      assert.equal(await q.finish(claim,snapshot,'signed_event',catalog),'credited');
      await q.receive(event(snapshot.id),snapshot);assert.equal(await q.claim(snapshot.id),null);
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>{throw new Error('already credited');}),'stale','a second worker does not count an already completed credit');
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);assert.equal((await store.listRecentTopups(10)).length,1);
      assert.equal((await store.payments.report()).pendingEvents,0);
      const wire=JSON.stringify(checkoutCaseWire((await q.get(snapshot.id))!));assert.doesNotMatch(wire,/deviceTokenHash|private_question|dev_/);
      const duplicate={...snapshot,id:snapshot.id+'_other'};assert.equal(await receive(store,duplicate),'review');
      assert.equal((await q.get(duplicate.id))?.reason,'order_conflict');assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
    }finally{await store.close();}
  });
  test(`${name}: out-of-catalog cash waits for a fresh provider observation and explicit audited quantity`,async()=>{
    const store=await make();try{
      const {device,snapshot,receipt}=await prepare(store,799),q=store.payments.checkouts;
      assert.equal(await receive(store,snapshot,receipt),'review');let entry=(await q.get(snapshot.id))!;
      assert.equal(entry.reason,'catalog_mismatch');assert.equal(entry.resolvedDeviceId,device.id);assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      const unreviewed={reference:'premature',fingerprint:checkoutFingerprint(entry),evidenceSha256:'a'.repeat(64),deviceId:device.id,questions:10,packId:'small',catalogVersion:'reviewed-catalog'};
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>snapshot,unreviewed),'conflict','signed evidence is not a current-provider review');
      const decision=await review(store,snapshot,device.id);
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>snapshot,decision),'credited');
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>{throw new Error('must not reread after a confirmed identical decision');},decision),'credited');
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
      const order=(await store.payments.report()).orders[0]!;assert.equal(order.amountCents,799);assert.equal(order.questions,10);assert.equal(order.catalogVersion,'reviewed-catalog');
      entry=(await q.get(snapshot.id))!;assert.equal(entry.decision?.reference,decision.reference);assert.ok(entry.decision?.appliedAt);
      const other=await prepare(store,799);await receive(store,other.snapshot,other.receipt);const reused=await review(store,other.snapshot,other.device.id,decision.reference);
      assert.equal(await reconcileCheckout(q,other.snapshot.id,catalog,async()=>other.snapshot,reused),'conflict');
      assert.equal((await store.billing.quota(other.device.token))?.balanceQuestions,0);
    }finally{await store.close();}
  });
  test(`${name}: changed observations and wrong known-device decisions never apply stale approval`,async()=>{
    const store=await make();try{
      const {device,snapshot,receipt}=await prepare(store,799),q=store.payments.checkouts;await receive(store,snapshot,receipt);
      const decision=await review(store,snapshot,device.id);
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>({...snapshot,amountCents:798}),decision),'conflict');
      const wrong=await store.registerDevice({platform:'macos',appVersion:'test',trialQuestions:0});
      const second=await review(store,snapshot,wrong.id);
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>snapshot,second),'review');
      assert.equal((await q.get(snapshot.id))?.reason,'device_missing');
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);assert.equal((await store.billing.quota(wrong.token))?.balanceQuestions,0);
      assert.equal((await store.listRecentTopups(10)).length,0);
    }finally{await store.close();}
  });
  test(`${name}: paid proof recovers a Checkout that arrived before local attachment`,async()=>{
    const store=await make();try{
      const {device,snapshot,receipt}=await prepare(store),q=store.payments.checkouts;
      const purchase=await store.createPurchaseSession({token:device.token,purchaseId:randomUUID(),packId:'small',questions:10,amountCents:800,currency:'CNY',catalogVersion:'frozen-v1',lang:'en'});assert.ok(purchase);
      snapshot.purchaseSessionId=purchase.sessionId;snapshot.deviceTokenHash=null;
      assert.equal(await receive(store,snapshot,receipt),'credited');
      const stored=await store.getPurchaseSessionByCheckout(snapshot.id);assert.equal(stored?.sessionId,purchase.sessionId);assert.ok(stored?.consumedAt);
      assert.equal((await store.payments.report()).orders[0]?.catalogVersion,'frozen-v1');assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
      assert.equal(await store.getPurchaseSession(purchase.sessionId,purchase.secret),null);assert.equal((await q.get(snapshot.id))?.resolvedDeviceId,device.id);
    }finally{await store.close();}
  });
  test(`${name}: outages, stale claims and bounded retries retain the original payment for review`,async()=>{
    const store=await make();try{
      const {device,snapshot,receipt}=await prepare(store,799),q=store.payments.checkouts;await q.receive(receipt,snapshot);
      const old=await q.claim(snapshot.id);assert.ok(old);await q.defer(old);
      assert.deepEqual(await q.pending(),[]);assert.deepEqual(await q.pending(new Date(Date.now()+61_000).toISOString()),[snapshot.id]);
      assert.equal(await q.claim(snapshot.id),null,'a worker with a stale pending list must respect the new retry deadline');
      const newer=await q.claim(snapshot.id,true);assert.ok(newer);
      assert.equal(await q.finish(old,snapshot,'stripe_api',catalog),'stale');await q.defer(newer);
      for(let i=0;i<3;i++)await assert.rejects(reconcileCheckout(q,snapshot.id,catalog,async()=>{throw new Error('injected outage');},undefined,true));
      assert.equal((await q.get(snapshot.id))?.state,'review');assert.equal((await q.get(snapshot.id))?.reason,'provider_unavailable');assert.deepEqual(await q.pending('2099-01-01T00:00:00.000Z'),[]);
      assert.equal((await store.payments.report()).pendingEvents,1);assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      const copy=(await q.get(snapshot.id))!;copy.signed.amountCents=1;assert.equal((await q.get(snapshot.id))?.signed.amountCents,799);
    }finally{await store.close();}
  });
  test(`${name}: canonical metadata changes cannot erase a signed beneficiary or sealed purchase`,async()=>{
    const store=await make();try{
      const {device,snapshot,receipt}=await prepare(store,799),q=store.payments.checkouts;
      const other=await store.registerDevice({platform:'macos',appVersion:'test',trialQuestions:0});
      await receive(store,snapshot,receipt);
      const erased={...snapshot,deviceTokenHash:null};const wrong=await review(store,erased,other.id);
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>erased,wrong),'review');
      assert.equal((await q.get(snapshot.id))?.reason,'device_missing');
      assert.equal((await store.billing.quota(other.token))?.balanceQuestions,0);
      const approved=await review(store,erased,device.id);
      assert.equal(await reconcileCheckout(q,snapshot.id,catalog,async()=>erased,approved),'credited');
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);

      const next=await prepare(store,799);
      const purchase=await store.createPurchaseSession({token:next.device.token,purchaseId:randomUUID(),packId:'small',questions:10,amountCents:800,currency:'CNY',catalogVersion:'frozen-v1',lang:'en'});assert.ok(purchase);
      next.snapshot.purchaseSessionId=purchase.sessionId;next.snapshot.deviceTokenHash=null;
      await store.attachPurchaseCheckout(purchase.sessionId,next.snapshot.id);
      await receive(store,next.snapshot,next.receipt);
      const removed={...next.snapshot,purchaseSessionId:null};const changed=await review(store,removed,other.id);
      assert.equal(await reconcileCheckout(q,removed.id,catalog,async()=>removed,changed),'review');
      assert.equal((await q.get(removed.id))?.reason,'purchase_mismatch');
      assert.equal((await store.billing.quota(other.token))?.balanceQuestions,0);
      assert.equal((await store.getPurchaseSessionByCheckout(removed.id))?.consumedAt,null);
    }finally{await store.close();}
  });
  test(`${name}: queue replay adopts an older paid order without duplicating its credit`,async()=>{
    const store=await make();try{
      const {device,snapshot}=await prepare(store);
      const purchase=await store.createPurchaseSession({token:device.token,purchaseId:randomUUID(),packId:'small',questions:10,amountCents:800,currency:'CNY',catalogVersion:'frozen-v1',lang:'en'});assert.ok(purchase);
      await store.attachPurchaseCheckout(purchase.sessionId,snapshot.id);
      await store.payments.pay(event(snapshot.id),{reference:snapshot.id,deviceId:device.id,paymentIntentId:snapshot.paymentIntentId,chargeId:null,
        questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'frozen-v1',paidAt:new Date().toISOString()});
      assert.equal((await store.getPurchaseSessionByCheckout(snapshot.id))?.consumedAt,null);
      snapshot.purchaseSessionId=purchase.sessionId;snapshot.deviceTokenHash=null;
      assert.equal(await receive(store,snapshot),'credited');
      assert.ok((await store.getPurchaseSessionByCheckout(snapshot.id))?.consumedAt);
      assert.equal((await store.payments.report()).orders[0]?.purchaseSessionId,purchase.sessionId);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);assert.equal((await store.listRecentTopups(10)).length,1);
    }finally{await store.close();}
  });
  test(`${name}: conflicting signed events stay visible and cursor pages do not silently drop cases`,async()=>{
    const store=await make();try{
      const first=await prepare(store),second=await prepare(store,799),q=store.payments.checkouts;
      await receive(store,first.snapshot,first.receipt);await receive(store,second.snapshot,second.receipt);
      await q.receive(event(first.snapshot.id),{...first.snapshot,packId:'changed'});
      const conflict=(await q.get(first.snapshot.id))!;assert.equal(conflict.state,'review');assert.equal(conflict.conflictingEvents,true);
      const page=await q.list({limit:1,state:'review'});assert.ok(page.next);
      const next=await q.list({limit:1,state:'review',before:page.next});assert.equal(next.items.length,1);assert.notEqual(page.items[0]!.reference,next.items[0]!.reference);
      await assert.rejects(q.receive({...first.receipt,payloadHash:'f'.repeat(64)},first.snapshot));
      assert.equal((await store.billing.quota(first.device.token))?.balanceQuestions,10);
    }finally{await store.close();}
  });
  test(`${name}: authenticated concurrent recovery sweeps credit once and isolate provider outages`,async()=>{
    const store=await make(),app=Fastify({logger:false}),secret='checkout-recovery-test-secret';
    try{
      const first=await prepare(store),second=await prepare(store),q=store.payments.checkouts;
      await q.receive(first.receipt,first.snapshot);await q.receive(second.receipt,second.snapshot);
      const provider=new MockProvider();let reads=0;
      registerRoutes(app,{config:{...config,cronSecret:secret,adminToken:'test_admin',paymentProvider:'stripe',stripeSecretKey:'test_not_a_vendor_key',
        currency:catalog.currency,catalogVersion:catalog.version,packs:catalog.packs},store,storeKind:name as 'memory'|'sqlite'|'postgres',
        provider,objectiveProvider:provider,providerDegraded:null,objectiveProviderDegraded:null,payment:new StripePaymentProvider(),
        readStripeFinance:async()=>{throw new Error('Isolated finance dependency unavailable');},
        readStripeCheckout:async id=>{reads++;if(id===second.snapshot.id)throw new Error('injected outage');return {...first.snapshot};}});
      assert.equal((await app.inject({url:'/api/internal/reap'})).statusCode,401);
      assert.equal((await app.inject({url:'/api/internal/reap',headers:{'x-admin-token':'test_admin'}})).statusCode,401);assert.equal(reads,0);
      const responses=await Promise.all([1,2].map(()=>app.inject({url:'/api/internal/reap',headers:{authorization:'Bearer '+secret}})));
      for(const response of responses){assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');}
      assert.equal(responses.reduce((n,r)=>n+r.json().checkouts_credited,0),1);
      assert.equal(responses.reduce((n,r)=>n+r.json().checkouts_failed,0),1);
      assert.equal((await store.billing.quota(first.device.token))?.balanceQuestions,10);
      assert.equal((await store.billing.quota(second.device.token))?.balanceQuestions,0);
      assert.equal((await q.get(second.snapshot.id))?.reason,'provider_unavailable');
      const after=reads;await app.inject({url:'/api/internal/reap',headers:{authorization:'Bearer '+secret}});assert.equal(reads,after,'future retries stay deferred');
    }finally{await app.close();await store.close();}
  });
}

test('sqlite: a receipt committed before process shutdown is discovered and credited after reopen',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'checkout-recovery-')),path=join(directory,'test.sqlite');let store=new SqliteStore(path);
  try{
    const {device,snapshot,receipt}=await prepare(store);await store.payments.checkouts.receive(receipt,snapshot);
    await store.close();store=new SqliteStore(path);
    assert.deepEqual(await store.payments.checkouts.pending(),[snapshot.id]);
    assert.equal(await reconcileCheckout(store.payments.checkouts,snapshot.id,catalog,async()=>snapshot),'credited');
    await store.close();store=new SqliteStore(path);
    assert.deepEqual(await store.payments.checkouts.pending(),[]);
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
    assert.equal((await store.payments.report()).pendingEvents,0);
  }finally{await store.close();rmSync(directory,{recursive:true,force:true});}
});

test('sqlite: review decision insertion failure rolls back quota, preserves the receipt, and recovers after reopen',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'checkout-audit-')),path=join(directory,'test.sqlite');let store=new SqliteStore(path);const raw=new DatabaseSync(path);
  try{
    const {device,snapshot,receipt}=await prepare(store,799);await receive(store,snapshot,receipt);const decision=await review(store,snapshot,device.id);
    raw.exec("CREATE TRIGGER reject_checkout_review BEFORE INSERT ON checkout_decisions BEGIN SELECT RAISE(ABORT,'injected review fault'); END");
    await assert.rejects(reconcileCheckout(store.payments.checkouts,snapshot.id,catalog,async()=>snapshot,decision));
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);assert.equal((await store.listRecentTopups(10)).length,0);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM checkout_deliveries').get()?.n,1);
    raw.exec('DROP TRIGGER reject_checkout_review');await store.close();store=new SqliteStore(path);
    const fresh=await review(store,snapshot,device.id);assert.equal(await reconcileCheckout(store.payments.checkouts,snapshot.id,catalog,async()=>snapshot,fresh),'credited');
    await store.close();store=new SqliteStore(path);assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
    assert.equal((await store.payments.checkouts.get(snapshot.id))?.decision?.reference,fresh.reference);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM checkout_decisions').get()?.n,1);
    assert.ok(Number(raw.prepare('SELECT count(*) AS n FROM checkout_observations').get()?.n)>1);
  }finally{raw.close();await store.close();rmSync(directory,{recursive:true,force:true});}
});
