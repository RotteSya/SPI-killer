import { randomUUID } from 'node:crypto';
import { hashToken } from './db.ts';
import { query, ledger, opening, type Row, type Transaction, type RunTransaction } from './billing-sql.ts';
import {purchaseFromRow} from './purchase-session-sql.ts';
import {validatePurchaseOrder} from './purchase-session.ts';
import {SQLCheckoutQueue,CHECKOUT_SCHEMA} from './checkout-sql.ts';
import { applyLotPolicy, refundPolicy, sameOrder, sameRefundIdentity, validDecision, validateEvent, validateOrder,
  validateRefund, type PaymentEvent, type PaidOrderInput, type PaymentOrder, type PaymentLedger,
  type PaymentReport, type RefundClaim, type RefundDecision, type RefundLot, type RefundSnapshot } from './payment-ledger.ts';

export const PAYMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS payment_processing_lock (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO payment_processing_lock(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS payment_orders (
 reference TEXT PRIMARY KEY, device_id BIGINT NOT NULL REFERENCES devices(id),
 payment_intent_id TEXT UNIQUE, charge_id TEXT UNIQUE, lot_id TEXT UNIQUE REFERENCES quota_lots(lot_id),
 metadata TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_refunds (
 refund_id TEXT PRIMARY KEY, generation BIGINT NOT NULL DEFAULT 0, metadata TEXT,
 payment_intent_id TEXT, charge_id TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_refund_revisions (
 refund_id TEXT NOT NULL REFERENCES payment_refunds(refund_id), generation BIGINT NOT NULL,
 provider_event_id TEXT NOT NULL REFERENCES webhook_inbox(provider_event_id), metadata TEXT NOT NULL,
 recorded_at TEXT NOT NULL, PRIMARY KEY(refund_id,generation)
);
CREATE TABLE IF NOT EXISTS payment_quota_changes (
 change_id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES quota_lots(lot_id),
 before_state TEXT NOT NULL, after_state TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_refund_decisions (
 decision_ref TEXT PRIMARY KEY, order_reference TEXT NOT NULL REFERENCES payment_orders(reference),
 fingerprint TEXT NOT NULL, questions BIGINT NOT NULL CHECK(questions>=0), created_at TEXT NOT NULL
);
${CHECKOUT_SCHEMA}
`;

export function* lockPayments(): Transaction<void> { yield* query('SELECT id FROM payment_processing_lock WHERE id=1 FOR UPDATE'); }
function eventFromRow(row: Row): PaymentEvent {
  return { id: String(row.provider_event_id), type: String(row.event_type), resourceId: String(row.resource_id),
    createdAt: row.event_created_at === null ? null : new Date(String(row.event_created_at)).toISOString(), payloadHash: String(row.payload_hash) };
}
export function* receipt(event: PaymentEvent): Transaction<Row> {
  validateEvent(event);
  yield* query(`INSERT INTO webhook_inbox(provider_event_id,event_type,resource_id,event_created_at,received_at,processing_state,payload_hash)
    VALUES(?,?,?,?,?,'received',?) ON CONFLICT(provider_event_id) DO NOTHING`, event.id,event.type,event.resourceId,event.createdAt,new Date().toISOString(),event.payloadHash);
  const row = (yield* query('SELECT * FROM webhook_inbox WHERE provider_event_id=? FOR UPDATE',event.id))[0]!;
  // Pre-upgrade receipts had no payload hash and never controlled effects. Adopt their first
  // signed replay; existing topup references still prevent an additional quota grant.
  if (row.payload_hash === null) yield* query('UPDATE webhook_inbox SET payload_hash=? WHERE provider_event_id=?',event.payloadHash,event.id);
  if ((row.payload_hash !== null && row.payload_hash !== event.payloadHash) || row.event_type !== event.type || row.resource_id !== event.resourceId) {
    throw new Error('Payment event identity conflict');
  }
  return row;
}
function* refunds(order:PaidOrderInput): Transaction<RefundSnapshot[]> {
  const rows = yield* query('SELECT metadata FROM payment_refunds WHERE metadata IS NOT NULL AND (payment_intent_id=? OR charge_id=?)',order.paymentIntentId,order.chargeId);
  return rows.map(row => JSON.parse(String(row.metadata)) as RefundSnapshot);
}

export function* applyRefundLot(lotId: string, frozen?: boolean, target?: number): Transaction<void> {
  const row = (yield* query('SELECT * FROM quota_lots WHERE lot_id=?',lotId))[0]!;
  const before: RefundLot = { remaining:Number(row.remaining),held:Number(row.held),revoked:Number(row.refund_revoked),
    frozen:Number(row.refund_frozen)===1,target:Number(row.refund_target) };
  const after = { ...before };
  const change = applyLotPolicy(after,frozen??before.frozen,target??before.target);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const id = randomUUID(), now = new Date().toISOString();
  yield* query('UPDATE quota_lots SET remaining=?,refund_revoked=?,refund_frozen=?,refund_target=? WHERE lot_id=?',
    after.remaining,after.revoked,after.frozen?1:0,after.target,lotId);
  yield* query('UPDATE devices SET balance_questions=balance_questions+?,balance_version=balance_version+1,updated_at=? WHERE id=?',change.availableDelta,now,Number(row.device_id));
  yield* ledger(Number(row.device_id),lotId,change.revokedDelta>0?'revoke':change.revokedDelta<0?'credit':after.frozen?'hold':'release',change.availableDelta,0,'refund-policy:'+id);
  yield* query('INSERT INTO payment_quota_changes(change_id,lot_id,before_state,after_state,created_at) VALUES(?,?,?,?,?)',id,lotId,JSON.stringify(before),JSON.stringify(after),now);
}
function* refreshOrder(row: Row, snapshots: RefundSnapshot[]): Transaction<PaymentOrder> {
  const order = JSON.parse(String(row.metadata)) as PaymentOrder;
  order.policy = refundPolicy(order,snapshots,order.decision);
  if(row.lot_id===null) order.policy={...order.policy,review:'integrity',frozen:false,revokeTarget:0};
  else yield* applyRefundLot(String(row.lot_id),order.policy.frozen,order.policy.revokeTarget);
  yield* query('UPDATE payment_orders SET metadata=? WHERE reference=?',JSON.stringify(order),order.reference);
  return order;
}

export function* creditPaidOrder(event:PaymentEvent,input:PaidOrderInput):Transaction<number|null>{
  validateOrder(input);validateEvent(event);
  if(event.resourceId!==input.reference)throw new Error('Payment resource mismatch');
      yield* receipt(event);
      const d = (input.token
        ? yield* query('SELECT * FROM devices WHERE token_hash=? FOR UPDATE',hashToken(input.token))
        : yield* query('SELECT * FROM devices WHERE id=? FOR UPDATE',input.deviceId??-1))[0];
      if (!d) return null;
      const deviceId = Number(d.id);
      if(input.purchaseSessionId){const purchase=(yield* query('SELECT * FROM purchase_sessions WHERE session_id=? FOR UPDATE',input.purchaseSessionId))[0];
        validatePurchaseOrder(purchase?purchaseFromRow(purchase):null,input,deviceId);}
      yield* opening(d);
      let row = (yield* query('SELECT * FROM payment_orders WHERE reference=?',input.reference))[0];
      if (row) {
        if (!sameOrder(JSON.parse(String(row.metadata)) as PaymentOrder,input,deviceId)) throw new Error('Paid order identity conflict');
        if(input.purchaseSessionId){const metadata=JSON.parse(String(row.metadata)) as PaymentOrder;
          metadata.purchaseSessionId??=input.purchaseSessionId;row.metadata=JSON.stringify(metadata);}
      } else {
        const now = new Date().toISOString();
        const inserted = yield* query(`INSERT INTO topups(device_id,questions,amount_cents,currency,provider,reference,created_at)
          VALUES(?,?,?,?,'stripe',?,?) ON CONFLICT(reference) DO NOTHING RETURNING id`,deviceId,input.questions,input.amountCents,input.currency,input.reference,now);
        let lotId: string | null;
        if (inserted.length) {
          lotId=randomUUID();
          yield* query(`INSERT INTO quota_lots(lot_id,device_id,kind,granted,remaining,source_ref,created_at) VALUES(?,?,'paid',?,?,?,?)`,lotId,deviceId,input.questions,input.questions,'credit:'+input.reference,now);
          yield* query('UPDATE devices SET balance_questions=balance_questions+?,balance_version=balance_version+1,updated_at=? WHERE id=?',input.questions,now,deviceId);
          yield* ledger(deviceId,lotId,'credit',input.questions,0,'credit:'+input.reference);
        } else {
          const topup=(yield* query('SELECT * FROM topups WHERE reference=?',input.reference))[0]!;
          if(Number(topup.device_id)!==deviceId || Number(topup.questions)!==input.questions || Number(topup.amount_cents)!==input.amountCents || String(topup.currency).toUpperCase()!==input.currency) throw new Error('Existing payment identity conflict');
          const lot=(yield* query('SELECT lot_id FROM quota_lots WHERE device_id=? AND source_ref=?',deviceId,'credit:'+input.reference))[0];
          // An older aggregate balance cannot be attributed retroactively to a paid lot.
          // Keep the legacy balance intact and require an explicit migration decision.
          lotId=lot?String(lot.lot_id):null;
        }
        const { token: _token, deviceId: _deviceId, ...snapshot }=input;
        const order:PaymentOrder={...snapshot,deviceId,decision:null,policy:refundPolicy(input,[],null),quotaAttribution:lotId?'paid_lot':'legacy_unknown'};
        yield* query('INSERT INTO payment_orders(reference,device_id,payment_intent_id,charge_id,lot_id,metadata,created_at) VALUES(?,?,?,?,?,?,?)',
          input.reference,deviceId,input.paymentIntentId,input.chargeId,lotId,JSON.stringify(order),now);
        row=(yield* query('SELECT * FROM payment_orders WHERE reference=?',input.reference))[0]!;
      }
      yield* refreshOrder(row,yield* refunds(input));
      if(input.purchaseSessionId)yield* query('UPDATE purchase_sessions SET consumed_at=COALESCE(consumed_at,?) WHERE session_id=?',new Date().toISOString(),input.purchaseSessionId);
      yield* query("UPDATE webhook_inbox SET processing_state='processed' WHERE provider_event_id=?",event.id);
      return Number((yield* query('SELECT balance_questions FROM devices WHERE id=?',deviceId))[0]!.balance_questions);
}

export class SQLPaymentLedger implements PaymentLedger {
  private run: RunTransaction;
  readonly checkouts:SQLCheckoutQueue;
  constructor(run: RunTransaction) { this.run=run;this.checkouts=new SQLCheckoutQueue(run); }
  acknowledge(event: PaymentEvent): Promise<void> {
    return this.run((function* (): Transaction<void> {
      yield* lockPayments(); yield* receipt(event);
      yield* query("UPDATE webhook_inbox SET processing_state='processed' WHERE provider_event_id=?",event.id);
    })());
  }
  pay(event:PaymentEvent,input:PaidOrderInput):Promise<number|null>{
    return this.run((function*():Transaction<number|null>{yield* lockPayments();return yield* creditPaidOrder(event,input);})());
  }
  queueRefunds(events:PaymentEvent[]):Promise<void>{
    if(events.length>100)throw new Error('Too many refund rechecks');
    for(const event of events){validateEvent(event);if(!/^re_[A-Za-z0-9_]{1,160}$/.test(event.resourceId))throw new Error('Invalid refund id');}
    return this.run((function*():Transaction<void>{yield* lockPayments();for(const event of events)yield* receipt(event);})());
  }
  claimRefund(event: PaymentEvent): Promise<RefundClaim | null> {
    if (!/^re_[A-Za-z0-9_]{1,160}$/.test(event.resourceId)) throw new Error('Invalid refund id');
    return this.run((function* (): Transaction<RefundClaim | null> {
      yield* lockPayments(); const row=yield* receipt(event);
      if(row.processing_state==='processed') return null;
      const now=Date.now();
      const updated=yield* query(`INSERT INTO payment_refunds(refund_id,generation,updated_at) VALUES(?,1,?)
        ON CONFLICT(refund_id) DO UPDATE SET generation=payment_refunds.generation+1,updated_at=excluded.updated_at RETURNING generation`,event.resourceId,new Date(now).toISOString());
      const generation=String(updated[0]!.generation);
      yield* query("UPDATE webhook_inbox SET processing_state='processing',resource_generation=?,retry_after=? WHERE provider_event_id=?",generation,new Date(now+60_000).toISOString(),event.id);
      return {event,generation};
    })());
  }
  applyRefund(claim: RefundClaim, snapshot: RefundSnapshot): Promise<boolean> {
    validateRefund(snapshot);
    if(snapshot.id!==claim.event.resourceId) throw new Error('Refund resource mismatch');
    return this.run((function* (): Transaction<boolean> {
      yield* lockPayments();
      const row=(yield* query('SELECT generation,metadata FROM payment_refunds WHERE refund_id=?',snapshot.id))[0];
      const inbox=(yield* query('SELECT processing_state,resource_generation FROM webhook_inbox WHERE provider_event_id=?',claim.event.id))[0];
      if(!row || String(row.generation)!==claim.generation || inbox?.processing_state!=='processing' || String(inbox.resource_generation)!==claim.generation) return false;
      if(row.metadata!==null&&!sameRefundIdentity(JSON.parse(String(row.metadata)) as RefundSnapshot,snapshot)) throw new Error('Refund financial identity conflict');
      const now=new Date().toISOString();
      yield* query('UPDATE payment_refunds SET metadata=?,payment_intent_id=?,charge_id=?,updated_at=? WHERE refund_id=?',JSON.stringify(snapshot),snapshot.paymentIntentId,snapshot.chargeId,now,snapshot.id);
      yield* query('INSERT INTO payment_refund_revisions(refund_id,generation,provider_event_id,metadata,recorded_at) VALUES(?,?,?,?,?)',snapshot.id,claim.generation,claim.event.id,JSON.stringify(snapshot),now);
      const orders=yield* query('SELECT * FROM payment_orders WHERE payment_intent_id=? OR charge_id=? ORDER BY device_id,reference',snapshot.paymentIntentId,snapshot.chargeId);
      for(const order of orders) {
        yield* query('SELECT id FROM devices WHERE id=? FOR UPDATE',Number(order.device_id));
        yield* refreshOrder(order,yield* refunds(JSON.parse(String(order.metadata)) as PaymentOrder));
      }
      // One row per refund resource; current succeeded facts count once. Charge summaries are
      // never also inserted as cash refunds. All state revisions remain in the audit table.
      yield* query(`INSERT INTO payment_adjustments(provider_ref,order_reference,adjustment_type,amount_cents,currency,status,effective_at,recorded_at)
        VALUES(?,?,'refund',?,?,?,?,?) ON CONFLICT(provider_ref) DO UPDATE SET order_reference=excluded.order_reference,
        amount_cents=excluded.amount_cents,currency=excluded.currency,status=excluded.status,effective_at=excluded.effective_at`,
        snapshot.id,orders[0]?String(orders[0].reference):snapshot.paymentIntentId??snapshot.chargeId!,snapshot.amountCents,snapshot.currency,snapshot.status==='succeeded'?'applied':'observed',now,now);
      yield* query("UPDATE webhook_inbox SET processing_state='processed',retry_after=NULL WHERE resource_id=? AND processing_state IN ('received','processing')",snapshot.id);
      return true;
    })());
  }
  deferRefund(claim: RefundClaim): Promise<void> {
    return this.run((function* (): Transaction<void> {
      yield* query("UPDATE webhook_inbox SET retry_after=? WHERE provider_event_id=? AND resource_generation=? AND processing_state='processing'",new Date(Date.now()+60_000).toISOString(),claim.event.id,claim.generation);
    })());
  }
  pendingRefunds(now=new Date().toISOString(),limit=10): Promise<PaymentEvent[]> {
    return this.run((function* (): Transaction<PaymentEvent[]> {
      const rows=yield* query(`SELECT * FROM webhook_inbox WHERE processing_state IN ('received','processing')
        AND event_type IN ('refund.created','refund.updated','refund.failed','charge.refund.updated','finance.refund.reconcile')
        AND (retry_after IS NULL OR retry_after<=?) ORDER BY received_at,provider_event_id LIMIT ?`,now,Math.max(1,Math.min(100,limit)));
      return rows.filter(row=>row.payload_hash!==null).map(eventFromRow);
    })());
  }
  decidePartial(reference: string, decision: RefundDecision): Promise<boolean> {
    return this.run((function* (): Transaction<boolean> {
      yield* lockPayments();
      const row=(yield* query('SELECT * FROM payment_orders WHERE reference=?',reference))[0]; if(!row) return false;
      yield* query('SELECT id FROM devices WHERE id=? FOR UPDATE',Number(row.device_id));
      const order=JSON.parse(String(row.metadata)) as PaymentOrder;
      const previous=(yield* query('SELECT * FROM payment_refund_decisions WHERE decision_ref=?',decision.reference))[0];
      if(previous) return previous.order_reference===reference && previous.fingerprint===decision.fingerprint && Number(previous.questions)===decision.questions;
      if(!validDecision(order,decision)) return false;
      order.decision=decision;
      yield* query('INSERT INTO payment_refund_decisions(decision_ref,order_reference,fingerprint,questions,created_at) VALUES(?,?,?,?,?)',decision.reference,reference,decision.fingerprint,decision.questions,new Date().toISOString());
      row.metadata=JSON.stringify(order); yield* refreshOrder(row,yield* refunds(order)); return true;
    })());
  }
  report(limit=100,reference?:string): Promise<PaymentReport> {
    return this.run((function* (): Transaction<PaymentReport> {
      yield* lockPayments();
      const bounded=Math.max(1,Math.min(1000,limit));
      const rows=reference?yield* query('SELECT metadata FROM payment_orders WHERE reference=?',reference)
        :yield* query('SELECT metadata FROM payment_orders ORDER BY created_at DESC,reference LIMIT ?',bounded+1);
      const orders=rows.map(row=>JSON.parse(String(row.metadata)) as PaymentOrder);
      const refundRows=reference?yield* query(`SELECT metadata FROM payment_refunds WHERE metadata IS NOT NULL
        AND (payment_intent_id=? OR charge_id=?) ORDER BY updated_at DESC,refund_id LIMIT 1001`,orders[0]?.paymentIntentId??null,orders[0]?.chargeId??null)
        :yield* query('SELECT metadata FROM payment_refunds WHERE metadata IS NOT NULL ORDER BY updated_at DESC,refund_id LIMIT 1001');
      const pending=(yield* query("SELECT COUNT(*) AS n FROM webhook_inbox WHERE processing_state!='processed'"))[0]!;
      return {orders:orders.slice(0,bounded),refunds:refundRows.slice(0,1000).map(row=>JSON.parse(String(row.metadata)) as RefundSnapshot),
        pendingEvents:Number(pending.n),hasMore:{orders:orders.length>bounded,refunds:refundRows.length>1000}};
    })());
  }
}
