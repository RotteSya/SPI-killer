import {aggregateQuality,parseQualitySubmission,qualityCanonical,qualityDigest,qualityRecord,qualityWithdrawal,validateQualityList,QualityConflictError,
  type QualityListQuery,type QualityPage,type QualityRecord,type QualityStore,type QualitySubmission,type QualityWithdrawal} from './quality.ts';
export class MemoryQualityStore implements QualityStore {
  private rows=new Map<string,{payload:string;createdAt:string;revision:string;runId:string}>();
  private runs=new Map<string,string>();
  private withdrawals=new Map<string,QualityWithdrawal>();
  private references=new Map<string,string>();
  private revision=0n;
  async record(raw:QualitySubmission):Promise<QualityRecord>{
    const input=parseQualitySubmission(raw),runDigest=qualityDigest(input.run),prior=this.runs.get(input.run.id);
    if(prior&&prior!==runDigest)throw new QualityConflictError('Evaluation ID cannot be rebound to another execution');
    const report=aggregateQuality(input),payload=qualityCanonical(report),id=qualityDigest(report);
    if(!this.rows.has(id)){
      this.revision++;this.rows.set(id,{payload,createdAt:new Date().toISOString(),revision:String(this.revision),runId:input.run.id});this.runs.set(input.run.id,runDigest);
    }
    return (await this.get(id))!;
  }
  async get(id:string):Promise<QualityRecord|null>{
    const row=this.rows.get(id);return row?qualityRecord(id,row.revision,row.createdAt,row.payload,structuredClone(this.withdrawals.get(id)??null)):null;
  }
  async list(q:QualityListQuery):Promise<QualityPage>{
    validateQualityList(q);const latest=new Map<string,string>();
    for(const row of this.rows.values()){const prev=latest.get(row.runId);if(!prev||BigInt(row.revision)>BigInt(prev))latest.set(row.runId,row.revision);}
    const records=[...this.rows.entries()].filter(([,row])=>(q.includeHistory||latest.get(row.runId)===row.revision)&&(!q.beforeRevision||BigInt(row.revision)<BigInt(q.beforeRevision)))
      .map(([id,row])=>qualityRecord(id,row.revision,row.createdAt,row.payload,structuredClone(this.withdrawals.get(id)??null)))
      .filter(r=>(!q.contract||r.report.run.contract===q.contract)&&(!q.scopeVersion||r.report.run.scope_version===q.scopeVersion)&&r.report.cells.some(c=>(!q.profile||c.profile===q.profile)&&(!q.kind||c.kind===q.kind)&&(!q.language||c.language===q.language)))
      .sort((a,b)=>BigInt(a.revision)>BigInt(b.revision)?-1:1);
    const items=records.slice(0,q.limit);return {items,next_revision:records.length>q.limit?items.at(-1)!.revision:null};
  }
  async withdraw(id:string,reference:string,reason:QualityWithdrawal['reason']):Promise<boolean>{
    const input=qualityWithdrawal(reference,reason),prior=this.withdrawals.get(id),previousId=this.references.get(input.reference);
    if(!this.rows.has(id)||(previousId&&previousId!==id))return false;
    if(prior)return prior.reference===input.reference&&prior.reason===input.reason;
    this.withdrawals.set(id,{...input,recorded_at:new Date().toISOString()});this.references.set(reference,id);return true;
  }
}
