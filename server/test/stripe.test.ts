import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Stripe-mode app: in-memory DB + mock provider + fake Stripe credentials. The webhook path
// is fully testable offline because signatures are just HMACs we can compute ourselves.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.TRIAL_QUESTIONS = '0';
process.env.TRIAL_MIN_QUESTIONS = '0'; // pin min===max so the trial grant is deterministic (0)
process.env.TRIAL_MAX_QUESTIONS = '0';
process.env.CURRENCY = 'CNY'; // pin: the webhook amount/currency cross-check must match the fixture
process.env.PACKS_JSON = JSON.stringify([{ id: 'pack300', questions: 300, amount_cents: 2400 }]);
process.env.STRIPE_SECRET_KEY = 'rk_test_fake_key_for_tests';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.ALLOW_STUB_TOPUP = '0';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');
const { verifyStripeSignature, buildCheckoutParams } = await import('../src/stripe.ts');

let app: FastifyInstance;
let base: string;

before(async () => {
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
});

function sign(payload: string, secret = 'whsec_testsecret', at = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

async function register(): Promise<string> {
  const res = await fetch(`${base}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: '2.0' }),
  });
  const body = (await res.json()) as { device_token: string };
  return body.device_token;
}

function checkoutEvent(
  token: string,
  type: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: (overrides.event_id as string) ?? 'evt_1',
    type,
    data: {
      object: {
        id: (overrides.session_id as string) ?? 'cs_test_ok_1',
        payment_status: 'paid',
        amount_total: 2400,
        currency: 'cny',
        metadata: { device_token: token, pack_id: 'pack300' },
        ...overrides,
      },
    },
  });
}

function checkoutCompletedEvent(token: string, overrides: Record<string, unknown> = {}): string {
  return checkoutEvent(token, 'checkout.session.completed', overrides);
}

// ---- pure signature verification --------------------------------------------------------

test('verifyStripeSignature accepts a valid header and rejects tampering', () => {
  const payload = '{"hello":"world"}';
  const now = 1_700_000_000;
  const header = sign(payload, 'whsec_x', now);
  assert.ok(verifyStripeSignature(payload, header, 'whsec_x', now));
  assert.ok(!verifyStripeSignature(payload + ' ', header, 'whsec_x', now), 'payload tamper');
  assert.ok(!verifyStripeSignature(payload, header, 'whsec_y', now), 'wrong secret');
  assert.ok(!verifyStripeSignature(payload, 't=123,v1=deadbeef', 'whsec_x', now), 'bogus mac');
  assert.ok(!verifyStripeSignature(payload, '', 'whsec_x', now), 'empty header');
});

test('verifyStripeSignature rejects stale timestamps (replay defense)', () => {
  const payload = '{}';
  const old = 1_700_000_000;
  const header = sign(payload, 'whsec_x', old);
  assert.ok(!verifyStripeSignature(payload, header, 'whsec_x', old + 301));
  assert.ok(verifyStripeSignature(payload, header, 'whsec_x', old + 299));
});

test('verifyStripeSignature accepts any matching v1 among several', () => {
  const payload = '{}';
  const now = 1_700_000_000;
  const mac = createHmac('sha256', 'whsec_x').update(`${now}.${payload}`).digest('hex');
  const header = `t=${now},v1=0000,v1=${mac}`;
  assert.ok(verifyStripeSignature(payload, header, 'whsec_x', now));
});

// ---- checkout params ---------------------------------------------------------------------

test('buildCheckoutParams builds a dynamic-payment-method session (no payment_method_types)', () => {
  const p = buildCheckoutParams({
    pack: { id: 'pack300', questions: 300, amountCents: 2400 },
    deviceToken: 'dev_abc',
    currency: 'CNY',
    publicBaseURL: 'https://api.example.com',
    lang: 'zh',
  });
  const s = p.toString();
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'cny');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '2400');
  assert.equal(p.get('metadata[device_token]'), 'dev_abc');
  assert.equal(p.get('metadata[pack_id]'), 'pack300');
  assert.match(p.get('success_url') ?? '', /paid=1/);
  assert.match(p.get('cancel_url') ?? '', /canceled=1/);
  assert.ok(!s.includes('payment_method_types'), 'must not pin payment method types');
});

// ---- webhook integration ------------------------------------------------------------------

test('signed checkout.session.async_payment_succeeded credits a delayed session; redelivery is a no-op', async () => {
  const token = await register();
  const sessionId = 'cs_test_async_1';
  const unpaid = checkoutCompletedEvent(token, { session_id: sessionId, payment_status: 'unpaid' });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(unpaid) },
    body: unpaid,
  })).status, 200);
  const before = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(before.balance_questions, 0, 'unpaid completed must not credit');

  const payload = checkoutEvent(token, 'checkout.session.async_payment_succeeded', {
    event_id: 'evt_async_1',
    session_id: sessionId,
  });
  const deliver = () => fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });
  assert.equal((await deliver()).status, 200);
  const acct1 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct1.balance_questions, 300);
  assert.equal((await deliver()).status, 200);
  const acct2 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct2.balance_questions, 300);
});

test('async_payment_succeeded after a paid completed event does not double-credit', async () => {
  const token = await register();
  const sessionId = 'cs_test_both_1';
  const completed = checkoutCompletedEvent(token, { session_id: sessionId });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(completed) },
    body: completed,
  })).status, 200);
  const asyncPaid = checkoutEvent(token, 'checkout.session.async_payment_succeeded', {
    event_id: 'evt_both_async',
    session_id: sessionId,
  });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(asyncPaid) },
    body: asyncPaid,
  })).status, 200);
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 300);
});

test('signed checkout.session.completed credits the pack; redelivery is a no-op', async () => {
  const token = await register();
  const payload = checkoutCompletedEvent(token, { session_id: 'cs_test_credit_1' });

  const deliver = () => fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });

  const first = await deliver();
  assert.equal(first.status, 200);
  const acct1 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct1.balance_questions, 300);

  const second = await deliver(); // Stripe redelivers; must not double-credit
  assert.equal(second.status, 200);
  const acct2 = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct2.balance_questions, 300);
});

test('webhook with a bad signature is rejected and credits nothing', async () => {
  const token = await register();
  const payload = checkoutCompletedEvent(token, { session_id: 'cs_test_badsig' });
  const res = await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bogus' },
    body: payload,
  });
  assert.equal(res.status, 400);
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 0);
});

test('paid amount mismatching the catalog is acknowledged but NOT credited', async () => {
  const token = await register();
  const payload = checkoutCompletedEvent(token, { session_id: 'cs_test_wrongamt', amount_total: 1 });
  const res = await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(payload) },
    body: payload,
  });
  assert.equal(res.status, 200); // acknowledged so Stripe stops retrying something unfixable
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 0);
});

test('unpaid or irrelevant events are acknowledged without crediting', async () => {
  const token = await register();
  const unpaid = checkoutCompletedEvent(token, { session_id: 'cs_test_unpaid', payment_status: 'unpaid' });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(unpaid) },
    body: unpaid,
  })).status, 200);
  const other = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  assert.equal((await fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(other) },
    body: other,
  })).status, 200);
  const acct = (await (await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } })).json()) as { balance_questions: number };
  assert.equal(acct.balance_questions, 0);
});

test('stub endpoint is OFF in stripe mode; checkout rejects junk tokens and packs', async () => {
  assert.equal((await fetch(`${base}/topup/stub-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: 'dev_x', pack_id: 'pack300' }),
  })).status, 404);

  assert.equal((await fetch(`${base}/topup/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: '</script>', pack_id: 'pack300' }),
  })).status, 400);

  assert.equal((await fetch(`${base}/topup/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: 'dev_unknown_token', pack_id: 'pack300' }),
  })).status, 401);

  const token = await register();
  assert.equal((await fetch(`${base}/topup/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: token, pack_id: 'nope' }),
  })).status, 400);
});

test('top-up page renders stripe mode with live buttons and no stub warning', async () => {
  const token = await register();
  const html = await (await fetch(`${base}/topup?device=${token}&lang=zh`)).text();
  assert.match(html, /data-pack="pack300"/);
  assert.match(html, /topup\/checkout/);
  assert.ok(!html.includes('stub-complete'), 'stripe page must not wire the stub endpoint');
  assert.ok(!html.includes('支付桩'), 'no dev warning in stripe mode');
});

test('healthz reports stripe payments and webhook configured', async () => {
  const h = (await (await fetch(`${base}/healthz`)).json()) as Record<string, string>;
  assert.equal(h.payments, 'stripe');
  assert.equal(h.webhook, 'configured');
});
