import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../src/db.ts';
import { SqliteStore } from '../src/db-sqlite.ts';
import { MemoryStore } from '../src/db-memory.ts';

// The same behavioral suite runs against every store implementation — they must be
// indistinguishable to the routes, and running one suite over all of them is what catches drift
// between them. SQLite and the in-memory fallback need no external services and always run.
const IMPLEMENTATIONS: Array<{ name: string; make: () => Store | Promise<Store> }> = [
  { name: 'sqlite', make: () => new SqliteStore(':memory:') },
  { name: 'memory', make: () => new MemoryStore() },
];

// PostgresStore is the PRODUCTION backend and the only one that cannot run without a real
// database, so it used to have no coverage at all — including for the quota arithmetic that
// decides what customers are charged. Point TEST_POSTGRES_URL at a throwaway database and the
// whole suite above runs against it too:
//
//   TEST_POSTGRES_URL='postgres://…/notchspi_test?sslmode=disable' npm test
//
// (A local server without TLS needs the sslmode=disable; managed providers verify by default.)
const PG_URL = process.env.TEST_POSTGRES_URL ?? '';
if (PG_URL !== '') {
  const { PostgresStore, resolvePostgresSSL } = await import('../src/db-postgres.ts');
  const pg = (await import('pg')).default;

  // Guard rail: this suite TRUNCATES every table between tests, because the credit-idempotency
  // cases reuse fixed references and would otherwise see the previous test's rows. Refuse any
  // database that doesn't look like scratch space, so a pasted production URL cannot wipe real
  // balances on someone's first run.
  const dbName = new URL(PG_URL).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(
      `TEST_POSTGRES_URL must point at a throwaway database whose name contains "test" — got "${dbName}". ` +
        'This suite truncates every table.',
    );
  }

  const ssl = resolvePostgresSSL({ connectionString: PG_URL });
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1, ssl });
  after(async () => admin.end());

  IMPLEMENTATIONS.push({
    name: 'postgres',
    make: async () => {
      const store = new PostgresStore(PG_URL, ssl);
      // Any public method awaits the lazy schema creation; do it before truncating so the very
      // first run has tables to truncate.
      await store.getAccount('__schema_bootstrap__');
      await admin.query('TRUNCATE usage_events, topups, devices, counters RESTART IDENTITY CASCADE');
      return store;
    },
  });
}

