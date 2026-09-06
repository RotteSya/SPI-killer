import { createHmac, timingSafeEqual } from 'node:crypto';
import type { QuestionPack } from './pricing.ts';
import type { PaymentProvider, TopUpPageInput, PageLang } from './payments.ts';
import { renderTopUpPage, packDisplayName } from './payments.ts';
import { validateRefund, type RefundSnapshot, type RefundStatus, type PaymentEvent, type PaymentLedger } from './payment-ledger.ts';
import {checkoutSnapshot,type CheckoutSnapshot} from './checkout-reconciliation.ts';

// Hosted Stripe Checkout uses a form-encoded POST, signed webhook verification and bounded
// resource reads for durable reconciliation. Quota effects belong to the payment ledger.
//
// Flow: page button → POST /topup/checkout → checkout.sessions.create → redirect to Stripe →
// customer pays → Stripe sends a signed completed/async paid event → durable receipt →
// validated order and paid-lot transaction. The return page asks the user to refresh the app.
//
// `payment_method_types` is deliberately NOT set: Stripe's dynamic payment methods pick the
// best-converting eligible methods (cards, Alipay, WeChat Pay, Link, …) per customer, all
// configurable from the Dashboard with no code changes.

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';
const SIGNATURE_TOLERANCE_SEC = 300; // Stripe's recommended replay window

// MARK: Signature verification (pure, unit-tested)

/**
 * Verify a `Stripe-Signature` header against the raw request payload.
 * Header format: `t=<unix>,v1=<hex>[,v1=<hex>…]`; the signed content is `${t}.${payload}`
 * HMAC-SHA256'd with the endpoint's whsec secret. Rejects stale timestamps (replay defense)
 * and compares in constant time.
 */
