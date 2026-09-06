import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupUnallocatedReceipts,receiptIdentity,summarizeUnallocatedReceipts,type ReportReceipt} from '../src/reporting-receipts.ts';
import {aggregateCohorts,aggregateEconomics,type ReportingFacts} from '../src/reporting.ts';
import {checkoutSnapshot} from '../src/checkout-reconciliation.ts';
import {SqliteStore} from '../src/db-sqlite.ts';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const from='2026-01-01T00:00:00.000Z',asOf='2026-02-15T00:00:00.000Z',paid='2026-01-02T00:00:00.000Z';
const receipt=(overrides:Partial<ReportReceipt>={}):ReportReceipt=>({eventId:'evt_paid',checkoutReference:'cs_paid',paymentIntentId:'pi_paid',mode:'payment',amountMinor:'1000',currency:'USD',
  paidAt:paid,recordedAt:paid,recordedTimeKnown:true,deviceId:1,isInternal:false,identityConflict:false,matchedOrders:[],...overrides});
const group=(rows:ReportReceipt[])=>groupUnallocatedReceipts(rows,from,asOf);
test('paid receipt groups deduplicate both resource keys and keep currencies and unknown net separate',()=>{
  const rows=group([receipt(),receipt({eventId:'evt_duplicate'}),receipt({eventId:'evt_alias',checkoutReference:'cs_alias'}),receipt({eventId:'evt_jpy',checkoutReference:'cs_jpy',paymentIntentId:'pi_jpy',currency:'JPY',amountMinor:'500',deviceId:null})]);
  assert.equal(rows.length,2);assert.equal(rows[0]!.receipt_count,3);
  const summary=summarizeUnallocatedReceipts(rows,new Set([1]),new Set());
  assert.deepEqual(summary.cohort_uncredited.currencies,[{currency:'USD',confirmed_gross_minor:'1000',unresolved_groups:0,net_minor:null}]);
  assert.equal(summary.account_unassigned.currencies[0]!.confirmed_gross_minor,'500');
});
test('transitive resource conflicts, different amounts and different signed identities stay unresolved',()=>{
  for(const other of [receipt({amountMinor:'999'}),receipt({currency:'JPY'}),receipt({deviceId:2}),receipt({paymentIntentId:'pi_other'})]) {
    const row=group([receipt(),other])[0]!;assert.equal(row.state,'conflict');assert.equal(row.amount_minor,null);
  }
  assert.equal(group([receipt(),receipt({checkoutReference:'cs_alias'}),receipt({checkoutReference:'cs_alias',paymentIntentId:'pi_other'})]).length,1);
});
test('a credited order suppresses matching and previously incomplete receipts but not contradictory evidence',()=>{
  const matchedOrders=[{reference:'cs_paid',deviceId:1,paymentIntentId:'pi_paid',amountMinor:'1000',currency:'USD'}];
  assert.equal(group([receipt({matchedOrders})])[0]!.state,'credited');
  assert.equal(group([receipt({matchedOrders,amountMinor:null,paymentIntentId:null,deviceId:null,identityConflict:true})])[0]!.state,'credited');
  assert.equal(group([receipt({matchedOrders,amountMinor:'2000'})])[0]!.state,'conflict');
  assert.equal(group([receipt({matchedOrders,deviceId:2})])[0]!.credit_conflict,true);
});
test('missing cash identity, timestamp, amount or product mode never produces a zero-valued complete total',()=>{
  for(const override of [{paymentIntentId:null},{paidAt:null},{amountMinor:null},{currency:null},{mode:'unknown' as const},{amountMinor:'0'},{recordedTimeKnown:false}]) {
    const row=group([receipt(override)])[0]!;assert.equal(row.state,'incomplete');assert.equal(row.amount_minor,null);
  }
  assert.equal(group([receipt({recordedAt:'2026-02-16T00:00:00.000Z'})]).length,0);
  assert.equal(group([receipt({recordedAt:'2025-12-31T00:00:00.000Z'})]).length,0);
});
test('receipt attribution respects creation time and rejects conflicting device/purchase identity',()=>{
  const snapshot=checkoutSnapshot({id:'cs_identity',mode:'payment',payment_status:'paid',amount_total:1000,currency:'usd',payment_intent:'pi_identity',metadata:{}});
  snapshot.deviceTokenHash='a'.repeat(64);snapshot.purchaseSessionId='11111111-1111-4111-8111-111111111111';
  assert.deepEqual(receiptIdentity(snapshot,paid,{id:1,createdAt:from},{deviceId:1,createdAt:from}),{deviceId:1,identityConflict:false});
  assert.equal(receiptIdentity(snapshot,paid,{id:1,createdAt:asOf},{deviceId:1,createdAt:from}).deviceId,null);
  assert.deepEqual(receiptIdentity(snapshot,paid,{id:2,createdAt:from},{deviceId:1,createdAt:from}),{deviceId:null,identityConflict:true});
});
test('uncredited known devices affect P28 uncertainty and contribution without inventing payment or quota',()=>{
  const facts:ReportingFacts={devices:[{id:1,registeredAt:from,policyVersion:'fixed30',isInternal:false}],sources:[],events:[],preferences:[],observations:[],captures:[],orders:[],refunds:[],adjustments:[],attempts:[],lots:[],expenses:[],untrackedQuotaDeviceIds:[],receipts:[receipt()]};
  const q={cohortFrom:from,cohortTo:paid,asOf};
  assert.equal(aggregateCohorts(facts,q).p28.unknown_payment_devices,1);assert.equal(aggregateCohorts(facts,q).p28.numerator,0);
  const report=aggregateEconomics(facts,q);assert.equal(report.currencies[0]!.cash_minor.confirmed,'0');assert.ok(report.currencies[0]!.incomplete_inputs.includes('unallocated_paid_receipts'));
  assert.equal(report.currencies[0]!.contribution_before_paid_liability_micros,null);assert.equal(report.paid_questions.remaining,'0');
  facts.receipts![0]!.isInternal=true;assert.equal(aggregateEconomics(facts,q).unallocated_receipts.cohort_uncredited.payment_groups,0);
});
test('account unassigned is distinct from source cohorts and remains visible with no registrations',()=>{
  const rows=group([receipt({deviceId:null}),receipt({checkoutReference:'cs_other',paymentIntentId:'pi_other',deviceId:2}),receipt({checkoutReference:'cs_internal',paymentIntentId:'pi_internal',deviceId:3,isInternal:true})]);
  const result=summarizeUnallocatedReceipts(rows,new Set(),new Set());assert.equal(result.account_unassigned.payment_groups,1);assert.equal(result.cohort_uncredited.payment_groups,0);assert.equal(result.other_registered_devices_pending,1);
});
test('a conflicting internal identity cannot hide external cash evidence from the account review pool',()=>{
  const rows=group([receipt(),receipt({eventId:'evt_internal_conflict',deviceId:2,isInternal:true})]);
  assert.equal(rows[0]!.state,'conflict');assert.equal(rows[0]!.device_id,null);assert.equal(rows[0]!.is_internal,false);
  const summary=summarizeUnallocatedReceipts(rows,new Set([1]),new Set([2]));
  assert.equal(summary.account_unassigned.conflicts,1);assert.equal(summary.account_unassigned.currencies[0]!.confirmed_gross_minor,'0');
});
test('existing SQLite receipt schema upgrades without inventing a verified historical projection time',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nspi-receipt-migration-')),path=join(dir,'legacy.sqlite3');let store=new SqliteStore(path);
  try {
    const event={id:'evt_legacy_projection',resourceId:'cs_legacy_projection',type:'checkout.session.completed',createdAt:new Date().toISOString(),payloadHash:'a'.repeat(64)};
    await store.payments.checkouts.receive(event,checkoutSnapshot({id:event.resourceId,mode:'payment',payment_status:'paid',amount_total:1000,currency:'usd',payment_intent:'pi_legacy_projection',metadata:{}}));await store.close();
    const database=new DatabaseSync(path);database.exec('DROP INDEX idx_reporting_checkout_recorded; ALTER TABLE checkout_deliveries DROP COLUMN recorded_at;');database.close();
    store=new SqliteStore(path);const q={cohortFrom:from,cohortTo:paid,asOf:new Date().toISOString()},facts=await store.reporting.snapshot(q);
    assert.equal(facts.receipts![0]!.recordedTimeKnown,false);
    const result=aggregateEconomics(facts,q).unallocated_receipts.account_unassigned;
    assert.equal(result.incomplete,1);assert.equal(result.legacy_timing_unknown_groups,1);assert.equal(result.currencies[0]!.confirmed_gross_minor,'0');
  }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
