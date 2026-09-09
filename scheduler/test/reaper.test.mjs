import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { createReaper } from '../src/index.ts';

const secret = 'test-only-reaper-credential-0123456789';
const controller = { scheduledTime: 1_788_825_600_000, cron: '* * * * *' };
const result = { processed: 2, checked_at: '2026-09-08T00:00:00.000Z', more_possible: false,
  refunds_reconciled: 0, refunds_failed: 0, checkouts_credited: 0, checkouts_review: 0,
  checkouts_failed: 0, finance_reconciled: 0, finance_failed: 0, events_pruned: 0 };

function harness(t, response) {
  const logs = [];
  t.mock.method(console, 'log', value => logs.push(value));
  t.mock.method(console, 'error', value => logs.push(value));
  const fetchMock = t.mock.method(globalThis, 'fetch', response);
  return { logs, fetchMock, run: () => worker.scheduled(controller, { CRON_SECRET: secret }) };
}

test('one authenticated request to the fixed origin; counters only in success logs', async t => {
  const h = harness(t, async (url, init) => {
    assert.equal(url, 'https://notchspi-api.vercel.app/api/internal/reap');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${secret}`);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ ...result, private_field: secret });
  });
  await h.run(); assert.equal(h.fetchMock.mock.callCount(), 1);
  assert.equal(JSON.parse(h.logs[0]).processed, 2);
  assert.ok(!JSON.stringify(h.logs).includes(secret));
});

test('missing or unsafe credentials make zero requests', async t => {
  const h = harness(t, async () => Response.json(result));
  for (const value of [undefined, '', 'short', `${secret}\n`]) {
    await assert.rejects(worker.scheduled(controller, { CRON_SECRET: value }), /reaper_failed/);
  }
  assert.equal(h.fetchMock.mock.callCount(), 0);
});

for (const status of [204, 301, 401, 403, 429, 500, 503]) {
  test(`HTTP ${status} fails without retry or body disclosure`, async t => {
    const h = harness(t, async () => new Response(status === 204 ? null : secret, { status }));
    await assert.rejects(h.run(), /reaper_failed/);
    assert.equal(h.fetchMock.mock.callCount(), 1);
    assert.ok(!JSON.stringify(h.logs).includes(secret));
  });
}

test('network errors and aborted requests are sanitized', async t => {
  const h = harness(t, async () => { throw new Error(`network failure ${secret}`); });
  await assert.rejects(h.run(), /^Error: reaper_failed$/);
  assert.ok(!JSON.stringify(h.logs).includes(secret));
});

test('invalid, oversized, and partial results cannot report cron success', async t => {
  const replies = [
    new Response('login', { headers: { 'Content-Type': 'text/html' } }),
    new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }),
    Response.json({ ...result, processed: -1 }), Response.json({ ...result, checked_at: '' }),
    Response.json({ ...result, finance_failed: 1 }), Response.json({ ok: true }),
    Response.json({ ...result, private_field: secret.repeat(150) }),
  ];
  const h = harness(t, async () => replies.shift());
  for (let i = 0; i < 7; i++) await assert.rejects(h.run(), /reaper_failed/);
  assert.equal(h.fetchMock.mock.callCount(), 7);
  assert.ok(!JSON.stringify(h.logs).includes(secret));
});

test('more work remains visible and is deferred to the next scheduled tick', async t => {
  const h = harness(t, async () => Response.json({ ...result, more_possible: true }));
  await h.run(); assert.equal(h.fetchMock.mock.callCount(), 1);
  assert.equal(JSON.parse(h.logs[0]).more_possible, true);
});

test('public HTTP requests cannot trigger maintenance', async t => {
  const h = harness(t, async () => { throw new Error('unexpected request'); });
  assert.equal((await worker.fetch()).status, 404);
  assert.equal(h.fetchMock.mock.callCount(), 0);
});

test('candidate authenticates to its immutable deployment; production never sends the protection secret', async t => {
  const bypass = '0123456789abcdefghijklmnopqrstuv';
  const requests = [];
  const h = harness(t, async (url, init) => {
    requests.push({url, headers:init.headers});
    return Response.json({ ...result, private_field: bypass });
  });
  const env = { CRON_SECRET: secret, VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
    REAP_URL: 'https://untrusted.invalid/', ENVIRONMENT: 'production' };
  await createReaper('candidate').scheduled(controller, env);
  await worker.scheduled(controller, env);
  assert.equal(requests[0].url, 'https://notchspi-ckatjw33a-rottesyas-projects.vercel.app/api/internal/reap');
  assert.equal(requests[0].headers['x-vercel-protection-bypass'], bypass);
  assert.equal(requests[0].headers.Authorization, `Bearer ${secret}`);
  assert.equal(requests[1].url, 'https://notchspi-api.vercel.app/api/internal/reap');
  assert.equal(requests[1].headers['x-vercel-protection-bypass'], undefined);
  assert.ok(!JSON.stringify(h.logs).includes(bypass));
});

test('candidate refuses missing or malformed protection credentials before any request', async t => {
  const h = harness(t, async () => Response.json(result));
  for (const value of [undefined, '', 'x'.repeat(31), 'x'.repeat(33), 'x'.repeat(31)+'\n', 'x'.repeat(31)+'_']) {
    await assert.rejects(createReaper('candidate').scheduled(controller,
      { CRON_SECRET: secret, VERCEL_AUTOMATION_BYPASS_SECRET: value }), /^Error: reaper_failed$/);
  }
  assert.equal(h.fetchMock.mock.callCount(), 0);
});
