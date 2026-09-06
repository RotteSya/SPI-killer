import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import Fastify from 'fastify';
import {config} from '../src/config.ts';
import {registerRoutes} from '../src/routes.ts';
import {MockProvider} from '../src/providers/mock.ts';
import {StubPaymentProvider} from '../src/payments.ts';
import {MemoryStore} from '../src/db-memory.ts';
import {SqliteStore} from '../src/db-sqlite.ts';
import {hashToken, type Store} from '../src/db.ts';
import type {AccountSnapshot} from '../src/billing.ts';

const implementations: Array<[string, () => Store | Promise<Store>]> = [
  ['memory', () => new MemoryStore()], ['sqlite', () => new SqliteStore(':memory:')],
];
if (process.env.TEST_POSTGRES_URL) {
  const url = new URL(process.env.TEST_POSTGRES_URL);
  if (!/test/i.test(url.pathname)) throw new Error('Account snapshots require an isolated database named test');
  const {PostgresStore, resolvePostgresSSL} = await import('../src/db-postgres.ts');
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({connectionString: url.toString(), ssl: resolvePostgresSSL({connectionString: url.toString()})});
  const schema = 'account_snapshot_test_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', '-c search_path=' + schema);
  const connection = url.toString(), ssl = resolvePostgresSSL({connectionString: connection});
  after(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  implementations.push(['postgres', async () => {
    const store = new PostgresStore(connection, ssl);
    await store.getAccount('__initialize_test_schema__');
    await admin.query(`TRUNCATE ${schema}.devices RESTART IDENTITY CASCADE`);
    return store;
  }]);
}

function appFor(store: Store, name: string) {
  const app = Fastify({logger: false}), provider = new MockProvider();
  registerRoutes(app, {config: {...config, trialQuestions: 30, quotaPolicyVersion: 'fixed30-test',
    deviceRegPerHour: 1000, stripeSecretKey: '', adminToken: '', cronSecret: ''}, store,
    storeKind: name as 'memory' | 'sqlite' | 'postgres', provider, objectiveProvider: provider,
    providerDegraded: null, objectiveProviderDegraded: null, payment: new StubPaymentProvider()});
  return app;
}

