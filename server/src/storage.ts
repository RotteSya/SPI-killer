import { readFileSync } from 'node:fs';
import type { Store } from './db.ts';
import type { Config } from './config.ts';

// Storage selection, most-durable first. Implementations are imported DYNAMICALLY so a
// platform missing node:sqlite (or with a read-only filesystem) never even loads the module
// it can't use:
//
//   1. POSTGRES_URL / DATABASE_URL set  → PostgresStore   (production)
//   2. serverless platform (VERCEL=1)   → MemoryStore     (ephemeral — visible in /healthz)
//   3. otherwise                        → SqliteStore     (local dev / self-hosted VPS)

export type StoreKind = 'postgres' | 'sqlite' | 'memory';

export async function makeStore(config: Config): Promise<{ store: Store; kind: StoreKind }> {
  if (config.postgresUrl) {
    const { PostgresStore, resolvePostgresSSL } = await import('./db-postgres.ts');
    // A custom CA can arrive inline (env vars often store PEM with literal "\n") or as a file
    // path. A configured-but-unreadable CA file fails boot loudly — never silently downgrade a
    // security setting the operator explicitly asked for.
    const caInline = config.postgresCACert ? config.postgresCACert.replace(/\\n/g, '\n') : '';
    const caCert = caInline || (config.postgresCACertFile ? readFileSync(config.postgresCACertFile, 'utf8') : '');
    const ssl = resolvePostgresSSL({ connectionString: config.postgresUrl, mode: config.postgresSSLMode, caCert });
    return { store: new PostgresStore(config.postgresUrl, ssl), kind: 'postgres' };
  }
  if (config.requireDurableStorage || (config.isServerless && (config.provider !== 'mock' || config.paymentProvider === 'stripe'))) {
    throw new Error('Durable Postgres storage is required for production service and payments');
  }
  if (config.isServerless) {
    const { MemoryStore } = await import('./db-memory.ts');
    return { store: new MemoryStore(), kind: 'memory' };
  }
  const { SqliteStore } = await import('./db-sqlite.ts');
  return { store: new SqliteStore(config.dbPath), kind: 'sqlite' };
}
