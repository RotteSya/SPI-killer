import { query, type RunTransaction, type Transaction } from './billing-sql.ts';
import { archiveCursor, archivePageLimit, archivePayload, archiveSummary, decodeArchive, parseArchiveCursor,
  type ReportArchive, type ReportArchivePage, type ReportArchiveStore, type ReportBundle } from './report-archive.ts';

export const REPORT_ARCHIVE_SCHEMA=`
CREATE TABLE IF NOT EXISTS report_archives (
 archive_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_archives_page ON report_archives(created_at,archive_id);
`;
export class SQLReportArchiveStore implements ReportArchiveStore {
  private run:RunTransaction;
  constructor(run:RunTransaction){this.run=run;}
  async save(report:ReportBundle):Promise<ReportArchive>{
    const {payload,digest}=archivePayload(report),createdAt=new Date().toISOString();
    return this.run((function*():Transaction<ReportArchive>{
      yield* query('INSERT INTO report_archives(archive_id,created_at,payload) VALUES(?,?,?) ON CONFLICT(archive_id) DO NOTHING',digest,createdAt,payload);
      const rows=yield* query('SELECT * FROM report_archives WHERE archive_id=?',digest);
      if(!rows[0])throw new Error('Archive persistence failed');
      return decodeArchive(digest,String(rows[0].created_at),String(rows[0].payload));
    })());
  }
  get(id:string):Promise<ReportArchive|null>{
    return this.run((function*():Transaction<ReportArchive|null>{
      const rows=yield* query('SELECT * FROM report_archives WHERE archive_id=?',id);
      return rows[0]?decodeArchive(id,String(rows[0].created_at),String(rows[0].payload)):null;
    })());
  }
  async list(limit:number,cursor?:string):Promise<ReportArchivePage>{
    archivePageLimit(limit);const after=cursor?parseArchiveCursor(cursor):null;
    return this.run((function*():Transaction<ReportArchivePage>{
      const rows=yield* query('SELECT * FROM report_archives'+(after?' WHERE created_at<? OR (created_at=? AND archive_id<?)':'')+
        ' ORDER BY created_at DESC,archive_id DESC LIMIT ?',...(after?[after[0],after[0],after[1]]:[]),limit+1);
      const items=rows.slice(0,limit).map(r=>archiveSummary(decodeArchive(String(r.archive_id),String(r.created_at),String(r.payload))));
      return {items,next_cursor:rows.length>limit?archiveCursor(items.at(-1)!):null};
    })());
  }
}
