import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { callUpperCNY, EvaluationBudget, type EvaluationCallBound } from '../../scripts/lib/evaluation-budget.mts';

const model = 'deepseek-v4-flash-vision-exp';
const candidate = 'https://candidate.example';
function bound(overrides: Partial<EvaluationCallBound> = {}): EvaluationCallBound {
  return {
    schema_version: 1, model, base_url: candidate, billing_currency: 'CNY',
    input_micros_per_million: 3_000_000, output_micros_per_million: 9_000_000,
    input_token_upper: 10_000, output_token_upper: 1_000, cny_micros_per_currency_unit: 1_000_000,
    pricing_source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    currency_evidence: 'Test account currency response: CNY', bounds_evidence: 'Test candidate enforced input/output limits',
    verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), ...overrides,
  };
}
const policy = { schema_version: 1, campaign_id: 'test', currency: 'CNY', limit_micros: 100_000 } as const;

test('evaluation cost bound uses integer arithmetic and upward CNY conversion', () => {
  assert.equal(callUpperCNY(bound(), model, candidate), 39_000);
  assert.equal(callUpperCNY(bound({ billing_currency: 'USD', input_micros_per_million: 1,
    output_micros_per_million: 1, input_token_upper: 1, output_token_upper: 1,
    cny_micros_per_currency_unit: 7_500_000, exchange_rate_evidence: 'Test conservative conversion' }), model, candidate), 1);
});

