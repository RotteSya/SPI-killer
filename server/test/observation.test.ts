import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/db-memory.ts';
import { SqliteStore } from '../src/db-sqlite.ts';
import type { Store } from '../src/db.ts';
import { parseObservationCoverage, parseObservationPreference, type ObservationCoverage } from '../src/observation.ts';
import { validateProductEvent } from '../src/telemetry.ts';

const implementations:Array<[string,()=>Store|Promise<Store>]>=[['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')]];
if(process.env.TEST_POSTGRES_URL){
  const original=new URL(process.env.TEST_POSTGRES_URL);if(!/test/i.test(original.pathname))throw new Error('Isolated test database required');
  const {PostgresStore,resolvePostgresSSL}=await import('../src/db-postgres.ts');const pg=(await import('pg')).default;
  implementations.push(['postgres',async()=>{
    const admin=new pg.Pool({connectionString:original.toString(),ssl:resolvePostgresSSL({connectionString:original.toString()})});
    const schema='observation_test_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(original);url.searchParams.set('options','-c search_path='+schema);
    const store=new PostgresStore(url.toString(),resolvePostgresSSL({connectionString:url.toString()})),close=store.close.bind(store);
    store.close=async()=>{await close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();};return store;
  }]);
}
const start=new Date(Date.now()-60_000).toISOString(),occurred=new Date(Date.now()-30_000).toISOString(),end=new Date().toISOString();
function event(sequence:number,epoch=0){
  const value=validateProductEvent({event_id:randomUUID(),capture_id:randomUUID(),occurred_at:occurred,event_name:'capture_completed',
    channel:'official',mode:'tutor',depth:'brief',result_state:'ready',parser_path:'v1',consent_epoch:epoch,event_sequence:sequence,
    usable_result:true,operation:'solve',completion_kind:'usable'},'2.12',new Date(),2);
  assert.ok(value);return value;
}
function coverage(to:number,epoch=0):ObservationCoverage {
  return {observationId:randomUUID(),consentEpoch:epoch,validFrom:start,validTo:end,sequenceFrom:0,sequenceTo:to,queueDropCount:0,coverageStatus:'complete',gapReason:'none'};
}
for(const [name,make] of implementations){
  test(`${name}: sequence receipts confirm coverage only when every event is present`,async()=>{
    const store=await make();try{
      const {token}=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:30});
      assert.equal(await store.observations.preference(token,{consentEpoch:0,sharingEnabled:true,validFrom:start}),true);
      const a=event(0),b=event(1);
      assert.deepEqual(await store.recordProductEvents(token,[a]),{accepted:1,duplicate:0});
      assert.equal((await store.observations.coverage(token,coverage(2)))?.gapReason,'sequence_gap');
      await store.recordProductEvents(token,[b,a]);const complete=coverage(2);
      assert.equal((await store.observations.coverage(token,complete))?.coverageStatus,'complete');
      assert.deepEqual(await store.observations.coverage(token,complete),complete);
      assert.equal(await store.observations.coverage(token,{...complete,sequenceTo:3}),null);
    }finally{await store.close();}
  });
  test(`${name}: disabling observation rejects new events without synthesizing product events`,async()=>{
    const store=await make();try{
      const {token}=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:30});
      await store.observations.preference(token,{consentEpoch:0,sharingEnabled:true,validFrom:start});
      await store.recordProductEvents(token,[event(0)]);
      await store.observations.preference(token,{consentEpoch:1,sharingEnabled:false,validFrom:occurred});
      assert.deepEqual(await store.recordProductEvents(token,[event(1)]),{accepted:0,duplicate:0,rejected:1});
      const state=await store.observations.state(token);assert.equal(state?.preference?.sharingEnabled,false);
      assert.equal((await store.observations.coverage(token,{...coverage(0,1),validFrom:occurred}))?.coverageStatus,'telemetry_disabled');
      const metrics=await store.getProductMetrics({from:start,to:new Date(Date.now()+1000).toISOString()});
      assert.equal(metrics.variants[0]?.captures_completed,1);
      assert.equal((await store.getAccount(token))?.balanceQuestions,30);
    }finally{await store.close();}
  });
  test(`${name}: epoch ordering, conflicting event IDs and duplicate sequence numbers cannot fabricate coverage`,async()=>{
    const store=await make();try{
      const {token}=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:30});
      await store.observations.preference(token,{consentEpoch:1,sharingEnabled:true,validFrom:start});
      assert.equal(await store.observations.preference(token,{consentEpoch:0,sharingEnabled:false,validFrom:end}),false);
      assert.equal(await store.observations.preference(token,{consentEpoch:1,sharingEnabled:false,validFrom:start}),false);
      const a=event(0,1);await store.recordProductEvents(token,[a]);
      assert.deepEqual(await store.recordProductEvents(token,[event(0,1)]),{accepted:0,duplicate:0,rejected:1});
      assert.deepEqual(await store.recordProductEvents(token,[{...a,resultState:'review'}]),{accepted:0,duplicate:0,rejected:1});
      const other=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:30});
      await store.observations.preference(other.token,{consentEpoch:1,sharingEnabled:true,validFrom:start});
      assert.deepEqual(await store.recordProductEvents(other.token,[a]),{accepted:0,duplicate:0,rejected:1});
      assert.equal((await store.observations.coverage(other.token,coverage(1,1)))?.gapReason,'sequence_gap');
    }finally{await store.close();}
  });
  test(`${name}: missing preferences, dropped queues, clock skew and server switches remain incomplete`,async()=>{
    const store=await make();try{
      const {token}=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:30});
      assert.equal((await store.observations.coverage(token,coverage(0)))?.coverageStatus,'unknown');
      await store.observations.preference(token,{consentEpoch:0,sharingEnabled:true,validFrom:start});
      await store.recordProductEvents(token,[event(0)]);
      assert.equal((await store.observations.coverage(token,{...coverage(1),queueDropCount:1}))?.gapReason,'queue_drop');
      assert.equal((await store.observations.coverage(token,{...coverage(1),validTo:start}))?.gapReason,'invalid_time');
      const disabled=coverage(1);const result=await store.observations.coverage(token,disabled,false);
      assert.equal(result?.gapReason,'server_disabled');
      assert.deepEqual(await store.observations.coverage(token,disabled,true),result,'a retry must preserve its original server observation');
    }finally{await store.close();}
  });
  test(`${name}: retention removes event receipts and coverage together while preserving opt-out`,async()=>{
    const store=await make();try{
      const {token}=await store.registerDevice({platform:'m',appVersion:'t',trialQuestions:30});
      await store.observations.preference(token,{consentEpoch:0,sharingEnabled:true,validFrom:start});
      await store.recordProductEvents(token,[event(0)]);
      const proof=coverage(1);assert.equal((await store.observations.coverage(token,proof))?.coverageStatus,'complete');
      assert.equal(await store.pruneProductEvents(new Date(Date.now()+1000).toISOString()),1);
      assert.equal((await store.observations.coverage(token,proof))?.gapReason,'sequence_gap','deleted receipts cannot prove retained coverage');
      await store.observations.preference(token,{consentEpoch:1,sharingEnabled:false,validFrom:occurred});
      await store.pruneProductEvents(new Date(Date.now()+1000).toISOString());
      assert.equal((await store.observations.state(token))?.preference?.sharingEnabled,false);
    }finally{await store.close();}
  });
}

