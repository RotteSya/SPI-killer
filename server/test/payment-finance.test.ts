import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import Fastify from 'fastify';
import {config} from '../src/config.ts';
import {registerRoutes} from '../src/routes.ts';
import {MockProvider} from '../src/providers/mock.ts';
import {StripePaymentProvider} from '../src/stripe.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../src/db-memory.ts';
import {SqliteStore} from '../src/db-sqlite.ts';
import type {Store} from '../src/db.ts';
import {financeTotals,validateFinanceSnapshot,reconcilePaymentFinance,type FinanceOrder} from '../src/payment-finance.ts';
import {aggregateCohorts,aggregateEconomics} from '../src/reporting.ts';
import {reconcileStripeRefund} from '../src/stripe.ts';
import {financeBase,financeAt,financeSnapshot,disputedSnapshot,balanceTransaction} from './helpers/finance-fixture.ts';

const order:FinanceOrder={reference:'cs_finance',deviceId:1,paymentIntentId:'pi_finance',chargeId:null,amountMinor:'1000',currency:'USD'};
const event=(suffix:string,resourceId='cs_finance',type='checkout.session.completed')=>({id:'evt_finance_test_'+suffix,resourceId,type,createdAt:new Date().toISOString(),payloadHash:'a'.repeat(64)});
const query=(day=40)=>({cohortFrom:financeAt(0),cohortTo:financeAt(1),asOf:financeAt(day)});
async function pay(store:Store){const d=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:0,policyVersion:'fixed30-test'});
  await store.payments.pay(event('paid'),{reference:order.reference,token:d.token,paymentIntentId:order.paymentIntentId,chargeId:null,questions:5,amountCents:1000,currency:'USD',packId:'five',catalogVersion:'v1',paidAt:financeAt(0)});return d;}
test('finance totals separate dispute principal, processing fees, fee rebates and foreign settlement currency',()=>{
  const lost=disputedSnapshot();validateFinanceSnapshot(order,lost);
  assert.deepEqual(financeTotals(lost,'USD'),{fees:[{currency:'USD',amountMinor:'1530'}],feesComplete:true,disputeLossMinor:'1000',disputesUnknown:false});
  const won=disputedSnapshot('won');assert.equal(financeTotals(won,'USD').disputeLossMinor,'0');assert.equal(financeTotals(won,'USD').fees[0]!.amountMinor,'30');
  const standalone=disputedSnapshot();standalone.transactions.push(balanceTransaction({id:'txn_counter_fee',sourceId:'du_finance',category:'fee',amountMinor:'-200',feeMinor:'0',netMinor:'-200'}));standalone.disputes[0]!.transactionIds.push('txn_counter_fee');
  assert.equal(financeTotals(standalone,'USD').fees[0]!.amountMinor,'1730');assert.equal(financeTotals(standalone,'USD').disputeLossMinor,'1000');
  lost.transactions[1]!.currency='JPY';assert.equal(financeTotals(lost,'USD').disputesUnknown,true);assert.equal(financeTotals(lost,'USD').disputeLossMinor,'0');
});
test('incomplete, open, inconsistent and future-shape financial resources cannot become confirmed totals',()=>{
  const s=financeSnapshot();s.charges[0]!.transactionId=null;s.transactions=[];assert.equal(financeTotals(s,'USD').feesComplete,false);
  const open=disputedSnapshot('under_review');assert.equal(financeTotals(open,'USD').disputesUnknown,true);assert.equal(financeTotals(open,'USD').disputeLossMinor,'0');
  const empty=disputedSnapshot();empty.disputes[0]!.transactionIds=[];empty.transactions.pop();assert.equal(financeTotals(empty,'USD').disputesUnknown,true);
  const duplicateLoss=disputedSnapshot();duplicateLoss.transactions[1]!.sourceId=null;duplicateLoss.disputes.push({...duplicateLoss.disputes[0]!,id:'du_second'});
  assert.throws(()=>validateFinanceSnapshot(order,duplicateLoss),/binding mismatch/);
  for(const mutate of [(s:ReturnType<typeof financeSnapshot>)=>{s.transactions[0]!.netMinor='0';},(s:ReturnType<typeof financeSnapshot>)=>{s.charges[0]!.paymentIntentId='pi_other';},
    (s:ReturnType<typeof financeSnapshot>)=>{s.transactions.push({...s.transactions[0]!});},(s:ReturnType<typeof financeSnapshot>)=>{s.transactions[0]!.sourceId='ch_other';},
    (s:ReturnType<typeof financeSnapshot>)=>{s.charges[0]!.capturedMinor='999';}]){const invalid=financeSnapshot();mutate(invalid);assert.throws(()=>validateFinanceSnapshot(order,invalid));}
});

