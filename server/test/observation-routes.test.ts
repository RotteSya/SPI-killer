import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

process.env.DB_PATH=':memory:';
process.env.OFFICIAL_PROVIDER='mock';
process.env.LOG_LEVEL='silent';
process.env.CRON_SECRET='observation-test-cron';
process.env.TELEMETRY_ENABLED='1';
const {buildApp}=await import('../src/index.ts');
let app:FastifyInstance;
before(async()=>{app=await buildApp();});
after(async()=>{await app.close();});

test('observation HTTP contract acknowledges only valid schema-2 events and preserves opt-out',async()=>{
  const registration=await app.inject({method:'POST',url:'/v1/devices',payload:{platform:'macos',app_version:'2.12'}});
  const token=registration.json().device_token as string;
  const headers={authorization:'Bearer '+token};
  const state=await app.inject({url:'/v1/device-observation',headers});
  assert.equal(state.statusCode,200);assert.equal(state.headers['cache-control'],'no-store');
  assert.equal(state.json().preference,null);
  const from=new Date(Date.now()-1000).toISOString();
  const pref={consent_epoch:0,sharing_enabled:true,valid_from:from};
  assert.equal((await app.inject({method:'POST',url:'/v1/device-observation',headers,payload:{schema_version:1,preference:pref}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/v1/device-observation',headers,payload:{schema_version:1,preference:{...pref,sharing_enabled:false}}})).statusCode,409);
  const event={event_id:randomUUID(),capture_id:randomUUID(),occurred_at:from,event_name:'capture_completed',channel:'official',
    mode:'tutor',depth:'brief',result_state:'ready',parser_path:'v1',consent_epoch:0,event_sequence:0,
    usable_result:true,completion_kind:'usable',operation:'solve'};
  const batch=async(events:unknown[])=>app.inject({method:'POST',url:'/v1/events/batch',headers,payload:{schema_version:2,events}});
  assert.deepEqual((await batch([event,{...event,event_id:randomUUID(),event_sequence:1,depth:'hint'}])).json(),{accepted:1,duplicate:0,rejected:1});
  assert.deepEqual((await batch([event])).json(),{accepted:0,duplicate:1,rejected:0});
  assert.deepEqual((await batch([{...event,event_id:event.event_id.toUpperCase(),capture_id:event.capture_id.toUpperCase()}])).json(),{accepted:0,duplicate:1,rejected:0});
  const coverage={observation_id:randomUUID(),consent_epoch:0,valid_from:from,valid_to:new Date().toISOString(),
    sequence_from:0,sequence_to:2,queue_drop_count:0,coverage_status:'complete',gap_reason:'none'};
  const proof=await app.inject({method:'POST',url:'/v1/device-observation',headers,payload:{schema_version:1,coverage}});
  assert.equal(proof.statusCode,200);assert.equal(proof.json().coverage.coverage_status,'partial');
  assert.equal(proof.json().coverage.gap_reason,'sequence_gap');
  const off={consent_epoch:1,sharing_enabled:false,valid_from:new Date().toISOString()};
  assert.equal((await app.inject({method:'POST',url:'/v1/device-observation',headers,payload:{schema_version:1,preference:off}})).statusCode,200);
  assert.deepEqual((await batch([{...event,event_id:randomUUID(),event_sequence:1}])).json(),{accepted:0,duplicate:0,rejected:1});
  assert.equal((await app.inject({url:'/v1/device-observation',headers})).json().preference.sharing_enabled,false);
  assert.equal((await app.inject({method:'POST',url:'/v1/device-observation',headers,payload:{schema_version:1,preference:off,answer:'secret'}})).statusCode,400);
});

test('observation routes require authentication and retention runs through the independent scheduler',async()=>{
  assert.equal((await app.inject({url:'/v1/device-observation'})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/v1/device-observation',payload:{}})).statusCode,401);
  assert.equal((await app.inject({url:'/api/internal/reap'})).statusCode,401);
  const sweep=await app.inject({url:'/api/internal/reap',headers:{authorization:'Bearer observation-test-cron'}});
  assert.equal(sweep.statusCode,200);assert.equal(sweep.headers['cache-control'],'no-store');
  assert.equal(sweep.json().events_pruned,0);
});
