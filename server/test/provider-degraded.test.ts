import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Naming a real vendor without its key used to fall back to the MOCK provider silently. The mock
// streams plausible text, so `sawDelta` was true and the charge landed: paying customers were
// billed a real question for a canned Chinese placeholder, and nothing failed loudly enough for
// an operator to notice. An emptied or renamed ANTHROPIC_API_KEY was all it took.
//
// The contract now: the server still boots (so /healthz can explain itself), but it reports
// unhealthy and refuses captures instead of billing for them.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = ''; // the misconfiguration under test
process.env.TRIAL_QUESTIONS = '5';
process.env.TRIAL_MIN_QUESTIONS = '5';
process.env.TRIAL_MAX_QUESTIONS = '5';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');

let app: FastifyInstance;
let base: string;

before(async () => {
  // Deliberately NO provider override: this suite exercises the config-driven path.
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
});

test('the server boots but reports itself unhealthy', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 503, 'an uptime check must page instead of seeing a healthy server');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.match(String(body.provider_error), /ANTHROPIC_API_KEY/);
});

test('a capture is refused and costs nothing', async () => {
  const reg = await fetch(`${base}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: 'test' }),
  });
  const { device_token: token } = (await reg.json()) as { device_token: string };

  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
  });
  assert.equal(res.status, 503);
  const body = (await res.text()) as string;
  assert.doesNotMatch(body, /questions_charged/, 'a refused capture must never report a charge');
  assert.doesNotMatch(body, /mock 模式/, 'the mock placeholder must never reach a paying client');

  const acct = (await (
    await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { balance_questions: number; total_questions: number };
  assert.equal(acct.balance_questions, 5, 'the balance must be untouched');
  assert.equal(acct.total_questions, 0);
});
