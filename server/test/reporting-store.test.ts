import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MemoryStore} from '../src/db-memory.ts';
import {SqliteStore} from '../src/db-sqlite.ts';
import type {Store} from '../src/db.ts';
import {aggregateCohorts,aggregateEconomics,type ReportQuery} from '../src/reporting.ts';
import {assembleReport} from '../src/report-archive.ts';
import {QualityConflictError} from '../src/quality.ts';
import {qualityFixture,signFixture} from './helpers/quality-fixture.ts';
import {checkoutSnapshot} from '../src/checkout-reconciliation.ts';

const factories:Array<[string,()=>Store|Promise<Store>]>=[['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')]];
if(process.env.TEST_POSTGRES_URL){
  const original=new URL(process.env.TEST_POSTGRES_URL);if(!/test/i.test(original.pathname))throw new Error('Test database required');
  const {PostgresStore,resolvePostgresSSL}=await import('../src/db-postgres.ts');const pg=(await import('pg')).default;
  factories.push(['postgres',async()=>{
    const pool=new pg.Pool({connectionString:original.toString(),ssl:resolvePostgresSSL({connectionString:original.toString()})});
    const schema='report_test_'+randomUUID().replaceAll('-','');await pool.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(original);url.searchParams.set('options','-c search_path='+schema);
    const store=new PostgresStore(url.toString(),resolvePostgresSSL({connectionString:url.toString()})),close=store.close.bind(store);
    store.close=async()=>{await close();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();};return store;
  }]);
}
const base=Date.parse('2026-01-01T00:00:00.000Z');
const at=(day:number)=>new Date(base+day*86_400_000).toISOString();
const query=(day:number):ReportQuery=>({cohortFrom:at(0),cohortTo:at(1),asOf:at(day)});
const receipt=(id:string,resourceId:string,type='checkout.session.completed')=>({id:'evt_'+id,resourceId,type,createdAt:new Date().toISOString(),payloadHash:'a'.repeat(64)});

