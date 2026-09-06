import { createHash } from 'node:crypto';
import type { ProductEventInput, ProductEventWriteResult, StoredProductEvent } from './db.ts';
import type { ReportPreference } from './reporting.ts';

export type CoverageStatus = 'complete' | 'partial' | 'unknown' | 'telemetry_disabled';
export type CoverageGap = 'none' | 'queue_drop' | 'invalid_time' | 'unsupported_schema' | 'preference_unsynced' |
  'queue_pending' | 'client_restart' | 'storage_failure' | 'event_rejected' | 'sequence_gap' | 'server_disabled';
export interface ObservationPreference { consentEpoch:number; sharingEnabled:boolean; validFrom:string }
export interface ObservationCoverage {
  observationId:string; consentEpoch:number; validFrom:string; validTo:string;
  sequenceFrom:number; sequenceTo:number; queueDropCount:number;
  coverageStatus:CoverageStatus; gapReason:CoverageGap;
}
export interface StoredObservation extends ObservationCoverage { deviceId:number; receivedAt:string }
export interface ObservationState {
  preference:ObservationPreference|null; serverTime:string;
}
export interface ObservationStore {
  state(token:string):Promise<ObservationState|null>;
  preference(token:string,input:ObservationPreference):Promise<boolean>;
  coverage(token:string,input:ObservationCoverage,telemetryEnabled?:boolean):Promise<ObservationCoverage|null>;
  events(token:string,events:ProductEventInput[]):Promise<ProductEventWriteResult>;
  prune(before:string):Promise<number>;
}
export const OBSERVATION_MAX_COUNTER=1_000_000_000;
const gaps=new Set<CoverageGap>(['none','queue_drop','invalid_time','unsupported_schema','preference_unsynced','queue_pending','client_restart','storage_failure','event_rejected','sequence_gap','server_disabled']);
const statuses=new Set<CoverageStatus>(['complete','partial','unknown','telemetry_disabled']);
export function observationCounter(value:unknown):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=OBSERVATION_MAX_COUNTER;
}
function timestamp(value:unknown):value is string {
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,19)===value.slice(0,19);
}
/** Preference changes are service state, never a synthetic product/exit event. */
export function parseObservationPreference(raw:unknown,now=Date.now()):ObservationPreference|null {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) return null;
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['consent_epoch','sharing_enabled','valid_from'].includes(key))||
    !observationCounter(value.consent_epoch)||typeof value.sharing_enabled!=='boolean'||!timestamp(value.valid_from)||
    Date.parse(value.valid_from)>now+300_000) return null;
  return {consentEpoch:value.consent_epoch,sharingEnabled:value.sharing_enabled,validFrom:new Date(value.valid_from).toISOString()};
}
export function parseObservationCoverage(raw:unknown,now=Date.now()):ObservationCoverage|null {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) return null;
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).some(key=>!['observation_id','consent_epoch','valid_from','valid_to','sequence_from','sequence_to','queue_drop_count','coverage_status','gap_reason'].includes(key))||
    typeof value.observation_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.observation_id)||
    !observationCounter(value.consent_epoch)||!observationCounter(value.sequence_from)||!observationCounter(value.sequence_to)||
    !observationCounter(value.queue_drop_count)||
    !timestamp(value.valid_from)||!timestamp(value.valid_to)||Date.parse(value.valid_from)>Date.parse(value.valid_to)||
    Date.parse(value.valid_to)>now+300_000||Date.parse(value.valid_to)<now-7*86_400_000||
    Date.parse(value.valid_to)-Date.parse(value.valid_from)>7*86_400_000||
    typeof value.coverage_status!=='string'||!statuses.has(value.coverage_status as CoverageStatus)||
    typeof value.gap_reason!=='string'||!gaps.has(value.gap_reason as CoverageGap)) return null;
  if(value.sequence_to<value.sequence_from||(value.sequence_to-value.sequence_from>10_000&&value.coverage_status==='complete')) return null;
  return {observationId:value.observation_id,consentEpoch:value.consent_epoch,validFrom:new Date(value.valid_from).toISOString(),validTo:new Date(value.valid_to).toISOString(),
    sequenceFrom:value.sequence_from,sequenceTo:value.sequence_to,queueDropCount:value.queue_drop_count,
    coverageStatus:value.coverage_status as CoverageStatus,gapReason:value.gap_reason as CoverageGap};
}
export function eventObservation(event:ProductEventInput):{epoch:number;sequence:number}|null {
  if(event.extensions?.schema_version!==2)return null;
  const epoch=event.extensions?.consent_epoch,sequence=event.extensions?.event_sequence;
  return observationCounter(epoch)&&observationCounter(sequence)?{epoch,sequence}:null;
}
export function eventFingerprint(event:ProductEventInput):string {
  // Stable across property order and retries; data contains only the event allowlist.
  const {appVersion:_appVersion,...source}=event;
  const value={...source,extensions:event.extensions?Object.fromEntries(Object.entries(event.extensions).sort(([a],[b])=>a.localeCompare(b))):null};
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
}
export function verifiedCoverage(input:ObservationCoverage,preference:ObservationPreference|null,
  nextPreference:ObservationPreference|null,rows:Array<{sequence:number;occurredAt:string}>):ObservationCoverage {
  const result={...input};
  if(!preference||input.validFrom<preference.validFrom||(nextPreference&&input.validTo>nextPreference.validFrom)) {
    return {...result,coverageStatus:'unknown',gapReason:'preference_unsynced'};
  }
  if(!preference.sharingEnabled) return {...result,coverageStatus:'telemetry_disabled',gapReason:'none'};
  if(input.coverageStatus==='telemetry_disabled') return {...result,coverageStatus:'unknown',gapReason:'preference_unsynced'};
  if(input.coverageStatus!=='complete') return result;
  if(input.queueDropCount>0) return {...result,coverageStatus:'partial',gapReason:'queue_drop'};
  if(input.gapReason!=='none') return {...result,coverageStatus:'partial'};
  const inRange=rows.filter(row=>row.sequence>=input.sequenceFrom&&row.sequence<input.sequenceTo);
  if(inRange.length!==input.sequenceTo-input.sequenceFrom) return {...result,coverageStatus:'partial',gapReason:'sequence_gap'};
  if(inRange.some(row=>row.occurredAt<input.validFrom||row.occurredAt>input.validTo)) return {...result,coverageStatus:'unknown',gapReason:'invalid_time'};
  return result;
}

