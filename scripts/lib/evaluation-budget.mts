import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface EvaluationPolicy {
  schema_version: 1;
  campaign_id: string;
  currency: 'CNY';
  limit_micros: number;
}

/** A dated, reviewed bound for one specific candidate. No inferred exchange rates or prices. */
export interface EvaluationCallBound {
  schema_version: 1;
  model: string;
  base_url: string;
  billing_currency: 'CNY' | 'USD';
  input_micros_per_million: number;
  output_micros_per_million: number;
  input_token_upper: number;
  output_token_upper: number;
  cny_micros_per_currency_unit: number;
  pricing_source: string;
  currency_evidence: string;
  bounds_evidence: string;
  exchange_rate_evidence?: string;
  verified_at: string;
  expires_at: string;
}

function integer(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive safe integer`);
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error(`${label} is missing or too long`);
}
function candidateURL(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Evaluation candidate must use HTTPS or loopback HTTP, without URL credentials');
  }
  return url.href.replace(/\/+$/u, '');
}

export function validateEvaluationPolicy(policy: EvaluationPolicy): void {
  if (policy.schema_version !== 1 || policy.currency !== 'CNY') throw new Error('Evaluation budget must use schema 1 and CNY');
  nonempty(policy.campaign_id, 'campaign_id');
  integer(policy.limit_micros, 'limit_micros');
}

export function callUpperCNY(bound: EvaluationCallBound, model: string, baseURL: string, now = Date.now()): number {
  if (bound.schema_version !== 1 || !['CNY', 'USD'].includes(bound.billing_currency)) throw new Error('Unsupported evaluation bound');
  nonempty(bound.model, 'model');
  if (bound.model !== model || candidateURL(bound.base_url) !== candidateURL(baseURL)) throw new Error('Evaluation model/candidate does not match its cost bound');
  for (const key of ['input_micros_per_million', 'output_micros_per_million', 'input_token_upper',
    'output_token_upper', 'cny_micros_per_currency_unit'] as const) integer(bound[key], key);
  for (const key of ['pricing_source', 'currency_evidence', 'bounds_evidence'] as const) nonempty(bound[key], key);
  if (new URL(bound.pricing_source).protocol !== 'https:') throw new Error('Pricing evidence requires an HTTPS source');
  if (bound.billing_currency === 'CNY' && bound.cny_micros_per_currency_unit !== 1_000_000) throw new Error('CNY must not be converted');
  if (bound.billing_currency !== 'CNY') nonempty(bound.exchange_rate_evidence, 'exchange_rate_evidence');
  const verified = Date.parse(bound.verified_at), expires = Date.parse(bound.expires_at);
  if (!Number.isFinite(verified) || !Number.isFinite(expires) || verified > now || expires <= now ||
      expires <= verified || expires - verified > 86_400_000) throw new Error('Evaluation pricing/bounds need verification within the last 24 hours');
  // All quantities are integral; round upward only after converting to CNY micros.
  const numerator = (BigInt(bound.input_token_upper) * BigInt(bound.input_micros_per_million) +
    BigInt(bound.output_token_upper) * BigInt(bound.output_micros_per_million)) * BigInt(bound.cny_micros_per_currency_unit);
  const result = Number((numerator + 999_999_999_999n) / 1_000_000_000_000n);
  integer(result, 'call_upper_cny_micros');
  return result;
}

/**
 * Local campaign ledger shared by all runs. Every dispatched call consumes its full reviewed
 * upper bound, including timeouts and crashes. Observed usage never creates a fresh allowance.
 * This is a conservative spend ceiling, separate from the server's actual-cost ledger.
 */
export class EvaluationBudget {
  private readonly db: DatabaseSync;
  private readonly policy: EvaluationPolicy;
  private readonly bound: EvaluationCallBound;
  private readonly boundHash: string;
  private readonly model: string;
  private readonly baseURL: string;

  constructor(path: string, policy: EvaluationPolicy, bound: EvaluationCallBound, model: string, baseURL: string) {
    validateEvaluationPolicy(policy);
    callUpperCNY(bound, model, baseURL);
    this.policy = structuredClone(policy);
    this.bound = structuredClone(bound);
    this.model = model;
    this.baseURL = candidateURL(baseURL);
    this.boundHash = createHash('sha256').update(JSON.stringify(bound)).digest('hex');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS evaluation_campaigns (
          id TEXT PRIMARY KEY, currency TEXT NOT NULL, limit_micros INTEGER NOT NULL, halted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS evaluation_dispatches (
          id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, bound_sha256 TEXT NOT NULL,
          model TEXT NOT NULL, fixture_id TEXT NOT NULL, purpose TEXT NOT NULL,
          upper_cny_micros INTEGER NOT NULL CHECK(upper_cny_micros>0),
          outcome TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT NOT NULL);`);
      this.db.prepare('INSERT INTO evaluation_campaigns(id,currency,limit_micros) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING')
        .run(policy.campaign_id, policy.currency, policy.limit_micros);
      const row = this.db.prepare('SELECT currency,limit_micros FROM evaluation_campaigns WHERE id=?').get(policy.campaign_id)!;
      if (row.currency !== policy.currency || row.limit_micros !== policy.limit_micros) throw new Error('Existing evaluation campaign budget cannot be reset or increased');
    } catch (error) { this.db.close(); throw error; }
  }

  remainingMicros(): number {
    if (this.db.prepare('SELECT halted FROM evaluation_campaigns WHERE id=?').get(this.policy.campaign_id)!.halted) return 0;
    const row = this.db.prepare(`SELECT COALESCE(SUM(upper_cny_micros),0) AS consumed
      FROM evaluation_dispatches WHERE campaign_id=?`).get(this.policy.campaign_id)!;
    return Math.max(0, this.policy.limit_micros - Number(row.consumed));
  }

  checkWholeRun(calls: number): { calls: number; upper_cny_micros: number; remaining_cny_micros: number } {
    integer(calls, 'calls');
    const upper = callUpperCNY(this.bound, this.model, this.baseURL);
    const required = BigInt(upper) * BigInt(calls);
    const remaining = this.remainingMicros();
    this.assertActive();
    if (required > BigInt(remaining)) throw new Error(`Entire evaluation exceeds remaining CNY budget (${remaining / 1_000_000} yuan)`);
    return { calls, upper_cny_micros: Number(required), remaining_cny_micros: remaining };
  }

  reserve(id: string, fixture: string, purpose: 'answer' | 'baseline' | 'explain' | 'recover'): number {
    nonempty(id, 'dispatch id'); nonempty(fixture, 'fixture id');
    const upper = callUpperCNY(this.bound, this.model, this.baseURL);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertActive();
      if (this.db.prepare('SELECT id FROM evaluation_dispatches WHERE id=?').get(id)) throw new Error('Evaluation dispatch already reserved; automatic retries are prohibited');
      if (this.remainingMicros() < upper) throw new Error('Evaluation CNY budget exhausted');
      this.db.prepare(`INSERT INTO evaluation_dispatches
        (id,campaign_id,bound_sha256,model,fixture_id,purpose,upper_cny_micros,outcome,created_at)
        VALUES (?,?,?,?,?,?,?,'unknown',?)`).run(id, this.policy.campaign_id, this.boundHash, this.model, fixture, purpose, upper, new Date().toISOString());
      this.db.exec('COMMIT');
      return upper;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private assertActive(): void {
    if (this.db.prepare('SELECT halted FROM evaluation_campaigns WHERE id=?').get(this.policy.campaign_id)!.halted) {
      throw new Error('Evaluation campaign halted after a cost-bound violation');
    }
  }

  observeUsage(id: string, input: unknown, output: unknown): void {
    if (!this.db.prepare('SELECT id FROM evaluation_dispatches WHERE id=? AND campaign_id=?').get(id, this.policy.campaign_id)) throw new Error('Unknown evaluation dispatch');
    // Missing, malformed and failed usage retains the entire bound. Do not interpret it as zero.
    if (typeof input !== 'number' || typeof output !== 'number' || !Number.isSafeInteger(input) ||
        !Number.isSafeInteger(output) || input < 0 || output < 0) return;
    if (input > this.bound.input_token_upper || output > this.bound.output_token_upper) {
      // Keep the evidence of an invalid bound. Never cap the observed token counts.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('UPDATE evaluation_dispatches SET outcome=?,input_tokens=?,output_tokens=? WHERE id=?')
          .run('bound_violated', input, output, id);
        this.db.prepare('UPDATE evaluation_campaigns SET halted=1 WHERE id=?').run(this.policy.campaign_id);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      throw new Error('Provider usage exceeded the reviewed token bound; campaign stopped for cost reconciliation');
    }
    this.db.prepare('UPDATE evaluation_dispatches SET input_tokens=?,output_tokens=? WHERE id=?').run(input, output, id);
  }

  dispatchEvidence(id: string): {id:string;upperCNYMicros:number;outcome:string}|null {
    const row=this.db.prepare('SELECT id,upper_cny_micros,outcome FROM evaluation_dispatches WHERE id=? AND campaign_id=?').get(id,this.policy.campaign_id);
    return row?{id:String(row.id),upperCNYMicros:Number(row.upper_cny_micros),outcome:String(row.outcome)}:null;
  }
  candidateIdentity(): {model:string;baseURL:string} {return {model:this.model,baseURL:this.baseURL};}
  costEvidence(): {policy:EvaluationPolicy;bound:EvaluationCallBound} {return {policy:structuredClone(this.policy),bound:structuredClone(this.bound)};}

  async fetchText(path: string, init: RequestInit, fixture: string, purpose: 'answer' | 'baseline' | 'explain' | 'recover', id: string = randomUUID()) {
    if (!/^\/v1\/captures(?:\/[0-9a-f-]+\/(?:explanation|recovery))?$/u.test(path) || init.method !== 'POST') {
      throw new Error('Unexpected evaluation endpoint');
    }
    const upper = this.reserve(id, fixture, purpose);
    // No redirect following, retry, or automatic release: the vendor may bill a lost response.
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000);
    const response = await fetch(`${this.baseURL}${path}`, { ...init, signal, redirect: 'error' });
    let body = '';
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', {fatal:true});
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Evaluation response exceeds 2 MiB'); }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } catch(error) {await reader.cancel().catch(()=>{});throw error;} finally { reader.releaseLock(); }
    }
    this.db.prepare('UPDATE evaluation_dispatches SET outcome=? WHERE id=? AND campaign_id=?')
      .run(response.ok ? 'response_received' : 'http_error', id, this.policy.campaign_id);
    return { body, ok: response.ok, status: response.status, contentType:response.headers.get('content-type'), dispatchId: id, upperCNYMicros: upper };
  }

  close(): void { this.db.close(); }
}

export function openEvaluationBudget(root: string, model: string, baseURL: string): EvaluationBudget {
  const policy = JSON.parse(readFileSync(resolve(root, 'docs/evaluation-budget.json'), 'utf8')) as EvaluationPolicy;
  const path = process.env.NSPI_EVAL_COST_BOUND;
  if (!path) throw new Error('NSPI_EVAL_COST_BOUND is required: verify candidate token limits, provider currency and dated prices before paid evaluation');
  const bound = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as EvaluationCallBound;
  return new EvaluationBudget(resolve(root, '.eval-results/budget-ledger.sqlite3'), policy, bound, model, baseURL);
}
