import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {aggregateCohorts,aggregateEconomics,observationCoverage,parseReportQuery,proportion,DAY,type ReportingFacts,type ReportQuery} from '../src/reporting.ts';
import type {StoredProductEvent} from '../src/db.ts';
import {aggregateProductMetrics} from '../src/telemetry.ts';

const registered='2026-01-01T00:00:00.000Z';
const at=(days:number)=>new Date(Date.parse(registered)+days*DAY).toISOString();
const query=(days=40):ReportQuery=>({cohortFrom:registered,cohortTo:at(1),asOf:at(days)});
function facts():ReportingFacts{return {devices:[{id:1,registeredAt:registered,policyVersion:'fixed30',isInternal:false}],sources:[],events:[],preferences:[],observations:[],
  captures:[],orders:[],refunds:[],adjustments:[],attempts:[],lots:[],expenses:[],untrackedQuotaDeviceIds:[]};}
function event(days:number,channel='official',id=1,capture=randomUUID()):StoredProductEvent{return {
  eventId:randomUUID(),deviceId:id,captureId:capture,occurredAt:at(days),receivedAt:at(days),eventName:'capture_completed',trigger:'capture_hotkey',
  channel,mode:'tutor',depth:'brief',contextCount:0,questionKind:'single_choice',resultState:'ready',parserPath:'v1',errorCode:null,action:null,
  captureMs:1,firstTokenMs:2,totalMs:3,appVersion:'2.12',configRevision:'test',variant:'objective_v1',
  extensions:{schema_version:2,usable_result:true,operation:'solve',completion_kind:'usable',consent_epoch:0,event_sequence:0,profile_id:'spi'}};}
