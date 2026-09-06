import {randomBytes,randomUUID} from 'node:crypto';
import {hashToken,type PurchaseSession,type PurchaseSessionInput,type StoredPurchaseSession} from './db.ts';
import {query,type Row,type RunTransaction,type Transaction} from './billing-sql.ts';
import {purchaseHandoff,purchaseSecretHash,reusablePurchase,validatePurchase,validateCheckoutAttachment} from './purchase-session.ts';

export function purchaseFromRow(row:Row):StoredPurchaseSession {
  const iso=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();
  return {sessionId:String(row.session_id),deviceId:Number(row.device_id),purchaseId:String(row.purchase_id),secretHash:String(row.secret_hash),
    packId:String(row.pack_id),catalogVersion:String(row.catalog_version),questions:Number(row.questions),amountCents:Number(row.amount_cents),
    currency:String(row.currency),lang:String(row.lang),expiresAt:iso(row.expires_at),
    checkoutSessionId:row.checkout_session_id as string|null,checkoutURL:row.checkout_url as string|null,
    consumedAt:row.consumed_at===null?null:iso(row.consumed_at)};
}
export class SQLPurchaseSessions {
  private readonly run:RunTransaction;
  constructor(run:RunTransaction){this.run=run;}
  create(input:PurchaseSessionInput):Promise<PurchaseSession|null>{
    validatePurchase(input);
    return this.run((function*():Transaction<PurchaseSession|null>{
      const device=(yield* query('SELECT id FROM devices WHERE token_hash=? FOR UPDATE',hashToken(input.token)))[0];if(!device)return null;
      const row=(yield* query('SELECT * FROM purchase_sessions WHERE device_id=? AND purchase_id=? FOR UPDATE',Number(device.id),input.purchaseId))[0];
      const now=Date.now(),secret=randomBytes(32).toString('base64url'),secretHash=purchaseSecretHash(secret);
      if(row){const stored=purchaseFromRow(row);if(!reusablePurchase(stored,input,now))return null;
        // The bearer-authenticated retry recovers the same order with a new random handoff
        // secret. Old browser links expire immediately; the original deadline is unchanged.
        yield* query('UPDATE purchase_sessions SET secret_hash=? WHERE session_id=?',secretHash,stored.sessionId);
        return purchaseHandoff(stored,secret);
      }
      const stored:StoredPurchaseSession={sessionId:randomUUID(),deviceId:Number(device.id),purchaseId:input.purchaseId,secretHash,
        packId:input.packId,catalogVersion:input.catalogVersion,questions:input.questions,amountCents:input.amountCents,currency:input.currency,
        lang:input.lang,expiresAt:new Date(now+600_000).toISOString(),checkoutSessionId:null,checkoutURL:null,consumedAt:null};
      yield* query(`INSERT INTO purchase_sessions(session_id,device_id,purchase_id,secret_hash,pack_id,catalog_version,questions,amount_cents,currency,lang,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,stored.sessionId,stored.deviceId,stored.purchaseId,secretHash,stored.packId,stored.catalogVersion,stored.questions,
        stored.amountCents,stored.currency,stored.lang,stored.expiresAt,new Date(now).toISOString());
      return purchaseHandoff(stored,secret);
    })());
  }
  get(sessionId:string,secret:string):Promise<StoredPurchaseSession|null>{
    // UUID validation also prevents invalid UUID casts in PostgreSQL.
    if(! /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sessionId))return Promise.resolve(null);
    return this.run((function*():Transaction<StoredPurchaseSession|null>{
      const row=(yield* query('SELECT * FROM purchase_sessions WHERE session_id=? AND secret_hash=? AND expires_at>? AND consumed_at IS NULL',sessionId,purchaseSecretHash(secret),new Date().toISOString()))[0];
      return row?purchaseFromRow(row):null;
    })());
  }
  byCheckout(id:string):Promise<StoredPurchaseSession|null>{return this.run((function*():Transaction<StoredPurchaseSession|null>{
    const row=(yield* query('SELECT * FROM purchase_sessions WHERE checkout_session_id=?',id))[0];return row?purchaseFromRow(row):null;
  })());}
  attach(sessionId:string,id:string,url?:string):Promise<boolean>{
    validateCheckoutAttachment(id,url);
    return this.run((function*():Transaction<boolean>{
      yield* query('SELECT id FROM payment_processing_lock WHERE id=1 FOR UPDATE');
      const existing=(yield* query('SELECT session_id FROM purchase_sessions WHERE checkout_session_id=?',id))[0];
      if(existing&&String(existing.session_id)!==sessionId)return false;
      const rows=yield* query(`UPDATE purchase_sessions SET checkout_session_id=?,checkout_url=COALESCE(checkout_url,?)
        WHERE session_id=? AND expires_at>? AND consumed_at IS NULL AND (checkout_session_id IS NULL OR checkout_session_id=?)
        AND (checkout_url IS NULL OR checkout_url=?) RETURNING session_id`,id,url??null,sessionId,new Date().toISOString(),id,url??null);
      return rows.length>0;
    })());
  }
}