for(const [name,make] of factories){
  test(`${name}: adopting an earlier webhook receipt never backdates newly stored cash evidence`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const event=receipt('adopted_receipt','cs_adopted_receipt');await store.payments.acknowledge(event);
      t.mock.timers.setTime(base+4*86_400_000);
      await store.payments.checkouts.receive(event,checkoutSnapshot({id:event.resourceId,mode:'payment',payment_status:'paid',amount_total:1000,currency:'usd',payment_intent:'pi_adopted_receipt',metadata:{}}));
      assert.equal((await store.reporting.snapshot(query(3))).receipts!.length,0);
      const current=await store.reporting.snapshot(query(5));assert.equal(current.receipts!.length,1);assert.equal(current.receipts![0]!.recordedAt,at(4));
    }finally{await store.close();}
  });
  test(`${name}: signed paid receipts survive historical reports and never double-count credited intents`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const d=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:0,policyVersion:'fixed30-test'});
      t.mock.timers.setTime(base+2*86_400_000);
      const known=receipt('known_receipt','cs_known_receipt'),unknown=receipt('unknown_receipt','cs_unknown_receipt');
      const input={mode:'payment',payment_status:'paid',amount_total:1000,currency:'usd'};
      const knownSnapshot=checkoutSnapshot({...input,id:known.resourceId,payment_intent:'pi_known_receipt',metadata:{device_token:d.token,pack_id:'five'}});
      await store.payments.checkouts.receive(known,knownSnapshot);await store.payments.checkouts.receive(known,knownSnapshot);
      await store.payments.checkouts.receive(unknown,checkoutSnapshot({...input,id:unknown.resourceId,payment_intent:'pi_unknown_receipt',metadata:{}}));
      t.mock.timers.setTime(base+3*86_400_000);
      const before=await store.reporting.snapshot(query(3)),report=aggregateEconomics(before,query(3));assert.equal(before.receipts!.length,2);
      assert.equal(report.unallocated_receipts.cohort_uncredited.currencies[0]!.confirmed_gross_minor,'1000');assert.equal(report.unallocated_receipts.account_unassigned.currencies[0]!.confirmed_gross_minor,'1000');
      assert.doesNotMatch(JSON.stringify(before.receipts),new RegExp(d.token));assert.doesNotMatch(JSON.stringify(before.receipts),/deviceTokenHash|device_token|secretHash/);
      t.mock.timers.setTime(base+4*86_400_000);
      await store.payments.pay(known,{reference:known.resourceId,token:d.token,paymentIntentId:'pi_known_receipt',chargeId:null,questions:5,amountCents:1000,currency:'USD',packId:'five',catalogVersion:'v1',paidAt:at(2)});
      assert.deepEqual(await store.reporting.snapshot(query(3)),before,'future credit must not remove a historically unallocated receipt');
      t.mock.timers.setTime(base+5*86_400_000);
      const alias=receipt('alias_receipt','cs_alias_receipt');await store.payments.checkouts.receive(alias,checkoutSnapshot({...input,id:alias.resourceId,payment_intent:'pi_known_receipt',metadata:{}}));
      const after=aggregateEconomics(await store.reporting.snapshot(query(5)),query(5));
      assert.equal(after.unallocated_receipts.cohort_uncredited.payment_groups,0);assert.equal(after.unallocated_receipts.credited_groups_excluded,1);
      assert.equal(after.currencies[0]!.cash_minor.confirmed,'1000');assert.equal(after.paid_questions.remaining,'5');assert.equal(after.unallocated_receipts.account_unassigned.payment_groups,1);
      const empty={...query(5),cohortFrom:at(1),cohortTo:at(1.5)},outside=aggregateEconomics(await store.reporting.snapshot(empty),empty);
      assert.equal(outside.registered,0);assert.equal(outside.unallocated_receipts.credited_groups_excluded,1);assert.equal(outside.unallocated_receipts.account_unassigned.payment_groups,1);
    }finally{await store.close();}
  });
  test(`${name}: signed purchase identity, internal exclusion and conflicting deliveries preserve cash uncertainty`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const d=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:0,policyVersion:'fixed30-test'});
      const purchase=await store.createPurchaseSession({token:d.token,purchaseId:randomUUID(),packId:'five',catalogVersion:'v1',questions:5,amountCents:1000,currency:'USD',lang:'en'});assert.ok(purchase);
      t.mock.timers.setTime(base+2*86_400_000);
      const event=receipt('purchase_receipt','cs_purchase_receipt'),snapshot=checkoutSnapshot({id:event.resourceId,mode:'payment',payment_status:'paid',amount_total:1000,currency:'usd',payment_intent:'pi_purchase_receipt',metadata:{purchase_session_id:purchase.sessionId}});
      await store.payments.checkouts.receive(event,snapshot);
      let facts=await store.reporting.snapshot(query(3));assert.equal(facts.receipts![0]!.deviceId,d.id);
      await store.reporting.setInternal(d.id,true,'test-receipt-internal');facts=await store.reporting.snapshot(query(3));
      assert.equal(facts.receipts![0]!.isInternal,true);assert.equal(aggregateEconomics(facts,query(3)).unallocated_receipts.cohort_uncredited.payment_groups,0);
      await store.reporting.setInternal(d.id,false,'test-receipt-external');
      const prior=await store.reporting.snapshot(query(3));
      t.mock.timers.setTime(base+4*86_400_000);
      await store.payments.checkouts.receive(receipt('conflicting_receipt',event.resourceId),{...snapshot,amountCents:999});
      assert.deepEqual(await store.reporting.snapshot(query(3)),prior,'later mutable case flags must not leak into earlier signed evidence');
      const after=aggregateEconomics(await store.reporting.snapshot(query(5)),query(5));assert.equal(after.unallocated_receipts.cohort_uncredited.conflicts,1);
      assert.equal(after.unallocated_receipts.cohort_uncredited.currencies[0]!.confirmed_gross_minor,'0');
    }finally{await store.close();}
  });
  test(`${name}: quality revisions preserve execution identity, withdrawal and exact combination filtering`,async()=>{
    const store=await make();
    try{
      const input=qualityFixture('store-quality');
      const initial=await Promise.all(Array.from({length:4},()=>store.reporting.quality.record(input)));
      assert.ok(initial.every(r=>r.id===initial[0]!.id&&r.revision===initial[0]!.revision));
      const original=structuredClone(initial[0]!);initial[0]!.report.overall.samples=999;
      assert.deepEqual(await store.reporting.quality.get(original.id),original);
      input.cases[0]!.answer_correct=false;signFixture(input);const revision=await store.reporting.quality.record(input);
      assert.notEqual(revision.id,original.id);assert.equal(BigInt(revision.revision),BigInt(original.revision)+1n);
      const latest=await store.reporting.quality.list({limit:20});assert.equal(latest.items.length,1);assert.equal(latest.items[0]!.id,revision.id);
      const firstPage=await store.reporting.quality.list({limit:1,includeHistory:true});assert.ok(firstPage.next_revision);
      const secondPage=await store.reporting.quality.list({limit:1,includeHistory:true,beforeRevision:firstPage.next_revision!});assert.equal(secondPage.items[0]!.id,original.id);assert.equal(secondPage.next_revision,null);
      assert.equal(await store.reporting.quality.withdraw(revision.id,'withdraw-1','scoring_error'),true);
      assert.equal(await store.reporting.quality.withdraw(revision.id,'withdraw-1','scoring_error'),true);
      assert.equal(await store.reporting.quality.withdraw(revision.id,'withdraw-2','scoring_error'),false);
      assert.equal(await store.reporting.quality.withdraw(original.id,'withdraw-1','scoring_error'),false);
      assert.equal((await store.reporting.quality.list({limit:20})).items[0]!.withdrawal?.reason,'scoring_error','withdrawal cannot resurrect an older active revision');
      const rebound=structuredClone(input);rebound.run.commit='b'.repeat(40);signFixture(rebound);
      await assert.rejects(()=>store.reporting.quality.record(rebound),QualityConflictError);
      const mixed=qualityFixture('mixed-quality');mixed.cases[0]!.profile='spi';mixed.cases[0]!.language='en';signFixture(mixed);await store.reporting.quality.record(mixed);
      assert.equal((await store.reporting.quality.list({limit:20,profile:'spi',language:'ja'})).items.length,0,'dimensions must match the same cell');
      assert.equal((await store.reporting.quality.list({limit:20,profile:'spi',language:'en'})).items.length,1);
      await store.pruneProductEvents('2099-01-01T00:00:00.000Z');assert.deepEqual(await store.reporting.quality.get(original.id),original);
      assert.equal(await store.reporting.quality.get('f'.repeat(64)),null);
    }finally{await store.close();}
  });
  test(`${name}: an empty registration cohort retains audited expenses and null per-device contribution`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const expense={reference:'empty-cohort-cost',kind:'service' as const,currency:'USD',amountMicros:'1230000',cohortFrom:at(0),cohortTo:at(1),coverageThrough:at(60)};
      assert.equal(await store.reporting.expense(expense),true);
      assert.equal(await store.reporting.expense(Object.fromEntries(Object.entries(expense).reverse()) as typeof expense),true);
      t.mock.timers.setTime(base+40*86_400_000);
      const report=assembleReport(await store.reporting.snapshot(query(40)),query(40));
      assert.equal(report.economics.registered,0);assert.equal(report.economics.currencies.length,1);
      assert.equal(report.economics.currencies[0]!.allocated_service_expenses_micros,'1230000');
      assert.equal(report.economics.currencies[0]!.contribution_before_paid_liability_micros,null);
      assert.equal(report.economics.currencies[0]!.paid_liability_scenarios[0]!.contribution_per_registered_device_micros,null);
    }finally{await store.close();}
  });
  test(`${name}: immutable archives survive fact retention, revisions and concurrent retries`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const d=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:30,policyVersion:'fixed30'});
      t.mock.timers.setTime(base+40*86_400_000);
      const original=assembleReport(await store.reporting.snapshot(query(40)),query(40));
      const archives=await Promise.all(Array.from({length:8},()=>store.reporting.archives.save(original)));
      assert.ok(archives.every(a=>a.id===archives[0]!.id&&a.created_at===archives[0]!.created_at));
      assert.equal(archives[0]!.status,'immutable_snapshot');
      assert.equal(archives[0]!.report.cohort.registered,1);
      await store.reporting.setInternal(d.id,true,'archive-internal');
      const revision=await store.reporting.archives.save(assembleReport(await store.reporting.snapshot(query(40)),query(40)));
      assert.notEqual(revision.id,archives[0]!.id);assert.equal(revision.report.cohort.registered,0);
      await store.pruneProductEvents(at(150));
      assert.deepEqual(await store.reporting.archives.get(archives[0]!.id),archives[0]);
      original.cohort.registered=999;archives[0]!.report.cohort.registered=999;
      assert.equal((await store.reporting.archives.get(archives[0]!.id))!.report.cohort.registered,1,'caller mutation cannot rewrite archived payload');
      const page1=await store.reporting.archives.list(1);assert.equal(page1.items.length,1);assert.ok(page1.next_cursor);
      const page2=await store.reporting.archives.list(1,page1.next_cursor!);assert.equal(page2.items.length,1);assert.equal(page2.next_cursor,null);
      assert.notEqual(page1.items[0]!.id,page2.items[0]!.id,'same-millisecond pagination does not skip rows');
      assert.equal('report' in page1.items[0]!,false);assert.equal(await store.reporting.archives.get('a'.repeat(64)),null);
      await assert.rejects(()=>store.reporting.archives.list(51));await assert.rejects(()=>store.reporting.archives.list(1,'invalid'));
    }finally{await store.close();}
  });
  test(`${name}: report reconstructs historical paid quota and costs without future refund leakage`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const d=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:0,policyVersion:'fixed30-test'});
      t.mock.timers.setTime(base+86_400_000);
      await store.payments.pay(receipt('paid','cs_report'),{reference:'cs_report',token:d.token,paymentIntentId:'pi_report',chargeId:null,
        questions:5,amountCents:1000,currency:'USD',packId:'five',catalogVersion:'v1',paidAt:at(1)});
      t.mock.timers.setTime(base+2*86_400_000);
      const captureId=randomUUID(),attemptId=randomUUID();
      assert.equal((await store.billing.begin({token:d.token,captureId,requestHmac:'h'})).ok,true);
      await store.billing.reserveBudget(d.token,attemptId,'official','USD',200,10000);
      await store.billing.startAttempt(d.token,{attemptId,captureId,purpose:'answer',provider:'test',model:'model',policyVersion:'policy',currency:'USD',pricingVersion:'prices'});
      await store.billing.finishAttempt(d.token,attemptId,{status:'succeeded',inputTokens:10,outputTokens:1,costMicros:'80'});
      await store.billing.finish({token:d.token,captureId,charge:true,terminalState:'usable'});
      t.mock.timers.setTime(base+3*86_400_000);
      const before=await store.reporting.snapshot(query(3));
      assert.equal(before.lots.find(l=>l.kind==='paid')?.remaining,'4');assert.equal(before.attempts.length,1);
      assert.equal(before.attempts[0]?.costMicros,'80');assert.equal(before.attempts[0]?.upperMicros,'200');
      t.mock.timers.setTime(base+4*86_400_000);
      const claim=await store.payments.claimRefund(receipt('refunded','re_report','refund.updated'));assert.ok(claim);
      await store.payments.applyRefund(claim,{id:'re_report',paymentIntentId:'pi_report',chargeId:null,amountCents:1000,currency:'USD',status:'succeeded'});
      t.mock.timers.setTime(base+5*86_400_000);
      assert.deepEqual(await store.reporting.snapshot(query(3)),before,'same as_of keeps prior lots, payment and cost revisions');
      const after=await store.reporting.snapshot(query(5));
      assert.equal(after.lots.find(l=>l.kind==='paid')?.remaining,'0');assert.equal(after.lots.find(l=>l.kind==='paid')?.revoked,'4');
      const economic=aggregateEconomics(after,query(5));assert.equal(economic.currencies[0]?.cash_minor.net,'0');
      assert.equal(economic.currencies[0]?.inference_micros.known_subtotal,'80','refunds do not erase already incurred inference');
    }finally{await store.close();}
  });
  test(`${name}: internal markings, source and expense allocations are audited and idempotent`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const d=await store.registerDevice({platform:'macos',appVersion:'2.12',trialQuestions:30,policyVersion:'fixed30'});
      assert.equal(await store.reporting.source(d.token,'reading_practice_entry','self_reported'),true);
      assert.equal(await store.reporting.source(d.token,'reading_practice_entry','self_reported'),true);
      assert.equal(await store.reporting.source(d.token,'spi_entry','self_reported'),false);
      const expense={reference:'allocation',kind:'service' as const,currency:'USD',amountMicros:'9007199254740993',cohortFrom:at(0),cohortTo:at(1),coverageThrough:at(60)};
      assert.equal(await store.reporting.expense(expense),true);assert.equal(await store.reporting.expense(expense),true);
      assert.equal(await store.reporting.expense({...expense,amountMicros:'1'}),false);
      assert.equal(await store.reporting.expense({...expense,reference:'aaa-new-allocation',amountMicros:'2'}),true);
      t.mock.timers.setTime(base+40*86_400_000);
      const facts=await store.reporting.snapshot(query(40));
      assert.equal(facts.expenses[0]?.amountMicros,'9007199254740993');
      assert.equal(aggregateEconomics(facts,query(40)).currencies[0]?.allocated_service_expenses_micros,'2','same-millisecond allocations use transaction revision, not reference sort');
      assert.equal(aggregateCohorts(facts,{...query(40),source:'reading_practice_entry'}).registered,1);
      assert.equal(await store.reporting.setInternal(d.id,true,'internal-1'),true);
      assert.equal(await store.reporting.setInternal(d.id,false,'internal-1'),false);
      assert.equal(aggregateCohorts(await store.reporting.snapshot(query(40)),query(40)).registered,0);
    }finally{await store.close();}
  });
  test(`${name}: legacy paid orders and unpriced usage remain unknown instead of vanishing`,async t=>{
    t.mock.timers.enable({apis:['Date'],now:base});const store=await make();
    try{
      const d=await store.registerDevice({platform:'macos',appVersion:'old',trialQuestions:1});
      t.mock.timers.setTime(base+86_400_000);
      await store.credit({token:d.token,questions:10,amountCents:1000,currency:'JPY',provider:'stripe',reference:'cs_legacy_report'});
      await store.reserveQuestions({token:d.token,questions:1});
      await store.settleReservation({token:d.token,questions:1,inputTokens:100,outputTokens:10,model:'legacy'});
      t.mock.timers.setTime(base+40*86_400_000);
      const facts=await store.reporting.snapshot(query(40)),report=aggregateEconomics(facts,query(40));
      assert.equal(facts.orders.length,1);assert.equal(report.currencies.find(c=>c.currency==='JPY')?.cash_minor.confirmed,'1000');
      assert.equal(report.currencies.find(c=>c.currency==='JPY')?.cash_minor.net,null);
      assert.equal(report.currencies.find(c=>c.currency===null)?.inference_micros.unknown_count,1);
      assert.equal(aggregateCohorts(facts,query(40)).p28.unknown_payment_devices,1);
    }finally{await store.close();}
  });
}
