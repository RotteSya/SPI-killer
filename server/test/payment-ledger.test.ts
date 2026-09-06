import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../src/db-memory.ts';
import { SqliteStore } from '../src/db-sqlite.ts';
import type { Store } from '../src/db.ts';
import type { PaidOrderInput, PaymentEvent, RefundSnapshot, RefundStatus } from '../src/payment-ledger.ts';

const implementations:Array<[string,()=>Store|Promise<Store>]>=[['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')]];
if(process.env.TEST_POSTGRES_URL) {
  const original=new URL(process.env.TEST_POSTGRES_URL);
  if(!/test/i.test(original.pathname)) throw new Error('Payment tests require an isolated test database');
  const {PostgresStore,resolvePostgresSSL}=await import('../src/db-postgres.ts');
  const pg=(await import('pg')).default;
  implementations.push(['postgres',async()=>{
    const admin=new pg.Pool({connectionString:original.toString(),ssl:resolvePostgresSSL({connectionString:original.toString()})});
    const schema='payment_test_'+randomUUID().replaceAll('-','');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(original);url.searchParams.set('options','-c search_path='+schema);
    const store=new PostgresStore(url.toString(),resolvePostgresSSL({connectionString:url.toString()}));
    const close=store.close.bind(store);
    store.close=async()=>{await close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();};
    return store;
  }]);
}
function event(resourceId:string,type='refund.updated'):PaymentEvent {
  const id='evt_'+randomUUID().replaceAll('-','');
  return {id,type,resourceId,createdAt:'2026-09-06T00:00:00.000Z',payloadHash:createHash('sha256').update(id+type+resourceId).digest('hex')};
}
async function setup(store:Store,trial=0) {
  const device=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:trial});
  const suffix=randomUUID().replaceAll('-','');
  const order:PaidOrderInput={token:device.token,reference:'cs_'+suffix,paymentIntentId:'pi_'+suffix,chargeId:'ch_'+suffix,
    questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'v1',paidAt:'2026-09-06T00:00:00.000Z'};
  await store.payments.pay(event(order.reference,'checkout.session.completed'),order);
  return {device,order};
}
function refund(order:PaidOrderInput,status:RefundStatus,amountCents=800,id='re_'+randomUUID().replaceAll('-','')):RefundSnapshot {
  return {id,paymentIntentId:order.paymentIntentId,chargeId:order.chargeId,amountCents,currency:order.currency,status};
}
async function apply(store:Store,snapshot:RefundSnapshot) {
  const claim=await store.payments.claimRefund(event(snapshot.id));assert.ok(claim);
  assert.equal(await store.payments.applyRefund(claim,snapshot),true);return claim;
}
async function solve(store:Store,token:string,charge:boolean) {
  const captureId=randomUUID();assert.equal((await store.billing.begin({token,captureId,requestHmac:captureId})).ok,true);
  await store.billing.finish({token,captureId,charge,terminalState:charge?'usable':'failed'});
}