export function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = SIGNATURE_TOLERANCE_SEC,
): boolean {
  if (!payload || !header || !secret) return false;
  let timestamp = '';
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') candidates.push(v);
  }
  if (!timestamp || candidates.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return candidates.some((c) => {
    const buf = Buffer.from(c, 'utf8');
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
}

// MARK: Checkout session (params builder pure; the POST thin)

export interface CheckoutInput {
  pack: QuestionPack;
  deviceToken?: string;
  purchaseSessionId?: string;
  currency: string; // ISO code matching the Stripe account's settings, e.g. CNY / JPY / USD
  publicBaseURL: string;
  lang: PageLang;
}

/**
 * Build the form body for `checkout.sessions.create`. Amounts are already in the currency's
 * smallest unit (fen for CNY, yen for JPY) — exactly how the pack catalog is configured.
 * New clients bind a sealed purchase id; legacy clients use device/pack metadata.
 */
export function buildCheckoutParams(input: CheckoutInput): URLSearchParams {
  if (!input.deviceToken && !input.purchaseSessionId) throw new Error('checkout identity missing');
  const back = input.purchaseSessionId
    ? `${input.publicBaseURL}/purchase/complete?lang=${input.lang}`
    : `${input.publicBaseURL}/topup?device=${encodeURIComponent(input.deviceToken!)}&lang=${input.lang}`;
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', input.currency.toLowerCase());
  p.set('line_items[0][price_data][unit_amount]', String(input.pack.amountCents));
  p.set('line_items[0][price_data][product_data][name]', packDisplayName(input.pack, input.lang));
  if (input.deviceToken) p.set('metadata[device_token]', input.deviceToken);
  if (input.purchaseSessionId) p.set('metadata[purchase_session_id]', input.purchaseSessionId);
  p.set('metadata[pack_id]', input.pack.id);
  p.set('metadata[questions]', String(input.pack.questions));
  p.set('success_url', `${back}&paid=1`);
  p.set('cancel_url', `${back}&canceled=1`);
  return p;
}

/** Create a hosted Checkout session; returns its redirect URL or a user-safe error. */
export async function createCheckoutSession(
  secretKey: string,
  input: CheckoutInput,
): Promise<{ url: string; id?: string } | { error: string }> {
  try {
    const res = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(input.purchaseSessionId ? {'Idempotency-Key':'purchase:'+input.purchaseSessionId} : {}),
      },
      body: buildCheckoutParams(input).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const body = (await res.json()) as { id?:unknown; url?:unknown };
    if (!res.ok || typeof body.url!=='string'||typeof body.id!=='string'||!/^cs_[A-Za-z0-9_]{1,160}$/.test(body.id)) {
      // Log the vendor detail server-side; never echo Stripe internals to the page.
      return { error: `stripe_http_${res.status}` };
    }
    const destination=new URL(body.url);
    if(destination.protocol!=='https:'||destination.username||destination.password) return {error:'stripe_invalid_redirect'};
    return { url: body.url, id: body.id };
  } catch {
    return { error: 'stripe_request_failed' };
  }
}

// MARK: Webhook event shape (the fields we consume)

export interface StripeCheckoutSession {
  id: string;
  payment_status?: string;
  amount_total?: number;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  payment_intent?: string;
  metadata?: { device_token?: string; pack_id?: string; purchase_session_id?: string; checkout_session_id?: string };
}

export interface StripeEvent {
  id?: string;
  created?: number;
  type: string;
  data?: { object?: StripeCheckoutSession };
}

/** Expanded Stripe references contain the same id as their string representation. */
export function stripeReference(value: unknown): string | null {
  if(typeof value==='string') return value;
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'id' in value&&typeof value.id==='string') return value.id;
  return null;
}
export async function retrieveStripeRefund(secretKey:string,id:string):Promise<RefundSnapshot> {
  if(!/^re_[A-Za-z0-9_]{1,160}$/.test(id)) throw new Error('Invalid refund id');
  const response=await fetch('https://api.stripe.com/v1/refunds/'+encodeURIComponent(id),{
    headers:{Authorization:'Bearer '+secretKey},signal:AbortSignal.timeout(8_000),redirect:'error',
  });
  if(!response.ok) throw new Error('Stripe refund retrieval unavailable');
  const body=await response.json() as Record<string,unknown>;
  const snapshot:RefundSnapshot={id:typeof body.id==='string'?body.id:'',paymentIntentId:stripeReference(body.payment_intent),chargeId:stripeReference(body.charge),
    amountCents:typeof body.amount==='number'?body.amount:NaN,currency:typeof body.currency==='string'?body.currency.toUpperCase():'',status:body.status as RefundStatus};
  validateRefund(snapshot); if(snapshot.id!==id) throw new Error('Stripe refund resource mismatch'); return snapshot;
}
export async function retrieveStripeCheckout(secretKey:string,id:string):Promise<CheckoutSnapshot>{
  if(!/^cs_[A-Za-z0-9_]{1,160}$/.test(id))throw new Error('Invalid Checkout id');
  const response=await fetch(STRIPE_API+'/'+encodeURIComponent(id),{
    headers:{Authorization:'Bearer '+secretKey},signal:AbortSignal.timeout(8_000),redirect:'error',
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Stripe Checkout retrieval unavailable');}
  if(!response.body)throw new Error('Stripe Checkout response missing');
  const chunks:Uint8Array[]=[];let length=0;
  for await(const chunk of response.body){length+=chunk.byteLength;if(length>256*1024)throw new Error('Stripe Checkout response exceeds limit');chunks.push(chunk);}
  let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Stripe Checkout payload invalid');}
  const snapshot=checkoutSnapshot(raw);
  if(snapshot.id!==id)throw new Error('Stripe Checkout resource mismatch');return snapshot;
}
export async function reconcileStripeRefund(ledger:PaymentLedger,event:PaymentEvent,read:(id:string)=>Promise<RefundSnapshot>):Promise<boolean> {
  const claim=await ledger.claimRefund(event); if(!claim) return true;
  try { return await ledger.applyRefund(claim,await read(event.resourceId)); }
  catch { await ledger.deferRefund(claim); throw new Error('Stripe refund reconciliation unavailable'); }
}

// MARK: Provider

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  renderTopUpPage(input: TopUpPageInput): string {
    return renderTopUpPage(input);
  }
}
