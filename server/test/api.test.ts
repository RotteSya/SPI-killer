import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Configure for an isolated in-memory DB + key-free mock provider BEFORE the app (and its
// config module) is imported. Env is read once at config import, so this must precede it.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.TRIAL_QUESTIONS = '2';
process.env.TRIAL_MIN_QUESTIONS = '2'; // pin min===max so the trial grant is deterministic (2)
process.env.TRIAL_MAX_QUESTIONS = '2';
process.env.CURRENCY = 'CNY'; // pin so the ¥9 assertions stay meaningful regardless of the default
process.env.PACKS_JSON = JSON.stringify([{ id: 'pack100', questions: 100, amount_cents: 900 }]);
process.env.ALLOW_STUB_TOPUP = '1';
process.env.LOG_LEVEL = 'silent';

// /dl and /update proxy an upstream release host. Point both at inline data: URLs so the suite
// exercises the real handlers — including that neither one leaks the upstream location — while
// staying entirely offline and independent of what is actually published.
export const DMG_FIXTURE_BODY = 'not-a-real-dmg';
process.env.DMG_URL = `data:application/octet-stream,${encodeURIComponent(DMG_FIXTURE_BODY)}`;
process.env.RELEASE_API_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify({ tag_name: 'v9.9', body: 'Fixture notes' }),
)}`;

const { buildApp } = await import('../src/index.ts');

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

async function register(): Promise<string> {
  const res = await fetch(`${base}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: '2.0' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { device_token: string; balance_questions: number };
  assert.match(body.device_token, /^dev_/);
  assert.equal(body.balance_questions, 2);
  return body.device_token;
}

async function account(token: string): Promise<{
  balance_questions: number;
  total_questions: number;
  total_input_tokens: number;
  total_output_tokens: number;
}> {
  const res = await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    balance_questions: number;
    total_questions: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
}

async function capture(token: string, image = 'QUJDREVG'): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: '你是老师', task: '讲解', image_base64: image, image_media_type: 'image/jpeg' }),
  });
  return { status: res.status, text: await res.text() };
}

test('missing / invalid token is 401 JSON with an error code', async () => {
  const noAuth = await fetch(`${base}/v1/account`);
  assert.equal(noAuth.status, 401);
  const bad = await fetch(`${base}/v1/account`, { headers: { authorization: 'Bearer dev_nope' } });
  assert.equal(bad.status, 401);
  const body = (await bad.json()) as { error: { message: string; code: string } };
  assert.ok(body.error.message.length > 0);
  assert.equal(body.error.code, 'invalid_token');
});

test('capture streams deltas then exactly one usage event then [DONE], charging 1 question', async () => {
  const token = await register();
  const { status, text } = await capture(token);
  assert.equal(status, 200);
  const deltas = [...text.matchAll(/"type":"delta"/g)].length;
  assert.ok(deltas >= 1, `expected delta events, got ${deltas}`);
  const usages = [...text.matchAll(/"type":"usage"/g)].length;
  assert.equal(usages, 1, 'exactly one usage event');
  assert.match(text, /"questions_charged":1/);
  assert.match(text, /"balance_questions":1/); // 2 trial - 1 charged
  assert.match(text, /data: \[DONE\]/);
  // Account reflects the charge.
  const acct = await account(token);
  assert.equal(acct.balance_questions, 1);
  assert.equal(acct.total_questions, 1);
  assert.ok(acct.total_output_tokens > 0);
});

test('missing image is 400 before streaming', async () => {
  const token = await register();
  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', task: 't', image_base64: '', image_media_type: 'image/jpeg' }),
  });
  assert.equal(res.status, 400);
});

test('images_base64 (上下文追问) streams and charges exactly one question', async () => {
  const token = await register();
  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      system: '你是老师',
      task: '结合第一张图讲解第二张图',
      images_base64: ['T0xE', 'TkVX'], // context first, fresh capture last
      image_media_type: 'image/jpeg',
    }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"questions_charged":1/); // two images, still one question
  const acct = await account(token);
  assert.equal(acct.balance_questions, 1);
});

