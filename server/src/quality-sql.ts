import {query,type Row,type RunTransaction,type Transaction} from './billing-sql.ts';
import {aggregateQuality,parseQualitySubmission,qualityCanonical,qualityDigest,qualityRecord,qualityWithdrawal,validateQualityList,QualityConflictError,
  type QualityListQuery,type QualityPage,type QualityRecord,type QualityStore,type QualitySubmission,type QualityWithdrawal} from './quality.ts';
export const QUALITY_SCHEMA=`
CREATE TABLE IF NOT EXISTS quality_revision_lock (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO quality_revision_lock(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS quality_runs (run_id TEXT PRIMARY KEY,execution_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quality_reports (
 report_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES quality_runs(run_id),revision BIGINT NOT NULL UNIQUE,
 created_at TEXT NOT NULL,contract TEXT NOT NULL,scope_version TEXT NOT NULL,payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quality_latest ON quality_reports(run_id,revision);
CREATE TABLE IF NOT EXISTS quality_cells (
 report_id TEXT NOT NULL REFERENCES quality_reports(report_id),profile TEXT NOT NULL,kind TEXT NOT NULL,language TEXT NOT NULL,
 PRIMARY KEY(report_id,profile,kind,language)
);
CREATE INDEX IF NOT EXISTS idx_quality_dimensions ON quality_cells(profile,kind,language,report_id);
CREATE TABLE IF NOT EXISTS quality_withdrawals (
 report_id TEXT PRIMARY KEY REFERENCES quality_reports(report_id),reference TEXT NOT NULL UNIQUE,reason TEXT NOT NULL,recorded_at TEXT NOT NULL
);
`;
const select=`SELECT r.*,w.reference AS withdrawal_reference,w.reason AS withdrawal_reason,w.recorded_at AS withdrawn_at
 FROM quality_reports r LEFT JOIN quality_withdrawals w ON w.report_id=r.report_id`;
function decode(row:Row):QualityRecord {
  return qualityRecord(String(row.report_id),String(row.revision),String(row.created_at),String(row.payload),row.withdrawal_reference===null?null:{
    reference:String(row.withdrawal_reference),reason:String(row.withdrawal_reason) as QualityWithdrawal['reason'],recorded_at:String(row.withdrawn_at)});
}
export class SQLQualityStore implements QualityStore {
  private run:RunTransaction;
  constructor(run:RunTransaction){this.run=run;}
  async record(raw:QualitySubmission):Promise<QualityRecord>{
    const input=parseQualitySubmission(raw),execution=qualityDigest(input.run),report=aggregateQuality(input),id=qualityDigest(report),payload=qualityCanonical(report),createdAt=new Date().toISOString();
    return this.run((function*():Transaction<QualityRecord>{
      yield* query('SELECT id FROM quality_revision_lock WHERE id=1 FOR UPDATE');
      const previous=(yield* query('SELECT execution_sha256 FROM quality_runs WHERE run_id=?',input.run.id))[0];
      if(previous&&String(previous.execution_sha256)!==execution)throw new QualityConflictError('Evaluation ID cannot be rebound to another execution');
      const prior=(yield* query(select+' WHERE r.report_id=?',id))[0];if(prior)return decode(prior);
      yield* query('INSERT INTO quality_runs(run_id,execution_sha256) VALUES(?,?) ON CONFLICT(run_id) DO NOTHING',input.run.id,execution);
      const maximum=(yield* query('SELECT COALESCE(MAX(revision),0) AS revision FROM quality_reports'))[0]!;
      const revision=String(BigInt(String(maximum.revision))+1n);
      yield* query('INSERT INTO quality_reports(report_id,run_id,revision,created_at,contract,scope_version,payload) VALUES(?,?,?,?,?,?,?)',id,input.run.id,revision,createdAt,input.run.contract,input.run.scope_version,payload);
      for(const c of report.cells)yield* query('INSERT INTO quality_cells(report_id,profile,kind,language) VALUES(?,?,?,?)',id,c.profile!,c.kind!,c.language!);
      return qualityRecord(id,revision,createdAt,payload,null);
    })());
  }
  get(id:string):Promise<QualityRecord|null>{return this.run((function*():Transaction<QualityRecord|null>{const row=(yield* query(select+' WHERE r.report_id=?',id))[0];return row?decode(row):null;})());}
  async list(q:QualityListQuery):Promise<QualityPage>{
    validateQualityList(q);const conditions:string[]=[],args:Array<string|number>=[];
    if(!q.includeHistory)conditions.push('NOT EXISTS(SELECT 1 FROM quality_reports newer WHERE newer.run_id=r.run_id AND newer.revision>r.revision)');
    if(q.beforeRevision){conditions.push('r.revision<?');args.push(q.beforeRevision);}
    if(q.contract){conditions.push('r.contract=?');args.push(q.contract);}
    if(q.scopeVersion){conditions.push('r.scope_version=?');args.push(q.scopeVersion);}
    const dimensions=['c.report_id=r.report_id'];
    for(const key of ['profile','kind','language'] as const)if(q[key]){dimensions.push('c.'+key+'=?');args.push(q[key]!);}
    conditions.push('EXISTS(SELECT 1 FROM quality_cells c WHERE '+dimensions.join(' AND ')+')');
    const sql=select+' WHERE '+conditions.join(' AND ')+' ORDER BY r.revision DESC LIMIT ?';
    return this.run((function*():Transaction<QualityPage>{const rows=yield* query(sql,...args,q.limit+1);
      const items=rows.slice(0,q.limit).map(decode);return {items,next_revision:rows.length>q.limit?items.at(-1)!.revision:null};})());
  }
  async withdraw(id:string,reference:string,reason:QualityWithdrawal['reason']):Promise<boolean>{
    const input=qualityWithdrawal(reference,reason),now=new Date().toISOString();
    return this.run((function*():Transaction<boolean>{
      yield* query('SELECT id FROM quality_revision_lock WHERE id=1 FOR UPDATE');
      if(!(yield* query('SELECT report_id FROM quality_reports WHERE report_id=?',id))[0])return false;
      const prior=(yield* query('SELECT * FROM quality_withdrawals WHERE report_id=? OR reference=?',id,input.reference))[0];
      if(prior)return String(prior.report_id)===id&&String(prior.reference)===input.reference&&String(prior.reason)===input.reason;
      yield* query('INSERT INTO quality_withdrawals(report_id,reference,reason,recorded_at) VALUES(?,?,?,?)',id,input.reference,input.reason,now);return true;
    })());
  }
}
