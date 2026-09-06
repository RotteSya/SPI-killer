import {createHash} from 'node:crypto';
import {opening, query, type Row, type RunTransaction, type Transaction} from './billing-sql.ts';
import {validQuestions} from './billing.ts';

export interface MigrationStatus {
  state: 'active' | 'paused'; revision: string; compatibilityRelease: string | null;
  devices: number; checkpointed: number; unvalidated: number; heldCaptures: number;
  runningAttempts: number;
}
const count = (row: Row | undefined): number => {
  const n = Number(row?.n);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid migration count');
  return n;
};
const canonical = (value: unknown): unknown => value instanceof Date ? value.toISOString()
  : typeof value === 'bigint' ? value.toString() : value;
const integer = (value: unknown): bigint => {
  if (!/^-?\d+$/.test(String(value))) throw new Error('Invalid quota integer');
  return BigInt(String(value));
};
const HISTORY = {
  topups: ['id','device_id','questions','amount_cents','currency','provider','reference','note','created_at'],
  usage_events: ['id','device_id','questions','input_tokens','output_tokens','model','created_at',
    'capture_id','result_protocol','result_state','parser_path','estimated_cost_micros','pricing_version'],
} as const;
type HistorySnapshot = Record<keyof typeof HISTORY, {maxId: string; count: number; sha256: string}>;

function* history(deviceId: number, previous?: HistorySnapshot): Transaction<HistorySnapshot> {
  const result = {} as HistorySnapshot;
  for (const table of ['topups','usage_events'] as const) {
    const maxId = previous?.[table].maxId ?? String((yield* query(`SELECT COALESCE(MAX(id),0) AS n FROM ${table} WHERE device_id=?`, deviceId))[0]!.n);
    const digest = createHash('sha256');
    let cursor = '0', rowsRead = 0;
    while (true) {
      const rows = yield* query(`SELECT ${HISTORY[table].join(',')} FROM ${table} WHERE device_id=? AND id>? AND id<=? ORDER BY id LIMIT 500`, deviceId, cursor, maxId);
      if (!rows.length) break;
      for (const row of rows) digest.update(JSON.stringify(HISTORY[table].map(key => canonical(row[key]))) + '\n');
      rowsRead += rows.length; cursor = String(rows.at(-1)!.id);
    }
    result[table] = {maxId, count: rowsRead, sha256: digest.digest('hex')};
  }
  return result;
}

/** The caller owns the device row. All arithmetic stays exact, including BIGINT sums. */
function* validateLedger(d: Row): Transaction<void> {
  for (const field of ['balance_questions','total_questions','total_input_tokens','total_output_tokens']) validQuestions(Number(d[field]));
  if (!/^\d{1,40}$/.test(String(d.balance_version)) || ![true,false,0,1,0n,1n].includes(d.cli_enabled as boolean | number | bigint)) throw new Error('Migration account metadata invalid');
  const rows = yield* query(`SELECT q.lot_id,q.remaining,q.held,q.refund_frozen,
    COALESCE((SELECT SUM(l.available_delta) FROM quota_ledger l WHERE l.lot_id=q.lot_id),0) AS available,
    COALESCE((SELECT SUM(l.held_delta) FROM quota_ledger l WHERE l.lot_id=q.lot_id),0) AS ledger_held,
    COALESCE((SELECT SUM(r.questions) FROM quota_reservations r WHERE r.lot_id=q.lot_id AND r.state='held'),0) AS reserved
    FROM quota_lots q WHERE q.device_id=?`, Number(d.id));
  let available = 0n;
  for (const row of rows) {
    const held = integer(row.held), expected = Number(row.refund_frozen) === 1 ? 0n : integer(row.remaining) - held;
    if (integer(row.available) !== expected || integer(row.ledger_held) !== held || integer(row.reserved) !== held) {
      throw new Error('Migration quota ledger mismatch');
    }
    available += expected;
  }
  if (!rows.length || available !== integer(d.balance_questions)) throw new Error('Migration account balance mismatch');
}

/** Called in the same transaction as a newly created opening lot or initial grant. */
export function* checkpointQuota(d: Row, openingLotId: string | null): Transaction<void> {
  if ((yield* query('SELECT device_id FROM quota_migration_checkpoints WHERE device_id=?', Number(d.id))).length) return;
  yield* validateLedger(d);
  const fields = ['id','token_hash','platform','app_version','balance_questions','total_questions','total_input_tokens',
    'total_output_tokens','cli_enabled','onboarded','hotkey_presses','created_at','updated_at','quota_policy_version',
    'initial_grant_questions','balance_version'];
  const snapshot = Object.fromEntries(fields.map(key => [key, canonical(d[key])]));
  yield* query(`INSERT INTO quota_migration_checkpoints(device_id,migration_version,opening_lot_id,account_snapshot,history_snapshot,created_at)
    VALUES(?,1,?,?,?,?)`, Number(d.id), openingLotId, JSON.stringify(snapshot), JSON.stringify(yield* history(Number(d.id))), new Date().toISOString());
}