for(const [name,make] of implementations) {
  test(`${name}: authenticated purchase recovery preserves one order and deadline while rotating the short secret`,async()=>{
    const store=await make();try{
      const device=await store.registerDevice({platform:'m',appVersion:'2.12',trialQuestions:0});
      const input={token:device.token,purchaseId:randomUUID(),packId:'small',catalogVersion:'v1',questions:10,amountCents:800,currency:'CNY',lang:'en'};
      const first=await store.createPurchaseSession(input);assert.ok(first);assert.equal(Buffer.from(first.secret,'base64url').length,32);
      const attempts=await Promise.all(Array.from({length:6},()=>store.createPurchaseSession(input)));
      for(const attempt of attempts){assert.ok(attempt);assert.equal(attempt.sessionId,first.sessionId);assert.equal(attempt.expiresAt,first.expiresAt);assert.notEqual(attempt.secret,first.secret);}
      assert.equal(await store.getPurchaseSession(first.sessionId,first.secret),null);
      const valid=await Promise.all(attempts.map(a=>store.getPurchaseSession(a!.sessionId,a!.secret)));
      assert.equal(valid.filter(Boolean).length,1);assert.equal(await store.createPurchaseSession({...input,amountCents:801}),null);
      const handoff=await store.createPurchaseSession(input);assert.ok(handoff);
      assert.equal(await store.attachPurchaseCheckout(handoff.sessionId,'cs_purchase_retry','https://checkout.stripe.com/c/pay/cs_purchase_retry'),true);
      const afterAttach=await store.createPurchaseSession(input);assert.ok(afterAttach);
      assert.equal(afterAttach.checkoutSessionId,'cs_purchase_retry');assert.equal(afterAttach.checkoutURL,'https://checkout.stripe.com/c/pay/cs_purchase_retry');
      const other=await store.createPurchaseSession({...input,purchaseId:randomUUID()});assert.ok(other);
      assert.equal(await store.attachPurchaseCheckout(other.sessionId,'cs_purchase_retry','https://checkout.stripe.com/c/pay/cs_purchase_retry'),false);
      assert.equal((await store.getAccount(device.token))?.balanceQuestions,0);
    }finally{await store.close();}
  });
  test(`${name}: confirmed payment consumes its exact purchase in the same quota transaction`,async()=>{
    const store=await make();try{
      const device=await store.registerDevice({platform:'m',appVersion:'2.12',trialQuestions:0});
      const input={token:device.token,purchaseId:randomUUID(),packId:'small',catalogVersion:'v1',questions:10,amountCents:800,currency:'CNY',lang:'en'};
      const purchase=await store.createPurchaseSession(input);assert.ok(purchase);
      assert.equal(await store.attachPurchaseCheckout(purchase.sessionId,'cs_purchase_paid','https://checkout.stripe.com/c/pay/cs_purchase_paid'),true);
      const order:PaidOrderInput={deviceId:device.id,purchaseSessionId:purchase.sessionId,reference:'cs_purchase_paid',paymentIntentId:'pi_purchase_paid',chargeId:null,
        questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'v1',paidAt:new Date().toISOString()};
      await assert.rejects(store.payments.pay(event(order.reference,'checkout.session.completed'),{...order,questions:11}));
      assert.equal((await store.getPurchaseSessionByCheckout(order.reference))?.consumedAt,null);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      const receipt=event(order.reference,'checkout.session.completed');
      await Promise.all(Array.from({length:8},()=>store.payments.pay(receipt,order)));
      const consumed=(await store.getPurchaseSessionByCheckout(order.reference))?.consumedAt;assert.ok(consumed);
      assert.equal(await store.getPurchaseSession(purchase.sessionId,purchase.secret),null);
      assert.equal(await store.createPurchaseSession(input),null);
      assert.equal(await store.attachPurchaseCheckout(purchase.sessionId,order.reference,'https://checkout.stripe.com/c/pay/cs_purchase_paid'),false);
      await store.payments.pay(event(order.reference,'checkout.session.async_payment_succeeded'),order);
      assert.equal((await store.getPurchaseSessionByCheckout(order.reference))?.consumedAt,consumed);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
      assert.equal((await store.listRecentTopups(10)).length,1);
    }finally{await store.close();}
  });
  test(`${name}: paid order and event identity prevent double credit and cross-device replay`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store);const paid=event(order.reference,'checkout.session.async_payment_succeeded');
      await Promise.all(Array.from({length:12},()=>store.payments.pay(paid,order)));
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
      assert.equal((await store.listRecentTopups(10)).length,1);
      const other=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:0});
      await assert.rejects(store.payments.pay(event(order.reference,'checkout.session.completed'),{...order,token:other.token}));
      await assert.rejects(store.payments.pay({...paid,payloadHash:'a'.repeat(64)},order));
      assert.equal((await store.billing.quota(other.token))?.balanceQuestions,0);
    }finally{await store.close();}
  });
  test(`${name}: replay binds a pre-consumption-version order without crediting it again`,async()=>{
    const store=await make();try{
      const device=await store.registerDevice({platform:'m',appVersion:'2.12',trialQuestions:0});
      const purchase=await store.createPurchaseSession({token:device.token,purchaseId:randomUUID(),packId:'small',catalogVersion:'v1',questions:10,amountCents:800,currency:'CNY',lang:'zh'});assert.ok(purchase);
      await store.attachPurchaseCheckout(purchase.sessionId,'cs_old_consumption');
      const old:PaidOrderInput={deviceId:device.id,reference:'cs_old_consumption',paymentIntentId:'pi_old_consumption',chargeId:null,questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'v1',paidAt:new Date().toISOString()};
      assert.equal(await store.payments.pay(event(old.reference,'checkout.session.completed'),old),10);
      assert.equal((await store.getPurchaseSessionByCheckout(old.reference))?.consumedAt,null);
      assert.equal(await store.payments.pay(event(old.reference,'checkout.session.completed'),{...old,purchaseSessionId:purchase.sessionId}),10);
      assert.ok((await store.getPurchaseSessionByCheckout(old.reference))?.consumedAt);
      assert.equal((await store.payments.report()).orders[0]?.purchaseSessionId,purchase.sessionId);
      assert.equal((await store.listRecentTopups(10)).length,1);
    }finally{await store.close();}
  });
  test(`${name}: pending freezes only its paid lot; failure releases it and never counts as cash refunded`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store,2);const snapshot=refund(order,'pending');
      await apply(store,snapshot);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,2);
      await solve(store,device.token,true);await solve(store,device.token,true);
      assert.equal((await store.billing.begin({token:device.token,captureId:randomUUID(),requestHmac:'x'})).ok,false);
      assert.equal((await store.payments.report()).orders[0]?.policy.succeededCents,0);
      assert.equal((await store.payments.report()).orders[0]?.policy.pendingCents,800);
      await apply(store,{...snapshot,status:'failed'});
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
      assert.equal((await store.getAccount(device.token))?.totalQuestions,2);
    }finally{await store.close();}
  });
  test(`${name}: full refund preserves consumed cost and handles both concurrent capture outcomes`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store);
      await solve(store,device.token,true);await solve(store,device.token,true);
      const charged=randomUUID(),released=randomUUID();
      for(const captureId of [charged,released]) assert.equal((await store.billing.begin({token:device.token,captureId,requestHmac:captureId})).ok,true);
      const snapshot=refund(order,'succeeded');const claim=await apply(store,snapshot);
      await Promise.all([
        store.billing.finish({token:device.token,captureId:charged,charge:true,terminalState:'usable'}),
        store.billing.finish({token:device.token,captureId:released,charge:false,terminalState:'failed'}),
        store.payments.applyRefund(claim,snapshot),
      ]);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      assert.equal((await store.billing.quota(device.token))?.heldQuestions,0);
      assert.equal((await store.getAccount(device.token))?.totalQuestions,3);
      await apply(store,{...snapshot,status:'failed'});
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,7);
      assert.equal((await store.getAccount(device.token))?.totalQuestions,3);
    }finally{await store.close();}
  });
  test(`${name}: stale canonical responses cannot overwrite a later refund reconciliation`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store);const snapshot=refund(order,'pending');
      const older=await store.payments.claimRefund(event(snapshot.id,'refund.created'));
      const newer=await store.payments.claimRefund(event(snapshot.id,'refund.updated'));
      assert.ok(older);assert.ok(newer);
      assert.equal(await store.payments.applyRefund(newer,{...snapshot,status:'succeeded'}),true);
      assert.equal(await store.payments.applyRefund(older,snapshot),false);
      assert.equal(await store.payments.claimRefund(older.event),null);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      // A genuinely current bank return is allowed: succeeded -> requires_action -> canceled.
      await apply(store,{...snapshot,status:'requires_action'});
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      assert.equal((await store.payments.report()).orders[0]?.policy.succeededCents,0);
      await apply(store,{...snapshot,status:'canceled'});
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
    }finally{await store.close();}
  });
  test(`${name}: refund arriving before checkout is retained and applies in the credit transaction`,async()=>{
    const store=await make();try {
      const device=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:0});
      const order:PaidOrderInput={deviceId:device.id,reference:'cs_before',paymentIntentId:'pi_before',chargeId:null,
        questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'v1',paidAt:'2026-09-06T00:00:00.000Z'};
      await apply(store,refund(order,'succeeded'));
      assert.equal(await store.payments.pay(event(order.reference,'checkout.session.completed'),order),0);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      assert.equal((await store.payments.report()).orders[0]?.policy.succeededCents,800);
    }finally{await store.close();}
  });
  test(`${name}: partial refunds require an explicit quantity and current-state owner decision`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store);const snapshot=refund(order,'succeeded',400);await apply(store,snapshot);
      const report=await store.payments.report(),policy=report.orders[0]!.policy;
      assert.equal(policy.review,'partial');assert.equal(policy.revokeTarget,0);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      const decision={reference:'owner_review_1',fingerprint:policy.fingerprint,questions:3};
      assert.equal(await store.payments.decidePartial(order.reference,{...decision,fingerprint:'0'.repeat(64)}),false);
      assert.equal(await store.payments.decidePartial(order.reference,{...decision,questions:1.5}),false);
      assert.equal(await store.payments.decidePartial(order.reference,decision),true);
      assert.equal(await store.payments.decidePartial(order.reference,decision),true);
      assert.equal(await store.payments.decidePartial(order.reference,{...decision,questions:4}),false);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,7);
      await solve(store,device.token,true);
      await apply(store,{...snapshot,status:'failed'});
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,9);
      await apply(store,refund(order,'succeeded',400));
      assert.equal((await store.payments.report()).orders[0]?.policy.review,'partial','new refund resource needs a new decision');
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
    }finally{await store.close();}
  });
  test(`${name}: two partial refund resources form one full cash refund without duplicate subtraction`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store);
      const a=refund(order,'succeeded',300),b=refund(order,'succeeded',500);
      await apply(store,a);await apply(store,b);await apply(store,a);
      const report=await store.payments.report();assert.equal(report.refunds.length,2);
      assert.equal(report.orders[0]?.policy.succeededCents,800);assert.equal(report.orders[0]?.policy.revokeTarget,10);
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
    }finally{await store.close();}
  });
  test(`${name}: currency mismatch is held for review and failed retrieval remains retryable`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store);const snapshot={...refund(order,'succeeded'),currency:'JPY'};
      const claim=await store.payments.claimRefund(event(snapshot.id));assert.ok(claim);await store.payments.deferRefund(claim);
      assert.equal((await store.payments.pendingRefunds()).length,0);
      const pending=await store.payments.pendingRefunds(new Date(Date.now()+61_000).toISOString());assert.equal(pending.length,1);
      const retry=await store.payments.claimRefund(pending[0]!);assert.ok(retry);
      assert.equal(await store.payments.applyRefund(retry,snapshot),true);
      assert.equal((await store.payments.report()).orders[0]?.policy.review,'integrity');
      assert.equal((await store.payments.report()).orders[0]?.policy.succeededCents,0,'different currencies must never be summed');
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
    }finally{await store.close();}
  });
  test(`${name}: immutable refund identity changes cannot transfer a refund to another order`,async()=>{
    const store=await make();try {
      const {device,order}=await setup(store),other=await setup(store);
      const snapshot=refund(order,'pending');await apply(store,snapshot);
      const claim=await store.payments.claimRefund(event(snapshot.id));assert.ok(claim);
      await assert.rejects(store.payments.applyRefund(claim,{...snapshot,paymentIntentId:other.order.paymentIntentId,chargeId:other.order.chargeId}));
      assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
      assert.equal((await store.billing.quota(other.device.token))?.balanceQuestions,10);
      assert.equal((await store.payments.report()).refunds[0]?.paymentIntentId,order.paymentIntentId);
    }finally{await store.close();}
  });
}

