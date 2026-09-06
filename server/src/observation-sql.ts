import { hashToken } from './db.ts';
import type { ProductEventInput, ProductEventWriteResult } from './db.ts';
import { query, type Row, type RunTransaction, type Transaction } from './billing-sql.ts';
import { eventFingerprint, eventObservation, verifiedCoverage, type ObservationCoverage, type ObservationPreference,
  type ObservationState, type ObservationStore } from './observation.ts';

export const OBSERVATION_SCHEMA=`
CREATE TABLE IF NOT EXISTS device_observation_preferences (
 device_id BIGINT NOT NULL REFERENCES devices(id), consent_epoch BIGINT NOT NULL CHECK(consent_epoch>=0),
 sharing_enabled INTEGER NOT NULL CHECK(sharing_enabled IN (0,1)), valid_from TEXT NOT NULL,
 recorded_at TEXT NOT NULL, PRIMARY KEY(device_id,consent_epoch)
);
CREATE TABLE IF NOT EXISTS device_observation (
 observation_id TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id), consent_epoch BIGINT NOT NULL,
 valid_from TEXT NOT NULL, valid_to TEXT NOT NULL, requested_metadata TEXT NOT NULL, metadata TEXT NOT NULL,
 received_at TEXT NOT NULL, CHECK(valid_from<=valid_to)
);
CREATE INDEX IF NOT EXISTS idx_observation_device_window ON device_observation(device_id,valid_from,valid_to);
CREATE INDEX IF NOT EXISTS idx_observation_retention ON device_observation(received_at);
CREATE TABLE IF NOT EXISTS product_event_receipts (
 event_id TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id), fingerprint TEXT NOT NULL,
 consent_epoch BIGINT, sequence BIGINT, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
 UNIQUE(device_id,consent_epoch,sequence)
);
CREATE INDEX IF NOT EXISTS idx_observation_event_range ON product_event_receipts(device_id,consent_epoch,sequence);
CREATE INDEX IF NOT EXISTS idx_observation_receipt_retention ON product_event_receipts(received_at);
`;
function preference(row:Row):ObservationPreference {
  return {consentEpoch:Number(row.consent_epoch),sharingEnabled:Number(row.sharing_enabled)===1,validFrom:String(row.valid_from)};
}
function* device(token:string):Transaction<number|null> {
  const row=(yield* query('SELECT id FROM devices WHERE token_hash=? FOR UPDATE',hashToken(token)))[0];return row?Number(row.id):null;
}
function* current(id:number):Transaction<ObservationPreference|null> {
  const row=(yield* query('SELECT * FROM device_observation_preferences WHERE device_id=? ORDER BY consent_epoch DESC LIMIT 1',id))[0];
  return row?preference(row):null;
}
export class SQLObservationStore implements ObservationStore {
  private run:RunTransaction;
  constructor(run:RunTransaction){this.run=run;}
  state(token:string):Promise<ObservationState|null> {
    return this.run((function*():Transaction<ObservationState|null>{
      const id=yield* device(token);if(id===null)return null;
      return {preference:yield* current(id),serverTime:new Date().toISOString()};
    })());
  }
  preference(token:string,input:ObservationPreference):Promise<boolean> {
    return this.run((function*():Transaction<boolean>{
      const id=yield* device(token);if(id===null)return false;
      const previous=(yield* query('SELECT * FROM device_observation_preferences WHERE device_id=? AND consent_epoch=?',id,input.consentEpoch))[0];
      if(previous)return JSON.stringify(preference(previous))===JSON.stringify(input);
      const before=(yield* query('SELECT valid_from FROM device_observation_preferences WHERE device_id=? AND consent_epoch<? ORDER BY consent_epoch DESC LIMIT 1',id,input.consentEpoch))[0];
      const after=(yield* query('SELECT valid_from FROM device_observation_preferences WHERE device_id=? AND consent_epoch>? ORDER BY consent_epoch LIMIT 1',id,input.consentEpoch))[0];
      if((before&&String(before.valid_from)>input.validFrom)||(after&&String(after.valid_from)<input.validFrom))return false;
      yield* query('INSERT INTO device_observation_preferences(device_id,consent_epoch,sharing_enabled,valid_from,recorded_at) VALUES(?,?,?,?,?)',
        id,input.consentEpoch,input.sharingEnabled?1:0,input.validFrom,new Date().toISOString());return true;
    })());
  }
  coverage(token:string,input:ObservationCoverage,telemetryEnabled=true):Promise<ObservationCoverage|null> {
    return this.run((function*():Transaction<ObservationCoverage|null>{
      const id=yield* device(token);if(id===null)return null;
      const previous=(yield* query('SELECT * FROM device_observation WHERE observation_id=?',input.observationId))[0];
      if(previous)return Number(previous.device_id)===id&&previous.requested_metadata===JSON.stringify(input)?JSON.parse(String(previous.metadata)) as ObservationCoverage:null;
      const pref=(yield* query('SELECT * FROM device_observation_preferences WHERE device_id=? AND consent_epoch=?',id,input.consentEpoch))[0];
      const next=(yield* query('SELECT * FROM device_observation_preferences WHERE device_id=? AND consent_epoch>? ORDER BY consent_epoch LIMIT 1',id,input.consentEpoch))[0];
      const events=input.coverageStatus==='complete'
        ? yield* query('SELECT sequence,occurred_at FROM product_event_receipts WHERE device_id=? AND consent_epoch=? AND sequence>=? AND sequence<?',id,input.consentEpoch,input.sequenceFrom,input.sequenceTo)
        : [];
      const result=verifiedCoverage(input,pref?preference(pref):null,next?preference(next):null,events.map(row=>({sequence:Number(row.sequence),occurredAt:String(row.occurred_at)})));
      if(!telemetryEnabled){result.coverageStatus='unknown';result.gapReason='server_disabled';}
      yield* query('INSERT INTO device_observation(observation_id,device_id,consent_epoch,valid_from,valid_to,requested_metadata,metadata,received_at) VALUES(?,?,?,?,?,?,?,?)',
        input.observationId,id,input.consentEpoch,input.validFrom,input.validTo,JSON.stringify(input),JSON.stringify(result),new Date().toISOString());return result;
    })());
  }
  events(token:string,events:ProductEventInput[]):Promise<ProductEventWriteResult> {
    return this.run((function*():Transaction<ProductEventWriteResult>{
      const id=yield* device(token);if(id===null)return {accepted:0,duplicate:0,rejected:events.length};
      const pref=yield* current(id);let accepted=0,duplicate=0,rejected=0;
      for(const event of [...events].sort((a,b)=>a.eventId.localeCompare(b.eventId))) {
        const coordinate=eventObservation(event),fingerprint=eventFingerprint(event);
        const previous=(yield* query('SELECT * FROM product_event_receipts WHERE event_id=?',event.eventId))[0];
        if(previous) {if(Number(previous.device_id)===id&&previous.fingerprint===fingerprint)duplicate++;else rejected++;continue;}
        if(pref?.sharingEnabled===false||(event.extensions?.schema_version===2&&(!coordinate||!pref||coordinate.epoch!==pref.consentEpoch||event.occurredAt<pref.validFrom))) {rejected++;continue;}
        const now=new Date().toISOString();
        const inserted=yield* query(`INSERT INTO product_event_receipts(event_id,device_id,fingerprint,consent_epoch,sequence,occurred_at,received_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING event_id`,event.eventId,id,fingerprint,coordinate?.epoch??null,coordinate?.sequence??null,event.occurredAt,now);
        if(!inserted.length){rejected++;continue;}
        const rows=yield* query(`INSERT INTO product_events(event_id,device_id,capture_id,occurred_at,received_at,event_name,trigger,channel,
          mode,depth,context_count,question_kind,result_state,parser_path,error_code,action,capture_ms,first_token_ms,total_ms,app_version,config_revision,variant,extensions)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
          event.eventId,id,event.captureId,event.occurredAt,now,event.eventName,event.trigger,event.channel,event.mode,event.depth,event.contextCount,
          event.questionKind,event.resultState,event.parserPath,event.errorCode,event.action,event.captureMs,event.firstTokenMs,event.totalMs,event.appVersion,event.configRevision,event.variant,event.extensions?JSON.stringify(event.extensions):null);
        if(rows.length) accepted++;
        else {
          // Pre-upgrade events have no sequence proof. Do not invent coverage for a replay.
          yield* query('DELETE FROM product_event_receipts WHERE event_id=?',event.eventId);
          const existing=(yield* query('SELECT device_id FROM product_events WHERE event_id=?',event.eventId))[0];
          if(Number(existing?.device_id)===id&&!coordinate)duplicate++;else rejected++;
        }
      }
      return {accepted,duplicate,...(rejected?{rejected}:{})};
    })());
  }
  prune(before:string):Promise<number> {
    return this.run((function*():Transaction<number>{
      const rows=yield* query('SELECT COUNT(*) AS count FROM product_events WHERE received_at<?',before);
      yield* query('DELETE FROM product_events WHERE received_at<?',before);
      yield* query('DELETE FROM product_event_receipts WHERE received_at<?',before);
      yield* query('DELETE FROM device_observation WHERE received_at<?',before);
      return Number(rows[0]?.count??0);
    })());
  }
}
