import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import Fastify from 'fastify';
import {SqliteStore} from '../src/db-sqlite.ts';
import {hashToken, type Store} from '../src/db.ts';
import type {Row} from '../src/billing-sql.ts';
import type {SQLQuotaMigration} from '../src/quota-migration.ts';
import {registerRoutes} from '../src/routes.ts';
import {config} from '../src/config.ts';
import {StubPaymentProvider} from '../src/payments.ts';
import type {Provider} from '../src/providers/types.ts';
import {pngBase64} from './helpers/images.ts';

type MigratingStore = Store & {quotaMigration: SQLQuotaMigration};
const release = 'a'.repeat(64), oldTime = '2026-01-01T00:00:00.000Z';
const implementations = ['sqlite', ...(process.env.TEST_POSTGRES_URL ? ['postgres'] : [])];
const exec = promisify(execFile);
async function fixture(kind: string, concurrentCold = false) {
  const dir = await mkdtemp(join(tmpdir(), 'nspi-quota-migration-')), path = join(dir, 'old.db');
  let query: (sql: string, args?: Array<string | number | null>) => Promise<Row[]>;
  let make: () => MigratingStore, closeDatabase: () => Promise<void>;
  if (kind === 'sqlite') {
    const db = new DatabaseSync(path);
    db.exec(await readFile(new URL('./fixtures/quota-migration/sqlite-7ba96db.sql', import.meta.url), 'utf8'));
    query = async (sql, args = []) => db.prepare(sql).all(...args);
    make = () => new SqliteStore(path);
    closeDatabase = async () => { db.close(); };
  } else {
    const url = new URL(process.env.TEST_POSTGRES_URL!);
    if (!/test/i.test(url.pathname)) throw new Error('Migration tests require an isolated database named test');
    const {PostgresStore, resolvePostgresSSL} = await import('../src/db-postgres.ts');
    const pg = (await import('pg')).default;
    const admin = new pg.Pool({connectionString: url.toString(), ssl: resolvePostgresSSL({connectionString: url.toString()})});
    const schema = 'quota_migration_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', '-c search_path=' + schema);
    const connection = url.toString(), ssl = resolvePostgresSSL({connectionString: connection});
    const db = new pg.Pool({connectionString: connection, ssl});
    await db.query(await readFile(new URL('./fixtures/quota-migration/postgres-7ba96db.sql', import.meta.url), 'utf8'));
    query = async (sql, args = []) => { let n = 0; return (await db.query(sql.replace(/\?/g, () => '$' + ++n), args)).rows; };
    make = () => new PostgresStore(connection, ssl);
    closeDatabase = async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  }
  const tokens: string[] = [];
  for (const balance of [147, 0, 7]) {
    const token = 'dev_' + randomUUID(); tokens.push(token);
    const d = (await query(`INSERT INTO devices(token_hash,platform,app_version,balance_questions,total_questions,
      total_input_tokens,total_output_tokens,cli_enabled,created_at,updated_at)
      VALUES(?,'macos','2.11',?,3,11,5,${kind === 'sqlite' ? 1 : 'true'},?,?) RETURNING id`, [hashToken(token), balance, oldTime, oldTime]))[0]!;
    for (const reference of [null, 'old-purchase-' + d.id]) await query(`INSERT INTO topups(device_id,questions,amount_cents,currency,provider,reference,note,created_at)
      VALUES(?,100,1000,'jpy','stripe',?,'historical purchase',?)`, [Number(d.id), reference, oldTime]);
    await query(`INSERT INTO usage_events(device_id,questions,input_tokens,output_tokens,model,created_at) VALUES(?,3,11,5,'old-model',?)`, [Number(d.id), oldTime]);
  }
  const historical = async () => JSON.stringify(await Promise.all([
    query('SELECT id,token_hash,platform,app_version,balance_questions,total_questions,total_input_tokens,total_output_tokens,cli_enabled,onboarded,hotkey_presses,created_at,updated_at FROM devices ORDER BY id'),
    query('SELECT * FROM topups ORDER BY id'), query('SELECT * FROM usage_events ORDER BY id'),
  ]));
  const before = await historical();
  if (kind === 'sqlite' && concurrentCold) {
    const module = new URL('../src/db-sqlite.ts', import.meta.url).href;
    await Promise.all(Array.from({length: 4}, () => exec(process.execPath, ['--input-type=module', '-e',
      `const {SqliteStore}=await import(${JSON.stringify(module)}); const s=new SqliteStore(process.argv[1]); await s.close();`, path])));
  }
  let store = make();
  return {path, query, tokens, before, historical, make,
    get store() { return store; },
    reopen: async () => { await store.close(); store = make(); },
    close: async () => { await store.close(); await closeDatabase(); await rm(dir, {recursive: true, force: true}); },
  };
}

