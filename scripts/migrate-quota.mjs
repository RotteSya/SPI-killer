#!/usr/bin/env node
// Explicit destination only. This tool never loads .env or falls back to production storage.
import {resolve} from 'node:path';
import {stat} from 'node:fs/promises';

const [action, ...rest] = process.argv.slice(2);
const usage = 'Usage: node scripts/migrate-quota.mjs <status|pause|batch|validate|resume> (--sqlite <existing-path>|--postgres) [--release <compatible-artifact-sha256>] [--revision <paused-revision>] [--batch-size <1..500>]. --postgres reads only NSPI_MIGRATION_DATABASE_URL.';
const options = new Map();
for (let i = 0; i < rest.length; i++) {
  const key = rest[i];
  if (!['--sqlite','--postgres','--release','--revision','--batch-size'].includes(key) || options.has(key)) throw new Error(usage);
  const value = key === '--postgres' ? true : rest[++i];
  if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) throw new Error(usage);
  options.set(key, value);
}
if (!['status','pause','batch','validate','resume'].includes(action) || options.has('--sqlite') === options.has('--postgres')) throw new Error(usage);
if (action === 'pause' ? !/^[a-f0-9]{64}$/.test(options.get('--release') ?? '') : options.has('--release')) throw new Error(usage);
if (action === 'resume' ? !/^\d{1,40}$/.test(options.get('--revision') ?? '') : options.has('--revision')) throw new Error(usage);
const batchSize = Number(options.get('--batch-size') ?? 100);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error(usage);
let store;
try {
  if (options.has('--sqlite')) {
    const path = resolve(options.get('--sqlite'));
    if (!(await stat(path)).isFile()) throw new Error('SQLite destination must already exist');
    const {SqliteStore} = await import('../server/src/db-sqlite.ts');
    store = new SqliteStore(path);
  } else {
    const connection = process.env.NSPI_MIGRATION_DATABASE_URL;
    if (!connection || !['postgres:','postgresql:'].includes(new URL(connection).protocol)) throw new Error('Explicit migration database URL required');
    const {PostgresStore, resolvePostgresSSL} = await import('../server/src/db-postgres.ts');
    store = new PostgresStore(connection, resolvePostgresSSL({connectionString: connection}));
  }
  const migration = store.quotaMigration;
  let result;
  if (action === 'status') result = await migration.status();
  if (action === 'pause') result = await migration.pause(options.get('--release'));
  if (action === 'batch') result = await migration.backfill(batchSize);
  if (action === 'validate' || action === 'resume') {
    const before = await migration.status();
    if (before.state !== 'paused' || (action === 'resume' && before.revision !== options.get('--revision'))) throw new Error('Expected paused revision required');
    await migration.invalidateValidation();
    for (let batch = 0; batch < 10000; batch++) {
      result = await migration.backfill(batchSize);
      if (!result.status.unvalidated) break;
    }
    if (result.status.unvalidated) throw new Error('Validation batch limit reached; admission remains paused');
    if (action === 'resume') result = await migration.resume(options.get('--revision'));
  }
  console.log(JSON.stringify({operation: action, result}));
} catch (error) {
  // Never emit a connection string, token, query parameters, or database row in operator logs.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'MIGRATION_FAILED';
  const detail = error instanceof Error && /^(Migration |Quota migration |Pause capture |Wait for held |Validate every |Paused migration |Expected paused |Validation batch |SQLite destination |Explicit migration )/.test(error.message)
    ? error.message : 'Inspect the isolated diagnostics or database service; no automatic repair was applied.';
  console.error(JSON.stringify({operation: action, error: code, detail}));
  process.exitCode = 1;
} finally { if (store) await store.close(); }