test('sqlite: payment and refund effects roll back on a mid-transaction fault, then survive reopen',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'notch-payment-')),path=join(directory,'test.sqlite');
  let store=new SqliteStore(path);const raw=new DatabaseSync(path);
  try {
    const {device,order}=await setup(store);
    const snapshot=refund(order,'succeeded'),claim=await store.payments.claimRefund(event(snapshot.id));assert.ok(claim);
    raw.exec("CREATE TRIGGER reject_refund BEFORE INSERT ON payment_quota_changes BEGIN SELECT RAISE(ABORT,'injected transaction fault'); END");
    await assert.rejects(store.payments.applyRefund(claim,snapshot),/injected transaction fault/);
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,10);
    assert.equal((await store.payments.report()).refunds.length,0);
    raw.exec('DROP TRIGGER reject_refund');await store.close();store=new SqliteStore(path);
    const pending=await store.payments.pendingRefunds(new Date(Date.now()+61_000).toISOString());assert.equal(pending.length,1);
    const retry=await store.payments.claimRefund(pending[0]!);assert.ok(retry);await store.payments.applyRefund(retry,snapshot);
    await store.close();store=new SqliteStore(path);
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
    assert.equal((await store.payments.report()).refunds[0]?.status,'succeeded');
    assert.equal(raw.prepare("SELECT count(*) AS n FROM payment_adjustments WHERE adjustment_type='refund' AND status='applied'").get()?.n,1);
  }finally{raw.close();await store.close();rmSync(directory,{recursive:true,force:true});}
});

