import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Safety default: with no ADMIN_TOKEN configured, the entire /admin path must not exist.
// node:test runs each test file in its own process, so this env is isolated from admin.test.ts.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.ADMIN_TOKEN = '';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');

let app: FastifyInstance;
let base: string;

before(async () => {
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
});

test('GET /admin is 404 when ADMIN_TOKEN is not set', async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 404);
});

test('POST /admin/grant is 404 when ADMIN_TOKEN is not set', async () => {
  const res = await fetch(`${base}/admin/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'anything' },
    body: JSON.stringify({ device_token: 'dev_x', questions: 100 }),
  });
  assert.equal(res.status, 404);
});

test('GET /admin/activity is 404 when ADMIN_TOKEN is not set', async () => {
  const res = await fetch(`${base}/admin/activity`, { headers: { 'x-admin-token': 'anything' } });
  assert.equal(res.status, 404);
});

test('POST /admin/cli is 404 when ADMIN_TOKEN is not set', async () => {
  const res = await fetch(`${base}/admin/cli`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'anything' },
    body: JSON.stringify({ device_token: 'dev_x', enabled: true }),
  });
  assert.equal(res.status, 404);
});