test('observation allowlists reject content, invalid calendars and unbounded sequence claims',()=>{
  assert.equal(parseObservationPreference({consent_epoch:0,sharing_enabled:false,valid_from:'2026-02-31T00:00:00Z'}),null);
  assert.equal(parseObservationPreference({consent_epoch:0,sharing_enabled:false,valid_from:start,answer:'content'}),null);
  const raw={observation_id:randomUUID(),consent_epoch:0,valid_from:start,valid_to:end,sequence_from:0,sequence_to:1,queue_drop_count:0,coverage_status:'complete',gap_reason:'none'};
  assert.ok(parseObservationCoverage(raw));assert.equal(parseObservationCoverage({...raw,sequence_to:10_001}),null);
  assert.ok(parseObservationCoverage({...raw,sequence_to:20_001,queue_drop_count:19_901,coverage_status:'partial',gap_reason:'queue_drop'}));
  assert.equal(parseObservationCoverage({...raw,sequence_to:1_000_000_001,coverage_status:'partial'}),null);
  assert.equal(parseObservationCoverage({...raw,sequence_from:2}),null);assert.equal(parseObservationCoverage({...raw,window_title:'content'}),null);
  assert.equal(validateProductEvent({event_id:randomUUID(),occurred_at:end,event_name:'capture_started'},'2.12',new Date(),2),null);
});