test('sqlite: historical aggregate balances remain legacy_unknown when a paid event is replayed',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'notch-old-payment-')),path=join(directory,'test.sqlite');
  const store=new SqliteStore(path),raw=new DatabaseSync(path);
  try {
    const device=await store.registerDevice({platform:'m',appVersion:'old',trialQuestions:0});
    raw.exec('PRAGMA foreign_keys=ON');
    raw.prepare('DELETE FROM quota_ledger WHERE device_id=?').run(device.id);
    raw.prepare('DELETE FROM quota_lots WHERE device_id=?').run(device.id);
    raw.prepare("UPDATE devices SET balance_questions=7,initial_grant_questions=NULL,quota_policy_version='legacy' WHERE id=?").run(device.id);
    raw.prepare("INSERT INTO topups(device_id,questions,amount_cents,currency,provider,reference,created_at) VALUES(?,10,800,'CNY','stripe','cs_historical',?)").run(device.id,'2026-08-01T00:00:00.000Z');
    const order:PaidOrderInput={token:device.token,reference:'cs_historical',paymentIntentId:'pi_historical',chargeId:null,
      questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'legacy-catalog',paidAt:'2026-08-01T00:00:00.000Z'};
    assert.equal(await store.payments.pay(event(order.reference,'checkout.session.completed'),order),7);
    await apply(store,refund(order,'succeeded'));
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,7);
    assert.deepEqual((await store.billing.quota(device.token))?.quotaBreakdown,{trial:0,paid:0,goodwill:0,legacy_unknown:7});
    const report=await store.payments.report();assert.equal(report.orders[0]?.quotaAttribution,'legacy_unknown');assert.equal(report.orders[0]?.policy.review,'integrity');
    assert.equal((await store.listRecentTopups(10)).length,1);
  }finally{raw.close();await store.close();rmSync(directory,{recursive:true,force:true});}
});

