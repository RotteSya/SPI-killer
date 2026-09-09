import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type RequestListener} from 'node:http';
import {once} from 'node:events';
import {openEvaluationAccess} from '../../scripts/lib/evaluation-access.mts';

async function serve(t:{after:(fn:()=>unknown)=>void},handler:RequestListener) {
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return 'http://127.0.0.1:'+address.port;
}
test('deployment access exchanges once, cancels response and binds the cookie to one origin',async t=>{
  let calls=0;
  const base=await serve(t,(req,res)=>{
    calls++;assert.equal(req.url,'/?_vercel_share=test-share');assert.equal(req.headers.authorization,undefined);
    res.writeHead(302,{'location':'/','set-cookie':['_other=ignored','_vercel_jwt=test.jwt.cookie; Path=/; HttpOnly; Max-Age=300']});res.end();
  });
  const access=await openEvaluationAccess(base,'test-share');
  assert.deepEqual(access.headersFor(base+'/healthz'),{cookie:'_vercel_jwt=test.jwt.cookie'});
  assert.deepEqual(access.headersFor(base+'/v1/captures'),{cookie:'_vercel_jwt=test.jwt.cookie'});
  assert.equal(calls,1);assert.equal(JSON.stringify(access),'{}');
  assert.throws(()=>access.headersFor('https://another.vercel.app/v1/captures'));
  assert.throws(()=>access.headersFor(base.replace('http://','http://user:password@')));
});
test('deployment access rejects redirects, missing/duplicate/expired cookies and failed responses without leaking credentials',async t=>{
  for(const [status,location,cookies] of [
    [302,'https://other.vercel.app/',['_vercel_jwt=secret']],
    [200,'/',[]],[200,'/',['_vercel_jwt=first','_vercel_jwt=second']],
    [200,'/',['_vercel_jwt=secret; Max-Age=0']],[200,'/',['_vercel_jwt=secret; Expires=invalid']],
    [503,'/',['_vercel_jwt=secret']],
  ] as const) {
    let calls=0;const base=await serve(t,(_req,res)=>{calls++;res.writeHead(status,{location,'set-cookie':[...cookies]});res.end('private provider detail');});
    await assert.rejects(openEvaluationAccess(base,'sensitive-share'),error=>{
      assert.ok(error instanceof Error);assert.equal(error.message,'Evaluation deployment access unavailable or expired');
      assert.equal(error.cause,undefined);return true;
    });assert.equal(calls,1);
  }
});
test('deployment access expires held cookies and bounds a stalled exchange',async t=>{
  const base=await serve(t,(_req,res)=>{res.writeHead(200,{'set-cookie':'_vercel_jwt=secret; Max-Age=1'});res.end();});
  const access=await openEvaluationAccess(base,'test-share');
  t.mock.method(Date,'now',()=>Number.MAX_SAFE_INTEGER);
  assert.throws(()=>access.headersFor(base+'/v1/captures'));t.mock.restoreAll();
  const stalled=await serve(t,()=>{}),started=performance.now();
  await assert.rejects(openEvaluationAccess(stalled,'sensitive-share',50),/deployment access unavailable/);
  assert.ok(performance.now()-started<2000);
});
test('unprotected access sends no cookie and invalid targets fail before network dispatch',async()=>{
  const access=await openEvaluationAccess('https://candidate.vercel.app');
  assert.deepEqual(access.headersFor('https://candidate.vercel.app/healthz'),{});
  for(const base of ['https://other.example','http://candidate.vercel.app','https://user:secret@candidate.vercel.app','https://candidate.vercel.app/?secret=x'])
    await assert.rejects(openEvaluationAccess(base,'sensitive-share'));
  await assert.rejects(openEvaluationAccess('https://candidate.vercel.app',''));
});