test('invalid UTF-8 response closes its stream while retaining the caller-assigned dispatch reservation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nspi-eval-utf8-'));
  let closed=false;const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(Buffer.from([0xff]));res.on('close',()=>{closed=true;});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`,budget=new EvaluationBudget(join(dir,'budget.sqlite3'),policy,bound({base_url:base}),model,base);
  try {
    await assert.rejects(budget.fetchText('/v1/captures',{method:'POST',body:'{}'},'fixture','answer','utf8-test'));
    assert.deepEqual(budget.dispatchEvidence('utf8-test'),{id:'utf8-test',upperCNYMicros:39_000,outcome:'unknown'});
    assert.equal(budget.remainingMicros(),61_000);assert.equal(budget.dispatchEvidence('not-present'),null);
    // Let the socket close callback run; this does not wait for the 150-second request deadline.
    for(let i=0;i<20&&!closed;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(closed,true);
  }finally{budget.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('missing prices, exchange evidence, stale bounds and mismatched candidate fail closed', () => {
  for (const input of [bound({ input_micros_per_million: NaN }), bound({ input_token_upper: -1 }),
    bound({ billing_currency: 'USD', exchange_rate_evidence: '' }), bound({ cny_micros_per_currency_unit: 7_000_000 }),
    bound({ verified_at: new Date(Date.now() + 1000).toISOString() }),
    bound({ expires_at: new Date(Date.now() - 500).toISOString() }),
    bound({ expires_at: new Date(Date.now() + 172_800_000).toISOString() })]) {
    assert.throws(() => callUpperCNY(input, model, candidate));
  }
  assert.throws(() => callUpperCNY(bound(), 'different-model', candidate), /does not match/);
  assert.throws(() => callUpperCNY(bound(), model, 'https://other.example'), /does not match/);
  assert.throws(() => callUpperCNY(bound({ base_url: 'https://user:secret@candidate.example' }), model, candidate), /credentials/);
});

test('budget survives restarts and shares one allowance across candidates and operations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nspi-eval-budget-')), path = join(dir, 'budget.sqlite3');
  try {
    const first = new EvaluationBudget(path, policy, bound(), model, candidate);
    assert.throws(() => first.checkWholeRun(3), /Entire evaluation/);
    assert.equal(first.remainingMicros(), 100_000);
    first.reserve('first', 'f1', 'answer');
    first.close();
    const second = new EvaluationBudget(path, policy, bound(), model, candidate);
    try {
      assert.equal(second.remainingMicros(), 61_000);
      assert.throws(() => second.reserve('first', 'f1', 'answer'), /already reserved/);
      second.observeUsage('first', undefined, null);
      second.reserve('second', 'f2', 'explain');
      assert.equal(second.remainingMicros(), 22_000);
      assert.throws(() => second.reserve('third', 'f3', 'recover'), /exhausted/);
    } finally { second.close(); }
    const third = new EvaluationBudget(path, policy, bound({ base_url: 'https://other.example' }), model, 'https://other.example');
    try { assert.throws(() => third.reserve('third', 'f3', 'baseline'), /exhausted/); } finally { third.close(); }
    assert.throws(() => new EvaluationBudget(path, { ...policy, limit_micros: 200_000 }, bound(), model, candidate), /cannot be reset/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two independent database connections cannot reserve the last allowance twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nspi-eval-budget-')), path = join(dir, 'budget.sqlite3');
  const first = new EvaluationBudget(path, { ...policy, limit_micros: 39_000 }, bound(), model, candidate);
  const second = new EvaluationBudget(path, { ...policy, limit_micros: 39_000 }, bound(), model, candidate);
  try {
    first.reserve('a', 'f', 'answer');
    assert.throws(() => second.reserve('b', 'f', 'answer'), /exhausted/);
    assert.equal(second.remainingMicros(), 0);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('token-bound violations stop the campaign even after restarting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nspi-eval-budget-')), path = join(dir, 'budget.sqlite3');
  const first = new EvaluationBudget(path, policy, bound(), model, candidate);
  try {
    first.reserve('a', 'f', 'answer');
    assert.throws(() => first.observeUsage('a', 10_001, 1), /exceeded/);
  } finally { first.close(); }
  const second = new EvaluationBudget(path, policy, bound(), model, candidate);
  try { assert.throws(() => second.reserve('b', 'f', 'answer'), /halted/); assert.equal(second.remainingMicros(), 0); }
  finally { second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('stale pricing is rechecked at dispatch time', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nspi-eval-budget-'));
  const now = Date.now();
  const ledger = new EvaluationBudget(join(dir, 'budget.sqlite3'), policy,
    bound({ expires_at: new Date(now + 60_000).toISOString() }), model, candidate);
  try {
    t.mock.method(Date, 'now', () => now + 60_001);
    assert.throws(() => ledger.reserve('a', 'f', 'answer'), /verification/);
    assert.equal(ledger.remainingMicros(), 100_000);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('transport errors keep their budget and exhaustion prevents another HTTP request', async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(503); res.end('unavailable'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const local = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'nspi-eval-budget-'));
  const ledger = new EvaluationBudget(join(dir, 'budget.sqlite3'), { ...policy, limit_micros: 39_000 },
    bound({ base_url: local }), model, local);
  try {
    const response = await ledger.fetchText('/v1/captures', { method: 'POST', body: '{}' }, 'fixture', 'answer');
    assert.equal(response.status, 503);
    assert.equal(ledger.remainingMicros(), 0);
    await assert.rejects(ledger.fetchText('/v1/captures', { method: 'POST' }, 'fixture', 'answer'), /exhausted/);
    assert.equal(requests, 1);
  } finally { ledger.close(); server.close(); await once(server, 'close'); rmSync(dir, { recursive: true, force: true }); }
});

test('connection loss is not retried and preserves its unknown cost upper bound', async () => {
  let requests = 0;
  const server = createServer(req => { requests++; req.socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const local = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'nspi-eval-budget-'));
  const ledger = new EvaluationBudget(join(dir, 'budget.sqlite3'), policy, bound({ base_url: local }), model, local);
  try {
    await assert.rejects(ledger.fetchText('/v1/captures', { method: 'POST' }, 'fixture', 'answer'));
    assert.equal(ledger.remainingMicros(), 61_000);
    assert.equal(requests, 1);
  } finally { ledger.close(); server.close(); await once(server, 'close'); rmSync(dir, { recursive: true, force: true }); }
});

test('paid Objective entrypoint refuses a missing cost bound before making any HTTP call', async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(503); res.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/run-objective-eval.mjs'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10_000,
      env: { PATH: process.env.PATH, NSPI_RUN_OBJECTIVE_EVAL: '1', NSPI_EVAL_BASE_URL: `http://127.0.0.1:${address.port}`,
        NSPI_EVAL_DEVICE_TOKEN: 'test-only', NSPI_EVAL_MODEL: model, NSPI_EVAL_COMMIT: 'test',
        NSPI_EVAL_APP_VERSION: 'test', NSPI_EVAL_EXECUTOR: 'executor', NSPI_EVAL_REVIEWER: 'reviewer' },
    }), /NSPI_EVAL_COST_BOUND is required/);
    assert.equal(requests, 0);
  } finally { server.close(); await once(server, 'close'); }
});