for (const impl of IMPLEMENTATIONS) {
  test(`[${impl.name}] registerDevice grants the trial questions and returns a token`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'macos', appVersion: '2.0', trialQuestions: 180 });
    assert.match(dev.token, /^dev_/);
    assert.equal(dev.balanceQuestions, 180);
    await store.close();
  });

  test(`[${impl.name}] getAccount reflects registration; unknown token is null`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    const acct = await store.getAccount(dev.token);
    assert.deepEqual(acct, {
      balanceQuestions: 180,
      totalQuestions: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cliEnabled: false,
      appVersion: '1',
      onboarded: false,
    });
    assert.equal(await store.getAccount('dev_nope'), null);
    await store.close();
  });

  test(`[${impl.name}] updateAppVersion replaces the build recorded at registration`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'macos', appVersion: '2.0.1', trialQuestions: 10 });
    await store.updateAppVersion(dev.token, '2.7');
    assert.equal((await store.getAccount(dev.token))?.appVersion, '2.7');
    // Visible in the admin view too — that view is the whole reason this column must not lie.
    assert.equal((await store.listRecentDevices(5))[0]?.appVersion, '2.7');
    // Unknown tokens are a silent no-op, never a throw: this runs inside the auth path.
    await store.updateAppVersion('dev_nope', '9.9');
    await store.close();
  });

  test(`[${impl.name}] onboarding + hotkey signals accumulate independently of usage`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'macos', appVersion: '2.7', trialQuestions: 10 });
    const row = async () => (await store.listRecentDevices(1))[0];
    assert.equal((await row())?.onboarded, false, 'a fresh device has not onboarded');
    assert.equal((await row())?.hotkeyPresses, 0);

    await store.markOnboarded(dev.token);
    await store.markOnboarded(dev.token); // idempotent
    assert.equal((await store.getAccount(dev.token))?.onboarded, true);

    // Presses are counted even though no question was ever charged — that gap is the signal.
    await store.recordHotkeyPress(dev.token);
    await store.recordHotkeyPress(dev.token);
    assert.equal((await row())?.hotkeyPresses, 2);
    assert.equal((await row())?.totalQuestions, 0);
    // Neither signal counts as balance activity, so 最后活跃 keeps meaning what it says.
    assert.equal((await row())?.updatedAt, (await row())?.createdAt);

    for (const call of [store.markOnboarded('dev_nope'), store.recordHotkeyPress('dev_nope')]) {
      await call; // unknown tokens are silent no-ops
    }
    await store.close();
  });

  test(`[${impl.name}] setCliEnabled flips per device; unknown token is null`, async () => {
    const store = await impl.make();
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

  test(`[${impl.name}] reserve + settle deducts questions and accumulates totals`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    const h1 = await store.reserveQuestions({ token: dev.token, questions: 1 });
    assert.deepEqual(h1, { ok: true, balanceQuestions: 179 });
    await store.settleReservation({ token: dev.token, questions: 1, inputTokens: 1200, outputTokens: 480, model: 'mock' });
    const h2 = await store.reserveQuestions({ token: dev.token, questions: 1 });
    assert.deepEqual(h2, { ok: true, balanceQuestions: 178 });
    await store.settleReservation({ token: dev.token, questions: 1, inputTokens: 100, outputTokens: 50, model: 'mock' });
    const acct = await store.getAccount(dev.token);
    assert.equal(acct?.balanceQuestions, 178);
    assert.equal(acct?.totalQuestions, 2);
    assert.equal(acct?.totalInputTokens, 1300);
    assert.equal(acct?.totalOutputTokens, 530);
    await store.close();
  });

  test(`[${impl.name}] a released hold restores the balance and bills nothing`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 5 });
    assert.deepEqual(await store.reserveQuestions({ token: dev.token, questions: 1 }), { ok: true, balanceQuestions: 4 });
    assert.equal(await store.releaseReservation({ token: dev.token, questions: 1 }), 5);
    const acct = await store.getAccount(dev.token);
    assert.equal(acct?.balanceQuestions, 5);
    assert.equal(acct?.totalQuestions, 0); // a refunded attempt never counts as a question
    await store.close();
  });

  test(`[${impl.name}] the balance can never be reserved below zero`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 1 });
    assert.deepEqual(await store.reserveQuestions({ token: dev.token, questions: 1 }), { ok: true, balanceQuestions: 0 });
    assert.deepEqual(await store.reserveQuestions({ token: dev.token, questions: 1 }), {
      ok: false, reason: 'insufficient_quota',
    });
    assert.equal((await store.getAccount(dev.token))?.balanceQuestions, 0);
    await store.close();
  });

  test(`[${impl.name}] concurrent holds on a balance of 1 produce exactly one winner`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 1 });
    // The double-spend regression: eight captures racing on the last question. A read-then-write
    // charge let every one of them through and drove the balance to -7.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.reserveQuestions({ token: dev.token, questions: 1 })),
    );
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal((await store.getAccount(dev.token))?.balanceQuestions, 0);
    await store.close();
  });

  test(`[${impl.name}] reserve / credit on an unknown token report it`, async () => {
    const store = await impl.make();
    assert.deepEqual(
      await store.reserveQuestions({ token: 'dev_x', questions: 1 }),
      { ok: false, reason: 'unknown_token' },
    );
    assert.equal(await store.releaseReservation({ token: 'dev_x', questions: 1 }), null);
    assert.equal(
      await store.credit({ token: 'dev_x', questions: 100, amountCents: 900, currency: 'CNY', provider: 'stub', reference: 'r' }),
      null,
    );
    await store.close();
  });

  test(`[${impl.name}] credit adds purchased questions to the balance`, async () => {
    const store = await impl.make();
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
    const store = await impl.make();
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
    const store = await impl.make();
    const a = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    const b = await store.registerDevice({ platform: 'm', appVersion: '1', trialQuestions: 180 });
    await store.reserveQuestions({ token: a.token, questions: 1 });
    assert.equal((await store.getAccount(a.token))?.balanceQuestions, 179);
    assert.equal((await store.getAccount(b.token))?.balanceQuestions, 180);
    await store.close();
  });

  test(`[${impl.name}] product events are idempotent, aggregate usage cost, and prune`, async () => {
    const store = await impl.make();
    const dev = await store.registerDevice({ platform: 'm', appVersion: '3', trialQuestions: 1 });
    const captureId = '3e7979c6-20cb-4c12-a23e-ece6eb3aa52d';
    const now = new Date().toISOString();
    const event = {
      eventId: '772359ba-172f-4e20-ab13-1a3e147ca260', captureId, occurredAt: now,
      eventName: 'capture_started', trigger: 'capture_hotkey', channel: 'official', mode: 'tutor',
      depth: 'brief', contextCount: 0, questionKind: null, resultState: null, parserPath: null,
      errorCode: null, action: null, captureMs: null, firstTokenMs: null, totalMs: null,
      appVersion: '3', configRevision: 'r1', variant: 'objective_v1',
    };
    assert.deepEqual(await store.recordProductEvents(dev.token, [event]), { accepted: 1, duplicate: 0 });
    assert.deepEqual(await store.recordProductEvents(dev.token, [event]), { accepted: 0, duplicate: 1 });
    await store.reserveQuestions({ token: dev.token, questions: 1 });
    await store.settleReservation({ token: dev.token, questions: 1, inputTokens: 1200,
      outputTokens: 300, model: 'mock', captureId, estimatedCostMicros: 42 });
    const metrics = await store.getProductMetrics({
      from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(metrics.variants[0]?.captures_started, 1);
    assert.equal(metrics.variants[0]?.tokens.avg_input, 1200);
    assert.equal(metrics.variants[0]?.estimated_cost_micros.total, 42);
    assert.equal(await store.pruneProductEvents(new Date(Date.now() + 60_000).toISOString()), 1);
    await store.close();
  });
}
