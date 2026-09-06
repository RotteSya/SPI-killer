import {query,type RunTransaction,type Transaction,type Row} from './billing-sql.ts';
import {financeOrder,financeDigest,financeResources,financeTotals,validateFinanceNotice,validateFinanceSnapshot,type FinanceNotice,type FinanceClaim,type FinanceSnapshot,type FinanceRevision,type FinanceJob,type PaymentFinance} from './payment-finance.ts';
import type {PaymentOrder} from './payment-ledger.ts';
import {ReportLimitError} from './reporting.ts';

export const FINANCE_SCHEMA=`
CREATE TABLE IF NOT EXISTS finance_state(id INTEGER PRIMARY KEY CHECK(id=1),version BIGINT NOT NULL);
INSERT INTO finance_state(id,version) VALUES(1,0) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS finance_notices(event_id TEXT PRIMARY KEY,revision BIGINT UNIQUE NOT NULL,metadata TEXT NOT NULL,recorded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS finance_notice_links(revision BIGINT NOT NULL REFERENCES finance_notices(revision),resource_id TEXT NOT NULL,PRIMARY KEY(resource_id,revision));
CREATE TABLE IF NOT EXISTS finance_jobs(order_reference TEXT PRIMARY KEY REFERENCES payment_orders(reference),generation BIGINT NOT NULL DEFAULT 0,
 watermark BIGINT NOT NULL DEFAULT 0,lease_until TEXT NOT NULL,next_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_finance_jobs_due ON finance_jobs(next_at);
CREATE TABLE IF NOT EXISTS finance_order_links(resource_id TEXT PRIMARY KEY,order_reference TEXT NOT NULL REFERENCES payment_orders(reference));
CREATE INDEX IF NOT EXISTS idx_finance_order_links ON finance_order_links(order_reference);
CREATE TABLE IF NOT EXISTS finance_revisions(order_reference TEXT NOT NULL REFERENCES payment_orders(reference),generation BIGINT NOT NULL,watermark BIGINT NOT NULL,
 started_at TEXT NOT NULL,recorded_at TEXT NOT NULL,digest TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(order_reference,generation));
CREATE INDEX IF NOT EXISTS idx_finance_revision_time ON finance_revisions(order_reference,recorded_at);
`;
const zero='1970-01-01T00:00:00.000Z';
const date=(millis:number)=>new Date(millis).toISOString();
function job(row:Row):FinanceJob{return {orderReference:String(row.order_reference),generation:String(row.generation),watermark:String(row.watermark),leaseUntil:String(row.lease_until),nextAt:String(row.next_at),attempts:Number(row.attempts),status:row.status as FinanceJob['status']};}
function revision(row:Row):FinanceRevision{return {orderReference:String(row.order_reference),generation:String(row.generation),watermark:String(row.watermark),startedAt:String(row.started_at),recordedAt:String(row.recorded_at),digest:String(row.digest),snapshot:JSON.parse(String(row.metadata)),dirty:false};}
const linkedNotice=`EXISTS(SELECT 1 FROM finance_notice_links nl WHERE nl.revision>COALESCE(j.watermark,0) AND
 (nl.resource_id=o.reference OR nl.resource_id=o.payment_intent_id OR nl.resource_id=o.charge_id OR
 nl.resource_id IN(SELECT resource_id FROM finance_order_links WHERE order_reference=o.reference)))`;
