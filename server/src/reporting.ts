import { createHash } from 'node:crypto';
import type { StoredProductEvent } from './db.ts';
import type { CaptureRecord } from './billing.ts';
import type { ObservationPreference, StoredObservation, CoverageStatus } from './observation.ts';
import type { RefundSnapshot } from './payment-ledger.ts';
import { usableProductResult } from './telemetry.ts';
import type { ReportArchiveStore } from './report-archive.ts';
import type { QualityStore } from './quality.ts';
import {groupUnallocatedReceipts,summarizeUnallocatedReceipts,type ReportReceipt} from './reporting-receipts.ts';
import type {FinanceRevision} from './payment-finance.ts';
import {reportFinance} from './reporting-finance.ts';

export const REPORT_DEFINITION='cohort-economics-v3';
export const DAY=86_400_000;
export type ReportChannel='official'|'custom_key'|'cli'|'mixed';
export interface ReportQuery {
  cohortFrom:string; cohortTo:string; asOf:string; channel?:ReportChannel;
  profile?:'spi'|'reading_practice'|'general'; source?:string; policyVersion?:string;
}
export interface ReportDevice { id:number; registeredAt:string; policyVersion:string; isInternal:boolean }
export interface ReportSource { deviceId:number; group:string; method:string; recordedAt:string }
export interface ReportPreference extends ObservationPreference {deviceId:number;recordedAt:string}
export interface ReportCapture {deviceId:number;quotaKind:string|null;record:Pick<CaptureRecord,'captureId'|'operation'|'profileId'|'createdAt'|'finishedAt'|'usableResult'|'settlementStatus'>}
export function reportCapture(record:CaptureRecord,asOf:string):ReportCapture['record'] {
  const finished=record.finishedAt!==null&&record.finishedAt<=asOf;
  return {captureId:record.captureId,operation:record.operation,profileId:record.profileId,createdAt:record.createdAt,
    finishedAt:finished?record.finishedAt:null,usableResult:finished&&record.usableResult,settlementStatus:finished?record.settlementStatus:'held'};
}
export interface ReportOrder {
  reference:string;deviceId:number;paymentIntentId:string|null;chargeId:string|null;
  amountMinor:string;currency:string;paidAt:string;recordedAt:string;
}
export interface ReportRefund {snapshot:RefundSnapshot;generation:string;recordedAt:string}
export interface ReportAdjustment {
  reference:string;orderReference:string;type:'dispute'|'fee';amountMinor:string;
  currency:string;status:string;effectiveAt:string;recordedAt:string;
}
export interface ReportAttempt {
  id:string;deviceId:number;captureId:string;purpose:string;currency:string;
  costMicros:string|null;upperMicros:string|null;revision:string;pricingVersion:string;
  startedAt:string;calculatedAt:string;status:string;
}
export interface ReportLot {
  id:string;deviceId:number;kind:string;granted:string;remaining:string;held:string;revoked:string;
  createdAt:string;sourceRef:string;
}
export interface ReportExpense {
  reference:string;kind:'service'|'acquisition';currency:string;amountMicros:string;
  cohortFrom:string;cohortTo:string;coverageThrough:string;recordedAt:string;
  sourceGroup?:string;policyVersion?:string;
  revision?:string;
}
export type ReportExpenseInput=Omit<ReportExpense,'recordedAt'|'revision'>;
export interface ReportingFacts {
  devices:ReportDevice[]; sources:ReportSource[]; events:StoredProductEvent[];
  preferences:ReportPreference[]; observations:StoredObservation[]; captures:ReportCapture[];
  orders:ReportOrder[];refunds:ReportRefund[];adjustments:ReportAdjustment[];
  attempts:ReportAttempt[];lots:ReportLot[];expenses:ReportExpense[];
  /** A device with pre-ledger quota cannot acquire invented historical lot balances. */
  untrackedQuotaDeviceIds:number[];
  /** Signed account receipts in the report time window; unknown attribution is not a cohort. */
  receipts?:ReportReceipt[];
  finance?:FinanceRevision[];
}
export interface ReportingStore {
  quality:QualityStore;
  archives:ReportArchiveStore;
  snapshot(query:ReportQuery):Promise<ReportingFacts>;
  setInternal(deviceId:number,internal:boolean,reference:string):Promise<boolean>;
  source(token:string,group:string,method:'self_reported'):Promise<boolean>;
  expense(input:ReportExpenseInput):Promise<boolean>;
}
export class ReportLimitError extends Error {}
export function decimal(value:unknown):string {
  const text=String(value);if(!/^[0-9]{1,40}$/.test(text))throw new Error('Invalid report integer');
  return BigInt(text).toString();
}
export function reportTime(value:unknown):string {
  const text=typeof value==='string'?value:value instanceof Date?value.toISOString():'';
  const normal=/^\d{4}-\d{2}-\d{2}$/.test(text)?text+'T00:00:00.000Z':text;
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normal)||
    !Number.isFinite(Date.parse(normal))||new Date(normal).toISOString().slice(0,19)!==normal.slice(0,19))throw new Error('Invalid UTC date');
  return new Date(normal).toISOString();
}
export function parseReportQuery(raw:Record<string,unknown>,now=Date.now(),economics=false):ReportQuery {
  const allowed=['cohort_from','cohort_to','as_of','source','policy_version',...(economics?[]:['channel','profile'])];
  if(Object.keys(raw).some(k=>!allowed.includes(k)))throw new Error('Unsupported report filter');
  const asOf=raw.as_of===undefined?new Date(now).toISOString():reportTime(raw.as_of);
  const cohortFrom=raw.cohort_from===undefined?new Date(Date.parse(asOf)-60*DAY).toISOString():reportTime(raw.cohort_from);
  const cohortTo=raw.cohort_to===undefined?new Date(Date.parse(asOf)-28*DAY).toISOString():reportTime(raw.cohort_to);
  if(cohortFrom>=cohortTo||Date.parse(cohortTo)-Date.parse(cohortFrom)>90*DAY||Date.parse(asOf)>now||cohortTo>asOf)throw new Error('Invalid report window');
  if(raw.channel!==undefined&&!['official','custom_key','cli','mixed'].includes(String(raw.channel)))throw new Error('Invalid channel');
  if(raw.profile!==undefined&&!['spi','reading_practice','general'].includes(String(raw.profile)))throw new Error('Invalid profile');
  if(raw.source!==undefined&&!['spi_entry','reading_practice_entry','direct','unknown'].includes(String(raw.source)))throw new Error('Invalid source');
  if(raw.policy_version!==undefined&&(typeof raw.policy_version!=='string'||! /^[A-Za-z0-9_.-]{1,64}$/.test(raw.policy_version)))throw new Error('Invalid policy version');
  for(const key of ['channel','profile','source'])if(raw[key]!==undefined&&typeof raw[key]!=='string')throw new Error('Invalid filter');
  return {cohortFrom,cohortTo,asOf,...(raw.channel?{channel:raw.channel as ReportChannel}:{}),
    ...(raw.profile?{profile:raw.profile as ReportQuery['profile']}:{}),...(raw.source?{source:String(raw.source)}:{}),
    ...(raw.policy_version?{policyVersion:String(raw.policy_version)}:{})};
}
export function cohortDevices(facts:ReportingFacts,q:ReportQuery,includeInternal=false):ReportDevice[] {
  const sources=new Map(facts.sources.filter(s=>s.recordedAt<=q.asOf).sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)).map(s=>[s.deviceId,s]));
  return facts.devices.filter(d=>(includeInternal||!d.isInternal)&&d.registeredAt>=q.cohortFrom&&d.registeredAt<q.cohortTo&&
    (!q.policyVersion||q.policyVersion===d.policyVersion)&&(!q.source||q.source===(sources.get(d.id)?.group??'unknown')));
}
function overlaps(a:string,b:string,from:string,to:string){return a<b&&a<to&&b>from;}
/** Union verified intervals; absent evidence and late preference changes cannot become churn. */
export function observationCoverage(facts:Pick<ReportingFacts,'preferences'|'observations'>,id:number,from:string,to:string,asOf:string):CoverageStatus {
  if(from===to)return 'complete';
  const prefs=facts.preferences.filter(p=>p.deviceId===id&&p.recordedAt<=asOf).sort((a,b)=>a.consentEpoch-b.consentEpoch);
  if(prefs.some((p,i)=>!p.sharingEnabled&&overlaps(p.validFrom,prefs[i+1]?.validFrom??asOf,from,to)))return 'telemetry_disabled';
  const intervals=facts.observations.filter(o=>o.deviceId===id&&o.receivedAt<=asOf&&overlaps(o.validFrom,o.validTo,from,to));
  let knownGap=false;
  const complete:Array<[string,string]>=[];
  for(const o of intervals){
    const index=prefs.findIndex(p=>p.consentEpoch===o.consentEpoch),p=prefs[index],next=prefs[index+1];
    if(!p||!p.sharingEnabled||o.validFrom<p.validFrom||(next&&o.validTo>next.validFrom)) {knownGap=true;continue;}
    if(o.coverageStatus==='complete'&&o.queueDropCount===0&&o.gapReason==='none')complete.push([o.validFrom,o.validTo]);
    else knownGap=true;
  }
  // Known gaps remain gaps even when another overlapping summary claims complete.
  if(knownGap)return intervals.some(o=>o.coverageStatus==='partial')?'partial':'unknown';
  let cursor=from;
  for(const [a,b] of complete.sort(([a],[b])=>a.localeCompare(b))){if(a>cursor)break;if(b>cursor)cursor=b;if(cursor>=to)return 'complete';}
  return complete.length?'partial':'unknown';
}
function grouped<T>(rows:T[],key:(row:T)=>string|number|null):Map<string|number,T[]> {
  const result=new Map<string|number,T[]>();
  for(const row of rows){const id=key(row);if(id===null)continue;const values=result.get(id)??[];values.push(row);result.set(id,values);}return result;
}
export function proportion(numerator:number,denominator:number){
  if(denominator===0)return {numerator,denominator,rate:null,confidence_interval_95:null};
  const p=numerator/denominator,z=1.959963984540054,z2=z*z,divisor=1+z2/denominator;
  const center=(p+z2/(2*denominator))/divisor;
  const margin=z*Math.sqrt(p*(1-p)/denominator+z2/(4*denominator*denominator))/divisor;
  return {numerator,denominator,rate:p,confidence_interval_95:{method:'Wilson',lower:Math.max(0,center-margin),upper:Math.min(1,center+margin)}};
}
function revision(facts:ReportingFacts,q:ReportQuery){
  const digest=createHash('sha256');
  digest.update(JSON.stringify([REPORT_DEFINITION,q]));
  for(const key of ['devices','sources','events','preferences','observations','captures','orders','refunds','adjustments','attempts','lots','expenses','untrackedQuotaDeviceIds'] as const){
    const values=facts[key].map(v=>JSON.stringify(v)).sort();digest.update(key);for(const value of values)digest.update(value+'\n');
  }
  digest.update('receipts');for(const value of (facts.receipts??[]).map(v=>JSON.stringify(v)).sort())digest.update(value+'\n');
  digest.update('finance');for(const value of (facts.finance??[]).map(v=>JSON.stringify(v)).sort())digest.update(value+'\n');
  return digest.digest('hex');
}
function eligibleEvents(facts:ReportingFacts,q:ReportQuery){
  const ids=new Set(cohortDevices(facts,q).map(d=>d.id)),byCapture=new Map<string,StoredProductEvent[]>();
  for(const e of facts.events){
    if(!ids.has(e.deviceId)||e.receivedAt>q.asOf||e.occurredAt>=q.asOf||e.eventName!=='capture_completed'||!e.captureId||e.trigger==='qa')continue;
    const key=e.deviceId+':'+e.captureId.toLowerCase(),values=byCapture.get(key)??[];values.push(e);byCapture.set(key,values);
  }
  const events:StoredProductEvent[]=[];let conflicts=0;
  for(const values of byCapture.values()){
    values.sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId));
    const first=values[0]!;
    const signature=(e:StoredProductEvent)=>JSON.stringify([e.channel,e.mode,e.depth,e.resultState,e.parserPath,e.errorCode,e.extensions?.usable_result,e.extensions?.operation,e.extensions?.profile_id]);
    if(values.some(e=>signature(e)!==signature(first))){conflicts++;continue;}
    if(usableProductResult(first)&&(!q.profile||first.extensions?.profile_id===q.profile))events.push(first);
  }
  return {events,conflicts};
}
function orderNet(facts:ReportingFacts,order:ReportOrder,asOf:string){
  const linked=facts.refunds.filter(r=>r.recordedAt<=asOf&&((order.paymentIntentId&&r.snapshot.paymentIntentId===order.paymentIntentId)||(order.chargeId&&r.snapshot.chargeId===order.chargeId)));
  const latest=new Map<string,ReportRefund>();
  for(const r of linked)if(!latest.has(r.snapshot.id)||BigInt(r.generation)>BigInt(latest.get(r.snapshot.id)!.generation))latest.set(r.snapshot.id,r);
  let refunds=0n,disputes=0n,integrity=!order.paymentIntentId&&!order.chargeId;
  const financial=reportFinance(order,facts.finance??[],facts.refunds,asOf);
  if(financial){integrity ||= financial.cashUnknown;disputes=BigInt(financial.totals.disputeLossMinor);}
  for(const {snapshot:r} of latest.values()){
    if(r.currency!==order.currency||(r.paymentIntentId&&order.paymentIntentId&&r.paymentIntentId!==order.paymentIntentId)||
      (r.chargeId&&order.chargeId&&r.chargeId!==order.chargeId)){integrity=true;continue;}
    if(r.status==='succeeded')refunds+=BigInt(r.amountCents);
  }
  for(const a of facts.adjustments)if([order.reference,order.paymentIntentId,order.chargeId].includes(a.orderReference)&&a.type==='dispute'&&a.recordedAt<=asOf&&a.effectiveAt<=asOf){
    if(financial&&a.recordedAt<=financial.revision.startedAt)continue;
    if(a.currency!==order.currency||a.status==='observed')integrity=true;else if(a.status==='applied')disputes+=BigInt(a.amountMinor);
  }
  const paid=BigInt(order.amountMinor),net=paid-refunds-disputes;
  if(net<0n)integrity=true;
  return {paid,refunds,disputes,net:integrity?null:net,integrity};
}
function indexedOrderNet(facts:ReportingFacts,asOf:string){
  const byIntent=grouped(facts.refunds,r=>r.snapshot.paymentIntentId),byCharge=grouped(facts.refunds,r=>r.snapshot.chargeId);
  const adjustments=grouped(facts.adjustments,a=>a.orderReference);
  const finance=grouped(facts.finance??[],f=>f.orderReference);
  return (order:ReportOrder)=>orderNet({...facts,
    refunds:[...(order.paymentIntentId?byIntent.get(order.paymentIntentId)??[]:[]),...(order.chargeId?byCharge.get(order.chargeId)??[]:[])],
    adjustments:[order.reference,order.paymentIntentId,order.chargeId].flatMap(key=>key?adjustments.get(key)??[]:[]),finance:finance.get(order.reference)??[]},order,asOf);
}
export function aggregateCohorts(facts:ReportingFacts,q:ReportQuery){
  const devices=cohortDevices(facts,q),mature=devices.filter(d=>Date.parse(d.registeredAt)+28*DAY<=Date.parse(q.asOf));
  const {events,conflicts}=eligibleEvents(facts,q);
  const preferences=grouped(facts.preferences,p=>p.deviceId),observations=grouped(facts.observations,o=>o.deviceId);
  const coverageFor=(id:number,from:string,to:string)=>observationCoverage({preferences:preferences.get(id)??[],observations:observations.get(id)??[]},id,from,to,q.asOf);
  const channels=(q.channel?[q.channel]:['official','custom_key','cli']) as ReportChannel[];
  const rows=channels.map(channel=>{
    const selected=events.filter(e=>channel==='mixed'||e.channel===channel);
    const eventsByDevice=grouped(selected,e=>e.deviceId);
    let activated=0,observedActivated=0,observedActivation=0,activationUnknown=0,knownInactive=0;
    const coverageCounts={mature_total:0,observed_complete:0,partial:0,unknown:0,telemetry_disabled:0};
    let repeated=0,repeatFrozen=0,repeatFrozenSuccess=0,firstSuccessUnknown=0,repeatImmature=0;
    for(const d of devices){
      const successes=(eventsByDevice.get(d.id)??[]).filter(e=>e.occurredAt>=d.registeredAt).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
      const regEnd=new Date(Date.parse(d.registeredAt)+28*DAY).toISOString();
      if(regEnd<=q.asOf){
        const active=successes.some(e=>e.occurredAt<regEnd),coverage=coverageFor(d.id,d.registeredAt,regEnd);
        if(active)activated++;
        if(coverage==='complete'){observedActivation++;if(active)observedActivated++;else knownInactive++;}
        else if(!active)activationUnknown++;
      }
      const first=successes[0];if(!first)continue;
      const repeatEnd=new Date(Date.parse(first.occurredAt)+28*DAY).toISOString();
      if(repeatEnd>q.asOf){repeatImmature++;continue;}
      coverageCounts.mature_total++;
      const origin=coverageFor(d.id,d.registeredAt,first.occurredAt);
      const coverage=origin==='complete'?coverageFor(d.id,first.occurredAt,repeatEnd):'unknown';
      if(origin!=='complete')firstSuccessUnknown++;
      if(coverage!=='complete'){coverageCounts[coverage]++;continue;}
      coverageCounts.observed_complete++;
      const utcDays=new Set(successes.filter(e=>e.occurredAt<repeatEnd).map(e=>e.occurredAt.slice(0,10)));
      const repeat=utcDays.size>=3;if(repeat)repeated++;
      if(Date.parse(repeatEnd)+7*DAY<=Date.parse(q.asOf)){repeatFrozen++;if(repeat)repeatFrozenSuccess++;}
    }
    return {channel,profile:q.profile??'all',activation28:{...proportion(activated,mature.length),interpretation:'confirmed_lower_bound',
      confirmed_inactive:knownInactive,unknown_without_confirmed_activation:activationUnknown,observed_only:proportion(observedActivated,observedActivation)},
      repeat28:{...proportion(repeated,coverageCounts.observed_complete),coverage:coverageCounts,immature:repeatImmature,
        first_success_origin_unknown:firstSuccessUnknown,preliminary:coverageCounts.observed_complete>repeatFrozen,
        frozen:proportion(repeatFrozenSuccess,repeatFrozen),frozen_after_days:35},
      usable_deliveries:selected.length,legacy_fallback_deliveries:selected.filter(e=>e.parserPath==='legacy_fallback').length};
  });
  let paid=0,fullyRefunded=0,disputed=0,paymentUnknown=0,operational=0;
  const unresolvedReceipts=groupUnallocatedReceipts(facts.receipts??[],q.cohortFrom,q.asOf).filter(r=>r.state!=='credited'&&!r.is_internal);
  const ordersByDevice=grouped(facts.orders,o=>o.deviceId),capturesByDevice=grouped(facts.captures,c=>c.deviceId),netFor=indexedOrderNet(facts,q.asOf);
  for(const d of mature){
    const end=new Date(Date.parse(d.registeredAt)+28*DAY).toISOString();
    const orders=(ordersByDevice.get(d.id)??[]).filter(o=>o.recordedAt<=q.asOf&&o.paidAt>=d.registeredAt&&o.paidAt<end);
    const nets=orders.map(netFor);
    if(nets.some(n=>n.net!==null&&n.net>0n))paid++;
    else if(nets.some(n=>n.integrity)||unresolvedReceipts.some(r=>r.device_id===d.id&&r.paid_at!==null&&r.paid_at>=d.registeredAt&&r.paid_at<end))paymentUnknown++;
    if(nets.some(n=>n.refunds===n.paid))fullyRefunded++;
    if(nets.some(n=>n.disputes>0n))disputed++;
    if((capturesByDevice.get(d.id)??[]).some(c=>c.record.operation==='solve'&&c.record.usableResult&&c.record.finishedAt&&
      c.record.finishedAt>=d.registeredAt&&c.record.finishedAt<end&&c.record.finishedAt<=q.asOf))operational++;
  }
  let exhausted=0,paidAfterExhaustion=0,exhaustionUnknown=0;const observedSeconds:number[]=[];
  const lotsByDevice=grouped(facts.lots,l=>l.deviceId);
  for(const d of devices){
    const trial=(lotsByDevice.get(d.id)??[]).filter(l=>l.kind==='trial'&&l.createdAt<=q.asOf);
    if(!trial.length){exhaustionUnknown++;continue;}
    const grant=trial.reduce((sum,l)=>sum+BigInt(l.granted),0n);
    const used=(capturesByDevice.get(d.id)??[]).filter(c=>c.quotaKind==='trial'&&c.record.settlementStatus==='settled'&&c.record.finishedAt&&c.record.finishedAt<=q.asOf)
      .sort((a,b)=>a.record.finishedAt!.localeCompare(b.record.finishedAt!));
    if(grant===0n||BigInt(used.length)<grant)continue;
    const ended=used[Number(grant)-1]!.record.finishedAt!;exhausted++;observedSeconds.push((Date.parse(q.asOf)-Date.parse(ended))/1000);
    if((ordersByDevice.get(d.id)??[]).some(o=>o.paidAt>=ended&&o.paidAt<=q.asOf&&o.recordedAt<=q.asOf&&(netFor(o).net??0n)>0n))paidAfterExhaustion++;
  }
  observedSeconds.sort((a,b)=>a-b);
  return {definition_version:REPORT_DEFINITION,query:queryWire(q),revision:revision(facts,q),identity:'device_not_person',
    registered:devices.length,mature_registered:mature.length,immature_registered:devices.length-mature.length,
    internally_excluded:cohortDevices(facts,q,true).filter(d=>d.isInternal).length,conflicting_completions_excluded:conflicts,
    dimensions_note:'source and policy select registrations; profile and channel select client solve outcomes only',channels:rows,
    p28:{...proportion(paid,mature.length),fully_refunded_devices:fullyRefunded,dispute_loss_devices:disputed,unknown_payment_devices:paymentUnknown},
    post_trial_exhaustion:{definition:'auxiliary_all_registered_not_a_substitute_for_P28',exhausted:proportion(exhausted,devices.length),
      paid_after_exhaustion:proportion(paidAfterExhaustion,exhausted),unknown_trial_origin:exhaustionUnknown,
      followup_seconds:{minimum:observedSeconds[0]??null,median:observedSeconds[Math.floor(observedSeconds.length/2)]??null,maximum:observedSeconds.at(-1)??null}},
    operational_activation28:{...proportion(operational,mature.length),definition:'server_settled_solve_separate_from_client_delivery'}};
}