test('sqlite: a failed order insertion never leaves credited quota or a consumed event receipt',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'notch-credit-fault-')),path=join(directory,'test.sqlite');
  const store=new SqliteStore(path),raw=new DatabaseSync(path);
  try {
    const device=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:0});
    const order:PaidOrderInput={token:device.token,reference:'cs_rollback',paymentIntentId:'pi_rollback',chargeId:null,
      questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'v1',paidAt:'2026-09-06T00:00:00.000Z'};
    const paid=event(order.reference,'checkout.session.completed');
    raw.exec("CREATE TRIGGER reject_order BEFORE INSERT ON payment_orders BEGIN SELECT RAISE(ABORT,'injected credit fault'); END");
    await assert.rejects(store.payments.pay(paid,order),/injected credit fault/);
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);
    assert.equal((await store.listRecentTopups(10)).length,0);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM webhook_inbox').get()?.n,0);
    raw.exec('DROP TRIGGER reject_order');assert.equal(await store.payments.pay(paid,order),10);
  }finally{raw.close();await store.close();rmSync(directory,{recursive:true,force:true});}
});

test('sqlite: expired Checkout still settles; consumption failure rolls back the entire credit and survives reopen',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'notch-purchase-')),path=join(directory,'test.sqlite');
  let store=new SqliteStore(path);const raw=new DatabaseSync(path);
  try{
    const device=await store.registerDevice({platform:'m',appVersion:'2.12',trialQuestions:0});
    const input={token:device.token,purchaseId:randomUUID(),packId:'small',catalogVersion:'v1',questions:10,amountCents:800,currency:'CNY',lang:'ja'};
    const purchase=await store.createPurchaseSession(input);assert.ok(purchase);
    await store.attachPurchaseCheckout(purchase.sessionId,'cs_purchase_expired','https://checkout.stripe.com/c/pay/cs_purchase_expired');
    raw.prepare('UPDATE purchase_sessions SET expires_at=? WHERE session_id=?').run('2026-01-01T00:00:00.000Z',purchase.sessionId);
    assert.equal(await store.createPurchaseSession(input),null);assert.equal(await store.getPurchaseSession(purchase.sessionId,purchase.secret),null);
    const order:PaidOrderInput={deviceId:device.id,purchaseSessionId:purchase.sessionId,reference:'cs_purchase_expired',paymentIntentId:'pi_purchase_expired',chargeId:null,
      questions:10,amountCents:800,currency:'CNY',packId:'small',catalogVersion:'v1',paidAt:new Date().toISOString()};
    const receipt=event(order.reference,'checkout.session.async_payment_succeeded');
    raw.exec("CREATE TRIGGER reject_consumption BEFORE UPDATE OF consumed_at ON purchase_sessions BEGIN SELECT RAISE(ABORT,'injected consumption fault'); END");
    await assert.rejects(store.payments.pay(receipt,order),/injected consumption fault/);
    assert.equal((await store.billing.quota(device.token))?.balanceQuestions,0);assert.equal((await store.listRecentTopups(10)).length,0);
    assert.equal((await store.getPurchaseSessionByCheckout(order.reference))?.consumedAt,null);
    raw.exec('DROP TRIGGER reject_consumption');await store.close();store=new SqliteStore(path);
    assert.equal(await store.payments.pay(receipt,order),10);await store.close();store=new SqliteStore(path);
    assert.ok((await store.getPurchaseSessionByCheckout(order.reference))?.consumedAt);
    assert.equal((await store.getPurchaseSessionByCheckout(order.reference))?.checkoutURL,'https://checkout.stripe.com/c/pay/cs_purchase_expired');
    assert.equal(await store.payments.pay(receipt,order),10);assert.equal((await store.listRecentTopups(10)).length,1);
  }finally{raw.close();await store.close();rmSync(directory,{recursive:true,force:true});}
});