for (const [name, make] of implementations) {
  test(`${name}: account route reads totals and permission from the same post-recovery quota snapshot`, async () => {
    const store = await make(), app = appFor(store, name);
    try {
      const {token} = await store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 30});
      const captureId = randomUUID();
      assert.equal((await store.billing.begin({token, captureId, requestHmac: 'snapshot'})).ok, true);
      const reap = store.billing.reap.bind(store.billing);
      store.billing.reap = async now => {
        // A real settlement and operator permission update commit after authentication has
        // read the old Account, but before the route assembles its response. No fake balances.
        await store.billing.finish({token, captureId, charge: true, terminalState: 'usable', inputTokens: 11, outputTokens: 7});
        await store.setCliEnabled(token, true);
        return reap(now);
      };
      const response = await app.inject({url: '/v1/account', headers: {authorization: `Bearer ${token}`}});
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.json(), {balance_version: '3', held_questions: 0, policy_version: 'legacy',
        quota_breakdown: {trial: 29, paid: 0, goodwill: 0, legacy_unknown: 0}, balance_questions: 29,
        total_questions: 1, total_input_tokens: 11, total_output_tokens: 7, cli_enabled: true});
    } finally { await app.close(); await store.close(); }
  });

  test(`${name}: registration never combines an old balance with a newer quota version`, async () => {
    const store = await make(), app = appFor(store, name);
    try {
      const register = store.registerDevice.bind(store);
      let heldToken = '';
      store.registerDevice = async input => {
        const device = await register(input);
        heldToken = device.token;
        assert.equal((await store.billing.begin({token: device.token, captureId: randomUUID(), requestHmac: 'during-registration'})).ok, true);
        return device;
      };
      const response = await app.inject({method: 'POST', url: '/v1/devices', payload: {platform: 'macos', app_version: '2.12'}});
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {policy_version: 'fixed30-test', initial_grant: 30,
        balance_version: '2', device_token: heldToken, balance_questions: 29});
    } finally { await app.close(); await store.close(); }
  });

  test(`${name}: concurrent account readers see complete held or settled states and immutable values`, async () => {
    const store = await make();
    try {
      const {token} = await store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 50, policyVersion: 'fixed30-test'});
      assert.equal(await store.billing.accountSnapshot('dev_unknown'), null);
      const opening = structuredClone(await store.billing.accountSnapshot(token));
      for (let round = 0; round < 20; round++) {
        await store.setCliEnabled(token, round % 2 === 0);
        const captureId = randomUUID();
        assert.equal((await store.billing.begin({token, captureId, requestHmac: 'snapshot_' + round})).ok, true);
        const before = await store.billing.accountSnapshot(token);
        assert.equal(before?.heldQuestions, 1);
        const readers = Array.from({length: 6}, () => store.billing.accountSnapshot(token));
        const finish = store.billing.finish({token, captureId, charge: true, terminalState: 'usable', inputTokens: 11, outputTokens: 7});
        readers.push(...Array.from({length: 6}, () => store.billing.accountSnapshot(token)));
        const snapshots = await Promise.all(readers);
        const committed = await finish;
        const after = await store.billing.accountSnapshot(token);
        assert.deepEqual(committed, after, 'finish must return the counters and quota committed by its own transaction');
        for (const snapshot of [before, after, committed, ...snapshots]) {
          assert.ok(snapshot);
          const held = snapshot.balanceVersion === String(2 + round * 2);
          const count = round + (held ? 0 : 1);
          assert.equal(snapshot.balanceVersion, String((held ? 2 : 3) + round * 2));
          assert.equal(snapshot.heldQuestions, held ? 1 : 0);
          assert.equal(snapshot.balanceQuestions, 49 - round);
          assert.equal(snapshot.totalQuestions, count);
          assert.equal(snapshot.totalInputTokens, count * 11);
          assert.equal(snapshot.totalOutputTokens, count * 7);
          assert.equal(snapshot.cliEnabled, round % 2 === 0);
          assert.deepEqual(snapshot.quotaBreakdown, {trial: 49 - round, paid: 0, goodwill: 0, legacy_unknown: 0});
        }
        assert.equal(before?.heldQuestions, 1, 'later settlement cannot mutate a returned snapshot');
        assert.equal(before?.totalQuestions, round);
        assert.equal(after?.totalQuestions, round + 1);
      }
      assert.equal(opening?.balanceQuestions, 50);
      assert.equal(opening?.quotaBreakdown.trial, 50);
      assert.equal(opening?.totalQuestions, 0);
    } finally { await store.close(); }
  });

  test(`${name}: account refresh sees a released expired hold without inventing a paid question`, async t => {
    t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-08-01T00:00:00Z')});
    const store = await make(), app = appFor(store, name);
    try {
      const {token} = await store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 30});
      await store.billing.begin({token, captureId: randomUUID(), requestHmac: 'expired', leaseMs: 1000});
      t.mock.timers.tick(2000);
      const response = await app.inject({url: '/v1/account', headers: {authorization: `Bearer ${token}`}});
      assert.equal(response.statusCode, 200);
      const snapshot = response.json();
      assert.equal(snapshot.balance_questions, 30); assert.equal(snapshot.balance_version, '3');
      assert.equal(snapshot.held_questions, 0); assert.equal(snapshot.total_questions, 0);
      assert.equal(snapshot.total_input_tokens, 0); assert.equal(snapshot.total_output_tokens, 0);
      assert.equal((await store.billing.accountSnapshot(token))?.balanceVersion, '3');
    } finally { await app.close(); await store.close(); }
  });

  test(`${name}: failed or missing snapshot cannot fall back to the authentication account`, async () => {
    const store = await make(), app = appFor(store, name);
    try {
      const {token} = await store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 30});
      const read = store.billing.accountSnapshot.bind(store.billing);
      store.billing.accountSnapshot = async () => null;
      const missing = await app.inject({url: '/v1/account', headers: {authorization: `Bearer ${token}`}});
      assert.equal(missing.statusCode, 401); assert.equal(missing.json().error.code, 'invalid_token');
      store.billing.accountSnapshot = async () => { throw new Error('private database failure'); };
      const failed = await app.inject({url: '/v1/account', headers: {authorization: `Bearer ${token}`}});
      assert.equal(failed.statusCode, 500); assert.equal(failed.json().error.code, 'internal');
      assert.equal(failed.body.includes('private database'), false);
      store.billing.accountSnapshot = read;
      assert.equal((await read(token))?.balanceQuestions, 30);
      const noToken = await app.inject({url: '/v1/account'});
      assert.equal(noToken.statusCode, 401);
    } finally { await app.close(); await store.close(); }
  });
}

