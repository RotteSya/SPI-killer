import {query,type Row,type RunTransaction,type Transaction} from './billing-sql.ts';
import {lockPayments,receipt,creditPaidOrder} from './payment-ledger-sql.ts';
import {purchaseFromRow} from './purchase-session-sql.ts';
import {validateEvent,type PaymentEvent,type PaymentOrder} from './payment-ledger.ts';
import {checkoutSnapshotHash,validateCheckoutSnapshot,validateCheckoutDecision,validateCheckoutQuery,evaluateCheckout,checkoutDecisionCurrent,checkoutReview,
  type CheckoutCase,type CheckoutCatalog,type CheckoutClaim,type CheckoutContext,type CheckoutDecision,type CheckoutQuery,type CheckoutQueue,type CheckoutSnapshot} from './checkout-reconciliation.ts';

export const CHECKOUT_SCHEMA=`
CREATE TABLE IF NOT EXISTS checkout_cases (
 reference TEXT PRIMARY KEY,state TEXT NOT NULL,retry_after TEXT,metadata TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_pending ON checkout_cases(state,retry_after,reference);
CREATE TABLE IF NOT EXISTS checkout_deliveries (
 provider_event_id TEXT PRIMARY KEY REFERENCES webhook_inbox(provider_event_id),
 reference TEXT NOT NULL REFERENCES checkout_cases(reference),snapshot_hash TEXT NOT NULL,snapshot TEXT NOT NULL,recorded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkout_deliveries_reference ON checkout_deliveries(reference);
CREATE TABLE IF NOT EXISTS checkout_observations (
 reference TEXT NOT NULL REFERENCES checkout_cases(reference),generation BIGINT NOT NULL,source TEXT NOT NULL,
 snapshot TEXT NOT NULL,reason TEXT,recorded_at TEXT NOT NULL,PRIMARY KEY(reference,generation)
);
CREATE TABLE IF NOT EXISTS checkout_decisions (
 review_reference TEXT PRIMARY KEY,reference TEXT NOT NULL REFERENCES checkout_cases(reference),metadata TEXT NOT NULL,recorded_at TEXT NOT NULL
);
`;
function decode(row:Row):CheckoutCase{return JSON.parse(String(row.metadata)) as CheckoutCase;}
function* save(c:CheckoutCase):Transaction<void>{yield* query('UPDATE checkout_cases SET state=?,retry_after=?,metadata=? WHERE reference=?',c.state,c.retryAfter,JSON.stringify(c),c.reference);}
function* context(s:CheckoutSnapshot,original:CheckoutSnapshot,d?:CheckoutDecision):Transaction<CheckoutContext>{
  const purchase=s.purchaseSessionId?(yield* query('SELECT * FROM purchase_sessions WHERE session_id=?',s.purchaseSessionId))[0]:null;
  const owner=(yield* query('SELECT session_id FROM purchase_sessions WHERE checkout_session_id=?',s.id))[0];
  const device=s.deviceTokenHash?(yield* query('SELECT id FROM devices WHERE token_hash=?',s.deviceTokenHash))[0]:null;
  const originalDevice=original.deviceTokenHash===s.deviceTokenHash?device:
    original.deviceTokenHash?(yield* query('SELECT id FROM devices WHERE token_hash=?',original.deviceTokenHash))[0]:null;
  const manual=d?(yield* query('SELECT id FROM devices WHERE id=?',d.deviceId))[0]:null;
  const order=(yield* query('SELECT metadata FROM payment_orders WHERE reference=?',s.id))[0];
  const paymentOwner=s.paymentIntentId?(yield* query('SELECT reference FROM payment_orders WHERE payment_intent_id=?',s.paymentIntentId))[0]:null;
  const topup=(yield* query('SELECT device_id,questions,amount_cents,currency FROM topups WHERE reference=?',s.id))[0];
  return {purchase:purchase?purchaseFromRow(purchase):null,checkoutOwner:owner?String(owner.session_id):null,deviceId:device?Number(device.id):null,
    originalDeviceId:originalDevice?Number(originalDevice.id):null,manualDeviceExists:!!manual,order:order?JSON.parse(String(order.metadata)) as PaymentOrder:null,paymentOwner:paymentOwner?String(paymentOwner.reference):null,
    topup:topup?{deviceId:Number(topup.device_id),questions:Number(topup.questions),amountCents:Number(topup.amount_cents),currency:String(topup.currency)}:null};
}
export class SQLCheckoutQueue implements CheckoutQueue {
  private run:RunTransaction;
  constructor(run:RunTransaction){this.run=run;}
  receive(event:PaymentEvent,snapshot:CheckoutSnapshot):Promise<void>{
    validateEvent(event);validateCheckoutSnapshot(snapshot);
    if(event.resourceId!==snapshot.id||snapshot.paymentStatus!=='paid'||!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))throw new Error('Invalid paid Checkout receipt');
    return this.run((function*():Transaction<void>{
      yield* lockPayments();yield* receipt(event);const hash=checkoutSnapshotHash(snapshot);
      const previous=(yield* query('SELECT snapshot_hash FROM checkout_deliveries WHERE provider_event_id=?',event.id))[0];
      if(previous){if(previous.snapshot_hash!==hash)throw new Error('Checkout receipt conflict');return;}
      const row=(yield* query('SELECT metadata FROM checkout_cases WHERE reference=?',snapshot.id))[0],now=new Date().toISOString();
      if(!row){const c:CheckoutCase={reference:snapshot.id,event,signed:snapshot,observed:null,observationSource:null,conflictingEvents:false,
        state:'queued',reason:null,generation:'0',attempts:0,retryAfter:null,createdAt:now,updatedAt:now,resolvedDeviceId:null,decision:null};
        yield* query("INSERT INTO checkout_cases(reference,state,retry_after,metadata) VALUES(?,'queued',NULL,?)",c.reference,JSON.stringify(c));
      }else{const c=decode(row);
        if(checkoutSnapshotHash(c.signed)!==hash){c.conflictingEvents=true;c.state='review';c.reason='conflicting_events';c.retryAfter=null;c.updatedAt=now;yield* save(c);}
        else if(c.state==='credited')yield* query("UPDATE webhook_inbox SET processing_state='processed' WHERE provider_event_id=?",event.id);
      }
      yield* query('INSERT INTO checkout_deliveries(provider_event_id,reference,snapshot_hash,snapshot,recorded_at) VALUES(?,?,?,?,?)',event.id,snapshot.id,hash,JSON.stringify(snapshot),now);
    })());
  }
  claim(reference:string,interactive=false):Promise<CheckoutClaim|null>{return this.run((function*():Transaction<CheckoutClaim|null>{
    yield* lockPayments();const row=(yield* query('SELECT metadata FROM checkout_cases WHERE reference=?',reference))[0];if(!row)return null;
    const c=decode(row);if(c.state==='credited'||(c.state==='processing'&&c.retryAfter!>new Date().toISOString()))return null;
    if(!interactive&&(c.state==='review'||(c.state==='queued'&&c.retryAfter!==null&&c.retryAfter>new Date().toISOString())))return null;
    c.generation=String(BigInt(c.generation)+1n);c.attempts++;c.state='processing';c.retryAfter=new Date(Date.now()+60_000).toISOString();yield* save(c);
    return {reference,generation:c.generation,event:c.event,signed:c.signed};
  })());}
  finish(claim:CheckoutClaim,snapshot:CheckoutSnapshot,source:'signed_event'|'stripe_api',catalog:CheckoutCatalog,decision?:CheckoutDecision):Promise<'credited'|'review'|'stale'|'conflict'>{
    validateCheckoutSnapshot(snapshot);if(decision)validateCheckoutDecision(decision);
    return this.run((function*():Transaction<'credited'|'review'|'stale'|'conflict'>{
      yield* lockPayments();const row=(yield* query('SELECT metadata FROM checkout_cases WHERE reference=?',claim.reference))[0];if(!row)return 'stale';
      const c=decode(row);if(c.state!=='processing'||c.generation!==claim.generation)return 'stale';
      if(snapshot.id!==claim.reference)throw new Error('Checkout observation mismatch');
      const current=!decision||checkoutDecisionCurrent(c,snapshot,source,decision);
      c.observed=snapshot;c.observationSource=source;c.updatedAt=new Date().toISOString();
      const prior=decision?(yield* query('SELECT reference FROM checkout_decisions WHERE review_reference=?',decision.reference))[0]:null;
      let status:'credited'|'review'|'conflict';
      if(!current||prior){checkoutReview(c,'review_changed');status='conflict';}
      else{
        const resolved=yield* context(snapshot,c.signed,decision);c.resolvedDeviceId=resolved.purchase?.deviceId??resolved.originalDeviceId??resolved.deviceId;
        const outcome=evaluateCheckout(c,snapshot,catalog,resolved,decision);
        if('reason' in outcome){checkoutReview(c,outcome.reason);status='review';}
        else{
          if(outcome.linkPurchase){
            yield* query('SELECT id FROM devices WHERE id=? FOR UPDATE',outcome.order.deviceId!);
            yield* query('UPDATE purchase_sessions SET checkout_session_id=? WHERE session_id=? AND checkout_session_id IS NULL',c.reference,outcome.order.purchaseSessionId!);
          }
          if((yield* creditPaidOrder(c.event,outcome.order))===null)throw new Error('Checkout account unavailable');
          c.state='credited';c.reason=null;c.retryAfter=null;status='credited';
          if(decision){c.decision={...decision,appliedAt:c.updatedAt};yield* query('INSERT INTO checkout_decisions(review_reference,reference,metadata,recorded_at) VALUES(?,?,?,?)',decision.reference,c.reference,JSON.stringify(c.decision),c.updatedAt);}
          yield* query("UPDATE webhook_inbox SET processing_state='processed',retry_after=NULL WHERE provider_event_id IN (SELECT provider_event_id FROM checkout_deliveries WHERE reference=?)",c.reference);
        }
      }
      yield* save(c);yield* query('INSERT INTO checkout_observations(reference,generation,source,snapshot,reason,recorded_at) VALUES(?,?,?,?,?,?)',c.reference,c.generation,source,JSON.stringify(snapshot),c.reason,c.updatedAt);
      return status;
    })());
  }
  defer(claim:CheckoutClaim):Promise<void>{return this.run((function*():Transaction<void>{
    yield* lockPayments();const row=(yield* query('SELECT metadata FROM checkout_cases WHERE reference=?',claim.reference))[0];if(!row)return;
    const c=decode(row);if(c.state==='processing'&&c.generation===claim.generation){checkoutReview(c,'provider_unavailable');yield* save(c);}
  })());}
  pending(now=new Date().toISOString(),limit=5):Promise<string[]>{return this.run((function*():Transaction<string[]>{
    return (yield* query("SELECT reference FROM checkout_cases WHERE state IN ('queued','processing') AND (retry_after IS NULL OR retry_after<=?) ORDER BY reference LIMIT ?",now,Math.max(1,Math.min(20,limit)))).map(r=>String(r.reference));
  })());}
  get(reference:string):Promise<CheckoutCase|null>{return this.run((function*():Transaction<CheckoutCase|null>{const row=(yield* query('SELECT metadata FROM checkout_cases WHERE reference=?',reference))[0];return row?decode(row):null;})());}
  list(q:CheckoutQuery):Promise<{items:CheckoutCase[];next:string|null}>{
    validateCheckoutQuery(q);return this.run((function*():Transaction<{items:CheckoutCase[];next:string|null}>{
      const clauses:string[]=[],args:Array<string|number>=[];
      if(q.state){clauses.push('state=?');args.push(q.state);}if(q.before){clauses.push('reference<?');args.push(q.before);}
      const rows=yield* query('SELECT metadata FROM checkout_cases'+(clauses.length?' WHERE '+clauses.join(' AND '):'')+' ORDER BY reference DESC LIMIT ?',...args,q.limit+1);
      const items=rows.slice(0,q.limit).map(decode);return {items,next:rows.length>q.limit?items.at(-1)!.reference:null};
    })());
  }
}
