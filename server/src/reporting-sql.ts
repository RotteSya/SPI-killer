import { hashToken, type StoredProductEvent } from './db.ts';
import { query, type Row, type RunTransaction, type Transaction } from './billing-sql.ts';
import type { Attempt, CaptureRecord } from './billing.ts';
import type { PaymentOrder, RefundSnapshot, RefundLot } from './payment-ledger.ts';
import { decimal, reportCapture, ReportLimitError, type ReportQuery, type ReportingFacts, type ReportingStore, type ReportExpenseInput } from './reporting.ts';
import { REPORT_ARCHIVE_SCHEMA, SQLReportArchiveStore } from './report-archive-sql.ts';
import { QUALITY_SCHEMA, SQLQualityStore } from './quality-sql.ts';
import {validateCheckoutSnapshot,type CheckoutSnapshot} from './checkout-reconciliation.ts';
import {receiptIdentity,type ReportReceipt,type ReceiptOrder} from './reporting-receipts.ts';
import {FINANCE_SCHEMA,financeFacts} from './payment-finance-sql.ts';

export const REPORTING_SCHEMA=`
${FINANCE_SCHEMA}
${REPORT_ARCHIVE_SCHEMA}
${QUALITY_SCHEMA}
CREATE TABLE IF NOT EXISTS report_allocation_lock (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO report_allocation_lock(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_reporting_device_cohort ON devices(created_at);
CREATE INDEX IF NOT EXISTS idx_reporting_event_occurrence ON product_events(device_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_reporting_attempt_device ON model_attempts(device_id);
CREATE INDEX IF NOT EXISTS idx_reporting_order_device ON payment_orders(device_id,created_at);
CREATE INDEX IF NOT EXISTS idx_reporting_webhook_received ON webhook_inbox(received_at);
CREATE INDEX IF NOT EXISTS idx_reporting_checkout_recorded ON checkout_deliveries(recorded_at);
CREATE INDEX IF NOT EXISTS idx_reporting_reservation_device ON quota_reservations(device_id,created_at);
CREATE INDEX IF NOT EXISTS idx_reporting_quota_changes ON payment_quota_changes(lot_id,created_at);
CREATE TABLE IF NOT EXISTS device_sources (
 device_id BIGINT PRIMARY KEY REFERENCES devices(id), source_group TEXT NOT NULL,
 source_method TEXT NOT NULL CHECK(source_method IN ('self_reported','attributed')), recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS internal_device_changes (
 reference TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id),
 is_internal INTEGER NOT NULL CHECK(is_internal IN (0,1)), recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_expense_allocations (
 reference TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('service','acquisition')),
 currency TEXT NOT NULL, amount_micros TEXT NOT NULL, cohort_from TEXT NOT NULL, cohort_to TEXT NOT NULL,
 coverage_through TEXT NOT NULL, recorded_at TEXT NOT NULL, source_group TEXT, policy_version TEXT,
 revision BIGINT NOT NULL DEFAULT 0
);
`;
const timestamp=(value:unknown)=>new Date(String(value)).toISOString();
const number=(value:unknown)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new Error('Report count overflow');return n;};
function* bounded(sql:string,...args:Array<string|number|null>):Transaction<Row[]> {
  const rows=yield* query(sql+' LIMIT 200001',...args);
  if(rows.length>200000)throw new ReportLimitError('Report exceeds row limit; narrow the registration cohort');return rows;
}
function* lookup(values:string[],sql:(marks:string)=>string,asOf:string):Transaction<Row[]> {
  const unique=[...new Set(values)],rows:Row[]=[];
  for(let offset=0;offset<unique.length;offset+=250){const batch=unique.slice(offset,offset+250);rows.push(...yield* bounded(sql(batch.map(()=>'?').join(',')),...batch,asOf));}
  return rows;
}
function* checkoutReceipts(q:ReportQuery):Transaction<ReportReceipt[]> {
  const deliveries=yield* bounded(`SELECT d.snapshot,d.recorded_at,w.provider_event_id,w.event_created_at,w.received_at FROM checkout_deliveries d
    JOIN webhook_inbox w ON w.provider_event_id=d.provider_event_id WHERE (d.recorded_at>=? AND d.recorded_at<=?)
    OR (d.recorded_at IS NULL AND w.received_at>=? AND w.received_at<=?) ORDER BY w.provider_event_id`,q.cohortFrom,q.asOf,q.cohortFrom,q.asOf);
  const values=deliveries.map(row=>{const snapshot=JSON.parse(String(row.snapshot)) as CheckoutSnapshot;validateCheckoutSnapshot(snapshot);return {row,snapshot};});
  const refs=values.map(v=>v.snapshot.id),intents=values.flatMap(v=>v.snapshot.paymentIntentId?[v.snapshot.paymentIntentId]:[]);
  const devices=yield* lookup(values.flatMap(v=>v.snapshot.deviceTokenHash?[v.snapshot.deviceTokenHash]:[]),m=>`SELECT id,token_hash,created_at,is_internal FROM devices WHERE token_hash IN (${m}) AND created_at<=?`,q.asOf);
  const purchases=yield* lookup(values.flatMap(v=>v.snapshot.purchaseSessionId?[v.snapshot.purchaseSessionId]:[]),m=>`SELECT session_id,device_id,created_at FROM purchase_sessions WHERE session_id IN (${m}) AND created_at<=?`,q.asOf);
  const purchaseDevices=yield* lookup(purchases.map(p=>String(p.device_id)),m=>`SELECT id,created_at,is_internal FROM devices WHERE id IN (${m}) AND created_at<=?`,q.asOf);
  const deviceByHash=new Map(devices.map(d=>[String(d.token_hash),d])),purchaseByID=new Map(purchases.map(p=>[String(p.session_id),p]));
  const internalIDs=new Set([...devices,...purchaseDevices].filter(d=>Number(d.is_internal)===1).map(d=>number(d.id)));
  const orderRows=[...yield* lookup(refs,m=>`SELECT device_id,metadata FROM payment_orders WHERE reference IN (${m}) AND created_at<=?`,q.asOf),
    ...yield* lookup(intents,m=>`SELECT device_id,metadata FROM payment_orders WHERE payment_intent_id IN (${m}) AND created_at<=?`,q.asOf)];
  const orders=new Map<string,ReceiptOrder>();for(const row of orderRows){const o=JSON.parse(String(row.metadata)) as PaymentOrder;
    orders.set(o.reference,{reference:o.reference,deviceId:number(row.device_id),paymentIntentId:o.paymentIntentId,amountMinor:decimal(o.amountCents),currency:o.currency});}
  const legacy=yield* lookup(refs,m=>`SELECT reference,device_id,amount_cents,currency FROM topups WHERE reference IN (${m}) AND provider='stripe' AND amount_cents>0 AND created_at<=?`,q.asOf);
  for(const row of legacy)if(!orders.has(String(row.reference)))orders.set(String(row.reference),{reference:String(row.reference),deviceId:number(row.device_id),paymentIntentId:null,amountMinor:decimal(row.amount_cents),currency:String(row.currency).toUpperCase()});
  const orderByIntent=new Map([...orders.values()].filter(o=>o.paymentIntentId).map(o=>[o.paymentIntentId,o]));
  return values.map(({row,snapshot:s})=>{
    const device=s.deviceTokenHash?deviceByHash.get(s.deviceTokenHash):undefined,purchase=s.purchaseSessionId?purchaseByID.get(s.purchaseSessionId):undefined,recordedAt=timestamp(row.recorded_at??row.received_at);
    const identity=receiptIdentity(s,recordedAt,device?{id:number(device.id),createdAt:timestamp(device.created_at)}:null,purchase?{deviceId:number(purchase.device_id),createdAt:timestamp(purchase.created_at)}:null);
    const matched=[orders.get(s.id),s.paymentIntentId?orderByIntent.get(s.paymentIntentId):undefined].filter((o):o is ReceiptOrder=>o!==undefined);
    return {eventId:String(row.provider_event_id),checkoutReference:s.id,paymentIntentId:s.paymentIntentId,mode:s.mode,amountMinor:s.amountCents===null?null:String(s.amountCents),currency:s.currency,
      paidAt:row.event_created_at===null?null:timestamp(row.event_created_at),recordedAt,recordedTimeKnown:row.recorded_at!==null,...identity,isInternal:identity.deviceId!==null&&internalIDs.has(identity.deviceId),
      matchedOrders:[...new Map(matched.map(o=>[o.reference,o])).values()].sort((a,b)=>a.reference.localeCompare(b.reference))};
  });
}
function event(row:Row):StoredProductEvent {
  return {eventId:String(row.event_id),deviceId:number(row.device_id),captureId:row.capture_id===null?null:String(row.capture_id),
    occurredAt:timestamp(row.occurred_at),receivedAt:timestamp(row.received_at),eventName:String(row.event_name),
    trigger:row.trigger as string|null,channel:row.channel as string|null,mode:row.mode as string|null,depth:row.depth as string|null,
    contextCount:row.context_count===null?null:number(row.context_count),questionKind:row.question_kind as string|null,resultState:row.result_state as string|null,
    parserPath:row.parser_path as string|null,errorCode:row.error_code as string|null,action:row.action as string|null,
    captureMs:row.capture_ms===null?null:number(row.capture_ms),firstTokenMs:row.first_token_ms===null?null:number(row.first_token_ms),
    totalMs:row.total_ms===null?null:number(row.total_ms),appVersion:row.app_version as string|null,configRevision:row.config_revision as string|null,
    variant:row.variant as string|null,extensions:row.extensions?JSON.parse(String(row.extensions)) as Record<string,unknown>:undefined};
}
export class SQLReportingStore implements ReportingStore {
  readonly quality:SQLQualityStore;
  readonly archives:SQLReportArchiveStore;
  private run:RunTransaction;
  private postgres:boolean;
  constructor(run:RunTransaction,postgres=false){this.run=run;this.postgres=postgres;this.archives=new SQLReportArchiveStore(run);this.quality=new SQLQualityStore(run);}
  snapshot(q:ReportQuery):Promise<ReportingFacts>{
    const postgres=this.postgres;
    return this.run((function*():Transaction<ReportingFacts>{
      const devices=yield* query('SELECT id,created_at,quota_policy_version,is_internal FROM devices WHERE created_at>=? AND created_at<? ORDER BY id LIMIT 10001',q.cohortFrom,q.cohortTo);
      if(devices.length>10000)throw new ReportLimitError('Report exceeds device limit; narrow the registration cohort');
      const facts:ReportingFacts={devices:devices.map(d=>({id:number(d.id),registeredAt:timestamp(d.created_at),policyVersion:String(d.quota_policy_version),isInternal:Number(d.is_internal)===1})),
        sources:[],events:[],preferences:[],observations:[],captures:[],orders:[],refunds:[],adjustments:[],attempts:[],lots:[],expenses:[],untrackedQuotaDeviceIds:[]};
      const expenses=yield* bounded('SELECT * FROM report_expense_allocations WHERE cohort_from=? AND cohort_to=? AND recorded_at<=?',q.cohortFrom,q.cohortTo,q.asOf);
      facts.expenses=expenses.map(e=>({reference:String(e.reference),kind:String(e.kind) as 'service'|'acquisition',currency:String(e.currency),amountMicros:decimal(e.amount_micros),
        cohortFrom:String(e.cohort_from),cohortTo:String(e.cohort_to),coverageThrough:String(e.coverage_through),recordedAt:String(e.recorded_at),
        revision:decimal(e.revision),...(e.source_group===null?{}:{sourceGroup:String(e.source_group)}),...(e.policy_version===null?{}:{policyVersion:String(e.policy_version)})}));
      facts.receipts=yield* checkoutReceipts(q);
      if(!devices.length)return facts;
      const ids=devices.map(d=>number(d.id)),where='('+ids.map(()=>'?').join(',')+')';
      facts.finance=yield* financeFacts(ids,q.asOf);
      const sources=yield* bounded(`SELECT * FROM device_sources WHERE device_id IN ${where} AND recorded_at<=?`,...ids,q.asOf);
      facts.sources=sources.map(s=>({deviceId:number(s.device_id),group:String(s.source_group),method:String(s.source_method),recordedAt:String(s.recorded_at)}));
      const events=yield* bounded(`SELECT * FROM product_events WHERE device_id IN ${where} AND received_at<=? AND occurred_at>=? AND occurred_at<?`,...ids,q.asOf,q.cohortFrom,q.asOf);
      facts.events=events.map(event);
      const prefs=yield* bounded(`SELECT * FROM device_observation_preferences WHERE device_id IN ${where} AND recorded_at<=?`,...ids,q.asOf);
      facts.preferences=prefs.map(p=>({deviceId:number(p.device_id),consentEpoch:number(p.consent_epoch),sharingEnabled:Number(p.sharing_enabled)===1,validFrom:String(p.valid_from),recordedAt:String(p.recorded_at)}));
      const obs=yield* bounded(`SELECT * FROM device_observation WHERE device_id IN ${where} AND received_at<=?`,...ids,q.asOf);
      facts.observations=obs.map(o=>({...JSON.parse(String(o.metadata)),deviceId:number(o.device_id),receivedAt:String(o.received_at)}));
      const captures=yield* bounded(`SELECT c.device_id,c.metadata,l.kind FROM capture_requests c LEFT JOIN quota_reservations r ON r.request_id=c.request_id
        LEFT JOIN quota_lots l ON l.lot_id=r.lot_id WHERE c.device_id IN ${where} AND c.created_at<=?`,...ids,q.asOf);
      facts.captures=captures.map(c=>({deviceId:number(c.device_id),quotaKind:c.kind===null?null:String(c.kind),record:reportCapture(JSON.parse(String(c.metadata)) as CaptureRecord,q.asOf)}));
      const orders=yield* bounded(`SELECT device_id,metadata,created_at FROM payment_orders WHERE device_id IN ${where} AND created_at<=?`,...ids,q.asOf);
      facts.orders=orders.map(row=>{const o=JSON.parse(String(row.metadata)) as PaymentOrder;return {reference:o.reference,deviceId:number(row.device_id),paymentIntentId:o.paymentIntentId,chargeId:o.chargeId,
        amountMinor:decimal(o.amountCents),currency:o.currency,paidAt:o.paidAt,recordedAt:String(row.created_at)};});
      const legacyOrders=yield* bounded(`SELECT * FROM topups WHERE device_id IN ${where} AND provider='stripe' AND amount_cents>0 AND created_at<=?
        AND NOT EXISTS(SELECT 1 FROM payment_orders o WHERE o.reference=topups.reference)`,...ids,q.asOf);
      facts.orders.push(...legacyOrders.map(o=>({reference:o.reference===null?'legacy_topup:'+String(o.id):String(o.reference),deviceId:number(o.device_id),paymentIntentId:null,chargeId:null,
        amountMinor:decimal(o.amount_cents),currency:String(o.currency).toUpperCase(),paidAt:timestamp(o.created_at),recordedAt:timestamp(o.created_at)})));
      const refunds=yield* bounded(`SELECT DISTINCT r.refund_id,r.generation,r.metadata,r.recorded_at FROM payment_refund_revisions r
        JOIN payment_refunds f ON f.refund_id=r.refund_id JOIN payment_orders o ON (o.payment_intent_id=f.payment_intent_id OR o.charge_id=f.charge_id)
        WHERE o.device_id IN ${where} AND r.recorded_at<=?`,...ids,q.asOf);
      facts.refunds=refunds.map(r=>({snapshot:JSON.parse(String(r.metadata)) as RefundSnapshot,generation:decimal(r.generation),recordedAt:String(r.recorded_at)}));
      const adjustments=yield* bounded(`SELECT a.* FROM payment_adjustments a JOIN payment_orders o ON (o.reference=a.order_reference OR o.payment_intent_id=a.order_reference OR o.charge_id=a.order_reference)
        WHERE o.device_id IN ${where} AND a.adjustment_type IN ('dispute','fee') AND a.recorded_at<=?`,...ids,q.asOf);
      facts.adjustments=adjustments.map(a=>({reference:String(a.provider_ref),orderReference:String(a.order_reference),type:String(a.adjustment_type) as 'dispute'|'fee',
        amountMinor:decimal(a.amount_cents),currency:String(a.currency),status:String(a.status),effectiveAt:timestamp(a.effective_at),recordedAt:timestamp(a.recorded_at)}));
      const attempts=yield* bounded(`SELECT a.attempt_id,a.device_id,a.metadata,c.revision,c.currency,c.cost_micros,c.pricing_version,c.calculated_at,h.reserved_upper_micros
        FROM model_attempts a JOIN attempt_costs c ON c.attempt_id=a.attempt_id
        LEFT JOIN attempt_budget_holds h ON h.attempt_id=a.attempt_id
        WHERE a.device_id IN ${where} AND c.calculated_at<=? AND NOT EXISTS (
          SELECT 1 FROM attempt_costs newer WHERE newer.attempt_id=c.attempt_id AND newer.revision>c.revision AND newer.calculated_at<=?)`,...ids,q.asOf,q.asOf);
      facts.attempts=attempts.map(a=>{const metadata=JSON.parse(String(a.metadata)) as Attempt;return {
        id:String(a.attempt_id),deviceId:number(a.device_id),captureId:metadata.captureId,purpose:metadata.purpose,currency:String(a.currency),
        costMicros:a.cost_micros===null?null:decimal(a.cost_micros),upperMicros:a.reserved_upper_micros===null?null:decimal(a.reserved_upper_micros),
        revision:decimal(a.revision),pricingVersion:String(a.pricing_version),startedAt:metadata.startedAt,calculatedAt:String(a.calculated_at),
        status:metadata.finishedAt&&metadata.finishedAt<=q.asOf?metadata.status:'running'};});
      const legacyUsage=yield* bounded(`SELECT u.id,u.device_id,u.capture_id,u.created_at FROM usage_events u WHERE u.device_id IN ${where} AND u.created_at<=?
        AND NOT EXISTS(SELECT 1 FROM model_attempts a JOIN capture_requests c ON c.request_id=a.request_id
          WHERE a.device_id=u.device_id AND LOWER(c.client_capture_id)=LOWER(u.capture_id))`,...ids,q.asOf);
      facts.attempts.push(...legacyUsage.map(u=>({id:'legacy_usage:'+String(u.id),deviceId:number(u.device_id),captureId:u.capture_id===null?'legacy_usage:'+String(u.id):String(u.capture_id),
        purpose:'legacy_usage_without_currency',currency:'unknown',costMicros:null,upperMicros:null,revision:'1',pricingVersion:'legacy_unattributed',
        startedAt:timestamp(u.created_at),calculatedAt:timestamp(u.created_at),status:'unknown'})));
      const lots=yield* bounded(`SELECT * FROM quota_lots WHERE device_id IN ${where} AND created_at<=?`,...ids,q.asOf);
      const reservations=yield* bounded(`SELECT lot_id,state,settled_at FROM quota_reservations WHERE device_id IN ${where} AND created_at<=?`,...ids,q.asOf);
      const changes=yield* bounded(`SELECT c.lot_id,c.before_state,c.after_state FROM payment_quota_changes c JOIN quota_lots l ON l.lot_id=c.lot_id WHERE l.device_id IN ${where} AND c.created_at<=?`,...ids,q.asOf);
      const consumedByLot=new Map<string,bigint>(),heldByLot=new Map<string,bigint>(),revokedByLot=new Map<string,bigint>();
      for(const r of reservations){const id=String(r.lot_id);
        if(r.state==='settled'&&r.settled_at!==null&&String(r.settled_at)<=q.asOf)consumedByLot.set(id,(consumedByLot.get(id)??0n)+1n);
        if(r.settled_at===null||String(r.settled_at)>q.asOf)heldByLot.set(id,(heldByLot.get(id)??0n)+1n);
      }
      for(const c of changes){const id=String(c.lot_id),before=JSON.parse(String(c.before_state)) as RefundLot,after=JSON.parse(String(c.after_state)) as RefundLot;
        revokedByLot.set(id,(revokedByLot.get(id)??0n)+BigInt(after.revoked)-BigInt(before.revoked));}
      facts.lots=lots.map(l=>{
        const id=String(l.lot_id),consumed=consumedByLot.get(id)??0n,held=heldByLot.get(id)??0n,revoked=revokedByLot.get(id)??0n;
        const granted=BigInt(decimal(l.granted)),remaining=granted-consumed-revoked;
        if(remaining<held||remaining>granted||revoked<0n)throw new Error('Historical lot reconstruction failed');
        return {id,deviceId:number(l.device_id),kind:String(l.kind),granted:String(granted),remaining:String(remaining),held:String(held),revoked:String(revoked),createdAt:String(l.created_at),sourceRef:String(l.source_ref)};
      });
      const devicesWithLots=new Set(facts.lots.map(l=>l.deviceId));facts.untrackedQuotaDeviceIds=ids.filter(id=>!devicesWithLots.has(id));
      return facts;
    })(), {readOnlySnapshot: postgres});
  }
  setInternal(deviceId:number,internal:boolean,reference:string):Promise<boolean>{
    return this.run((function*():Transaction<boolean>{
      const d=(yield* query('SELECT id FROM devices WHERE id=? FOR UPDATE',deviceId))[0];if(!d)return false;
      const prior=(yield* query('SELECT * FROM internal_device_changes WHERE reference=?',reference))[0];
      if(prior)return number(prior.device_id)===deviceId&&Number(prior.is_internal)===(internal?1:0);
      yield* query('INSERT INTO internal_device_changes(reference,device_id,is_internal,recorded_at) VALUES(?,?,?,?)',reference,deviceId,internal?1:0,new Date().toISOString());
      yield* query('UPDATE devices SET is_internal=? WHERE id=?',internal?1:0,deviceId);return true;
    })());
  }
  source(token:string,group:string,method:'self_reported'):Promise<boolean>{
    return this.run((function*():Transaction<boolean>{
      const d=(yield* query('SELECT id FROM devices WHERE token_hash=? FOR UPDATE',hashToken(token)))[0];if(!d)return false;
      const prior=(yield* query('SELECT source_group,source_method FROM device_sources WHERE device_id=?',number(d.id)))[0];
      if(prior)return prior.source_group===group&&prior.source_method===method;
      yield* query('INSERT INTO device_sources(device_id,source_group,source_method,recorded_at) VALUES(?,?,?,?)',number(d.id),group,method,new Date().toISOString());return true;
    })());
  }
  expense(input:ReportExpenseInput):Promise<boolean>{
    return this.run((function*():Transaction<boolean>{
      yield* query('SELECT id FROM report_allocation_lock WHERE id=1 FOR UPDATE');
      const prior=(yield* query('SELECT * FROM report_expense_allocations WHERE reference=?',input.reference))[0];
      if(prior)return prior.kind===input.kind&&prior.currency===input.currency&&prior.amount_micros===input.amountMicros&&prior.cohort_from===input.cohortFrom&&prior.cohort_to===input.cohortTo&&prior.coverage_through===input.coverageThrough&&prior.source_group===(input.sourceGroup??null)&&prior.policy_version===(input.policyVersion??null);
      const revision=(yield* query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM report_expense_allocations'))[0]!.revision;
      const inserted=yield* query('INSERT INTO report_expense_allocations(reference,kind,currency,amount_micros,cohort_from,cohort_to,coverage_through,recorded_at,source_group,policy_version,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(reference) DO NOTHING RETURNING reference',
        input.reference,input.kind,input.currency,input.amountMicros,input.cohortFrom,input.cohortTo,input.coverageThrough,new Date().toISOString(),input.sourceGroup??null,input.policyVersion??null,decimal(revision));return inserted.length===1;
    })());
  }
}