function* control(exclusive = false): Transaction<Row> {
  const row = (yield* query(`SELECT * FROM quota_migration_control WHERE id=1 ${exclusive ? 'FOR UPDATE' : 'FOR SHARE'}`))[0];
  if (!row || !['active','paused'].includes(String(row.state))) throw new Error('Quota migration control unavailable');
  return row;
}
function* statusFor(row: Row): Transaction<MigrationStatus> {
  return {state: row.state as MigrationStatus['state'], revision: String(row.revision),
    compatibilityRelease: row.compatibility_release === null ? null : String(row.compatibility_release),
    devices: count((yield* query('SELECT COUNT(*) AS n FROM devices'))[0]),
    checkpointed: count((yield* query('SELECT COUNT(*) AS n FROM quota_migration_checkpoints'))[0]),
    unvalidated: count((yield* query(`SELECT COUNT(*) AS n FROM devices d LEFT JOIN quota_migration_checkpoints c ON c.device_id=d.id
      WHERE c.device_id IS NULL OR c.validated_balance_version IS NULL OR c.validated_balance_version<>CAST(d.balance_version AS TEXT)`))[0]),
    heldCaptures: count((yield* query("SELECT COUNT(*) AS n FROM capture_requests WHERE state='held'"))[0]),
    runningAttempts: count((yield* query("SELECT COUNT(*) AS n FROM model_attempts WHERE status='running'"))[0]),
  };
}
function requirePaused(row: Row): void {
  if (row.state !== 'paused') throw new Error('Pause capture admission before migrating');
}
function requireDrained(status: MigrationStatus): void {
  if (status.heldCaptures || status.runningAttempts) throw new Error('Wait for held captures and model attempts to drain');
}

export class SQLQuotaMigration {
  private run: RunTransaction;
  constructor(run: RunTransaction) { this.run = run; }
  status(): Promise<MigrationStatus> {
    return this.run((function* (): Transaction<MigrationStatus> { return yield* statusFor(yield* control()); })());
  }
  pause(compatibilityRelease: string): Promise<MigrationStatus> {
    if (!/^[a-f0-9]{64}$/.test(compatibilityRelease)) throw new Error('A compatible server artifact SHA-256 is required');
    return this.run((function* (): Transaction<MigrationStatus> {
      const row = yield* control(true);
      if (row.state === 'paused') {
        if (row.compatibility_release !== compatibilityRelease) throw new Error('Paused migration belongs to another compatible release');
        return yield* statusFor(row);
      }
      const now = new Date().toISOString();
      yield* query("UPDATE quota_migration_control SET state='paused',revision=revision+1,compatibility_release=?,updated_at=? WHERE id=1", compatibilityRelease, now);
      yield* query('UPDATE quota_migration_checkpoints SET validated_balance_version=NULL');
      const updated = yield* control(true);
      yield* query('INSERT INTO quota_migration_events(revision,state,compatibility_release,created_at) VALUES(?,?,?,?)', String(updated.revision), 'paused', compatibilityRelease, now);
      return yield* statusFor(updated);
    })());
  }
  /** Each batch is atomic; checkpoints, not a process cursor, make restarts safe. */
  backfill(limit = 100): Promise<{processed: number; status: MigrationStatus}> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Migration batch must be 1..500 devices');
    return this.run((function* (): Transaction<{processed: number; status: MigrationStatus}> {
      const state = yield* control(); requirePaused(state); requireDrained(yield* statusFor(state));
      const rows = yield* query(`SELECT d.id FROM devices d LEFT JOIN quota_migration_checkpoints c ON c.device_id=d.id
        WHERE c.device_id IS NULL OR c.validated_balance_version IS NULL OR c.validated_balance_version<>CAST(d.balance_version AS TEXT)
        ORDER BY d.id LIMIT ?`, limit);
      for (const row of rows) {
        const d = (yield* query('SELECT * FROM devices WHERE id=? FOR UPDATE', Number(row.id)))[0]!;
        yield* opening(d);
        const lot = (yield* query("SELECT lot_id FROM quota_lots WHERE device_id=? AND source_ref='opening_balance'", Number(d.id)))[0];
        yield* checkpointQuota(d, lot ? String(lot.lot_id) : null);
        yield* validateLedger(d);
        const checkpoint = (yield* query('SELECT * FROM quota_migration_checkpoints WHERE device_id=?', Number(d.id)))[0]!;
        const account = JSON.parse(String(checkpoint.account_snapshot)) as Row;
        if (account.token_hash !== d.token_hash || account.created_at !== canonical(d.created_at)) throw new Error('Migration account identity changed');
        const previous = JSON.parse(String(checkpoint.history_snapshot)) as HistorySnapshot;
        if (JSON.stringify(yield* history(Number(d.id), previous)) !== JSON.stringify(previous)) throw new Error('Migration historical records changed');
        yield* query('UPDATE quota_migration_checkpoints SET validated_balance_version=? WHERE device_id=?', String(d.balance_version), Number(d.id));
      }
      return {processed: rows.length, status: yield* statusFor(state)};
    })());
  }
  /** Operators can repeat full validation, including history changed without a balance write. */
  invalidateValidation(): Promise<void> {
    return this.run((function* (): Transaction<void> {
      const state = yield* control(true); requirePaused(state);
      yield* query('UPDATE quota_migration_checkpoints SET validated_balance_version=NULL');
    })());
  }
  resume(expectedRevision: string): Promise<MigrationStatus> {
    if (!/^\d{1,40}$/.test(expectedRevision)) throw new Error('Invalid migration revision');
    return this.run((function* (): Transaction<MigrationStatus> {
      const state = yield* control(true); requirePaused(state);
      if (String(state.revision) !== expectedRevision) throw new Error('Migration revision changed');
      const status = yield* statusFor(state); requireDrained(status);
      if (status.unvalidated || status.devices !== status.checkpointed) throw new Error('Validate every device before resuming');
      const now = new Date().toISOString();
      yield* query("UPDATE quota_migration_control SET state='active',revision=revision+1,updated_at=? WHERE id=1", now);
      const updated = yield* control(true);
      yield* query('INSERT INTO quota_migration_events(revision,state,compatibility_release,created_at) VALUES(?,?,?,?)', String(updated.revision), 'active', String(state.compatibility_release), now);
      return yield* statusFor(updated);
    })());
  }
}