function* noticeVersion(resources:string[],asOf:string):Transaction<bigint>{
  let result=0n;for(let offset=0;offset<resources.length;offset+=250){const batch=resources.slice(offset,offset+250);
    const rows=yield* query(`SELECT MAX(l.revision) AS version FROM finance_notice_links l JOIN finance_notices n ON n.revision=l.revision
      WHERE l.resource_id IN (${batch.map(()=>'?').join(',')}) AND n.recorded_at<=?`,...batch,asOf);
    const version=BigInt(String(rows[0]?.version??0));if(version>result)result=version;
  }return result;
}
export class SQLPaymentFinance implements PaymentFinance {
  private run:RunTransaction;
  constructor(run:RunTransaction){this.run=run;}
  observe(notice:FinanceNotice):Promise<void>{
    validateFinanceNotice(notice);const copy={event:{...notice.event},resources:[...new Set(notice.resources)].sort()};
    return this.run((function*():Transaction<void>{
      const state=(yield* query('SELECT version FROM finance_state WHERE id=1 FOR UPDATE'))[0]!;
      const old=(yield* query('SELECT metadata FROM finance_notices WHERE event_id=?',copy.event.id))[0];
      if(old){if(String(old.metadata)!==JSON.stringify(copy))throw new Error('Finance notice conflict');return;}
      const next=(BigInt(String(state.version))+1n).toString();
      yield* query('UPDATE finance_state SET version=? WHERE id=1',next);
      yield* query('INSERT INTO finance_notices(event_id,revision,metadata,recorded_at) VALUES(?,?,?,?)',copy.event.id,next,JSON.stringify(copy),date(Date.now()));
      for(const resource of copy.resources)yield* query('INSERT INTO finance_notice_links(revision,resource_id) VALUES(?,?)',next,resource);
    })());
  }
  pending(now=date(Date.now()),limit=3):Promise<string[]>{
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid finance limit');
    return this.run((function*():Transaction<string[]>{
      const rows=yield* query(`SELECT o.reference FROM payment_orders o LEFT JOIN finance_jobs j ON j.order_reference=o.reference
        WHERE (o.payment_intent_id IS NOT NULL OR o.charge_id IS NOT NULL) AND (j.order_reference IS NULL OR
        (j.lease_until<=? AND ((${linkedNotice}) OR (j.attempts<5 AND j.next_at<=?))))
        ORDER BY COALESCE(j.next_at,o.created_at),o.reference LIMIT ?`,now,now,limit);
      return rows.map(r=>String(r.reference));
    })());
  }
  claim(reference:string,force=false):Promise<FinanceClaim|null>{
    return this.run((function*():Transaction<FinanceClaim|null>{
      const row=(yield* query('SELECT metadata FROM payment_orders WHERE reference=?',reference))[0];if(!row)return null;
      const order=financeOrder(JSON.parse(String(row.metadata)) as PaymentOrder);if(!order.paymentIntentId&&!order.chargeId)return null;
      yield* query("INSERT INTO finance_jobs(order_reference,lease_until,next_at,status) VALUES(?,?,?,'pending') ON CONFLICT(order_reference) DO NOTHING",reference,zero,zero);
      const j=job((yield* query('SELECT * FROM finance_jobs WHERE order_reference=? FOR UPDATE',reference))[0]!);
      const now=date(Date.now());if(j.leaseUntil>now)return null;
      const links=yield* query('SELECT resource_id FROM finance_order_links WHERE order_reference=?',reference);
      const changed=(yield* noticeVersion([...financeResources(order),...links.map(l=>String(l.resource_id))],now))>BigInt(j.watermark);
      if(!force&&!changed&&(j.nextAt>now||j.attempts>=5))return null;
      const watermark=String((yield* query('SELECT version FROM finance_state WHERE id=1'))[0]!.version);
      const generation=(BigInt(j.generation)+1n).toString(),leaseUntil=date(Date.parse(now)+30_000);
      yield* query("UPDATE finance_jobs SET generation=?,watermark=?,lease_until=?,next_at=?,attempts=?,status='reading' WHERE order_reference=?",generation,watermark,leaseUntil,now,force||changed?1:j.attempts+1,reference);
      return {order,generation,watermark,startedAt:now,leaseUntil};
    })());
  }
  finish(claim:FinanceClaim,snapshot:FinanceSnapshot):Promise<boolean>{
    validateFinanceSnapshot(claim.order,snapshot);const copy=structuredClone(snapshot),digest=financeDigest(copy);
    return this.run((function*():Transaction<boolean>{
      const row=(yield* query('SELECT * FROM finance_jobs WHERE order_reference=? FOR UPDATE',claim.order.reference))[0];
      const now=date(Date.now());if(!row||String(row.generation)!==claim.generation||String(row.status)!=='reading'||String(row.lease_until)<=now)return false;
      if(copy.transactions.some(t=>t.createdAt>now))throw new Error('Future balance transaction');
      const resources=financeResources(claim.order,copy).sort();
      for(let offset=0;offset<resources.length;offset+=250){const batch=resources.slice(offset,offset+250);
        yield* query('INSERT INTO finance_order_links(resource_id,order_reference) VALUES '+batch.map(()=>'(?,?)').join(',')+' ON CONFLICT(resource_id) DO NOTHING',...batch.flatMap(resource=>[resource,claim.order.reference]));
        const owners=yield* query('SELECT order_reference FROM finance_order_links WHERE resource_id IN ('+batch.map(()=>'?').join(',')+')',...batch);
        if(owners.length!==batch.length||owners.some(owner=>String(owner.order_reference)!==claim.order.reference))throw new Error('Finance resource reused across orders');
      }
      const recordedAt=date(Date.now());if(String(row.lease_until)<=recordedAt)return false;
      yield* query('INSERT INTO finance_revisions(order_reference,generation,watermark,started_at,recorded_at,digest,metadata) VALUES(?,?,?,?,?,?,?)',claim.order.reference,claim.generation,claim.watermark,claim.startedAt,recordedAt,digest,JSON.stringify(copy));
      const totals=financeTotals(copy,claim.order.currency);
      yield* query("UPDATE finance_jobs SET lease_until=?,next_at=?,attempts=0,status='verified' WHERE order_reference=?",zero,date(Date.parse(recordedAt)+(totals.feesComplete&&!totals.disputesUnknown?86_400_000:300_000)),claim.order.reference);
      return true;
    })());
  }
  defer(claim:FinanceClaim):Promise<void>{return this.run((function*():Transaction<void>{
    yield* query("UPDATE finance_jobs SET lease_until=?,next_at=?,status=CASE WHEN attempts>=5 THEN 'review' ELSE 'pending' END WHERE order_reference=? AND generation=? AND status='reading'",
      zero,date(Date.now()+60_000),claim.order.reference,claim.generation);
  })());}
  inspect(reference:string):Promise<{job:FinanceJob|null;revision:FinanceRevision|null}>{return this.run((function*():Transaction<{job:FinanceJob|null;revision:FinanceRevision|null}>{
    const j=(yield* query('SELECT * FROM finance_jobs WHERE order_reference=?',reference))[0];
    const r=(yield* query('SELECT * FROM finance_revisions WHERE order_reference=? ORDER BY generation DESC LIMIT 1',reference))[0];
    const order=(yield* query('SELECT metadata FROM payment_orders WHERE reference=?',reference))[0];const rev=r?revision(r):null;
    if(rev&&order){const o=financeOrder(JSON.parse(String(order.metadata)));validateFinanceSnapshot(o,rev.snapshot);if(financeDigest(rev.snapshot)!==rev.digest)throw new Error('Finance snapshot integrity failure');
      rev.dirty=(yield* noticeVersion(financeResources(o,rev.snapshot),date(Date.now())))>BigInt(rev.watermark);}
    return {job:j?job(j):null,revision:rev};
  })());}
}