const factories:Array<[string,()=>Store|Promise<Store>]>=[['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')]];
if(process.env.TEST_POSTGRES_URL){const original=new URL(process.env.TEST_POSTGRES_URL);if(!/test/i.test(original.pathname))throw new Error('Isolated test database required');
  const {PostgresStore,resolvePostgresSSL}=await import('../src/db-postgres.ts'),pg=(await import('pg')).default;
  factories.push(['postgres',async()=>{const pool=new pg.Pool({connectionString:original.toString(),ssl:resolvePostgresSSL({connectionString:original.toString()})}),schema='finance_test_'+randomUUID().replaceAll('-','');
    await pool.query(`CREATE SCHEMA ${schema}`);const url=new URL(original);url.searchParams.set('options','-c search_path='+schema);
    const store=new PostgresStore(url.toString(),resolvePostgresSSL({connectionString:url.toString()})),close=store.close.bind(store);
    store.close=async()=>{await close();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();};return store;}]);
}
for(const [name,make] of factories){
  test(`${name}: finance notices, claims and immutable revisions deduplicate money and respect historical as_of`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{const d=await pay(store);assert.deepEqual(await store.finance.pending(),['cs_finance']);
      const before=aggregateEconomics(await store.reporting.snapshot(query()),query());assert.equal(before.currencies[0]!.cash_minor.payment_fees_total,null);
      t.mock.timers.setTime(financeBase+86_400_000);const notice={event:event('dispute','du_finance','charge.dispute.created'),resources:['du_finance','pi_finance']};
      await store.finance.observe(notice);await store.finance.observe(notice);await assert.rejects(store.finance.observe({...notice,event:{...notice.event,payloadHash:'b'.repeat(64)}}));
      const claims=await Promise.all(Array.from({length:8},()=>store.finance.claim('cs_finance')));assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(Boolean)!;
      assert.equal(await store.finance.finish(claim,disputedSnapshot()),true);assert.equal(await store.finance.finish(claim,disputedSnapshot()),false);
      const report=aggregateEconomics(await store.reporting.snapshot(query()),query());assert.equal(report.currencies[0]!.cash_minor.confirmed_dispute_losses,'1000');assert.equal(report.currencies[0]!.cash_minor.payment_fees_total,'1530');
      assert.equal(aggregateCohorts(await store.reporting.snapshot(query()),query()).p28.dispute_loss_devices,1);assert.equal((await store.billing.quota(d.token))?.balanceQuestions,5,'financial loss does not arbitrarily revoke quota');
      const historical=await store.reporting.snapshot(query(2));t.mock.timers.setTime(financeBase+3*86_400_000);
      await store.finance.observe({event:event('won','du_finance','charge.dispute.closed'),resources:['du_finance','ch_finance']});
      assert.equal((await store.finance.inspect('cs_finance')).revision?.dirty,true);assert.equal(aggregateEconomics(await store.reporting.snapshot(query()),query()).currencies[0]!.cash_minor.net,null);
      assert.deepEqual(await store.reporting.snapshot(query(2)),historical);
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>disputedSnapshot('won'));
      const final=aggregateEconomics(await store.reporting.snapshot(query()),query());assert.equal(final.currencies[0]!.cash_minor.payment_fees_total,'30');assert.equal(final.currencies[0]!.cash_minor.net,'1000');assert.equal(final.finance_reconciliation.pending_new_notices,0);
      assert.doesNotMatch(JSON.stringify(await store.finance.inspect('cs_finance')),new RegExp(d.token));
      t.mock.timers.setTime(financeBase+4*86_400_000);
      await store.recordPaymentAdjustment({providerRef:'fee_late',orderReference:'pi_finance',type:'fee',amountCents:10,currency:'USD',status:'applied',effectiveAt:financeAt(4)});
      assert.equal(aggregateEconomics(await store.reporting.snapshot(query()),query()).currencies[0]!.cash_minor.payment_fees_total,null,'a later legacy fee input cannot be hidden by an earlier resource snapshot');
    }finally{await store.close();}
  });
  test(`${name}: finance lease recovery rejects stale workers and five read failures require review`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{await pay(store);const old=(await store.finance.claim('cs_finance'))!;t.mock.timers.setTime(financeBase+31_000);const current=(await store.finance.claim('cs_finance'))!;
      assert.notEqual(current.generation,old.generation);assert.equal(await store.finance.finish(old,financeSnapshot()),false);await store.finance.defer(old);assert.equal((await store.finance.inspect('cs_finance')).job?.status,'reading');
      await store.finance.defer(current);
      for(let i=0;i<3;i++){t.mock.timers.tick(61_000);await assert.rejects(reconcilePaymentFinance(store.finance,'cs_finance',async()=>{throw new Error('private provider outage');}));}
      t.mock.timers.tick(61_000);assert.deepEqual(await store.finance.pending(),[]);assert.equal((await store.finance.inspect('cs_finance')).job?.status,'review');
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>financeSnapshot(),true);assert.equal((await store.finance.inspect('cs_finance')).job?.status,'verified');
      const forced=(await store.finance.claim('cs_finance',true))!;t.mock.timers.tick(31_000);
      assert.deepEqual(await store.finance.pending(),['cs_finance'],'an interrupted forced read must not wait for the previous daily schedule');
      assert.equal(await store.finance.finish(forced,financeSnapshot()),false);await reconcilePaymentFinance(store.finance,'cs_finance',async()=>financeSnapshot());
      assert.deepEqual(await store.finance.pending(),[]);t.mock.timers.tick(86_400_001);assert.deepEqual(await store.finance.pending(),['cs_finance']);
    }finally{await store.close();}
  });
  test(`${name}: a notice during provider reading invalidates the snapshot until a newer claim`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{await pay(store);const claim=(await store.finance.claim('cs_finance'))!;
      await store.finance.observe({event:event('during','ch_finance','charge.updated'),resources:['ch_finance']});
      await store.finance.finish(claim,financeSnapshot());assert.equal((await store.finance.inspect('cs_finance')).revision?.dirty,true);
      assert.deepEqual(await store.finance.pending(),['cs_finance']);
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>financeSnapshot());assert.equal((await store.finance.inspect('cs_finance')).revision?.dirty,false);
    }finally{await store.close();}
  });
  test(`${name}: finance discovery queues missing refunds for a fresh ledger read without issuing cash refunds`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{const d=await pay(store),s=financeSnapshot();s.refunds=[{id:'re_finance',chargeId:'ch_finance',paymentIntentId:'pi_finance',amountCents:1000,currency:'USD',status:'succeeded',transactionId:'txn_refund',failureTransactionId:null}];
      s.transactions.push(balanceTransaction({id:'txn_refund',sourceId:'re_finance',category:'refund',amountMinor:'-1000',feeMinor:'0',netMinor:'-1000'}));
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>s,false,store.payments);
      assert.equal((await store.billing.quota(d.token))?.balanceQuestions,5);
      const pending=await store.payments.pendingRefunds();assert.equal(pending.length,1);assert.equal(pending[0]!.type,'finance.refund.reconcile');
      assert.equal(aggregateEconomics(await store.reporting.snapshot(query()),query()).finance_reconciliation.refund_ledger_mismatch,1);
      await reconcileStripeRefund(store.payments,pending[0]!,async()=>{const {transactionId:_,failureTransactionId:__,...refund}=s.refunds[0]!;return refund;});
      assert.equal((await store.billing.quota(d.token))?.balanceQuestions,0);assert.equal((await store.payments.pendingRefunds()).length,0);
      const report=aggregateEconomics(await store.reporting.snapshot(query()),query());assert.equal(report.currencies[0]!.cash_minor.net,'0');assert.equal(report.currencies[0]!.cash_minor.succeeded_refunds,'1000');assert.equal(report.currencies[0]!.cash_minor.payment_fees_total,'30');
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>s,true,store.payments);assert.equal((await store.payments.pendingRefunds()).length,0);
    }finally{await store.close();}
  });
  test(`${name}: missing and foreign-currency fees stay explicit and block an invented converted contribution`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{await pay(store);const s=financeSnapshot();s.transactions[0]!.currency='JPY';s.transactions[0]!.amountMinor='1500';s.transactions[0]!.feeMinor='50';s.transactions[0]!.netMinor='1450';
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>s);const report=aggregateEconomics(await store.reporting.snapshot(query()),query());
      const usd=report.currencies.find(r=>r.currency==='USD')!,jpy=report.currencies.find(r=>r.currency==='JPY')!;
      assert.equal(usd.cash_minor.payment_fees_total,null);assert.equal(usd.contribution_before_paid_liability_micros,null);assert.equal(jpy.cash_minor.payment_fees_total,'50');
      const claim=(await store.finance.claim('cs_finance',true))!;const future=financeSnapshot();future.transactions[0]!.createdAt=financeAt(1);await assert.rejects(store.finance.finish(claim,future),/Future/);
      assert.equal((await store.finance.inspect('cs_finance')).revision?.generation,'1');
    }finally{await store.close();}
  });
  test(`${name}: a balance transaction cannot be charged to two orders and failed attachment rolls back`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{const d=await pay(store),first=financeSnapshot();first.transactions[0]!.sourceId=null;await reconcilePaymentFinance(store.finance,'cs_finance',async()=>first);
      await store.payments.pay(event('other','cs_other'),{reference:'cs_other',token:d.token,paymentIntentId:'pi_other',chargeId:null,questions:5,amountCents:1000,currency:'USD',packId:'five',catalogVersion:'v1',paidAt:financeAt(0)});
      const second=financeSnapshot();second.charges[0]!.id='ch_other';second.charges[0]!.paymentIntentId='pi_other';second.transactions[0]!.sourceId=null;
      await assert.rejects(reconcilePaymentFinance(store.finance,'cs_other',async()=>second));assert.equal((await store.finance.inspect('cs_other')).revision,null);
      second.transactions[0]!.id='txn_other';second.charges[0]!.transactionId='txn_other';await reconcilePaymentFinance(store.finance,'cs_other',async()=>second,true);
      const report=aggregateEconomics(await store.reporting.snapshot(query()),query());assert.equal(report.currencies[0]!.cash_minor.payment_fees_total,'60');
    }finally{await store.close();}
  });
  test(`${name}: admin finance and signed webhook routes drive durable rechecks with isolated cron authorization`,async()=>{
    const store=await make(),app=Fastify({logger:false}),provider=new MockProvider(),admin={'x-admin-token':'finance_test_admin'};let reads=0;
    try{await pay(store);
      app.removeContentTypeParser('application/json');app.addContentTypeParser('application/json',{parseAs:'buffer'},(req,body,done)=>{(req as typeof req&{rawBody?:Buffer}).rawBody=body as Buffer;try{done(null,JSON.parse(String(body)));}catch{done(new Error('invalid JSON'));}});
      registerRoutes(app,{config:{...config,adminToken:'finance_test_admin',cronSecret:'finance_test_cron',stripeSecretKey:'test_only',stripeWebhookSecret:'finance_test_webhook'},store,storeKind:name as 'memory'|'sqlite'|'postgres',
        provider,objectiveProvider:provider,providerDegraded:null,objectiveProviderDegraded:null,payment:new StripePaymentProvider(),readStripeFinance:async()=>{reads++;return financeSnapshot();}});
      assert.equal((await app.inject({url:'/admin/payments/finance?reference=cs_finance'})).statusCode,401);
      assert.equal((await app.inject({method:'POST',url:'/admin/payments/finance/reconcile',headers:admin,payload:{reference:'cs_finance',amount:0}})).statusCode,400);
      assert.equal((await app.inject({url:'/api/internal/reap',headers:admin})).statusCode,401);assert.equal(reads,0);
      const results=await Promise.all([1,2].map(()=>app.inject({url:'/api/internal/reap',headers:{authorization:'Bearer finance_test_cron'}})));
      assert.equal(results.reduce((s,r)=>s+r.json().finance_reconciled,0),1);assert.equal(reads,1);
      const before=await app.inject({url:'/admin/payments/finance?reference=cs_finance',headers:admin});assert.equal(before.headers['cache-control'],'no-store');assert.equal(before.json().revision.dirty,false);
      const payload=JSON.stringify({id:'evt_webhook_finance',type:'charge.updated',created:Math.floor(Date.now()/1000),data:{object:{id:'ch_finance',payment_intent:'pi_finance'}}});
      assert.equal((await app.inject({method:'POST',url:'/webhooks/stripe',headers:{'content-type':'application/json'},payload})).statusCode,400);
      const ts=Math.floor(Date.now()/1000),signature='t='+ts+',v1='+createHmac('sha256','finance_test_webhook').update(ts+'.'+payload).digest('hex');
      for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':signature},payload})).statusCode,200);
      assert.equal((await store.finance.inspect('cs_finance')).revision?.dirty,true);
      const reconcile=await app.inject({method:'POST',url:'/admin/payments/finance/reconcile',headers:admin,payload:{reference:'cs_finance'}});assert.equal(reconcile.statusCode,200);assert.equal(reconcile.json().applied,true);assert.equal(reconcile.json().revision.dirty,false);assert.equal(reads,2);
    }finally{await app.close();await store.close();}
  });
  test(`${name}: finance resource sets beyond one SQL bind batch preserve every unique fee`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:financeBase});const store=await make();
    try{await pay(store);const s=financeSnapshot();
      for(let i=0;i<99;i++)s.charges.push({id:'ch_attempt_'+i,paymentIntentId:'pi_finance',currency:'USD',capturedMinor:'0',paid:false,transactionId:null});
      for(let i=0;i<100;i++){const id='du_boundary_'+i,tx='txn_boundary_'+i;s.disputes.push({id,chargeId:'ch_finance',paymentIntentId:'pi_finance',currency:'USD',amountMinor:'0',status:'warning_closed',transactionIds:[tx]});
        s.transactions.push(balanceTransaction({id:tx,sourceId:id,category:'fee',amountMinor:'-1',feeMinor:'0',netMinor:'-1'}));}
      await reconcilePaymentFinance(store.finance,'cs_finance',async()=>s);
      const report=aggregateEconomics(await store.reporting.snapshot(query()),query());assert.equal(report.currencies[0]!.cash_minor.payment_fees_total,'130');
      assert.equal((await store.finance.inspect('cs_finance')).revision?.snapshot.disputes.length,100);
    }finally{await store.close();}
  });
}
test('SQLite finance revisions and pending notices survive closing and reopening the database',async t=>{
  t.mock.timers.enable({apis:['Date'],now:financeBase});const dir=await mkdtemp(join(tmpdir(),'finance-restart-')),path=join(dir,'test.sqlite');let store=new SqliteStore(path);
  try{await pay(store);await reconcilePaymentFinance(store.finance,'cs_finance',async()=>financeSnapshot());await store.finance.observe({event:event('restart','ch_finance','charge.updated'),resources:['ch_finance']});
    await store.close();store=new SqliteStore(path);assert.equal((await store.finance.inspect('cs_finance')).revision?.dirty,true);assert.deepEqual(await store.finance.pending(),['cs_finance']);
    const database=new DatabaseSync(path);database.prepare('UPDATE finance_revisions SET digest=?').run('0'.repeat(64));database.close();
    await assert.rejects(store.finance.inspect('cs_finance'),/integrity failure/);await assert.rejects(store.reporting.snapshot(query()),/integrity failure/);
  }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
