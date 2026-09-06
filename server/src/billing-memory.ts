import { combineAccountSnapshot, duplicateCapture, isRecoveredAnswerFor, newCapture, validQuestions, type AccountSnapshot, type Attempt, type BeginCapture, type BeginResult,
  type BillingStore, type CaptureRecord, type FinishCapture, type LotKind, type QuotaSnapshot } from './billing.ts';
import type { StoredUsageMetric } from './db.ts';
import { applyLotPolicy, type RefundLot, type RefundPolicy } from './payment-ledger.ts';
import { randomUUID } from 'node:crypto';
import { reportCapture, type ReportCapture, type ReportAttempt, type ReportLot } from './reporting.ts';

export interface MemoryQuotaDevice {
  id: number; balanceQuestions: number; totalQuestions: number; totalInputTokens: number;
  totalOutputTokens: number; updatedAt: string; cliEnabled: boolean;
}
interface Lot extends RefundLot { kind: LotKind; sourceRef?: string; id:string;granted:number;createdAt:string;revocations:Array<{at:string;delta:number}> }
function newLot(kind:LotKind,remaining:number,sourceRef?:string):Lot {
  return {kind,remaining,held:0,revoked:0,frozen:false,target:0,id:randomUUID(),granted:remaining,createdAt:new Date().toISOString(),revocations:[],...(sourceRef?{sourceRef}:{})};
}
interface State {
  version: bigint; policy: string; initial: number | null; lots: Lot[];
  captures: Map<string, { record: CaptureRecord; lot: Lot; legacy: boolean }>;
  attempts: Map<string, Attempt>;
}
export class MemoryBilling implements BillingStore {
  private states = new Map<number, State>();
  private devices = new Map<number, MemoryQuotaDevice>();
  private buckets = new Map<string, { count: number; end: number }>();
  private budgets = new Map<string, { limit: number; spent: number; held: number; end: number }>();
  private budgetHolds = new Map<string, { deviceId: number; key: string; reserved: number; state: 'held'|'released'|'settled' }>();
  private lookup: (token: string) => MemoryQuotaDevice | undefined;
  private usage: (event: StoredUsageMetric & { createdAt: string }) => void;
  constructor(lookup: (token: string) => MemoryQuotaDevice | undefined,
    usage: (event: StoredUsageMetric & { createdAt: string }) => void) { this.lookup = lookup; this.usage = usage; }
  register(d: MemoryQuotaDevice, policy: string, grant: number): void {
    this.devices.set(d.id,d);
    this.states.set(d.id, { version: 1n, policy, initial: grant,
      lots: [newLot('trial',grant)], captures: new Map(), attempts: new Map() });
  }
  private state(d: MemoryQuotaDevice): State {
    this.devices.set(d.id,d);
    let state = this.states.get(d.id);
    if (!state) {
      state = { version: 0n, policy: 'legacy', initial: null,
        lots: [newLot('legacy_unknown',d.balanceQuestions)], captures: new Map(), attempts: new Map() };
      this.states.set(d.id,state);
    }
    return state;
  }
  private snapshot(d: MemoryQuotaDevice): QuotaSnapshot {
    const state = this.state(d);
    const result: QuotaSnapshot = { balanceQuestions: d.balanceQuestions, balanceVersion: String(state.version),
      heldQuestions: 0, policyVersion: state.policy, initialGrantQuestions: state.initial,
      quotaBreakdown: { trial: 0, paid: 0, goodwill: 0, legacy_unknown: 0 } };
    for (const lot of state.lots) {
      result.heldQuestions += lot.held; result.quotaBreakdown[lot.kind] += lot.frozen?0:lot.remaining-lot.held;
    }
    return result;
  }
  async quota(token: string): Promise<QuotaSnapshot | null> { const d=this.lookup(token); return d ? this.snapshot(d) : null; }
  async accountSnapshot(token: string): Promise<AccountSnapshot | null> {
    const d = this.lookup(token);
    return d ? this.accountFor(d) : null;
  }
  private accountFor(d: MemoryQuotaDevice): AccountSnapshot {
    // No await: the device counters, permission and lot snapshot are copied in one turn.
    return combineAccountSnapshot(this.snapshot(d), {totalQuestions: d.totalQuestions,
      totalInputTokens: d.totalInputTokens, totalOutputTokens: d.totalOutputTokens, cliEnabled: d.cliEnabled});
  }
  credit(d: MemoryQuotaDevice, questions: number, kind: LotKind, sourceRef?:string): void {
    const state = this.state(d); state.lots.push(newLot(kind,questions,sourceRef)); state.version++;
    d.balanceQuestions += questions; d.updatedAt = new Date().toISOString();
  }
  refundPolicy(deviceId:number,reference:string,policy:RefundPolicy):void {
    const d=this.devices.get(deviceId); if(!d) throw new Error('Unknown payment device');
    const state=this.state(d),lot=state.lots.find(l=>l.sourceRef===reference);
    if(!lot) throw new Error('Payment quota source missing');
    const before=JSON.stringify(lot),change=applyLotPolicy(lot,policy.frozen,policy.revokeTarget);
    if(change.revokedDelta)lot.revocations.push({at:new Date().toISOString(),delta:change.revokedDelta});
    if(before!==JSON.stringify(lot)) {d.balanceQuestions+=change.availableDelta;state.version++;d.updatedAt=new Date().toISOString();}
  }
  async creditDevice(deviceId:number,input:{questions:number;amountCents:number;currency:string;provider:string;reference:string;note?:string}):Promise<number|null> {
    const d=this.devices.get(deviceId); if(!d) return null; validQuestions(input.questions); return (this.credit(d,input.questions,input.amountCents>0?'paid':'goodwill'),d.balanceQuestions);
  }
  async capture(token: string, captureId: string): Promise<CaptureRecord | null> {
    const d = this.lookup(token), record = d ? this.state(d).captures.get(captureId)?.record : null;
    if (record && Date.now() - Date.parse(record.createdAt) >= 900_000 && record.answerHmac !== null) {
      record.answerHmac = null;
    }
    return record ? { ...record } : null;
  }
  async begin(input: BeginCapture): Promise<BeginResult> {
    const d = this.lookup(input.token); if (!d) return { ok: false, reason: 'unknown_token' };
    const state = this.state(d), previous = state.captures.get(input.captureId);
    if (previous) return duplicateCapture(previous.record,input);
    if (input.exclusive && [...state.captures.values()].some(c => c.record.settlementStatus === 'held')) return { ok: false, reason: 'device_busy' };
    if (input.operation && input.operation !== 'solve') {
      const parent = input.parentCaptureId ? state.captures.get(input.parentCaptureId)?.record : null;
      if (!parent || parent.operation !== 'solve' || parent.settlementStatus !== 'settled' || !parent.usableResult ||
          Date.now() - Date.parse(parent.createdAt) >= 900_000) return { ok: false, reason: 'idempotency_conflict' };
      if (input.answerCaptureId && input.answerCaptureId !== parent.captureId) {
        const answer = state.captures.get(input.answerCaptureId)?.record;
        if (input.operation !== 'explain' || !answer || !isRecoveredAnswerFor(parent, answer)) {
          return {ok: false, reason: 'idempotency_conflict'};
        }
      }
      const property = input.operation === 'explain' ? 'explanationCaptureId' : 'recoveryCaptureId';
      if (parent[property]) return { ok: false, reason: 'capture_already_finalized' };
      const record = newCapture(input);
      parent[property] = record.captureId;
      state.captures.set(record.captureId,{record,lot:newLot('trial',0),legacy:false});
      return {ok:true,capture:{...record},quota:this.snapshot(d)};
    }
    if (d.balanceQuestions < 1) return { ok: false, reason: 'insufficient_quota' };
    const priority: LotKind[] = ['trial','legacy_unknown','goodwill','paid'];
    const lot = priority.flatMap(kind => state.lots.filter(l => l.kind===kind && !l.frozen && l.remaining>l.held))[0];
    if (!lot) throw new Error('Quota source unavailable');
    const record = newCapture(input);
    state.captures.set(record.captureId,{record,lot,legacy:input.legacy??false});
    lot.held++; d.balanceQuestions--; state.version++; d.updatedAt=record.createdAt;
    return { ok:true,capture:{...record},quota:this.snapshot(d) };
  }
  private finishDevice(d: MemoryQuotaDevice, input: FinishCapture): void {
    const state=this.state(d);
    const capture = input.captureId ? state.captures.get(input.captureId)
      : [...state.captures.values()].find(c => c.legacy && c.record.settlementStatus==='held');
    if (!capture || capture.record.settlementStatus!=='held') return;
    if (capture.record.operation !== 'solve') {
      capture.record.settlementStatus = 'released'; capture.record.terminalState = input.terminalState;
      capture.record.finishedAt = new Date().toISOString();
      capture.record.terminalReason = input.terminalReason ?? null;
      capture.record.usableResult = input.terminalState === 'usable';
      capture.record.answerHmac = capture.record.usableResult ? input.answerHmac ?? null : null;
      capture.record.resultState = input.resultState ?? null; capture.record.questionKind = input.questionKind ?? null;
      capture.record.parserPath = input.parserPath ?? null;
      if (capture.record.operation === 'recover' && input.compensateGoodwill && capture.record.parentCaptureId) {
        this.credit(d, 1, 'goodwill');
      }
      return;
    }
    const now=new Date().toISOString(), charge=input.charge && capture.record.expiresAt>now;
    capture.record={...capture.record,settlementStatus:charge?'settled':'released',
      terminalState:input.charge&&!charge?'failed':input.terminalState,usableResult:charge&&input.terminalState==='usable',
      answerHmac:charge?input.answerHmac??null:null,resultState:input.resultState??null,
      questionKind:input.questionKind??null,parserPath:input.parserPath??null,
      terminalReason:input.terminalReason??null,finishedAt:now};
    capture.lot.held--; if(charge) { capture.lot.remaining--; d.totalQuestions++; } else if(!capture.lot.frozen) d.balanceQuestions++;
    const refundChange=applyLotPolicy(capture.lot,capture.lot.frozen,capture.lot.target);
    if(refundChange.revokedDelta)capture.lot.revocations.push({at:now,delta:refundChange.revokedDelta});
    d.balanceQuestions+=refundChange.availableDelta;
    state.version++; d.totalInputTokens+=input.inputTokens??0; d.totalOutputTokens+=input.outputTokens??0; d.updatedAt=now;
    this.usage({deviceId:d.id,captureId:input.usageCaptureId??capture.record.captureId,inputTokens:input.inputTokens??0,
      outputTokens:input.outputTokens??0,questions:charge?1:0,estimatedCostMicros:input.estimatedCostMicros??null,createdAt:now});
  }
  async finish(input:FinishCapture):Promise<AccountSnapshot|null> {
    const d=this.lookup(input.token); if(!d) return null;
    this.finishDevice(d,input); return this.accountFor(d);
  }
  async reap(now=new Date().toISOString()):Promise<number> {
    let count=0;
    for(const [id,state] of this.states) for(const {record} of state.captures.values()) {
      if(count>=100) break;
      if(record.settlementStatus==='held' && record.expiresAt<=now) {
        this.finishDevice(this.devices.get(id)!,{token:'',captureId:record.captureId,charge:false,terminalState:'failed',
          terminalReason:'lease_expired',compensateGoodwill:record.operation==='recover'}); count++;
      }
    }
    for (const state of this.states.values()) {
      for (const attempt of state.attempts.values()) {
        if (attempt.status === 'running') {
          const capture = state.captures.get(attempt.captureId)?.record;
          if (capture && capture.expiresAt <= now) {
            attempt.status = 'unknown'; attempt.inputTokens = null; attempt.outputTokens = null; attempt.costMicros = null; attempt.finishedAt = now;
          }
        }
      }
    }
    for(const [key,bucket] of this.buckets) if(bucket.end<Date.parse(now)) this.buckets.delete(key);
    return count;
  }
  async startAttempt(token:string,input:Omit<Attempt,'status'|'inputTokens'|'outputTokens'|'costMicros'|'startedAt'|'finishedAt'>):Promise<boolean> {
    const d=this.lookup(token); if(!d) return false;
    const state=this.state(d),capture=state.captures.get(input.captureId);
    if(!capture || capture.record.settlementStatus!=='held' || [...state.attempts.values()].some(a=>a.captureId===input.captureId)) return false;
    state.attempts.set(input.attemptId,{...input,status:'running',inputTokens:null,outputTokens:null,costMicros:null,startedAt:new Date().toISOString(),finishedAt:null}); return true;
  }
  async finishAttempt(token:string,id:string,input:Pick<Attempt,'status'|'inputTokens'|'outputTokens'|'costMicros'>):Promise<void> {
    const d=this.lookup(token); if(!d) return;
    const state=this.state(d),old=state.attempts.get(id);
    if(old?.status==='running') state.attempts.set(id,{...old,...input,finishedAt:new Date().toISOString()});
  }
  async reserveBudget(token:string,attemptId:string,scope:string,currency:string,reservedUpperMicros:number,limitMicros:number,windowMs=86_400_000,now=Date.now()):Promise<boolean> {
    const d = this.lookup(token); if (!d) return false;
    if (limitMicros<=0 || reservedUpperMicros<=0) return true;
    const start=Math.floor(now/windowMs)*windowMs,key=`${scope}:${start}:${currency}`,existing=this.budgetHolds.get(attemptId);
    if (existing) return existing.deviceId===d.id && (existing.state==='held'||existing.state==='settled');
    const budget=this.budgets.get(key)??{limit:limitMicros,spent:0,held:0,end:start+windowMs};
    if (budget.spent+budget.held+reservedUpperMicros>budget.limit) return false;
    budget.held+=reservedUpperMicros; this.budgets.set(key,budget); this.budgetHolds.set(attemptId,{deviceId:d.id,key,reserved:reservedUpperMicros,state:'held'}); return true;
  }
  async releaseBudget(token:string,attemptId:string):Promise<void> {
    const d=this.lookup(token); if (!d) return; const hold=this.budgetHolds.get(attemptId); if (!hold||hold.deviceId!==d.id||hold.state!=='held') return;
    const budget=this.budgets.get(hold.key); if (budget) budget.held=Math.max(0,budget.held-hold.reserved); hold.state='released';
  }
  async settleBudget(token:string,attemptId:string,actualMicros:number|null):Promise<void> {
    const d=this.lookup(token); if (!d) return; const hold=this.budgetHolds.get(attemptId); if (!hold||hold.deviceId!==d.id||hold.state!=='held') return;
    // An underestimated hold must never erase real spend. Accounting the entire overrun
    // also prevents the next reservation from spending the apparently unused difference.
    const budget=this.budgets.get(hold.key); if (!budget) return; const actual=actualMicros===null||!Number.isSafeInteger(actualMicros)||actualMicros<0?hold.reserved:actualMicros;
    budget.held=Math.max(0,budget.held-hold.reserved); budget.spent+=actual; hold.state='settled';
  }
  async attempts(token:string):Promise<Attempt[]> {
    const d=this.lookup(token); return d?[...this.state(d).attempts.values()].map(a=>({...a})):[];
  }
  report(ids:Set<number>,asOf:string):{captures:ReportCapture[];attempts:ReportAttempt[];lots:ReportLot[];policies:Map<number,string>} {
    const captures:ReportCapture[]=[],attempts:ReportAttempt[]=[],lots:ReportLot[]=[],policies=new Map<number,string>();
    for(const [id,state] of this.states){
      if(!ids.has(id))continue;policies.set(id,state.policy);
      const rows=[...state.captures.values()].filter(c=>c.record.createdAt<=asOf);
      for(const c of rows)captures.push({deviceId:id,quotaKind:c.record.operation==='solve'?c.lot.kind:null,record:reportCapture(c.record,asOf)});
      for(const a of state.attempts.values())if(a.startedAt<=asOf){
        const finished=a.finishedAt!==null&&a.finishedAt<=asOf,hold=this.budgetHolds.get(a.attemptId);
        attempts.push({id:a.attemptId,deviceId:id,captureId:a.captureId,purpose:a.purpose,currency:a.currency,
          costMicros:finished?a.costMicros:null,upperMicros:hold?String(hold.reserved):null,revision:finished?'2':'1',pricingVersion:a.pricingVersion,
          startedAt:a.startedAt,calculatedAt:finished?a.finishedAt!:a.startedAt,status:finished?a.status:'running'});
      }
      for(const l of state.lots)if(l.createdAt<=asOf){
        const related=rows.filter(c=>c.lot===l&&c.record.operation==='solve');
        const consumed=related.filter(c=>c.record.settlementStatus==='settled'&&c.record.finishedAt!==null&&c.record.finishedAt<=asOf).length;
        const held=related.filter(c=>c.record.finishedAt===null||c.record.finishedAt>asOf).length;
        const revoked=l.revocations.filter(r=>r.at<=asOf).reduce((s,r)=>s+r.delta,0);
        lots.push({id:l.id,deviceId:id,kind:l.kind,granted:String(l.granted),remaining:String(l.granted-consumed-revoked),held:String(held),revoked:String(revoked),
          createdAt:l.createdAt,sourceRef:l.sourceRef??(l.kind==='trial'?'initial_trial':'opening_balance')});
      }
    }
    return {captures,attempts,lots,policies};
  }
  async rateLimit(scope:string,limit:number,windowMs:number,now=Date.now()):Promise<boolean> {
    if(limit<=0) return true;
    const start=Math.floor(now/windowMs)*windowMs,key=scope+':'+start;
    const bucket=this.buckets.get(key)??{count:0,end:start+windowMs}; bucket.count++; this.buckets.set(key,bucket); return bucket.count<=limit;
  }
}
