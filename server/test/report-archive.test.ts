import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStore} from '../src/db-sqlite.ts';
import {archivePayload,ArchiveIntegrityError,assembleReport,assertReportRetained,decodeArchive,ReportExpiredError} from '../src/report-archive.ts';
import {DAY,type ReportingFacts} from '../src/reporting.ts';

const query={cohortFrom:'2026-01-01T00:00:00.000Z',cohortTo:'2026-01-02T00:00:00.000Z',asOf:'2026-02-10T00:00:00.000Z'};
const facts:ReportingFacts={devices:[],sources:[],events:[],preferences:[],observations:[],captures:[],orders:[],refunds:[],adjustments:[],attempts:[],lots:[],expenses:[],untrackedQuotaDeviceIds:[]};
test('archive hashing is key-order independent, detects corruption, and refuses unsupported payload values',()=>{
  const report=assembleReport(facts,query),{payload,digest}=archivePayload(report);
  const reversed=Object.fromEntries(Object.entries(report).reverse()) as typeof report;
  assert.equal(archivePayload(reversed).digest,digest);assert.equal(decodeArchive(digest,query.asOf,payload).report.revision,report.revision);
  assert.throws(()=>decodeArchive(digest,query.asOf,payload.replace('device_not_person','altered_identity')),ArchiveIntegrityError);
  assert.throws(()=>decodeArchive(digest,query.asOf,'{'),ArchiveIntegrityError);
  report.cohort.registered=Number.NaN;assert.throws(()=>archivePayload(report),ArchiveIntegrityError);
  assert.doesNotThrow(()=>assertReportRetained(query,Date.parse(query.cohortFrom)+90*DAY));
  assert.throws(()=>assertReportRetained(query,Date.parse(query.cohortFrom)+90*DAY+1),ReportExpiredError);
});
test('SQLite archive persists across restart and corruption fails closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nspi-archive-test-')),path=join(dir,'test.sqlite');let store:SqliteStore|null=null;
  try{
    store=new SqliteStore(path);const archive=await store.reporting.archives.save(assembleReport(facts,query));await store.close();store=null;
    store=new SqliteStore(path);assert.deepEqual(await store.reporting.archives.get(archive.id),archive);await store.close();store=null;
    const db=new DatabaseSync(path);try{db.prepare('UPDATE report_archives SET payload=? WHERE archive_id=?').run('{}',archive.id);}finally{db.close();}
    store=new SqliteStore(path);await assert.rejects(()=>store!.reporting.archives.get(archive.id),ArchiveIntegrityError);
    await assert.rejects(()=>store!.reporting.archives.list(10),ArchiveIntegrityError);
  }finally{await store?.close();await rm(dir,{recursive:true,force:true});}
});
