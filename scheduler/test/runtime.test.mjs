import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

for (const candidate of [false, true]) {
test(`workerd runs the ${candidate ? 'candidate' : 'production'} handler and refuses public HTTP invocation`, { timeout: 55_000 }, async () => {
  const source = await build({ entryPoints: [new URL(candidate ? '../src/candidate.ts' : '../src/index.ts', import.meta.url).pathname],
    bundle: true, write: false, format: 'esm', platform: 'browser' });
  const secret = 'isolated-runtime-test-credential-0123456789';
  const bypass = '0123456789abcdefghijklmnopqrstuv';
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'notchspi-reaper', modules: true, script: source.outputFiles[0].text, compatibilityDate: '2026-09-08',
    cf: false, bindings: { CRON_SECRET: secret, VERCEL_AUTOMATION_BYPASS_SECRET: bypass },
    outboundService: async request => {
      calls++;
      assert.equal(request.url, candidate ? 'https://notchspi-ckatjw33a-rottesyas-projects.vercel.app/api/internal/reap'
        : 'https://notchspi-api.vercel.app/api/internal/reap');
      assert.equal(request.headers.get('Authorization'), `Bearer ${secret}`);
      assert.equal(request.headers.get('x-vercel-protection-bypass'), candidate ? bypass : null);
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
}
