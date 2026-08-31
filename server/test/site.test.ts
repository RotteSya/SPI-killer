import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// The public product site at GET / — must carry everything a payment-provider review looks
// for: product description, live pricing, contact, and the Japanese commerce disclosure.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.CURRENCY = 'JPY';
process.env.TRIAL_QUESTIONS = '180';
process.env.PACKS_JSON = JSON.stringify([
  { id: 'pack100', questions: 100, amount_cents: 300 },
  { id: 'pack300', questions: 300, amount_cents: 800 },
  { id: 'pack1000', questions: 1000, amount_cents: 2200 },
]);
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');
const { renderLandingPage, resolveSiteLang } = await import('../src/site.ts');

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

test('GET / renders the Japanese site by default with live pricing and legal sections', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /ノッチにひそむ/);                     // hero (ja default)
  assert.match(html, /180 問ぶん無料|180問ぶん/);            // trial from config
  assert.match(html, /¥800/);                               // live pack price
  assert.match(html, /特定商取引法に基づく表記/);            // JP commerce disclosure
  assert.match(html, /プライバシーポリシー/);                // privacy
  assert.match(html, /返金・キャンセルポリシー/);            // refunds
  assert.match(html, /raysyadesu@gmail\.com/);              // contact
  assert.match(html, /href="\/dl"/);                        // download CTA → our own counted endpoint
});

test('the site never links a visitor to where the app is hosted or built', async () => {
  // The product is distributed from this origin only: /dl streams the DMG and /update reports
  // the version. A stray github.com href would leak the source repo straight into the UI, so
  // this asserts the absence across every rendered language, not just the default one.
  for (const lang of ['ja', 'zh', 'en']) {
    const html = await (await fetch(`${base}/?lang=${lang}`)).text();
    assert.doesNotMatch(html, /github\.com|api\.github\.com/i, `${lang} page links to GitHub`);
  }
});

test('?lang switches the site language; the JP disclosure stays present', async () => {
  const zh = await (await fetch(`${base}/?lang=zh`)).text();
  assert.match(zh, /藏在刘海里的解题助手/);
  assert.match(zh, /特定商取引法に基づく表記/);
  const en = await (await fetch(`${base}/?lang=en`)).text();
  assert.match(en, /answer assistant hiding in your notch/);
  assert.match(en, /特定商取引法に基づく表記/);
});

test('Accept-Language negotiation picks zh/en; unknown falls back to ja', async () => {
  const zh = await (await fetch(`${base}/`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })).text();
  assert.match(zh, /藏在刘海里的解题助手/);
  const en = await (await fetch(`${base}/`, { headers: { 'accept-language': 'en-US,en;q=0.9' } })).text();
  assert.match(en, /hiding in your notch/);
  const fr = await (await fetch(`${base}/`, { headers: { 'accept-language': 'fr-FR' } })).text();
  assert.match(fr, /ノッチにひそむ/);
});

test('resolveSiteLang: explicit query beats headers; header order respected', () => {
  assert.equal(resolveSiteLang('en', 'ja-JP'), 'en');
  assert.equal(resolveSiteLang('', 'zh-CN,ja;q=0.8'), 'zh');
  assert.equal(resolveSiteLang('', 'fr-FR,de-DE'), 'ja');
  assert.equal(resolveSiteLang('', ''), 'ja');
});

test('the site is browser-cacheable and varies on Accept-Language', async () => {
  const res = await fetch(`${base}/`);
  assert.match(res.headers.get('cache-control') ?? '', /max-age=300/);
  assert.ok(!(res.headers.get('cache-control') ?? '').includes('s-maxage'));
  assert.match(res.headers.get('vary') ?? '', /Accept-Language/i);
});

test('the privacy disclosure names the configured AI provider', () => {
  const html = renderLandingPage({
    packs: [{ id: 'pack100', questions: 100, amountCents: 300 }],
    trialQuestions: 180,
    currency: 'JPY',
    lang: 'en',
    aiProvider: 'deepseek',
  });
  assert.match(html, /AI provider \(DeepSeek\)/);
  assert.doesNotMatch(html, /\{\{AI_PROVIDER\}\}/);
});