/** Called inside the reporting transaction, so notice revisions and snapshot cutoffs agree. */
export function* financeFacts(deviceIDs:number[],asOf:string):Transaction<FinanceRevision[]>{
  if(!deviceIDs.length)return [];
  const where=`o.device_id IN (${deviceIDs.map(()=>'?').join(',')}) AND r.recorded_at<=? AND NOT EXISTS
    (SELECT 1 FROM finance_revisions newer WHERE newer.order_reference=r.order_reference AND newer.generation>r.generation AND newer.recorded_at<=?)`;
  const args=[...deviceIDs,asOf,asOf],from='FROM finance_revisions r JOIN payment_orders o ON o.reference=r.order_reference WHERE '+where;
  const size=(yield* query('SELECT COUNT(*) AS count,COALESCE(SUM(length(r.metadata)),0) AS bytes '+from,...args))[0]!;
  if(Number(size.count)>10000||Number(size.bytes)>32*1024*1024)throw new ReportLimitError('Finance snapshot report exceeds limit');
  const rows=yield* query('SELECT r.*,o.metadata AS order_metadata '+from+' ORDER BY r.order_reference',...args);
  const revisions=rows.map(r=>{const rev=revision(r),order=financeOrder(JSON.parse(String(r.order_metadata)));validateFinanceSnapshot(order,rev.snapshot);
    if(financeDigest(rev.snapshot)!==rev.digest)throw new Error('Finance snapshot integrity failure');return {revision:rev,order};});
  const resources=[...new Set(revisions.flatMap(r=>financeResources(r.order,r.revision.snapshot)))];
  if(resources.length>200000)throw new ReportLimitError('Finance resource report exceeds limit');
  const noticeVersions=new Map<string,bigint>();
  for(let offset=0;offset<resources.length;offset+=250){const batch=resources.slice(offset,offset+250);
    const notices=yield* query(`SELECT l.resource_id,MAX(l.revision) AS version FROM finance_notice_links l JOIN finance_notices n ON n.revision=l.revision
      WHERE l.resource_id IN (${batch.map(()=>'?').join(',')}) AND n.recorded_at<=? GROUP BY l.resource_id`,...batch,asOf);
    for(const n of notices)noticeVersions.set(String(n.resource_id),BigInt(String(n.version)));
  }
  return revisions.map(({order,revision:r})=>({...r,dirty:financeResources(order,r.snapshot).some(id=>(noticeVersions.get(id)??0n)>BigInt(r.watermark))}));
}
