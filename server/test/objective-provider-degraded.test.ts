import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.OBJECTIVE_RESULT_V1_PROVIDER = 'deepseek';
process.env.DEEPSEEK_API_KEY = '';
process.env.OBJECTIVE_RESULT_V1_BPS = '10000';
process.env.QUOTA_POLICY_VERSION = 'legacy-test';
process.env.TRIAL_QUESTIONS = '2';
process.env.TRIAL_MIN_QUESTIONS = '2';
process.env.TRIAL_MAX_QUESTIONS = '2';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');
let app: FastifyInstance;
let base = '';

before(async () => {
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => app.close());

async function register(): Promise<string> {
  const response = await fetch(`${base}/v1/devices`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: 'test' }),
  });
  return ((await response.json()) as { device_token: string }).device_token;
}

test('active Objective misconfiguration makes health fail without breaking control captures', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 503);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(healthBody.ok, false);
  assert.equal(healthBody.objective_provider_active, true);
  assert.match(String(healthBody.objective_provider_error), /DEEPSEEK_API_KEY/);

  const token = await register();
  const control = await fetch(`${base}/v1/captures`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
  });
  assert.equal(control.status, 200);
  assert.match(await control.text(), /"questions_charged":1/);

  const objective = await fetch(`${base}/v1/captures`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg',
      result_protocol: 'objective_v1' }),
  });
  assert.equal(objective.status, 503);
  assert.doesNotMatch(await objective.text(), /questions_charged/);
});
