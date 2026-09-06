import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createFixedWindowLimiter, createConcurrencyLimiter } from '../src/rateLimit.ts';

// Isolate an in-memory DB and pin a LOW registration cap so the /v1/devices integration test can
// trip it deterministically. Env is read once at config import, so this must precede it.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.QUOTA_POLICY_VERSION = 'legacy-test';
process.env.TRIAL_QUESTIONS = '5';
process.env.LOG_LEVEL = 'silent';
process.env.DEVICE_REG_PER_HOUR = '2';

const { buildApp } = await import('../src/index.ts');

// ---- Pure limiter unit tests (deterministic) ---------------------------------------------

test('fixed-window limiter allows up to maxHits per key, then blocks', () => {
  const lim = createFixedWindowLimiter(2, 60_000);
  assert.equal(lim.hit('a'), true);
  assert.equal(lim.hit('a'), true);
  assert.equal(lim.hit('a'), false); // third hit in the window is blocked
  assert.equal(lim.hit('b'), true); // a different key has its own budget
});

test('fixed-window limiter with maxHits <= 0 is disabled (always allows)', () => {
  const lim = createFixedWindowLimiter(0, 60_000);
  for (let i = 0; i < 100; i++) assert.equal(lim.hit('x'), true);
});

test('concurrency limiter caps in-flight per key and frees on release', () => {
  const lim = createConcurrencyLimiter(1);
  assert.equal(lim.tryAcquire('t'), true);
  assert.equal(lim.tryAcquire('t'), false); // already at the cap
  lim.release('t');
  assert.equal(lim.tryAcquire('t'), true); // slot freed
  assert.equal(lim.tryAcquire('u'), true); // independent key
});

test('concurrency limiter with max <= 0 is disabled (always acquires)', () => {
  const lim = createConcurrencyLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(lim.tryAcquire('x'), true);
});

// ---- /v1/devices per-IP cap integration --------------------------------------------------

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

async function reg(): Promise<Response> {
  return fetch(`${base}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: 'test' }),
  });
}

test('anonymous registration is capped per IP (DEVICE_REG_PER_HOUR)', async () => {
  assert.equal((await reg()).status, 200); // 1st
  assert.equal((await reg()).status, 200); // 2nd
  const third = await reg();
  assert.equal(third.status, 429, 'third registration from the same IP is rate limited');
  const body = (await third.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'rate_limited');
  assert.ok(body.error.message.length > 0);
});