for (const [name, make] of implementations) {
  test(`${name}: later settlements and duplicate finish cannot mutate or double-count a returned account snapshot`, async () => {
    const store = await make();
    try {
      const {token} = await store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 30});
      const first = {token, captureId: randomUUID(), charge: true, terminalState: 'usable' as const, inputTokens: 11, outputTokens: 7};
      await store.billing.begin({...first, requestHmac: 'first'});
      const committed = await store.billing.finish(first);
      assert.ok(committed);
      assert.equal(committed.totalQuestions, 1); assert.equal(committed.totalInputTokens, 11);
      assert.equal(committed.totalOutputTokens, 7); assert.equal(committed.balanceVersion, '3');
      const second = {...first, captureId: randomUUID(), inputTokens: 5, outputTokens: 3};
      await store.billing.begin({...second, requestHmac: 'second'});
      const latest = await store.billing.finish(second);
      assert.ok(latest);
      assert.equal(latest.totalQuestions, 2); assert.equal(latest.totalInputTokens, 16);
      assert.equal(latest.totalOutputTokens, 10); assert.equal(latest.balanceVersion, '5');
      assert.deepEqual(await store.billing.finish(first), latest);
      assert.equal(committed.totalQuestions, 1); assert.equal(committed.totalInputTokens, 11);
      assert.equal(committed.balanceQuestions, 29); assert.equal(committed.balanceVersion, '3');
    } finally { await store.close(); }
  });
}

test('sqlite: an unclassified legacy account keeps its counters and exact version after lazy opening and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nspi-account-snapshot-')), path = join(dir, 'test.sqlite');
  let store = new SqliteStore(path);
  const probe = new DatabaseSync(path), token = 'dev_legacy_snapshot_123456';
  try {
    const now = new Date().toISOString();
    probe.prepare(`INSERT INTO devices (token_hash,platform,app_version,balance_questions,total_questions,total_input_tokens,
      total_output_tokens,cli_enabled,created_at,updated_at,balance_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(hashToken(token), 'macos', '2.0', 125, 13, 1000, 400, 1, now, now, 9007199254740993n);
    const first = await store.billing.accountSnapshot(token);
    assert.ok(first);
    assert.deepEqual(first, {balanceQuestions: 125, heldQuestions: 0, balanceVersion: '9007199254740993',
      policyVersion: 'legacy', initialGrantQuestions: null, quotaBreakdown: {trial: 0, paid: 0, goodwill: 0, legacy_unknown: 125},
      totalQuestions: 13, totalInputTokens: 1000, totalOutputTokens: 400, cliEnabled: true} satisfies AccountSnapshot);
    await store.close(); store = new SqliteStore(path);
    assert.deepEqual(await store.billing.accountSnapshot(token), first);
    assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM quota_lots').get()?.n, 1);
    assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM quota_ledger').get()?.n, 1);
    assert.equal((await store.getAccount(token))?.balanceQuestions, 125);
  } finally { probe.close(); await store.close(); await rm(dir, {recursive: true, force: true}); }
});

test('sqlite: unsafe persisted counters or malformed permission fail before an imprecise account response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nspi-account-invalid-')), path = join(dir, 'test.sqlite');
  const store = new SqliteStore(path), probe = new DatabaseSync(path), app = appFor(store, 'sqlite');
  try {
    const {token} = await store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 30});
    for (const change of ['total_input_tokens=9007199254740993', 'total_questions=-1', 'cli_enabled=2', "balance_version='invalid'"]) {
      probe.exec('UPDATE devices SET total_input_tokens=0,total_questions=0,cli_enabled=0,balance_version=1');
      probe.exec('UPDATE devices SET ' + change);
      const response = await app.inject({url: '/v1/account', headers: {authorization: `Bearer ${token}`}});
      assert.equal(response.statusCode, 500);
      assert.equal(response.json().error.code, 'internal');
      assert.equal(response.json().balance_questions, undefined);
    }
  } finally { await app.close(); probe.close(); await store.close(); await rm(dir, {recursive: true, force: true}); }
});
