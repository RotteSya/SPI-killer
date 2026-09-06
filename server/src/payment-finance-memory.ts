import {financeDigest,financeResources,financeTotals,validateFinanceNotice,validateFinanceSnapshot,type FinanceOrder,type FinanceNotice,type FinanceClaim,type FinanceSnapshot,type FinanceRevision,type FinanceJob,type PaymentFinance} from './payment-finance.ts';

const zero='1970-01-01T00:00:00.000Z',date=(millis=Date.now())=>new Date(millis).toISOString();
export class MemoryPaymentFinance implements PaymentFinance {
  private version=0n;
  private notices=new Map<string,{notice:FinanceNotice;version:bigint;recordedAt:string}>();
  private jobs=new Map<string,FinanceJob>();
  private revisions:FinanceRevision[]=[];
  private links=new Map<string,string>();
  private orders:()=>FinanceOrder[];
  constructor(orders:()=>FinanceOrder[]){this.orders=orders;}
  async observe(notice:FinanceNotice):Promise<void>{
    validateFinanceNotice(notice);const copy={event:{...notice.event},resources:[...new Set(notice.resources)].sort()},old=this.notices.get(copy.event.id);
    if(old){if(JSON.stringify(old.notice)!==JSON.stringify(copy))throw new Error('Finance notice conflict');return;}
    this.notices.set(copy.event.id,{notice:copy,version:++this.version,recordedAt:date()});
  }
  private noticeVersion(resources:string[],asOf:string){const ids=new Set(resources);let version=0n;
    for(const n of this.notices.values())if(n.recordedAt<=asOf&&n.notice.resources.some(id=>ids.has(id))&&n.version>version)version=n.version;return version;
  }
  private changed(order:FinanceOrder,job:FinanceJob,now:string){return this.noticeVersion([...financeResources(order),...[...this.links].filter(([,ref])=>ref===order.reference).map(([id])=>id)],now)>BigInt(job.watermark);}
  async pending(now=date(),limit=3):Promise<string[]>{
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid finance limit');
    return this.orders().filter(o=>{const j=this.jobs.get(o.reference);return (o.paymentIntentId||o.chargeId)&&(!j||(j.leaseUntil<=now&&(this.changed(o,j,now)||(j.attempts<5&&j.nextAt<=now))));})
      .sort((a,b)=>(this.jobs.get(a.reference)?.nextAt??zero).localeCompare(this.jobs.get(b.reference)?.nextAt??zero)||a.reference.localeCompare(b.reference)).slice(0,limit).map(o=>o.reference);
  }
  async claim(reference:string,force=false):Promise<FinanceClaim|null>{
    const order=this.orders().find(o=>o.reference===reference);if(!order||(!order.paymentIntentId&&!order.chargeId))return null;
    const j=this.jobs.get(reference)??{orderReference:reference,generation:'0',watermark:'0',leaseUntil:zero,nextAt:zero,attempts:0,status:'pending'},now=date();
    const changed=this.changed(order,j,now);if(j.leaseUntil>now||(!force&&!changed&&(j.nextAt>now||j.attempts>=5)))return null;
    j.generation=(BigInt(j.generation)+1n).toString();j.watermark=this.version.toString();j.leaseUntil=date(Date.parse(now)+30_000);j.nextAt=now;j.attempts=force||changed?1:j.attempts+1;j.status='reading';this.jobs.set(reference,j);
    return {order:structuredClone(order),generation:j.generation,watermark:j.watermark,startedAt:now,leaseUntil:j.leaseUntil};
  }
  async finish(claim:FinanceClaim,snapshot:FinanceSnapshot):Promise<boolean>{
    validateFinanceSnapshot(claim.order,snapshot);const j=this.jobs.get(claim.order.reference),now=date();
    if(!j||j.generation!==claim.generation||j.status!=='reading'||j.leaseUntil<=now)return false;
    if(snapshot.transactions.some(t=>t.createdAt>now))throw new Error('Future balance transaction');
    const resources=financeResources(claim.order,snapshot);
    if(resources.some(id=>this.links.has(id)&&this.links.get(id)!==claim.order.reference))throw new Error('Finance resource reused across orders');
    for(const id of resources)this.links.set(id,claim.order.reference);
    this.revisions.push({orderReference:claim.order.reference,generation:claim.generation,watermark:claim.watermark,startedAt:claim.startedAt,recordedAt:now,digest:financeDigest(snapshot),snapshot:structuredClone(snapshot),dirty:false});
    const totals=financeTotals(snapshot,claim.order.currency);j.leaseUntil=zero;j.nextAt=date(Date.parse(now)+(totals.feesComplete&&!totals.disputesUnknown?86_400_000:300_000));j.attempts=0;j.status='verified';return true;
  }
  async defer(claim:FinanceClaim):Promise<void>{const j=this.jobs.get(claim.order.reference);if(j?.generation===claim.generation&&j.status==='reading'){
    j.leaseUntil=zero;j.nextAt=date(Date.now()+60_000);j.status=j.attempts>=5?'review':'pending';
  }}
  facts(ids:Set<number>,asOf:string):FinanceRevision[]{
    const orders=new Map(this.orders().filter(o=>ids.has(o.deviceId)).map(o=>[o.reference,o]));
    const latest=new Map<string,FinanceRevision>();for(const r of this.revisions)if(orders.has(r.orderReference)&&r.recordedAt<=asOf&&(!latest.has(r.orderReference)||BigInt(latest.get(r.orderReference)!.generation)<BigInt(r.generation)))latest.set(r.orderReference,r);
    return [...latest.values()].sort((a,b)=>a.orderReference.localeCompare(b.orderReference)).map(r=>({...structuredClone(r),dirty:this.noticeVersion(financeResources(orders.get(r.orderReference)!,r.snapshot),asOf)>BigInt(r.watermark)}));
  }
  async inspect(reference:string):Promise<{job:FinanceJob|null;revision:FinanceRevision|null}>{
    const order=this.orders().find(o=>o.reference===reference);
    return {job:structuredClone(this.jobs.get(reference)??null),revision:order?this.facts(new Set([order.deviceId]),date()).find(r=>r.orderReference===reference)??null:null};
  }
}
