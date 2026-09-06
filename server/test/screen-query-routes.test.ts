import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { config, type Config } from '../src/config.ts';
import { registerRoutes } from '../src/routes.ts';
import { MemoryStore } from '../src/db-memory.ts';
import { SqliteStore } from '../src/db-sqlite.ts';
import { StubPaymentProvider } from '../src/payments.ts';
import type { Provider } from '../src/providers/types.ts';
import { SCREEN_QUERY_VERSION } from '../src/screen-query.ts';
import type { StreamEvent } from '../src/http.ts';
import {pngBase64 as png,corruptPixels} from './helpers/images.ts';

const ready = 'FINAL: B\nNSPI_RESULT_V1: {"v":1,"kind":"single_choice","state":"ready","answer":"B","reason":"none"}';
const output = (answer: string, state = 'ready', reason = 'none') =>
  `FINAL: ${answer}\nNSPI_RESULT_V1: ${JSON.stringify({ v: 1, kind: 'single_choice', state, answer, reason })}`;

function solveBody() {
  return {
    capture_id: randomUUID(), result_protocol: 'objective_v1', response_contract: 'screen_query_v1',
    operation: 'solve', image_base64: png, images_base64: [png], image_media_type: 'image/png',
    profile_id: 'reading_practice', profile_version: SCREEN_QUERY_VERSION, prompt_version: SCREEN_QUERY_VERSION,
    ui_language: 'en', scope: { target_count: 1, question_image_index: 0, rect: { x: 0, y: 0, width: 1, height: 1 } },
  };
}
function events(payload: string): StreamEvent[] {
  assert.ok(payload.endsWith('data: [DONE]\n\n'), 'every confirmed stream must terminate');
  return payload.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
}
function usage(payload: string) {
  const terminal = events(payload).filter(event => event.type === 'usage');
  assert.equal(terminal.length, 1, 'exactly one billing terminal');
  return terminal[0]!;
}