function ratio(numerator:bigint|null,denominator:bigint){return numerator===null||denominator===0n?null:{numerator:numerator.toString(),denominator:denominator.toString()};}
function queryWire(q:ReportQuery){return {cohort_from:q.cohortFrom,cohort_to:q.cohortTo,as_of:q.asOf,
  ...(q.channel?{channel:q.channel}:{}),...(q.profile?{profile:q.profile}:{}),...(q.source?{source:q.source}:{}),...(q.policyVersion?{policy_version:q.policyVersion}:{})};}
export function aggregateEconomics(facts:ReportingFacts,q:ReportQuery){
  const devices=cohortDevices(facts,q),ids=new Set(devices.map(d=>d.id));
  const receiptGroups=groupUnallocatedReceipts(facts.receipts??[],q.cohortFrom,q.asOf);
  const unallocated=summarizeUnallocatedReceipts(receiptGroups,ids,new Set(facts.devices.filter(d=>d.isInternal).map(d=>d.id)));
  const unresolvedReceipts=receiptGroups.filter(r=>r.state!=='credited'&&!r.is_internal&&(r.device_id===null||ids.has(r.device_id)));
  const incompleteLegacyHistory=devices.some(d=>d.policyVersion==='legacy');
  const orders=facts.orders.filter(o=>ids.has(o.deviceId)&&o.recordedAt<=q.asOf&&o.paidAt<=q.asOf);
  const financeRevisions=grouped(facts.finance??[],r=>r.orderReference),refundsByIntent=grouped(facts.refunds,r=>r.snapshot.paymentIntentId),refundsByCharge=grouped(facts.refunds,r=>r.snapshot.chargeId);
  const financial=new Map(orders.map(o=>[o.reference,reportFinance(o,financeRevisions.get(o.reference)??[],[...(o.paymentIntentId?refundsByIntent.get(o.paymentIntentId)??[]:[]),...(o.chargeId?refundsByCharge.get(o.chargeId)??[]:[])],q.asOf)]));
  const feeAdjustments=grouped(facts.adjustments.filter(a=>a.type==='fee'&&a.recordedAt<=q.asOf&&a.effectiveAt<=q.asOf),a=>a.orderReference);
  for(const o of orders){const f=financial.get(o.reference);if(f&&[o.reference,o.paymentIntentId,o.chargeId].some(key=>key!==null&&(feeAdjustments.get(key)??[]).some(a=>a.recordedAt>f.revision.startedAt)))f.feesComplete=false;}
  const orderCurrency=new Map(orders.map(o=>[o.reference,o.currency]));
  const attempts=facts.attempts.filter(a=>ids.has(a.deviceId)&&a.startedAt<=q.asOf);
  const lots=facts.lots.filter(l=>ids.has(l.deviceId)&&l.createdAt<=q.asOf);
  const delivery=eligibleEvents(facts,{...q,channel:undefined,profile:undefined}).events.filter(e=>e.channel==='official');
  const currencies=new Set([...orders.map(o=>o.currency),...attempts.map(a=>a.currency),...facts.expenses.map(e=>e.currency),
    ...[...financial.values()].flatMap(f=>f?.totals.fees.map(f=>f.currency)??[]),
    ...unresolvedReceipts.filter(r=>r.device_id!==null&&r.currency!==null).map(r=>r.currency!)]);
  const paidLots=lots.filter(l=>l.kind==='paid'),legacy=lots.filter(l=>l.kind==='legacy_unknown');
  const sum=(rows:ReportLot[],key:'remaining'|'granted'|'held'|'revoked')=>rows.reduce((s,l)=>s+BigInt(l[key]),0n);
  const remaining=sum(paidLots,'remaining'),maturePaid=paidLots.filter(l=>Date.parse(l.createdAt)+28*DAY<=Date.parse(q.asOf));
  const matureGrant=sum(maturePaid,'granted'),matureUsed=matureGrant-sum(maturePaid,'remaining')-sum(maturePaid,'revoked');
  const netFor=indexedOrderNet(facts,q.asOf);
  const rows=[...currencies].sort().map(currency=>{
    const localOrders=orders.filter(o=>o.currency===currency),nets=localOrders.map(netFor);
    const paid=nets.reduce((s,n)=>s+n.paid,0n),refunded=nets.reduce((s,n)=>s+n.refunds,0n),disputed=nets.reduce((s,n)=>s+n.disputes,0n);
    const pendingReceipts=unresolvedReceipts.filter(r=>r.currency===null||r.currency===currency);
    const net=nets.some(n=>n.integrity)?null:paid-refunded-disputed;
    const localAttempts=attempts.filter(a=>a.currency===currency),unknown=localAttempts.filter(a=>a.costMicros===null);
    const known=localAttempts.reduce((s,a)=>s+(a.costMicros===null?0n:BigInt(a.costMicros)),0n);
    const unknownUpper=unknown.some(a=>a.upperMicros===null)?null:unknown.reduce((s,a)=>s+BigInt(a.upperMicros!),0n);
    const upper=unknownUpper===null||incompleteLegacyHistory?null:known+unknownUpper;
    const total=unknown.length||incompleteLegacyHistory?null:known;
    const orderKeys=new Set(localOrders.flatMap(o=>[o.reference,o.paymentIntentId,o.chargeId].filter((key):key is string=>key!==null)));
    const resolvedKeys=new Set(orders.filter(o=>financial.get(o.reference)).flatMap(o=>[o.reference,o.paymentIntentId,o.chargeId].filter((k):k is string=>k!==null)));
    const fees=facts.adjustments.filter(a=>a.type==='fee'&&a.status==='applied'&&a.currency===currency&&a.recordedAt<=q.asOf&&a.effectiveAt<=q.asOf&&orderKeys.has(a.orderReference)&&!resolvedKeys.has(a.orderReference));
    const feeKeys=new Set(fees.map(f=>f.orderReference));
    const feeUnknown=localOrders.filter(o=>{const f=financial.get(o.reference);return f?!f.feesComplete||f.totals.fees.some(fee=>fee.currency!==currency&&BigInt(fee.amountMinor)!==0n):
      ![o.reference,o.paymentIntentId,o.chargeId].some(key=>key!==null&&feeKeys.has(key));}).length;
    const foreignIncomplete=[...financial].filter(([reference,f])=>f&&!f.feesComplete&&orderCurrency.get(reference)!==currency&&f.totals.fees.some(fee=>fee.currency===currency)).length;
    const feesKnown=fees.reduce((s,f)=>s+BigInt(f.amountMinor),0n)+[...financial.values()].reduce((s,f)=>s+(f?.totals.fees.filter(fee=>fee.currency===currency).reduce((n,fee)=>n+BigInt(fee.amountMinor),0n)??0n),0n);
    const feeIncomplete=feeUnknown+foreignIncomplete;
    const expenses=facts.expenses.filter(e=>(q.source??null)===(e.sourceGroup??null)&&(q.policyVersion??null)===(e.policyVersion??null)&&e.currency===currency&&e.cohortFrom===q.cohortFrom&&e.cohortTo===q.cohortTo&&e.coverageThrough>=q.asOf&&e.recordedAt<=q.asOf);
    const allocated=(kind:ReportExpense['kind'])=>{
      const rows=expenses.filter(e=>e.kind===kind).sort((a,b)=>{
        const x=BigInt(a.revision??'0'),y=BigInt(b.revision??'0');return x===y?b.recordedAt.localeCompare(a.recordedAt)||b.reference.localeCompare(a.reference):x>y?-1:1;
      });
      return rows[0]?BigInt(rows[0].amountMicros):null;
    };
    const service=allocated('service'),acquisition=allocated('acquisition');
    const minorScale=currency==='JPY'?1_000_000n:['USD','CNY'].includes(currency)?10_000n:null;
    const beforeLiability=net===null||minorScale===null||total===null||service===null||feeIncomplete||pendingReceipts.length?null:
      net*minorScale-total-feesKnown*minorScale-service;
    // Liabilities are question obligations. Show each model-cost currency component separately;
    // never add JPY cash to USD inference or infer cash minor-unit scales from display symbols.
    const scenarios=[{name:'zero_use',n:0n,d:1n},{name:'observed_consumption',n:matureUsed,d:matureGrant},{name:'full_use',n:1n,d:1n}].map(s=>{
      const zeroLiability=remaining===0n||(s.n===0n&&s.d>0n);
      const costDenominator=zeroLiability?1n:BigInt(delivery.length)*s.d;
      const costNumerator=zeroLiability?0n:total===null?null:total*remaining*s.n;
      const contribution=beforeLiability===null||costNumerator===null?null:beforeLiability*costDenominator-costNumerator;
      return {name:s.name,usage_fraction:ratio(s.n,s.d),future_inference_cost_micros:{
        lower:ratio(zeroLiability?0n:known*remaining*s.n,costDenominator),upper:ratio(zeroLiability?0n:upper===null?null:upper*remaining*s.n,costDenominator)},
        contribution_per_registered_device_micros:ratio(contribution,costDenominator*BigInt(devices.length)),
        contribution_after_acquisition_micros:ratio(contribution===null||acquisition===null?null:contribution-acquisition*costDenominator,costDenominator*BigInt(devices.length)),
        basis:s.name==='observed_consumption'?'descriptive_mature_paid_lot_consumption_not_a_probability_forecast':'sensitivity'};
    });
    return {currency:currency==='unknown'?null:currency,cash_minor:{confirmed:paid.toString(),succeeded_refunds:nets.some(n=>n.integrity)?null:refunded.toString(),
      succeeded_refunds_known_subtotal:refunded.toString(),confirmed_dispute_losses:disputed.toString(),net:net?.toString()??null,
      payment_fees_known:feesKnown.toString(),payment_fees_total:feeIncomplete?null:feesKnown.toString(),orders_missing_fee_data:feeUnknown,foreign_orders_with_incomplete_fees:foreignIncomplete},
      inference_micros:{attempts:localAttempts.length,known_subtotal:known.toString(),total:total?.toString()??null,unknown_count:unknown.length,
        recorded_attempt_unknown_fraction:localAttempts.length?unknown.length/localAttempts.length:null,conservative_upper:upper?.toString()??null,
        historical_attempt_coverage:incompleteLegacyHistory?'incomplete_pre_ledger_history':'recorded_attempts',
        unknown_upper_basis:'configured_attempt_budget_reservation; not a provider settlement',
        by_purpose:Object.fromEntries([...new Set(localAttempts.map(a=>a.purpose))].sort().map(p=>[p,localAttempts.filter(a=>a.purpose===p).length])),
        pricing_versions:[...new Set(localAttempts.map(a=>a.pricingVersion))].sort(),cost_per_client_usable_solve:ratio(total,BigInt(delivery.length))},
      paid_liability_scenarios:scenarios,
      allocated_service_expenses_micros:service?.toString()??null,acquisition_expenses_micros:acquisition?.toString()??null,
      contribution_before_paid_liability_micros:ratio(beforeLiability,BigInt(devices.length)),
      incomplete_inputs:[...(service===null?['allocated_service_expenses']:[]),...(acquisition===null?['acquisition_expenses']:[]),
        ...(pendingReceipts.length?['unallocated_paid_receipts']:[]),
        ...(minorScale===null?['currency_minor_unit_scale']:[]),...(feeIncomplete?['payment_fees']:[]),...(nets.some(n=>n.integrity)?['unresolved_cash_facts']:[]),...(unknown.length?['unknown_inference_costs']:[]),...(incompleteLegacyHistory?['pre_ledger_attempt_history']:[])],
      contribution_definition:'(net_cash - all_attempt_costs - payment_fees - allocated_service_expenses - paid_liability) / registered_devices; refund subtracted once'};
  });
  return {definition_version:REPORT_DEFINITION,query:queryWire(q),revision:revision(facts,q),registered:devices.length,client_usable_official_deliveries:delivery.length,
    currencies:rows,exchange_rates:[],currency_policy:'separate_currencies_no_implicit_conversion',
    unallocated_receipts:{...unallocated,received_from:q.cohortFrom,received_through:q.asOf},
    finance_reconciliation:{orders:orders.length,with_resource_snapshot:[...financial.values()].filter(Boolean).length,
      pending_new_notices:[...financial.values()].filter(f=>f?.revision.dirty).length,refund_ledger_mismatch:[...financial.values()].filter(f=>f?.refundMismatch).length,
      unknown_dispute_outcomes:[...financial.values()].filter(f=>f?.totals.disputesUnknown).length,
      latest_checked_at:[...financial.values()].flatMap(f=>f?[f.revision.recordedAt]:[]).sort().at(-1)??null,
      basis:'complete_bounded_Stripe_resource_reads; unique_balance_transaction_fees; settled_dispute_principal_separate; no_implicit_FX'},
    paid_questions:{remaining:remaining.toString(),held:sum(paidLots,'held').toString(),revoked:sum(paidLots,'revoked').toString(),
      mature_lots:maturePaid.length,mature_devices:new Set(maturePaid.map(l=>l.deviceId)).size,observed_consumed:matureUsed.toString(),observed_granted:matureGrant.toString()},
    legacy_unknown_questions:{lower_paid:'0',upper_paid:facts.untrackedQuotaDeviceIds.some(id=>ids.has(id))?null:sum(legacy,'remaining').toString(),
      known_legacy_remaining:sum(legacy,'remaining').toString(),devices_without_historical_lots:facts.untrackedQuotaDeviceIds.filter(id=>ids.has(id)).length},
    unused_trial_questions:sum(lots.filter(l=>l.kind==='trial'),'remaining').toString(),
    financial_interpretation:'operational_estimate_not_revenue_recognition; contribution remains unknown until expense coverage is recorded'};
}
