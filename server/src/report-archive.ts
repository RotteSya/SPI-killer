import { createHash } from 'node:crypto';
import { aggregateCohorts, aggregateEconomics, DAY, REPORT_DEFINITION, type ReportingFacts, type ReportQuery } from './reporting.ts';

export function assembleReport(facts:ReportingFacts,query:ReportQuery) {
  const financialQuery={...query,profile:undefined,channel:undefined};
  const cohort=aggregateCohorts(facts,query),economics=aggregateEconomics(facts,financialQuery);
  return {definition_version:REPORT_DEFINITION,query:cohort.query,revision:cohort.revision,
    cohort,economics,by_source:(query.source?[query.source]:['spi_entry','reading_practice_entry','direct','unknown']).map(source=>({
      source,cohort:aggregateCohorts(facts,{...query,source}),economics:aggregateEconomics(facts,{...financialQuery,source}),
    })),financial_dimensions:'source_and_policy_only; profile_and_channel_filter_client_outcomes_only'};
}
export type ReportBundle=ReturnType<typeof assembleReport>;
export interface ReportArchiveSummary {
  id:string;created_at:string;definition_version:string;query:ReportBundle['query'];revision:string;
  payload_sha256:string;status:'immutable_snapshot';
}
export interface ReportArchive extends ReportArchiveSummary {report:ReportBundle}
export interface ReportArchivePage {items:ReportArchiveSummary[];next_cursor:string|null}
export interface ReportArchiveStore {
  save(report:ReportBundle):Promise<ReportArchive>;
  get(id:string):Promise<ReportArchive|null>;
  list(limit:number,cursor?:string):Promise<ReportArchivePage>;
}
export class ArchiveIntegrityError extends Error {}
export class ReportExpiredError extends Error {}
// Once event/coverage retention can have removed facts, a historical recomputation cannot
// be presented as a revision. Use the already archived aggregate instead. The financial
// ledger remains available for reconciliation through its separate admin endpoints.
export function assertReportRetained(query:ReportQuery,now=Date.now()):void {
  if(Date.parse(query.cohortFrom)<now-90*DAY)throw new ReportExpiredError('Read an archived report for cohorts outside detail retention');
}
function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  throw new ArchiveIntegrityError('Report contains an unsupported value');
}
export function archivePayload(report:ReportBundle):{payload:string;digest:string} {
  const payload=canonical(report);
  if(Buffer.byteLength(payload)>1_048_576)throw new ArchiveIntegrityError('Report archive exceeds size limit');
  return {payload,digest:createHash('sha256').update(payload).digest('hex')};
}
export function archiveSummary(archive:ReportArchive):ReportArchiveSummary {
  const {report:_report,...summary}=archive;return summary;
}
export function decodeArchive(id:string,createdAt:string,payload:string):ReportArchive {
  if(!/^[a-f0-9]{64}$/.test(id)||Buffer.byteLength(payload)>1_048_576)throw new ArchiveIntegrityError('Invalid report archive');
  let report:ReportBundle;
  try{report=JSON.parse(payload) as ReportBundle;}catch{throw new ArchiveIntegrityError('Invalid report archive JSON');}
  if(!report||typeof report!=='object'||!report.query||typeof report.definition_version!=='string'||typeof report.revision!=='string'||
    archivePayload(report).digest!==id)throw new ArchiveIntegrityError('Report archive checksum mismatch');
  return {id,created_at:createdAt,definition_version:report.definition_version,query:report.query,revision:report.revision,
    payload_sha256:id,status:'immutable_snapshot',report};
}
export function archiveCursor(summary:Pick<ReportArchiveSummary,'created_at'|'id'>):string {
  return Buffer.from(JSON.stringify([summary.created_at,summary.id])).toString('base64url');
}
export function parseArchiveCursor(cursor:string):[string,string] {
  try{
    if(cursor.length>160||! /^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
    const raw=JSON.parse(Buffer.from(cursor,'base64url').toString());
    if(!Array.isArray(raw)||raw.length!==2||typeof raw[0]!=='string'||typeof raw[1]!=='string'||
      ! /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw[0])||new Date(raw[0]).toISOString()!==raw[0]||! /^[a-f0-9]{64}$/.test(raw[1]))throw new Error();
    return [raw[0],raw[1]];
  }catch{throw new Error('Invalid archive cursor');}
}
export function archivePageLimit(limit:number):void {
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('Invalid archive page size');
}
export class MemoryReportArchiveStore implements ReportArchiveStore {
  private rows=new Map<string,{payload:string;createdAt:string}>();
  async save(report:ReportBundle):Promise<ReportArchive>{
    const {payload,digest}=archivePayload(report),row=this.rows.get(digest)??{payload,createdAt:new Date().toISOString()};
    this.rows.set(digest,row);return decodeArchive(digest,row.createdAt,row.payload);
  }
  async get(id:string):Promise<ReportArchive|null>{const row=this.rows.get(id);return row?decodeArchive(id,row.createdAt,row.payload):null;}
  async list(limit:number,cursor?:string):Promise<ReportArchivePage>{
    archivePageLimit(limit);const after=cursor?parseArchiveCursor(cursor):null;
    const rows=[...this.rows.entries()].filter(([id,row])=>!after||row.createdAt<after[0]||(row.createdAt===after[0]&&id<after[1]))
      .sort(([a,x],[b,y])=>y.createdAt.localeCompare(x.createdAt)||b.localeCompare(a));
    const items=rows.slice(0,limit).map(([id,row])=>archiveSummary(decodeArchive(id,row.createdAt,row.payload)));
    return {items,next_cursor:rows.length>limit?archiveCursor(items.at(-1)!):null};
  }
}
