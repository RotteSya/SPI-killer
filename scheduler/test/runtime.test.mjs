import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { transform } from 'esbuild';

test('workerd runs the scheduled handler and refuses public HTTP invocation', { timeout: 55_000 }, async () => {
  const source = await transform(await readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
    { loader: 'ts', format: 'esm' });
  const secret = 'isolated-runtime-test-credential-0123456789';
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'notchspi-reaper', modules: true, script: source.code, compatibilityDate: '2026-09-08',
    cf: false, bindings: { CRON_SECRET: secret },
    outboundService: async request => {
      calls++;
      assert.equal(request.url, 'https://notchspi-api.vercel.app/api/internal/reap');
      assert.equal(request.headers.get('Authorization'), `Bearer ${secret}`);
      return Response.json({ processed: 0, checked_at: new Date().toISOString(), more_possible: false,
        refunds_reconciled: 0, refunds_failed: 0, checkouts_credited: 0, checkouts_review: 0,
        checkouts_failed: 0, finance_reconciled: 0, finance_failed: 0, events_pruned: 0 });
    },
  }));
  try {
    const worker = await mf.getWorker();
    const outcome = await worker.scheduled({ cron: '* * * * *' });
    assert.equal(outcome.outcome, 'ok', JSON.stringify({ calls, outcome }));
    assert.equal(calls, 1);
    assert.equal((await mf.dispatchFetch('https://local.invalid/')).status, 404);
    assert.equal(calls, 1);
  } finally { await mf.dispose(); }
});