for (const kind of implementations) {
  test(`${kind}: actual previous schema expands concurrently and preserves all old fields`, async () => {
    const f = await fixture(kind, true);
    try {
      const workers = Array.from({length: 8}, () => f.make());
      try { await Promise.all(workers.map(s => s.getAccount(f.tokens[0]!))); }
      finally { await Promise.all(workers.map(s => s.close())); }
      assert.equal(await f.historical(), f.before);
      assert.equal((await f.store.quotaMigration.status()).checkpointed, 0);
      const paused = await f.store.quotaMigration.pause(release);
      assert.equal(paused.state, 'paused'); assert.equal(paused.revision, '1');
      assert.equal((await f.store.quotaMigration.pause(release)).revision, '1');
      await assert.rejects(f.store.quotaMigration.pause('b'.repeat(64)), /another compatible release/);
      for (let i = 0; i < 3; i++) assert.equal((await f.store.quotaMigration.backfill(1)).processed, 1);
      assert.equal((await f.store.quotaMigration.backfill(1)).processed, 0);
      assert.equal(await f.historical(), f.before);
      assert.equal(String((await f.query('SELECT COUNT(*) AS n FROM quota_lots'))[0]!.n), '3');
      assert.equal(String((await f.query('SELECT COUNT(*) AS n FROM quota_ledger'))[0]!.n), '3');
      for (let i = 0; i < 3; i++) {
        const snapshot = await f.store.billing.accountSnapshot(f.tokens[i]!);
        assert.equal(snapshot?.policyVersion, 'legacy'); assert.equal(snapshot?.initialGrantQuestions, null);
        assert.equal(snapshot?.balanceQuestions, [147, 0, 7][i]);
        assert.equal(snapshot?.quotaBreakdown.legacy_unknown, [147, 0, 7][i]);
        assert.equal(snapshot?.cliEnabled, true); assert.equal(snapshot?.totalQuestions, 3);
      }
      await f.reopen(); assert.equal((await f.store.quotaMigration.status()).state, 'paused');
      await assert.rejects(f.store.quotaMigration.resume('0'), /revision changed/);
      assert.equal((await f.store.quotaMigration.resume('1')).state, 'active');
      await f.reopen(); assert.equal((await f.store.quotaMigration.status()).state, 'active');
      assert.equal(await f.historical(), f.before);
      const fresh = await f.store.registerDevice({platform: 'macos', appVersion: '2.12', trialQuestions: 30, policyVersion: 'fixed30-test'});
      assert.equal((await f.store.billing.quota(fresh.token))?.quotaBreakdown.trial, 30);
      assert.equal((await f.store.billing.quota(f.tokens[0]!))?.balanceQuestions, 147);
    } finally { await f.close(); }
  });

  test(`${kind}: pause drains existing captures, survives restart and preserves compatible rollback writes`, async () => {
    const f = await fixture(kind), token = f.tokens[0]!, captureId = randomUUID();
    try {
      assert.equal((await f.store.billing.begin({token, captureId, requestHmac: 'inflight'})).ok, true);
      const paused = await f.store.quotaMigration.pause(release); assert.equal(paused.heldCaptures, 1);
      const denied = await Promise.all(Array.from({length: 20}, () => f.store.billing.begin({token, captureId: randomUUID(), requestHmac: 'denied'})));
      assert.ok(denied.every(r => !r.ok && r.reason === 'service_maintenance'));
      await assert.rejects(f.store.quotaMigration.backfill(), /drain/);
      await f.reopen();
      await f.store.billing.finish({token, captureId, charge: true, terminalState: 'usable', inputTokens: 7, outputTokens: 3});
      assert.equal((await f.store.billing.quota(token))?.balanceQuestions, 146);
      await f.store.quotaMigration.backfill();
      await f.store.credit({token, questions: 10, amountCents: 100, currency: 'jpy', provider: 'stripe', reference: 'new-credit'});
      await assert.rejects(f.store.quotaMigration.resume(paused.revision), /Validate every device/);
      await f.store.quotaMigration.backfill();
      await f.store.quotaMigration.resume(paused.revision);
      // The bridge retains the original Store and HTTP contracts; its writes use the ledger.
      assert.equal((await f.store.reserveQuestions({token, questions: 1})).ok, true);
      await f.store.settleReservation({token, questions: 1, inputTokens: 2, outputTokens: 1, model: 'bridge'});
      await f.store.credit({token, questions: 10, amountCents: 100, currency: 'jpy', provider: 'stripe', reference: 'new-credit'});
      const snapshot = await f.store.billing.accountSnapshot(token);
      assert.equal(snapshot?.balanceQuestions, 155); assert.equal(snapshot?.heldQuestions, 0);
      assert.equal(snapshot?.totalQuestions, 5); assert.equal(snapshot?.totalInputTokens, 20);
      const again = await f.store.quotaMigration.pause(release);
      await f.store.quotaMigration.backfill(); await f.store.quotaMigration.resume(again.revision);
    } finally { await f.close(); }
  });

  test(`${kind}: interrupted batch rolls back opening lots and checkpoints without repairing invalid old balances`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.quotaMigration.pause(release);
      await f.query('UPDATE devices SET balance_questions=-1 WHERE id=2');
      await assert.rejects(f.store.quotaMigration.backfill(3), /Invalid question amount/);
      assert.equal(String((await f.query('SELECT COUNT(*) AS n FROM quota_lots'))[0]!.n), '0');
      assert.equal((await f.store.quotaMigration.status()).checkpointed, 0);
      assert.equal((await f.store.quotaMigration.status()).state, 'paused');
      await f.query('UPDATE devices SET balance_questions=0 WHERE id=2');
      await f.store.quotaMigration.backfill(3);
      assert.equal(await f.historical(), f.before);
    } finally { await f.close(); }
  });

  test(`${kind}: the shared admission lock orders simultaneous pause and capture transactions`, async () => {
    const f = await fixture(kind), token = f.tokens[0]!;
    try {
      await f.store.billing.quota(token);
      const begins = Array.from({length: 24}, () => f.store.billing.begin({token, captureId: randomUUID(), requestHmac: 'race'}));
      const pause = f.store.quotaMigration.pause(release);
      const [results, state] = await Promise.all([Promise.all(begins), pause]);
      const accepted = results.filter(result => result.ok);
      assert.equal(state.heldCaptures, accepted.length);
      assert.equal((await f.store.quotaMigration.status()).heldCaptures, accepted.length);
      assert.equal((await f.store.billing.quota(token))?.balanceQuestions, 147 - accepted.length);
      for (const result of accepted) if (result.ok) await f.store.billing.finish({token, captureId: result.capture.captureId, charge: false, terminalState: 'canceled'});
      await f.store.quotaMigration.backfill(); await f.store.quotaMigration.resume(state.revision);
      assert.equal((await f.store.billing.quota(token))?.balanceQuestions, 147);
    } finally { await f.close(); }
  });

  test(`${kind}: old direct balance writes and historical purchase tampering block validation`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.quotaMigration.pause(release); await f.store.quotaMigration.backfill();
      await f.query('UPDATE devices SET balance_questions=balance_questions-1 WHERE id=1');
      await f.store.quotaMigration.invalidateValidation();
      await assert.rejects(f.store.quotaMigration.backfill(), /account balance mismatch/);
      await assert.rejects(f.store.quotaMigration.resume('1'), /Validate every device/);
      await f.query('UPDATE devices SET balance_questions=balance_questions+1 WHERE id=1');
      await f.query("UPDATE topups SET note='changed after checkpoint' WHERE id=1");
      await assert.rejects(f.store.quotaMigration.backfill(), /historical records changed/);
      await f.query("UPDATE topups SET note='historical purchase' WHERE id=1");
      await f.store.quotaMigration.backfill(); assert.equal(await f.historical(), f.before);
      await f.store.quotaMigration.resume('1');
    } finally { await f.close(); }
  });

  test(`${kind}: expired captures can be reaped while paused; legacy HTTP returns 503 without model or debit`, async () => {
    const f = await fixture(kind), token = f.tokens[0]!, captureId = randomUUID();
    let calls = 0;
    const provider: Provider = {name: 'mock', async stream() { calls++; return {inputTokens: 1, outputTokens: 1}; }};
    const app = Fastify({logger: false});
    registerRoutes(app, {config: {...config, attemptBudgetUpperMicros: 10, modelDailyBudgetMicros: 1000,
      requireDurableStorage: false}, store: f.store, storeKind: kind as 'sqlite' | 'postgres',
      provider, objectiveProvider: provider, providerDegraded: null, objectiveProviderDegraded: null, payment: new StubPaymentProvider()});
    try {
      await f.store.billing.begin({token, captureId, requestHmac: 'expires', leaseMs: 1});
      await f.store.quotaMigration.pause(release);
      await f.store.billing.reap(new Date(Date.now() + 2000).toISOString());
      assert.equal((await f.store.billing.quota(token))?.balanceQuestions, 147);
      const response = await app.inject({method: 'POST', url: '/v1/captures', headers: {authorization: `Bearer ${token}`},
        payload: {image_base64: pngBase64, image_media_type: 'image/png', system: 'test', task: 'test'}});
      assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().error.code, 'service_maintenance');
      assert.equal(response.headers['retry-after'], '60'); assert.equal(calls, 0);
      assert.equal((await f.store.billing.quota(token))?.balanceQuestions, 147);
      assert.equal(String((await f.query("SELECT COUNT(*) AS n FROM attempt_budget_holds WHERE state='held'"))[0]!.n), '0');
      await f.store.quotaMigration.backfill(); await f.store.quotaMigration.resume('1');
    } finally { await app.close(); await f.close(); }
  });
}

test('sqlite: operator CLI validates and resumes an explicit isolated destination across processes', async () => {
  const f = await fixture('sqlite'), cli = new URL('../../scripts/migrate-quota.mjs', import.meta.url).pathname;
  const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args, '--sqlite', f.path])).stdout);
  try {
    assert.equal((await run('pause', '--release', release)).result.state, 'paused');
    assert.equal((await run('batch', '--batch-size', '1')).result.processed, 1);
    assert.equal((await run('status')).result.checkpointed, 1);
    assert.equal((await run('resume', '--revision', '1', '--batch-size', '1')).result.state, 'active');
    assert.equal(await f.historical(), f.before);
    await assert.rejects(run('resume', '--revision', '1'));
    await assert.rejects(exec(process.execPath, [cli, 'status', '--sqlite', join(tmpdir(), randomUUID() + '.db')]));
  } finally { await f.close(); }
});
