import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// The public product site at GET / — must carry everything a payment-provider review looks
// for: product description, live pricing, contact, and the Japanese commerce disclosure.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.CURRENCY = 'JPY';
process.env.QUOTA_POLICY_VERSION = 'legacy-test';
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
  assert.match(html, /Mac の画面から、一問ずつ/);            // hero (ja default)
  assert.match(html, /180 問ぶん無料|180問ぶん/);            // trial from config
  assert.match(html, /¥800/);                               // live pack price
  assert.match(html, /特定商取引法に基づく表記/);            // JP commerce disclosure
  assert.match(html, /プライバシーとデータ利用/);            // privacy
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
  assert.match(zh, /在 Mac 屏幕上，一次查清一道题/);
  assert.match(zh, /特定商取引法に基づく表記/);
  const en = await (await fetch(`${base}/?lang=en`)).text();
  assert.match(en, /One question, right on your Mac/);
  assert.match(en, /特定商取引法に基づく表記/);
});

test('Accept-Language negotiation picks zh/en; unknown falls back to ja', async () => {
  const zh = await (await fetch(`${base}/`, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })).text();
  assert.match(zh, /在 Mac 屏幕上，一次查清一道题/);
  const en = await (await fetch(`${base}/`, { headers: { 'accept-language': 'en-US,en;q=0.9' } })).text();
  assert.match(en, /One question, right on your Mac/);
  const fr = await (await fetch(`${base}/`, { headers: { 'accept-language': 'fr-FR' } })).text();
  assert.match(fr, /Mac の画面から、一問ずつ/);
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

test('both entry pages preserve their route across languages and use the shared distribution endpoint', async () => {
  for (const path of ['/spi', '/reading-practice']) for (const lang of ['ja', 'zh', 'en']) {
    const response = await fetch(`${base}${path}?lang=${lang}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const target of ['ja', 'zh', 'en']) assert.ok(html.includes(`href="${path}?lang=${target}"`));
    assert.match(html, /href="\/dl"/);
    assert.match(html, /¥800/);
    assert.doesNotMatch(html, /<script|github\.com|utm_source|device_token/i);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'.*frame-ancestors 'none'/);
  }
});

test('entry descriptions distinguish unsupported reading practice from the existing SPI entry', async () => {
  const reading = await (await fetch(`${base}/reading-practice?lang=en`)).text();
  assert.match(reading, /Practice reading questions on your Mac/);
  assert.match(reading, /Reading practice is not open yet/);
  assert.match(reading, /Authorized material and independent evaluation/);
  assert.match(reading, /You can skip the source choice/);
  assert.match(reading, /A download click is not an installation record/);
  const spi = await (await fetch(`${base}/spi?lang=en`)).text();
  assert.match(spi, /Prepare for SPI on your Mac/);
  assert.match(spi, /The existing SPI entry continues/);
  assert.match(spi, /Historical SPI results do not establish accuracy for all questions/);
});

test('beta reading scope remains explicit and fixed30 pricing renders from the current catalog', () => {
  const input = {packs: [{id:'current', questions:100, amountCents:500}], trialQuestions:30,
    currency:'USD', lang:'en' as const, aiProvider:'openai' as const, entry:'reading_practice' as const, entryStatus:'beta' as const};
  const html = renderLandingPage(input);
  assert.match(html, /Reading practice is in internal testing/);
  assert.match(html, /No public support combinations have completed independent evaluation/);
  assert.match(html, /30 free questions/); assert.match(html, /class="price">\$5<\/div>/); assert.match(html, /class="price">\$0<\/div>/);
  assert.doesNotMatch(html, /¥0|180 free questions|\{\{TRIAL\}\}|invisible|notarized|Most popular/i);
  for (const lang of ['zh', 'ja', 'en'] as const) {
    const page = renderLandingPage({...input, lang});
    const visibleCopy = page.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(visibleCopy, /绝对隐身|完全不可见|100%|必ず正解|always correct|unlimited free/i);
    assert.match(page, /raysyadesu@gmail\.com/);
  }
});
