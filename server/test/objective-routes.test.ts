import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.QUOTA_POLICY_VERSION = 'legacy-test';
process.env.TRIAL_QUESTIONS = '2';
process.env.TRIAL_MIN_QUESTIONS = '2';
process.env.TRIAL_MAX_QUESTIONS = '2';
process.env.OBJECTIVE_RESULT_V1_BPS = '10000';
process.env.OBJECTIVE_RESULT_EXPERIMENT_SALT = 'test-salt';
process.env.CLIENT_CONFIG_REVISION = 'test-r1';
process.env.TELEMETRY_ENABLED = '1';
process.env.EVENT_BATCH_PER_MINUTE = '30';
process.env.ADMIN_TOKEN = 'admin-secret';
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
    body: JSON.stringify({ platform: 'macos', app_version: '3.0' }),
  });
  return ((await response.json()) as { device_token: string }).device_token;
}

test('authenticated client config uses stable treatment contract', async () => {
  assert.equal((await fetch(`${base}/v1/client-config`)).status, 401);
  const token = await register();
  const response = await fetch(`${base}/v1/client-config`, {
    headers: { authorization: `Bearer ${token}`, 'x-app-version': '3.0' },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, any>;
  assert.equal(body.schema_version, 1);
  assert.equal(body.revision, 'test-r1');
  assert.equal(body.objective_result_v1.variant, 'objective_v1');
  assert.equal(body.objective_result_v1.protocol, 'objective_v1');
});

test('event batch partially accepts, deduplicates, and feeds token-free admin metrics', async () => {
  const token = await register();
  const captureID = '3e7979c6-20cb-4c12-a23e-ece6eb3aa52d';
  const started = {
    event_id: '772359ba-172f-4e20-ab13-1a3e147ca260', capture_id: captureID,
    occurred_at: new Date().toISOString(), event_name: 'capture_started', trigger: 'capture_hotkey',
    channel: 'official', mode: 'tutor', depth: 'brief', context_count: 0,
    config_revision: 'test-r1', variant: 'objective_v1',
  };
  const completed = {
    ...started, event_id: '972359ba-172f-4e20-ab13-1a3e147ca260',
    event_name: 'capture_completed', parser_path: 'none', error_code: 'protocol_invalid',
  };
  const invalid = { ...started, event_id: '872359ba-172f-4e20-ab13-1a3e147ca260', surprise: 'not allowed' };
  const upload = async (events: unknown[]) => fetch(`${base}/v1/events/batch`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, events }),
  });
  const first = await upload([started, completed, invalid]);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { accepted: 2, duplicate: 0, rejected: 1 });
  const duplicate = await upload([started]);
  assert.deepEqual(await duplicate.json(), { accepted: 0, duplicate: 1, rejected: 0 });

  const metrics = await fetch(`${base}/admin/metrics`, { headers: { 'x-admin-token': 'admin-secret' } });
  assert.equal(metrics.status, 200);
  const body = await metrics.json() as Record<string, any>;
  assert.equal(body.variants[0].captures_started, 1);
  assert.equal(body.variants[0].captures_completed, 1);
  assert.equal(body.variants[0].protocol_valid_rate, 0);
  assert.equal(JSON.stringify(body).includes(token), false);
});
