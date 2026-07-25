import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../src/db.ts';
import { SqliteStore } from '../src/db-sqlite.ts';
import { MemoryStore } from '../src/db-memory.ts';

// The same behavioral suite runs against every store implementation that can run without
// external services — SQLite and the in-memory fallback must be indistinguishable to routes.
const IMPLEMENTATIONS: Array<{ name: string; make: () => Store }> = [
  { name: 'sqlite', make: () => new SqliteStore(':memory:') },
  { name: 'memory', make: () => new MemoryStore() },
];

for (const impl of IMPLEMENTATIONS) {
  test(`[${impl.name}] registerDevice grants the trial questions and returns a token`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'macos', appVersion: '2.0', trialQuestions: 180 });
    assert.match(dev.token, /^dev_/);
    assert.equal(dev.balanceQuestions, 180);
    await store.close();
  });

  test(`[${impl.name}] getAccount reflects registration; unknown token is null`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    const acct = await store.getAccount(dev.token);
    assert.deepEqual(acct, {
      balanceQuestions: 180,
      totalQuestions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cliEnabled: false,
      appVersion: '1',
    });
    assert.equal(await store.getAccount('dev_nope'), null);
    await store.close();
  });

  test(`[${impl.name}] updateAppVersion replaces the build recorded at registration`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'macos', appVersion: '2.0.1', trialQuestions: 10 });
    await store.updateAppVersion(dev.token, '2.7');
    assert.equal((await store.getAccount(dev.token))?.appVersion, '2.7');
    // Visible in the admin view too — that view is the whole reason this column must not lie.
    assert.equal((await store.listRecentDevices(5))[0]?.appVersion, '2.7');
    // Unknown tokens are a silent no-op, never a throw: this runs inside the auth path.
    await store.updateAppVersion('dev_nope', '9.9');
    await store.close();
  });

  test(`[${impl.name}] setCliEnabled flips per device; unknown token is null`, async () => {
    const store = impl.make();
    const a = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 0 });
    const b = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 0 });
    assert.equal(await store.setCliEnabled(a.token, true), true);
    assert.equal((await store.getAccount(a.token))?.cliEnabled, true);
    assert.equal((await store.getAccount(b.token))?.cliEnabled, false, 'the switch is per-device');
    assert.equal(await store.setCliEnabled(a.token, false), false);
    assert.equal((await store.getAccount(a.token))?.cliEnabled, false);
    assert.equal(await store.setCliEnabled('dev_nope', true), null);
    await store.close();
  });

  test(`[${impl.name}] chargeForUsage deducts questions and accumulates totals`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    const b1 = await store.chargeForUsage({ token: dev.token, questions: 1, inputTokens: 1200, outputTokens: 480, model: 'mock' });
    assert.equal(b1, 179);
    const b2 = await store.chargeForUsage({ token: dev.token, questions: 1, inputTokens: 100, outputTokens: 50, model: 'mock' });
    assert.equal(b2, 178);
    const acct = await store.getAccount(dev.token);
    assert.equal(acct?.totalQuestions, 2);
    assert.equal(acct?.totalInputTokens, 1300);
    assert.equal(acct?.totalOutputTokens, 530);
    await store.close();
  });

  test(`[${impl.name}] balance may go negative when a capture was in flight at zero`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 0 });
    const b = await store.chargeForUsage({ token: dev.token, questions: 1, inputTokens: 0, outputTokens: 1000, model: 'mock' });
    assert.equal(b, -1); // honest accounting; the pre-request gate blocks the NEXT capture
    await store.close();
  });

  test(`[${impl.name}] chargeForUsage / credit on an unknown token return null`, async () => {
    const store = impl.make();
    assert.equal(
      await store.chargeForUsage({ token: 'dev_x', questions: 1, inputTokens: 1, outputTokens: 1, model: 'm' }),
      null,
    );
    assert.equal(
      await store.credit({ token: 'dev_x', questions: 100, amountCents: 900, currency: 'CNY', provider: 'stub', reference: 'r' }),
      null,
    );
    await store.close();
  });

  test(`[${impl.name}] credit adds purchased questions to the balance`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 0 });
    assert.equal(
      await store.credit({ token: dev.token, questions: 100, amountCents: 900, currency: 'CNY', provider: 'stub', reference: 'r1' }),
      100,
    );
    assert.equal(
      await store.credit({ token: dev.token, questions: 300, amountCents: 2400, currency: 'CNY', provider: 'stub', reference: 'r2' }),
      400,
    );
    await store.close();
  });

  test(`[${impl.name}] credit is idempotent by reference (webhook redelivery is a no-op)`, async () => {
    const store = impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 0 });
    const first = await store.credit({
      token: dev.token, questions: 300, amountCents: 2400, currency: 'CNY',
      provider: 'stripe', reference: 'cs_test_abc123',
    });
    assert.equal(first, 300);
    // Same reference again — Stripe retries deliveries; the balance must not move.
    const second = await store.credit({
      token: dev.token, questions: 300, amountCents: 2400, currency: 'CNY',
      provider: 'stripe', reference: 'cs_test_abc123',
    });
    assert.equal(second, 300);
    assert.equal((await store.getAccount(dev.token))?.balanceQuestions, 300);
    await store.close();
  });

  test(`[${impl.name}] two devices have independent balances`, async () => {
    const store = impl.make();
    const a = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    const b = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    await store.chargeForUsage({ token: a.token, questions: 1, inputTokens: 0, outputTokens: 0, model: 'm' });
    assert.equal((await store.getAccount(a.token))?.balanceQuestions, 179);
    assert.equal((await store.getAccount(b.token))?.balanceQuestions, 180);
    await store.close();
  });
}