export class MemoryObservationStore implements ObservationStore {
  private lookup:(token:string)=>number|null;
  private productEvents:StoredProductEvent[];
  private preferences=new Map<number,Map<number,ObservationPreference>>();
  private preferenceRecordedAt=new Map<string,string>();
  private intervals=new Map<string,{value:StoredObservation;input:string}>();
  private receipts=new Map<string,{deviceId:number;fingerprint:string;epoch:number|null;sequence:number|null;occurredAt:string;receivedAt:string}>();
  constructor(lookup:(token:string)=>number|null,events:StoredProductEvent[]) {this.lookup=lookup;this.productEvents=events;}
  async state(token:string):Promise<ObservationState|null> {
    const id=this.lookup(token);if(id===null)return null;
    const preference=[...(this.preferences.get(id)?.values()??[])].sort((a,b)=>b.consentEpoch-a.consentEpoch)[0]??null;
    return {preference:preference?{...preference}:null,serverTime:new Date().toISOString()};
  }
  async preference(token:string,input:ObservationPreference):Promise<boolean> {
    const id=this.lookup(token);if(id===null)return false;
    const values=this.preferences.get(id)??new Map<number,ObservationPreference>(),existing=values.get(input.consentEpoch);
    if(existing) return JSON.stringify(existing)===JSON.stringify(input);
    const before=[...values.values()].filter(p=>p.consentEpoch<input.consentEpoch).sort((a,b)=>b.consentEpoch-a.consentEpoch)[0];
    const after=[...values.values()].filter(p=>p.consentEpoch>input.consentEpoch).sort((a,b)=>a.consentEpoch-b.consentEpoch)[0];
    if((before&&before.validFrom>input.validFrom)||(after&&after.validFrom<input.validFrom))return false;
    values.set(input.consentEpoch,{...input});this.preferences.set(id,values);
    this.preferenceRecordedAt.set(id+':'+input.consentEpoch,new Date().toISOString());return true;
  }
  async coverage(token:string,input:ObservationCoverage,telemetryEnabled=true):Promise<ObservationCoverage|null> {
    const id=this.lookup(token);if(id===null)return null;
    const previous=this.intervals.get(input.observationId);
    if(previous) {
      const {deviceId:_id,receivedAt:_at,...value}=previous.value;
      return previous.value.deviceId===id&&previous.input===JSON.stringify(input)?value:null;
    }
    const values=[...(this.preferences.get(id)?.values()??[])];
    const verified=verifiedCoverage(input,values.find(p=>p.consentEpoch===input.consentEpoch)??null,
      values.filter(p=>p.consentEpoch>input.consentEpoch).sort((a,b)=>a.consentEpoch-b.consentEpoch)[0]??null,
      [...this.receipts.values()].filter(row=>row.deviceId===id&&row.epoch===input.consentEpoch&&row.sequence!==null).map(row=>({sequence:row.sequence!,occurredAt:row.occurredAt})));
    if(!telemetryEnabled){verified.coverageStatus='unknown';verified.gapReason='server_disabled';}
    this.intervals.set(input.observationId,{value:{...verified,deviceId:id,receivedAt:new Date().toISOString()},input:JSON.stringify(input)});return verified;
  }
  async events(token:string,events:ProductEventInput[]):Promise<ProductEventWriteResult> {
    const id=this.lookup(token);if(id===null)return {accepted:0,duplicate:0,rejected:events.length};
    const current=[...(this.preferences.get(id)?.values()??[])].sort((a,b)=>b.consentEpoch-a.consentEpoch)[0];
    let accepted=0,duplicate=0,rejected=0;
    for(const event of [...events].sort((a,b)=>a.eventId.localeCompare(b.eventId))) {
      const coordinate=eventObservation(event),fingerprint=eventFingerprint(event),existing=this.receipts.get(event.eventId);
      if(existing) {if(existing.deviceId===id&&existing.fingerprint===fingerprint)duplicate++;else rejected++;continue;}
      if(current?.sharingEnabled===false||(event.extensions?.schema_version===2&&(!coordinate||!current||coordinate.epoch!==current.consentEpoch||event.occurredAt<current.validFrom))) {rejected++;continue;}
      if(coordinate&&[...this.receipts.values()].some(row=>row.deviceId===id&&row.epoch===coordinate.epoch&&row.sequence===coordinate.sequence)) {rejected++;continue;}
      const receivedAt=new Date().toISOString();
      this.receipts.set(event.eventId,{deviceId:id,fingerprint,epoch:coordinate?.epoch??null,sequence:coordinate?.sequence??null,occurredAt:event.occurredAt,receivedAt});
      this.productEvents.push({...event,deviceId:id,receivedAt});accepted++;
    }
    return {accepted,duplicate,...(rejected?{rejected}:{})};
  }
  async prune(before:string):Promise<number> {
    const previous=this.productEvents.length;
    const retained=this.productEvents.filter(event=>event.receivedAt>=before);
    this.productEvents.splice(0,this.productEvents.length,...retained);
    for(const [id,row] of this.receipts)if(row.receivedAt<before)this.receipts.delete(id);
    for(const [id,row] of this.intervals)if(row.value.receivedAt<before)this.intervals.delete(id);
    return previous-retained.length;
  }
  report(ids:Set<number>,asOf:string):{preferences:ReportPreference[];observations:StoredObservation[]} {
    const preferences:ReportPreference[]=[];
    for(const [id,values] of this.preferences)if(ids.has(id))for(const value of values.values()){
      const recordedAt=this.preferenceRecordedAt.get(id+':'+value.consentEpoch)!;
      if(recordedAt<=asOf)preferences.push({...value,deviceId:id,recordedAt});
    }
    return {preferences,observations:[...this.intervals.values()].map(r=>r.value).filter(r=>ids.has(r.deviceId)&&r.receivedAt<=asOf).map(r=>({...r}))};
  }
}