test('malformed or oversized images_base64 is 400 before streaming', async () => {
  const token = await register();
  const post = async (images: unknown): Promise<number> => {
    const res = await fetch(`${base}/v1/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ system: 's', task: 't', images_base64: images, image_media_type: 'image/jpeg' }),
    });
    void (await res.text());
    return res.status;
  };
  assert.equal(await post('not-an-array'), 400);
  assert.equal(await post([1, 2]), 400);       // non-string entries
  assert.equal(await post([]), 400);           // empty list = no image
  assert.equal(await post(['QUJD', '']), 400); // empty entry
  assert.equal(await post(['QUJD', 'QUJD', 'QUJD', 'QUJD', 'QUJD']), 400); // over the count cap
  // None of the rejected requests may have burned quota.
  const acct = await account(token);
  assert.equal(acct.balance_questions, 2);
});

test('missing system or task is 400 (contract-required fields)', async () => {
  const token = await register();
  const missingSystem = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
  });
  assert.equal(missingSystem.status, 400);
  const missingTask = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
  });
  assert.equal(missingTask.status, 400);
});

test('quota drains to 0 then the gate returns HTTP 402 insufficient_quota', async () => {
  const token = await register();
  assert.equal((await capture(token)).status, 200); // 2 → 1
  assert.equal((await capture(token)).status, 200); // 1 → 0
  const { status, text } = await capture(token);
  assert.equal(status, 402);
  const body = JSON.parse(text) as { error: { message: string; code: string } };
  assert.equal(body.error.code, 'insufficient_quota');
  assert.ok(body.error.message.length > 0);
});

test('stub top-up credits a pack and restores capture', async () => {
  const token = await register();
  await capture(token);
  await capture(token);
  assert.equal((await capture(token)).status, 402);
  // Buy the 100-question pack.
  const topup = await fetch(`${base}/topup/stub-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: token, pack_id: 'pack100' }),
  });
  assert.equal(topup.status, 200);
  const tb = (await topup.json()) as { balance_questions: number };
  assert.equal(tb.balance_questions, 100); // 0 + 100
  // Capture works again.
  assert.equal((await capture(token)).status, 200);
  assert.equal((await account(token)).balance_questions, 99);
});

test('stub top-up rejects an unknown pack and an unknown token', async () => {
  const token = await register();
  const bad = await fetch(`${base}/topup/stub-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: token, pack_id: 'nope' }),
  });
  assert.equal(bad.status, 400);
  const unknown = await fetch(`${base}/topup/stub-complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: 'dev_nope', pack_id: 'pack100' }),
  });
  assert.equal(unknown.status, 401);
});

test('top-up page renders localized HTML with the pack catalog', async () => {
  const token = await register();
  const zh = await fetch(`${base}/topup?device=${token}`);
  assert.equal(zh.status, 200);
  assert.match(zh.headers.get('content-type') ?? '', /text\/html/);
  const zhText = await zh.text();
  assert.match(zhText, /充值题数/);
  assert.match(zhText, /100 题/);
  assert.match(zhText, /¥9/);

  const ja = await (await fetch(`${base}/topup?device=${token}&lang=ja`)).text();
  assert.match(ja, /チャージ/);
  const en = await (await fetch(`${base}/topup?device=${token}&lang=en`)).text();
  assert.match(en, /Top Up Questions/);
});

test('GET /dl counts the click and streams the DMG from this origin; /stats reports the tally', async () => {
  const before = (await (await fetch(`${base}/stats`)).json()) as { download_clicks: number };
  const res = await fetch(`${base}/dl`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  // Deliberately NOT a redirect: a 302 would put the upstream host in the user's address bar and
  // download list. The bytes must come back from us, with no Location leaking where they live.
  assert.equal(res.headers.get('location'), null);
  assert.match(res.headers.get('content-disposition') ?? '', /filename="NotchSPI\.dmg"/);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(await res.text(), DMG_FIXTURE_BODY);
  const after = (await (await fetch(`${base}/stats`)).json()) as { download_clicks: number };
  assert.equal(after.download_clicks, before.download_clicks + 1);
});

test('GET /update reports the latest version without exposing the upstream release host', async () => {
  const res = await fetch(`${base}/update`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { version: string; tag: string; notes: string };
  assert.equal(body.version, '9.9'); // "v9.9" from the fixture, normalized server-side
  assert.equal(body.tag, 'v9.9');
  assert.equal(body.notes, 'Fixture notes');
  // The client composes its own download link from the base URL it already knows, so the relay
  // never hands out an upstream URL.
  assert.doesNotMatch(JSON.stringify(body), /github\.com/i);
});