function cover(f:ReportingFacts,from=0,to=40,id=1){
  f.preferences.push({deviceId:id,consentEpoch:0,sharingEnabled:true,validFrom:at(from),recordedAt:at(from)});
  for(let d=from;d<to;d+=7)f.observations.push({deviceId:id,observationId:randomUUID(),consentEpoch:0,validFrom:at(d),validTo:at(Math.min(to,d+7)),
    sequenceFrom:0,sequenceTo:0,queueDropCount:0,coverageStatus:'complete',gapReason:'none',receivedAt:at(Math.min(to,d+7))});
}
test('A28 uses all mature registrations; incomplete observation stays unknown, not confirmed inactive',()=>{
  const f=facts();f.devices.push({id:2,registeredAt:registered,policyVersion:'fixed30',isInternal:false});f.events.push(event(1));
  const report=aggregateCohorts(f,query());const a=report.channels[0]!.activation28;
  assert.equal(a.numerator,1);assert.equal(a.denominator,2);assert.equal(a.rate,.5);assert.equal(a.unknown_without_confirmed_activation,1);
  assert.equal(a.confirmed_inactive,0);assert.equal(a.observed_only.rate,null);
});
test('R28 uses half-open 28 days and distinct UTC dates; registration maturity and freeze are separate',()=>{
  const f=facts();cover(f);f.events.push(event(0.5),event(1.1),event(1.9),event(28.5));
  let r=aggregateCohorts(f,query()).channels[0]!.repeat28;
  assert.equal(r.numerator,0,'event exactly at first+28d is excluded; two events on same UTC date count once');assert.equal(r.denominator,1);
  f.events.push(event(2.01));r=aggregateCohorts(f,query()).channels[0]!.repeat28;
  assert.equal(r.numerator,1);assert.equal(r.frozen.numerator,1);
  const early=facts();cover(early,0,29);early.events.push(event(.5),event(1.01),event(2.01));
  const preliminary=aggregateCohorts(early,query(29)).channels[0]!.repeat28;
  assert.equal(preliminary.preliminary,true);assert.equal(preliminary.frozen.denominator,0);
  assert.equal(aggregateCohorts(f,query(27.999)).mature_registered,0);
});
test('channels stay separate; mixed explicitly deduplicates device UTC dates',()=>{
  const f=facts();cover(f);f.events.push(event(.5),event(1.5,'custom_key'),event(2.5,'cli'));
  assert.deepEqual(aggregateCohorts(f,query()).channels.map(c=>c.repeat28.numerator),[0,0,0]);
  assert.equal(aggregateCohorts(f,{...query(),channel:'mixed'}).channels[0]!.repeat28.numerator,1);
});
test('late opt-out invalidates prior complete claims; absent origin coverage cannot invent first success',()=>{
  const f=facts();cover(f);f.events.push(event(1),event(2),event(3));
  f.preferences.push({deviceId:1,consentEpoch:1,sharingEnabled:false,validFrom:at(10),recordedAt:at(31)});
  assert.equal(observationCoverage(f,1,registered,at(29),at(40)),'telemetry_disabled');
  assert.equal(aggregateCohorts(f,query()).channels[0]!.repeat28.denominator,0);
  const missing=facts();cover(missing,1,40);missing.events.push(event(1.5),event(2),event(3));
  const result=aggregateCohorts(missing,query()).channels[0]!.repeat28;
  assert.equal(result.first_success_origin_unknown,1);assert.equal(result.coverage.unknown,1);
});
test('late event receipt changes the revision without substituting received time for occurrence',()=>{
  const f=facts();cover(f);const e=event(27.9);e.receivedAt=at(33);f.events.push(e);
  assert.equal(aggregateCohorts(f,query(30)).channels[0]!.activation28.numerator,0);
  assert.equal(aggregateCohorts(f,query(34)).channels[0]!.activation28.numerator,1);
  assert.notEqual(aggregateCohorts(f,query(30)).revision,aggregateCohorts(f,query(34)).revision);
});
test('capture identity is device-scoped and duplicate completions, auxiliary, hint, QA and internal data are excluded',()=>{
  const f=facts();const e=event(1);f.events.push(e,{...e,eventId:randomUUID()});
  f.events.push({...event(2),depth:'hint'},{...event(3),trigger:'qa'},{...event(4),extensions:{schema_version:2,operation:'recover',usable_result:true,completion_kind:'usable'}});
  f.devices.push({id:2,registeredAt:registered,policyVersion:'fixed30',isInternal:true});f.events.push(event(1,'official',2));
  assert.equal(aggregateCohorts(f,query()).channels[0]!.usable_deliveries,1);
  f.events.push({...e,eventId:randomUUID(),resultState:'retake'});
  assert.equal(aggregateCohorts(f,query()).conflicting_completions_excluded,1);
});
test('P28 keeps non-exhausted devices in denominator and late successful full refunds restate payment',()=>{
  const f=facts();f.devices.push({id:2,registeredAt:registered,policyVersion:'fixed30',isInternal:false});
  f.orders.push({reference:'cs_paid',deviceId:1,paymentIntentId:'pi_paid',chargeId:null,amountMinor:'1000',currency:'JPY',paidAt:at(2),recordedAt:at(2)});
  f.refunds.push({snapshot:{id:'re_paid',paymentIntentId:'pi_paid',chargeId:null,amountCents:1000,currency:'JPY',status:'pending'},generation:'1',recordedAt:at(29)});
  assert.equal(aggregateCohorts(f,query(30)).p28.rate,.5);
  f.refunds.push({snapshot:{...f.refunds[0]!.snapshot,status:'succeeded'},generation:'2',recordedAt:at(31)});
  assert.equal(aggregateCohorts(f,query(32)).p28.rate,0);assert.equal(aggregateCohorts(f,query(32)).p28.fully_refunded_devices,1);
  assert.equal(aggregateCohorts(f,query(30)).p28.rate,.5,'future revision cannot rewrite an earlier knowledge cutoff');
});
test('economics retains failed and auxiliary costs, unknown upper bounds, exact integers and separate currencies',()=>{
  const f=facts();f.events.push(event(1));
  f.orders.push({reference:'cs_jpy',deviceId:1,paymentIntentId:'pi_jpy',chargeId:null,amountMinor:'9007199254740993',currency:'JPY',paidAt:at(1),recordedAt:at(1)});
  for(const [id,purpose,cost,upper] of [['a','answer','100','200'],['b','explain','20','80'],['c','recover',null,'300']] as const)
    f.attempts.push({id,deviceId:1,captureId:randomUUID(),purpose,currency:'USD',costMicros:cost,upperMicros:upper,revision:'2',pricingVersion:'p1',startedAt:at(1),calculatedAt:at(1),status:id==='c'?'failed':'succeeded'});
  const report=aggregateEconomics(f,query());assert.equal(report.currencies.length,2);
  assert.equal(report.currencies[0]!.cash_minor.confirmed,'9007199254740993');
  const cost=report.currencies[1]!.inference_micros;assert.equal(cost.known_subtotal,'120');assert.equal(cost.total,null);assert.equal(cost.conservative_upper,'420');
  assert.equal(cost.cost_per_client_usable_solve,null);assert.equal(cost.by_purpose.recover,1);
});
test('single-currency contribution subtracts refunds once and accounts for paid liability independently of trial',()=>{
  const f=facts();f.events.push(event(1));
  f.orders.push({reference:'cs_usd',deviceId:1,paymentIntentId:'pi_usd',chargeId:null,amountMinor:'1000',currency:'USD',paidAt:at(1),recordedAt:at(1)});
  f.refunds.push({snapshot:{id:'re_usd',paymentIntentId:'pi_usd',chargeId:null,amountCents:200,currency:'USD',status:'succeeded'},generation:'1',recordedAt:at(2)});
  f.adjustments.push({reference:'fee',orderReference:'cs_usd',type:'fee',amountMinor:'30',currency:'USD',status:'applied',effectiveAt:at(1),recordedAt:at(1)});
  f.attempts.push({id:'a',deviceId:1,captureId:randomUUID(),purpose:'answer',currency:'USD',costMicros:'100',upperMicros:'100',revision:'2',pricingVersion:'p',startedAt:at(1),calculatedAt:at(1),status:'succeeded'});
  f.lots.push({id:'paid',deviceId:1,kind:'paid',granted:'10',remaining:'5',held:'1',revoked:'0',createdAt:registered,sourceRef:'cs_usd'},
    {id:'trial',deviceId:1,kind:'trial',granted:'30',remaining:'30',held:'0',revoked:'0',createdAt:registered,sourceRef:'trial'});
  f.expenses.push({reference:'service',kind:'service',currency:'USD',amountMicros:'400',cohortFrom:registered,cohortTo:at(1),coverageThrough:at(50),recordedAt:at(1)},
    {reference:'acquisition',kind:'acquisition',currency:'USD',amountMicros:'1000',cohortFrom:registered,cohortTo:at(1),coverageThrough:at(50),recordedAt:at(1)});
  const report=aggregateEconomics(f,query()),row=report.currencies[0]!;
  assert.deepEqual(row.contribution_before_paid_liability_micros,{numerator:'7699500',denominator:'1'});
  assert.equal(report.paid_questions.remaining,'5');assert.equal(report.unused_trial_questions,'30');
  assert.deepEqual(row.paid_liability_scenarios[2]!.contribution_per_registered_device_micros,{numerator:'7699000',denominator:'1'});
});
test('empty denominators return null and report filters reject time, free text and mixed money dimensions',()=>{
  assert.equal(proportion(0,0).rate,null);assert.equal(proportion(1,1).confidence_interval_95?.upper,1);
  assert.equal(aggregateCohorts({...facts(),devices:[]},query()).p28.rate,null);
  assert.throws(()=>parseReportQuery({cohort_from:'2026-02-31',cohort_to:'2026-03-03'},Date.parse(at(100))));
  assert.throws(()=>parseReportQuery({channel:['official']},Date.parse(at(100))));
  assert.throws(()=>parseReportQuery({profile:'spi'},Date.parse(at(100)),true));
});
test('trial exhaustion is separate from P28 and reports follow-up time',()=>{
  const f=facts();f.lots.push({id:'trial',deviceId:1,kind:'trial',granted:'2',remaining:'0',held:'0',revoked:'0',createdAt:registered,sourceRef:'trial'});
  for(const day of [1,2])f.captures.push({deviceId:1,quotaKind:'trial',record:{captureId:randomUUID(),operation:'solve',profileId:'spi',createdAt:at(day),finishedAt:at(day),usableResult:true,settlementStatus:'settled'}});
  f.orders.push({reference:'cs_after_trial',deviceId:1,paymentIntentId:'pi_after_trial',chargeId:null,amountMinor:'100',currency:'JPY',paidAt:at(3),recordedAt:at(3)});
  const report=aggregateCohorts(f,query());assert.equal(report.post_trial_exhaustion.exhausted.numerator,1);
  assert.equal(report.post_trial_exhaustion.paid_after_exhaustion.numerator,1);assert.equal(report.post_trial_exhaustion.followup_seconds.minimum,38*86400);
  assert.equal(report.p28.denominator,1);
});
test('legacy reliability metrics never attribute another device cost to a reused capture UUID',()=>{
  const id=randomUUID(),a={...event(1,'official',1,id),variant:'control'},b=event(1,'official',2,id);
  const report=aggregateProductMetrics([a,b],{from:registered,to:at(2)},[
    {deviceId:1,captureId:id,inputTokens:1,outputTokens:1,questions:1,estimatedCostMicros:80},
    {deviceId:2,captureId:id,inputTokens:1,outputTokens:1,questions:1,estimatedCostMicros:900}]);
  assert.equal(report.variants.find(v=>v.variant==='control')?.estimated_cost_micros.total,80);
  assert.equal(report.variants.find(v=>v.variant==='objective_v1')?.estimated_cost_micros.total,900);
});
