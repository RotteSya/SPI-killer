import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';

process.env.DB_PATH=':memory:';process.env.OFFICIAL_PROVIDER='mock';process.env.LOG_LEVEL='silent';
process.env.ADMIN_TOKEN='report-test-admin';
const {buildApp}=await import('../src/index.ts');
let app:FastifyInstance;
beforeEach(async()=>{app=await buildApp();});afterEach(async()=>{await app.close();});
const admin={'x-admin-token':'report-test-admin'};
test('report console uses a script hash, no saved credentials, and admin-only data routes',async()=>{
  const page=await app.inject({url:'/admin/reports'});assert.equal(page.statusCode,200);
  const script=/<script>([\s\S]*)<\/script>/.exec(page.payload)?.[1];assert.ok(script);new Script(script);
  assert.ok(String(page.headers['content-security-policy']).includes("'sha256-"+createHash('sha256').update(script).digest('base64')+"'"));
  assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.headers['referrer-policy'],'no-referrer');
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML/);
  for(const url of ['/admin/reports/data','/admin/reports/archives','/admin/reports/archives/'+'a'.repeat(64)])assert.equal((await app.inject({url})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/admin/reports/archive',payload:{}})).statusCode,401);
});
test('archive HTTP saves only the reviewed server aggregate; historical reads survive expiry without recalculation',async t=>{
  const day=86_400_000,base=Date.now()-40*day;t.mock.timers.enable({apis:['Date'],now:base});
  const registered=await app.inject({method:'POST',url:'/v1/devices',payload:{platform:'macos',app_version:'2.12'}});assert.equal(registered.statusCode,200);
  t.mock.timers.setTime(base+40*day);
  const params={cohort_from:new Date(base).toISOString(),cohort_to:new Date(base+day).toISOString(),as_of:new Date(base+40*day).toISOString()};
  const live=await app.inject({url:'/admin/reports/data?'+new URLSearchParams(params),headers:admin});assert.equal(live.statusCode,200);
  assert.equal(live.json().report.cohort.registered,1);
  const payload={query:live.json().report.query,expected_payload_sha256:live.json().payload_sha256};
  const save=()=>app.inject({method:'POST',url:'/admin/reports/archive',headers:admin,payload});
  const saved=await save();assert.equal(saved.statusCode,200);assert.deepEqual((await save()).json(),saved.json());
  assert.equal((await app.inject({method:'POST',url:'/admin/reports/archive',headers:admin,payload:{...payload,report:{registered:100}}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/admin/reports/archive',headers:admin,payload:{...payload,expected_payload_sha256:'a'.repeat(64)}})).statusCode,409);
  assert.doesNotMatch(saved.payload,/token_hash|device_token|request_hmac|answer_hmac/);
  const list=await app.inject({url:'/admin/reports/archives?limit=1',headers:admin});assert.equal(list.json().items[0].id,saved.json().id);
  for(const suffix of ['?limit=51','?limit=1&limit=2','?cursor=bad','?unknown=x'])assert.equal((await app.inject({url:'/admin/reports/archives'+suffix,headers:admin})).statusCode,400);
  t.mock.timers.setTime(base+150*day);
  assert.equal((await app.inject({url:'/admin/reports/data?'+new URLSearchParams(params),headers:admin})).statusCode,410);
  assert.equal((await save()).statusCode,410);
  const archived=await app.inject({url:'/admin/reports/archives/'+saved.json().id,headers:admin});assert.equal(archived.statusCode,200);assert.deepEqual(archived.json(),saved.json());
});
test('cohort and economics routes require admin authentication and return null for empty denominators',async()=>{
  for(const url of ['/admin/cohorts','/admin/economics']){
    assert.equal((await app.inject({url})).statusCode,401);
    const response=await app.inject({url,headers:admin});assert.equal(response.statusCode,200);
    assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.json().registered,0);
    assert.match(response.json().query.as_of,/Z$/);assert.ok(response.json().query.cohort_from<response.json().query.cohort_to);
    assert.doesNotMatch(response.payload,/token_hash|device_token|request_hmac|answer_hmac/);
  }
  assert.equal((await app.inject({url:'/admin/cohorts',headers:admin})).json().p28.rate,null);
  for(const url of ['/admin/economics?profile=spi','/admin/cohorts?channel=official&channel=cli','/admin/cohorts?as_of=2099-01-01','/admin/cohorts?question=secret'])
    assert.equal((await app.inject({url,headers:admin})).statusCode,400);
});
test('internal classification and expense records cannot be written through client credentials',async()=>{
  const registration=await app.inject({method:'POST',url:'/v1/devices',payload:{platform:'macos',app_version:'2.12'}});
  const token=registration.json().device_token as string;assert.ok(token);
  const client={authorization:'Bearer '+token};
  assert.equal((await app.inject({method:'POST',url:'/admin/devices/internal',headers:client,payload:{device_id:1,is_internal:true,reference:'test'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/v1/device-source',headers:client,payload:{source_group:'spi_entry',is_internal:true}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/v1/device-source',headers:client,payload:{source_group:'x'.repeat(5000)}})).statusCode,413);
  const source=()=>app.inject({method:'POST',url:'/v1/device-source',headers:client,payload:{source_group:'spi_entry'}});
  assert.equal((await source()).statusCode,200);assert.equal((await source()).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/v1/device-source',headers:client,payload:{source_group:'reading_practice_entry'}})).statusCode,409);
  const payload={reference:'invoice-1',kind:'service',currency:'USD',amount_micros:'9007199254740993',cohort_from:'2026-01-01',cohort_to:'2026-02-01',coverage_through:'2026-03-01'};
  assert.equal((await app.inject({method:'POST',url:'/admin/economics/expense-allocation',headers:client,payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/admin/economics/expense-allocation',headers:admin,payload})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/admin/economics/expense-allocation',headers:admin,payload})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/admin/economics/expense-allocation',headers:admin,payload:{...payload,amount_micros:'1'}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/admin/economics/expense-allocation',headers:admin,payload:{...payload,amount_micros:100}})).statusCode,400);
});