for (const kind of ['memory', 'sqlite'] as const) {
  async function fixture(provider: Provider, overrides: Partial<Config> = {}) {
    const app = Fastify({ logger: false });
    const store = kind === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    const settings: Config = {
      ...config, provider: 'mock', objectiveProvider: 'mock', model: 'test', objectiveModel: 'test',
      requestHmacKeysJSON: JSON.stringify({ test: randomBytes(32).toString('base64') }), requestHmacKeyVersion: 'test',
      dbPath: ':memory:', requireDurableStorage: false, screenQueryEnabled: true, explanationEnabled: true,
      enabledSupportProfiles: 'reading_practice', deviceRegPerHour: 0,
      attemptBudgetUpperMicros: 100, modelDailyBudgetMicros: 10_000,
      ...overrides,
    };
    registerRoutes(app, { config: settings, store, storeKind: kind, provider, objectiveProvider: provider,
      providerDegraded: null, objectiveProviderDegraded: null, payment: new StubPaymentProvider() });
    const { token } = await store.registerDevice({ platform: 'macos', appVersion: 'test', trialQuestions: 30 });
    const headers = { authorization: `Bearer ${token}` };
    return { app, store, token, settings, headers,
      post: (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload }),
      close: async () => { await app.close(); await store.close(); } };
  }
  for (const [label, raw, charged, terminal] of [
    ['ready', ready, 1, 'usable'],
    ['review', output('B', 'review', 'ambiguous_options'), 1, 'usable'],
    ['retake', 'NSPI_RESULT_V1: {"v":1,"kind":"single_choice","state":"retake","answer":null,"reason":"missing_context"}', 0, 'retake'],
    ['fallback', 'FINAL: B', 1, 'usable'],
    ['multiple targets', 'NSPI_NO_RESULT_V1: {"v":1,"reason":"multiple_targets"}', 0, 'no_result'],
    ['unsupported', 'NSPI_NO_RESULT_V1: {"v":1,"reason":"unsupported_scope"}', 0, 'no_result'],
    ['mixed markers', ready + '\nNSPI_NO_RESULT_V1: {"v":1,"reason":"unsupported_scope"}', 0, 'failed'],
    ['invalid', 'No usable protocol', 0, 'failed'],
  ] as const) {
    test(`${kind}: screen query ${label} settles once and replays metadata without another attempt`, async () => {
      let calls = 0;
      const f = await fixture({ name: 'test', async stream(_, delta) {
        calls++; for (const char of raw) delta(char);
        return { inputTokens: 20, outputTokens: 5 };
      } });
      try {
        const body = solveBody();
        const response = await f.post('/v1/captures', body);
        assert.equal(response.statusCode, 200);
        assert.equal(usage(response.payload).questions_charged, charged);
        assert.equal(usage(response.payload).balance_questions, 30 - charged);
        assert.equal(usage(response.payload).terminal_state, terminal);
        assert.equal(usage(response.payload).capture_id, body.capture_id);
        assert.equal(usage(response.payload).held_questions, 0);
        assert.deepEqual(usage(response.payload).account_totals, {questions: charged, input_tokens: 20, output_tokens: 5});
        const status = await f.app.inject({ url: `/v1/captures/${body.capture_id}/status`, headers: f.headers });
        assert.equal(status.json().terminal_state, terminal);
        assert.equal(status.json().questions_charged, charged);
        assert.equal(status.json().usable_result, charged === 1);
        assert.deepEqual(status.json().account_totals, usage(response.payload).account_totals);
        const duplicate = await f.post('/v1/captures', body);
        assert.equal(duplicate.statusCode, 409);
        assert.equal(duplicate.json().error.code, 'capture_already_finalized');
        assert.deepEqual(duplicate.json().settlement.account_totals, usage(response.payload).account_totals);
        assert.equal(calls, 1);
        assert.equal((await f.store.billing.attempts(f.token)).length, 1);
        assert.equal((await f.store.billing.quota(f.token))?.heldQuestions, 0);
      } finally { await f.close(); }
    });
  }
  test(`${kind}: new official prompts are server-owned; material changes conflict and invalid scopes never call`, async () => {
    let calls = 0;
    const f = await fixture({ name: 'test', async stream(request, delta) {
      calls++;
      assert.ok(!request.system.includes('ATTACK') && !request.task.includes('ATTACK'));
      delta(ready); return { inputTokens: 20, outputTokens: 5 };
    } });
    try {
      const body = solveBody();
      assert.equal((await f.post('/v1/captures', { ...body, system: 'ATTACK', task: 'ATTACK' })).statusCode, 200);
      assert.equal((await f.post('/v1/captures', { ...body, ui_language: 'ja' })).json().error.code, 'idempotency_conflict');
      assert.equal((await f.post('/v1/captures', { ...solveBody(), scope: { ...body.scope, question_image_index: 1 } })).statusCode, 422);
      assert.equal(calls, 1);
      const stranger = await f.store.registerDevice({ platform: 'macos', appVersion: 'test', trialQuestions: 30 });
      assert.equal((await f.app.inject({ url: `/v1/captures/${body.capture_id}/status`, headers: { authorization: `Bearer ${stranger.token}` } })).statusCode, 404);
    } finally { await f.close(); }
  });
  test(`${kind}: corrupt reference pixels are rejected before a hold or model attempt and do not poison a retry`, async () => {
    let calls=0;const f=await fixture({name:'test',async stream(_,delta){calls++;delta(ready);return {inputTokens:1,outputTokens:1};}});
    try {
      const body=solveBody(),bad=corruptPixels().toString('base64');
      const response=await f.post('/v1/captures',{...body,images_base64:[bad,png],scope:{...body.scope,question_image_index:1}});
      assert.equal(response.statusCode,422);assert.equal(response.json().error.code,'invalid_image');
      assert.doesNotMatch(response.payload,/libpng|IDAT|vips/);assert.equal(calls,0);
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions,30);
      assert.equal((await f.store.billing.quota(f.token))?.heldQuestions,0);
      assert.equal(await f.store.billing.capture(f.token,body.capture_id),null);
      assert.equal((await f.store.billing.attempts(f.token)).length,0);
      assert.equal((await f.post('/v1/captures',body)).statusCode,200);assert.equal(calls,1);
      const auxiliary={...body,images_base64:[bad],explanation_id:randomUUID(),final_answer:'B'};
      assert.equal((await f.post(`/v1/captures/${body.capture_id}/explanation`,auxiliary)).statusCode,422);
      assert.equal(calls,1);assert.equal((await f.store.billing.attempts(f.token)).length,1);
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions,29);
    } finally {await f.close();}
  });
  test(`${kind}: explanation is bound to the paid answer, attempted once, and never adds a charge`, async () => {
    let calls = 0;
    const f = await fixture({ name: 'test', async stream(request, delta) {
      calls++;
      if (calls === 1) delta(ready);
      else { assert.equal(request.maxTokens, 768); delta(JSON.stringify({ consistent: true, explanation: 'Option B follows from the passage.' })); }
      return { inputTokens: 20, outputTokens: 5 };
    } });
    try {
      const body = solveBody(); await f.post('/v1/captures', body);
      const url = `/v1/captures/${body.capture_id}/explanation`;
      const explanation = { ...body, explanation_id: randomUUID(), final_answer: 'B' };
      assert.equal((await f.post(url, { ...explanation, final_answer: 'A' })).json().error.code, 'binding_mismatch');
      assert.equal((await f.post(url, { ...explanation, ui_language: 'ja' })).json().error.code, 'binding_mismatch');
      const response = await f.post(url, explanation);
      assert.equal(usage(response.payload).questions_charged, 0);
      assert.equal(usage(response.payload).settlement_status, 'not_required');
      assert.deepEqual(usage(response.payload).account_totals, {questions: 1, input_tokens: 20, output_tokens: 5});
      assert.ok(events(response.payload).some(e => e.type === 'delta' && e.text.includes('Option B')));
      assert.equal((await f.post(url, { ...explanation, explanation_id: randomUUID() })).statusCode, 409);
      assert.equal(calls, 2);
      assert.equal((await f.store.getAccount(f.token))?.balanceQuestions, 29);
      const parent = await f.store.billing.capture(f.token, body.capture_id);
      assert.equal(parent?.answerHmac !== null, true);
      assert.equal(parent?.settlementStatus, 'settled');
    } finally { await f.close(); }
  });
  test(`${kind}: failed recovery compensates once; successful recovery keeps its own result metadata`, async () => {
    for (const succeeds of [false, true]) {
      let calls = 0;
      const f = await fixture({ name: 'test', async stream(_, delta) {
        calls++;
        if (calls === 1) delta(ready);
        else if (succeeds) delta(output('C'));
        else throw new Error('private upstream details');
        return { inputTokens: 20, outputTokens: 5 };
      } });
      try {
        const body = solveBody(); await f.post('/v1/captures', body);
        const recovery = { ...body, recovery_id: randomUUID() };
        const url = `/v1/captures/${body.capture_id}/recovery`;
        const response = await f.post(url, recovery);
        assert.equal(usage(response.payload).questions_charged, 0);
        assert.equal(usage(response.payload).balance_questions, succeeds ? 29 : 30);
        assert.deepEqual(usage(response.payload).account_totals, {questions: 1, input_tokens: 20, output_tokens: 5});
        assert.ok(!response.payload.includes('private upstream details'));
        const record = await f.store.billing.capture(f.token, recovery.recovery_id);
        assert.equal(record?.usableResult, succeeds);
        assert.equal(Boolean(record?.answerHmac), succeeds);
        assert.equal((await f.post(url, { ...recovery, recovery_id: randomUUID() })).statusCode, 409);
        assert.equal(calls, 2);
        assert.equal((await f.store.getAccount(f.token))?.totalQuestions, 1);
      } finally { await f.close(); }
    }
  });
  test(`${kind}: a recovered answer can use the billed parent's single explanation entitlement`, async () => {
    let calls = 0;
    const f = await fixture({name: 'test', async stream(_, delta) {
      calls++;
      delta(calls === 1 ? ready : calls === 2 ? output('C') : JSON.stringify({consistent: true, explanation: 'C follows from the passage.'}));
      return {inputTokens: 20, outputTokens: 5};
    }});
    try {
      const parent = solveBody(); const solved = await f.post('/v1/captures', parent);
      const recoveryID = randomUUID();
      const recovered = await f.post(`/v1/captures/${parent.capture_id}/recovery`, {...parent, recovery_id: recoveryID});
      assert.equal(recovered.statusCode, 200);
      assert.equal(usage(recovered.payload).explanation_available, true);
      assert.equal(usage(recovered.payload).explanation_expires_at, usage(solved.payload).explanation_expires_at);
      const explainPath = `/v1/captures/${parent.capture_id}/explanation`;
      for (const selector of [null, 3, 'invalid']) {
        assert.equal((await f.post(explainPath, {...parent, explanation_id: randomUUID(), answer_capture_id: selector, final_answer: 'C'})).statusCode, 422);
      }
      for (const change of [{answer_capture_id: randomUUID()}, {final_answer: 'B'}, {ui_language: 'ja'}]) {
        assert.equal((await f.post(explainPath, {...parent, explanation_id: randomUUID(), answer_capture_id: recoveryID, final_answer: 'C', ...change})).statusCode, 409);
      }
      const explanationID = randomUUID();
      const explained = await f.post(`/v1/captures/${parent.capture_id}/explanation`, {
        ...parent, explanation_id: explanationID, answer_capture_id: recoveryID, final_answer: 'C',
      });
      assert.equal(explained.statusCode, 200);
      assert.equal(usage(explained.payload).questions_charged, 0);
      assert.equal(usage(explained.payload).explanation_available, false);
      const record = await f.store.billing.capture(f.token, explanationID);
      assert.equal(record?.parentCaptureId, parent.capture_id);
      assert.equal(record?.answerCaptureId, recoveryID);
      for (const [answerID, answer] of [[parent.capture_id, 'B'], [recoveryID, 'C']]) {
        assert.equal((await f.post(explainPath, {...parent, explanation_id: randomUUID(), answer_capture_id: answerID, final_answer: answer})).statusCode, 409);
      }
      assert.equal(calls, 3);
      assert.equal((await f.store.getAccount(f.token))?.totalQuestions, 1);
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions, 29);
      assert.equal((await f.store.billing.attempts(f.token)).length, 3);
    } finally { await f.close(); }
  });

  test(`${kind}: explaining the original answer consumes the entitlement before recovery`, async () => {
    let calls = 0;
    const f = await fixture({name: 'test', async stream(request, delta) {
      calls++;
      delta(request.maxTokens === 768 ? JSON.stringify({consistent: true, explanation: 'B follows from the text.'}) : calls === 1 ? ready : output('C'));
      return {inputTokens: 20, outputTokens: 5};
    }});
    try {
      const parent = solveBody(); await f.post('/v1/captures', parent);
      assert.equal((await f.post(`/v1/captures/${parent.capture_id}/explanation`, {...parent, explanation_id: randomUUID(), final_answer: 'B'})).statusCode, 200);
      const recoveryID = randomUUID();
      const recovered = await f.post(`/v1/captures/${parent.capture_id}/recovery`, {...parent, recovery_id: recoveryID});
      assert.equal(usage(recovered.payload).explanation_available, false);
      assert.equal((await f.post(`/v1/captures/${parent.capture_id}/explanation`, {...parent,
        explanation_id: randomUUID(), answer_capture_id: recoveryID, final_answer: 'C'})).statusCode, 409);
      assert.equal(calls, 3);
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions, 29);
    } finally { await f.close(); }
  });
  test(`${kind}: runtime kill switch rejects cached capabilities without changing the parent bill`, async () => {
    let calls = 0;
    const f = await fixture({ name: 'test', async stream(_, delta) { calls++; delta(ready); return { inputTokens: 1, outputTokens: 1 }; } });
    try {
      const body = solveBody(); await f.post('/v1/captures', body);
      (f.settings as { screenQueryEnabled: boolean }).screenQueryEnabled = false;
      assert.equal((await f.post('/v1/captures', solveBody())).statusCode, 503);
      assert.equal((await f.post(`/v1/captures/${body.capture_id}/explanation`, { ...body, explanation_id: randomUUID(), final_answer: 'B' })).statusCode, 503);
      assert.equal(calls, 1);
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions, 29);
    } finally { await f.close(); }
  });
  test(`${kind}: scheduled recovery requires its own credential and overlapping sweeps release once`, async () => {
    const secret = randomBytes(32).toString('base64url');
    const f = await fixture({ name: 'test', async stream() { throw new Error('must not call a model'); } }, { cronSecret: secret });
    try {
      const id = randomUUID();
      await f.store.billing.begin({ token: f.token, captureId: id, requestHmac: 'expired', leaseMs: -1 });
      assert.equal((await f.app.inject({ url: '/api/internal/reap' })).statusCode, 401);
      assert.equal((await f.app.inject({ url: '/api/internal/reap', headers: f.headers })).statusCode, 401);
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions, 29);
      const responses = await Promise.all([1, 2].map(() => f.app.inject({ url: '/api/internal/reap', headers: { authorization: `Bearer ${secret}` } })));
      assert.equal(responses.reduce((count, r) => count + r.json().processed, 0), 1);
      assert.ok(responses.every(r => r.statusCode === 200 && r.headers['cache-control'] === 'no-store'));
      assert.equal((await f.store.billing.quota(f.token))?.balanceQuestions, 30);
    } finally { await f.close(); }
  });
}
