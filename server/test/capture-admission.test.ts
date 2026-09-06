import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config, type Config } from '../src/config.ts';
import { CaptureService } from '../src/capture-service.ts';
import { MemoryStore } from '../src/db-memory.ts';
import { SqliteStore } from '../src/db-sqlite.ts';
import type { Store } from '../src/db.ts';
import type { Provider } from '../src/providers/types.ts';
import { StubPaymentProvider } from '../src/payments.ts';
import { SCREEN_QUERY_VERSION } from '../src/screen-query.ts';
import { pngBase64 } from './helpers/images.ts';

function latch() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
function pause<Args extends unknown[],Result>(call:(...args:Args)=>Promise<Result>,afterCommit=true) {
  const entered=latch(),resume=latch();let first=true;
  return {entered:entered.promise,resume:resume.resolve,call:async (...args:Args):Promise<Result>=>{
    if(!first)return call(...args);first=false;
    if(!afterCommit){entered.resolve();await resume.promise;return call(...args);}
    const result=await call(...args);entered.resolve();await resume.promise;return result;
  }};
}
function failOnce<Args extends unknown[],Result>(call:(...args:Args)=>Promise<Result>,afterCommit:boolean) {
  let first=true;
  return async (...args:Args):Promise<Result>=>{
    if(!first)return call(...args);first=false;
    if(afterCommit)await call(...args);
    throw new Error('Injected transaction acknowledgement failure');
  };
}
const implementations:Array<[string,()=>Store|Promise<Store>]>=[
  ['memory',()=>new MemoryStore()],['sqlite',()=>new SqliteStore(':memory:')],
];
if(process.env.TEST_POSTGRES_URL) {
  const url=new URL(process.env.TEST_POSTGRES_URL);
  if(!/test/i.test(url.pathname))throw new Error('Admission tests require an isolated database named test');
  const {PostgresStore,resolvePostgresSSL}=await import('../src/db-postgres.ts');
  const pg=(await import('pg')).default;
  const admin=new pg.Pool({connectionString:url.toString(),ssl:resolvePostgresSSL({connectionString:url.toString()})});
  const schema='admission_test_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options','-c search_path='+schema);
  const connection=url.toString(),ssl=resolvePostgresSSL({connectionString:connection});
  after(async()=>{await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  implementations.push(['postgres',async()=>{
    const store=new PostgresStore(connection,ssl);await store.getAccount('__admission_test__');
    await admin.query(`TRUNCATE ${schema}.devices, ${schema}.budget_windows, ${schema}.attempt_budget_holds RESTART IDENTITY CASCADE`);
    return store;
  }]);
}
const ready='FINAL: B\nNSPI_RESULT_V1: {"v":1,"kind":"single_choice","state":"ready","answer":"B","reason":"none"}';
function body() {
  return {capture_id:randomUUID(),result_protocol:'objective_v1',response_contract:'screen_query_v1',operation:'solve',
    images_base64:[pngBase64],image_media_type:'image/png',profile_id:'reading_practice',
    profile_version:SCREEN_QUERY_VERSION,prompt_version:SCREEN_QUERY_VERSION,ui_language:'en',
    scope:{target_count:1,question_image_index:0,rect:{x:0,y:0,width:1,height:1}}};
}
type Operation='solve'|'explain'|'recover';
async function fixture(make:()=>Store|Promise<Store>,concurrency=1) {
  const store=await make(),app=Fastify({logger:false,forceCloseConnections:true});let calls=0;
  const provider:Provider={name:'test',async stream(request,delta) {
    calls++;delta(request.system.includes('consistent (boolean)')?JSON.stringify({consistent:true,explanation:'B follows from the passage.'}):ready);
    return {inputTokens:10,outputTokens:2};
  }};
  const settings:Config={...config,provider:'mock',objectiveProvider:'mock',model:'test',objectiveModel:'test',
    dbPath:':memory:',requireDurableStorage:false,requestHmacKeysJSON:JSON.stringify({test:randomBytes(32).toString('base64')}),
    requestHmacKeyVersion:'test',screenQueryEnabled:true,explanationEnabled:true,enabledSupportProfiles:'reading_practice',
    captureConcurrencyPerToken:concurrency,attemptBudgetUpperMicros:100,modelDailyBudgetMicros:100,
    modelCostCurrency:'CNY',modelPricingJSON:JSON.stringify([{model:'test:test',input_micros_per_million_tokens:0,output_micros_per_million_tokens:0}])};
  const service=new CaptureService({config:settings,store,storeKind:'memory',provider,objectiveProvider:provider,
    providerDegraded:null,objectiveProviderDegraded:null,payment:new StubPaymentProvider()});
  const watches=new Map<string,{closed:ReturnType<typeof latch>;finished:ReturnType<typeof latch>}>();
  // Instrument only the handler lifecycle. Requests still use real HTTP, production
  // CaptureService/auth/image decoding and the selected real billing implementation.
  for(const [url,operation] of [['/v1/captures','solve'],['/v1/captures/:id/explanation','explain'],['/v1/captures/:id/recovery','recover']] as const) {
    app.post(url,async(req,reply)=>{
      const watch=watches.get(String(req.headers['x-test-request']))!;
      reply.raw.once('close',watch.closed.resolve);
      try {
        if(operation==='solve')await service.solve(req,reply);else await service.auxiliary(req,reply,operation);
      } finally {watch.finished.resolve();}
    });
  }
  const base=await app.listen({port:0,host:'127.0.0.1'});
  const {token}=await store.registerDevice({platform:'macos',appVersion:'test',trialQuestions:30});
  function request(url:string,payload:object) {
    const id=randomUUID(),closed=latch(),finished=latch(),abort=new AbortController();
    watches.set(id,{closed,finished});
    const response=fetch(base+url,{method:'POST',signal:abort.signal,headers:{'content-type':'application/json',
      authorization:'Bearer '+token,'x-test-request':id},body:JSON.stringify(payload)})
      .then(async r=>({status:r.status,payload:await r.text()}),()=>null).catch(()=>null);
    return {response,finished:finished.promise,cancel:async()=>{abort.abort();await closed.promise;}};
  }
  async function target(operation:Operation) {
    const input=body();
    if(operation==='solve')return {url:'/v1/captures',payload:input,id:input.capture_id};
    const parent=request('/v1/captures',input);assert.equal((await parent.response)?.status,200);await parent.finished;
    assert.equal((await store.billing.capture(token,input.capture_id))?.settlementStatus,'settled');
    const id=randomUUID();return {url:`/v1/captures/${input.capture_id}/${operation==='explain'?'explanation':'recovery'}`,
      payload:{...input,[operation==='explain'?'explanation_id':'recovery_id']:id,final_answer:'B'},id};
  }
  async function budgetAvailable(expected=true) {
    const id=randomUUID();assert.equal(await store.billing.reserveBudget(token,id,'official','CNY',100,100),expected);
    await store.billing.releaseBudget(token,id);
  }
  return {store,token,provider,request,target,budgetAvailable,calls:()=>calls,
    close:async()=>{await app.close();await store.close();}};
}

for(const [kind,make] of implementations) {
  for(const operation of ['solve','explain','recover'] as const) {
    for(const stage of ['before_budget','budget','begin','attempt'] as const) {
      test(`${kind}: ${operation} HTTP disconnect at ${stage} never starts a vendor and releases admission`,{timeout:10_000},async()=>{
        const f=await fixture(make);let resume:()=>void=()=>{};
        try {
          const target=await f.target(operation),before=f.calls(),billing=f.store.billing;
          const gate=stage==='before_budget'
            ? operation==='solve'?pause(billing.reap.bind(billing)):pause(billing.attempts.bind(billing))
            : stage==='budget'?pause(billing.reserveBudget.bind(billing))
            : stage==='begin'?pause(billing.begin.bind(billing)):pause(billing.startAttempt.bind(billing));
          // Each pause follows a successful real operation, including committed writes.
          if(stage==='before_budget') {
            if(operation==='solve')billing.reap=gate.call as typeof billing.reap;
            else billing.attempts=gate.call as typeof billing.attempts;
          } else if(stage==='budget')billing.reserveBudget=gate.call as typeof billing.reserveBudget;
          else if(stage==='begin')billing.begin=gate.call as typeof billing.begin;
          else billing.startAttempt=gate.call as typeof billing.startAttempt;
          resume=gate.resume;
          const req=f.request(target.url,target.payload);await gate.entered;await req.cancel();resume();await req.finished;
          assert.equal(await req.response,null);assert.equal(f.calls(),before);
          const capture=await billing.capture(f.token,target.id),held=stage==='begin'||stage==='attempt';
          assert.equal(capture?.settlementStatus??null,held?'released':null);
          const quota=(await billing.quota(f.token))!;
          assert.equal(quota.heldQuestions,0);
          assert.equal(quota.balanceQuestions,operation==='solve'?30:operation==='recover'&&held?30:29);
          const attempt=(await billing.attempts(f.token)).find(a=>a.captureId===target.id);
          if(stage==='attempt') {
            assert.equal(attempt?.status,'failed');assert.equal(attempt.costMicros,'0');assert.equal(attempt.inputTokens,0);
          } else assert.equal(attempt,undefined);
          await f.budgetAvailable();
          const next=f.request('/v1/captures',body());assert.equal((await next.response)?.status,200);await next.finished;
          assert.equal(f.calls(),before+1,'the concurrency slot is reusable');
        } finally {resume();await f.close();}
      });
    }
    for(const method of ['reserveBudget','begin','startAttempt'] as const)for(const afterCommit of [false,true]) {
      test(`${kind}: ${operation} ${method} ${afterCommit?'lost commit acknowledgement':'rollback'} leaves no admission leak`,{timeout:10_000},async()=>{
        const f=await fixture(make);
        try {
          const target=await f.target(operation),before=f.calls(),billing=f.store.billing;
          if(method==='reserveBudget')billing.reserveBudget=failOnce(billing.reserveBudget.bind(billing),afterCommit);
          else if(method==='begin')billing.begin=failOnce(billing.begin.bind(billing),afterCommit);
          else billing.startAttempt=failOnce(billing.startAttempt.bind(billing),afterCommit);
          const req=f.request(target.url,target.payload);await req.response;await req.finished;
          assert.equal(f.calls(),before);
          const captured=method==='startAttempt'||method==='begin'&&afterCommit;
          assert.equal((await billing.capture(f.token,target.id))?.settlementStatus??null,captured?'released':null);
          const quota=(await billing.quota(f.token))!;assert.equal(quota.heldQuestions,0);
          assert.equal(quota.balanceQuestions,operation==='solve'?30:operation==='recover'&&captured?30:29);
          const attempt=(await billing.attempts(f.token)).find(a=>a.captureId===target.id);
          if(method==='startAttempt'&&afterCommit)assert.deepEqual([attempt?.status,attempt?.costMicros,attempt?.inputTokens],['failed','0',0]);
          else assert.equal(attempt,undefined);
          await f.budgetAvailable();
          const next=f.request('/v1/captures',body());assert.equal((await next.response)?.status,200);await next.finished;
          assert.equal(f.calls(),before+1);
        } finally {await f.close();}
      });
    }
  }
  test(`${kind}: uncertain duplicate admission cannot release another worker's capture`,{timeout:10_000},async()=>{
    const f=await fixture(make);let resume:()=>void=()=>{};
    try {
      const billing=f.store.billing,original=billing.begin.bind(billing),target=await f.target('solve');
      const gate=pause(async (...args:Parameters<typeof original>)=>{
        await original(...args);throw new Error('Duplicate acknowledgement lost');
      },false);resume=gate.resume;billing.begin=gate.call;
      const req=f.request(target.url,target.payload);await gate.entered;
      const otherId=randomUUID();
      assert.equal((await original({token:f.token,captureId:target.id,requestHmac:'another worker',requestId:otherId})).ok,true);
      billing.begin=original;
      // The paused operation observes a duplicate and loses its database acknowledgement.
      await req.cancel();resume();await req.finished;
      assert.equal((await billing.capture(f.token,target.id))?.requestId,otherId);
      assert.equal((await billing.capture(f.token,target.id))?.settlementStatus,'held');
      assert.equal((await billing.quota(f.token))?.heldQuestions,1);assert.equal(f.calls(),0);await f.budgetAvailable();
      await billing.finish({token:f.token,captureId:target.id,charge:false,terminalState:'canceled'});
    } finally {resume();await f.close();}
  });
  for(const operation of ['solve','explain','recover'] as const) {
    test(`${kind}: ${operation} synchronous provider failure is settled without an unhandled deadline rejection`,{timeout:10_000},async()=>{
      const f=await fixture(make);
      try {
        const target=await f.target(operation);
        f.provider.stream=()=>{throw new Error('Provider initialization failed');};
        const req=f.request(target.url,target.payload),response=await req.response;await req.finished;
        assert.equal(response?.status,200);assert.ok(response.payload.endsWith('data: [DONE]\n\n'));
        assert.equal((await f.store.billing.capture(f.token,target.id))?.settlementStatus,'released');
        const attempt=(await f.store.billing.attempts(f.token)).find(a=>a.captureId===target.id)!;
        assert.equal(attempt.status,'failed');assert.equal(attempt.costMicros,null);await f.budgetAvailable(false);
      } finally {await f.close();}
    });
    test(`${kind}: ${operation} disconnect after vendor invocation retains unknown cost and rejects late deltas`,{timeout:10_000},async()=>{
      const f=await fixture(make),entered=latch(),late=latch();let emit:(text:string)=>void=()=>{};
      try {
        const target=await f.target(operation),before=f.calls();
        f.provider.stream=async(_input,delta)=>{emit=delta;entered.resolve();await late.promise;delta(ready);return {inputTokens:99,outputTokens:10};};
        const req=f.request(target.url,target.payload);await entered.promise;await req.cancel();await req.finished;
        const capture=await f.store.billing.capture(f.token,target.id);assert.equal(capture?.settlementStatus,'released');
        const attempt=(await f.store.billing.attempts(f.token)).find(a=>a.captureId===target.id)!;
        assert.equal(attempt.status,'failed');assert.equal(attempt.costMicros,null);assert.equal(attempt.inputTokens,null);
        assert.equal((await f.store.billing.quota(f.token))?.heldQuestions,0);await f.budgetAvailable(false);
        const snapshot=await f.store.billing.quota(f.token);emit(ready);late.resolve();await Promise.resolve();await Promise.resolve();
        assert.deepEqual(await f.store.billing.quota(f.token),snapshot);assert.equal(f.calls(),before);
      } finally {late.resolve();await f.close();}
    });
  }
}
