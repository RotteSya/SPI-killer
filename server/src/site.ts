import type { QuestionPack } from './pricing.ts';
import { formatMoney, escapeHtml, type PageLang } from './payments.ts';

// The public product site, served at GET / — the "company website" for app users, curious
// visitors, and payment-provider review (Stripe activation requires a real product page with
// pricing, contact, and — for Japan — the 特定商取引法に基づく表記 disclosure, all included
// below). One self-contained page: inline CSS, inline SVG logo, zero external assets.
// Pricing renders from the LIVE pack catalog so the site can never drift from checkout.

// Every download button targets our own /dl endpoint, which tallies the click and then streams
// the DMG back from this origin (see routes.ts; the upstream location lives in config, not here).
// No link on this page may point off-site to where the app is built or hosted.
const DOWNLOAD = '/dl';
const CONTACT_EMAIL = 'raysyadesu@gmail.com';

export interface SiteInput {
  packs: readonly QuestionPack[];
  trialQuestions: number;
  currency: string;
  lang: PageLang;
  aiProvider: string;
}

/** ?lang wins; otherwise sniff Accept-Language; default Japanese (the selling entity is JP). */
export function resolveSiteLang(query: string, acceptLanguage: string): PageLang {
  const q = query.toLowerCase();
  if (q.startsWith('ja')) return 'ja';
  if (q.startsWith('zh')) return 'zh';
  if (q.startsWith('en')) return 'en';
  const a = acceptLanguage.toLowerCase();
  for (const part of a.split(',')) {
    const tag = part.trim();
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return 'ja';
}

/** The Rose (r = a·cos 2θ) as an inline SVG path — the app's signature mark. */
function roseSVGPath(): string {
  const pts: string[] = [];
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = 42 * Math.cos(2 * t);
    const x = 50 + Math.cos(t) * r;
    const y = 50 + Math.sin(t) * r;
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return pts.join('');
}

interface SiteStrings {
  metaDesc: string;
  navDownload: string;
  heroTitle: string;
  heroSub: string;
  heroCTA: string;
  heroCTASub: string;
  heroFree: (n: number) => string;
  mockQuestion: string;
  mockAnswerTitle: string;
  mockAnswerBody: string;
  mockStatus: string;
  howTitle: string;
  how: Array<{ t: string; d: string }>;
  featTitle: string;
  feats: Array<{ icon: string; t: string; d: string }>;
  priceTitle: string;
  priceSub: (n: number) => string;
  freeCard: { name: string; price: string; unit: (n: number) => string; note: string };
  packUnit: (n: number) => string;
  perQuestion: string;
  popular: string;
  priceNote: string;
  faqTitle: string;
  faqs: Array<{ q: string; a: string }>;
  legalTitle: string;
  privacyTitle: string;
  privacyBody: string[];
  refundTitle: string;
  refundBody: string[];
  reqNote: string;
  footerContact: string;
}

const S: Record<PageLang, SiteStrings> = {
  ja: {
    metaDesc: 'NotchSPI は MacBook のノッチにひそむ AI 解答アシスタント。ショートカットひとつで画面上の問題を読み取り、答えをノッチからストリーミング表示。最大180問無料。',
    navDownload: 'ダウンロード',
    heroTitle: 'ノッチにひそむ、解答アシスタント。',
    heroSub: 'ショートカットを押すだけ。画面上の問題を AI が読み取り、答えが MacBook のノッチからそっと流れ出します。画面録画・画面共有には一切映りません。',
    heroCTA: 'Mac 用に無料ダウンロード',
    heroCTASub: 'macOS 14+ · Apple 公証済み · アカウント登録不要',
    heroFree: (n) => `いま始めると最大 ${n} 問ぶん無料`,
    mockQuestion: '問題を画面に表示したまま…',
    mockAnswerTitle: '学習チューター',
    mockAnswerBody: 'この問題は等差数列の和を求めるものです。まず初項と公差を確認しましょう。a₁ = 3, d = 4 なので…',
    mockStatus: '完了 · 残り179問',
    howTitle: '使い方は 3 ステップ',
    how: [
      { t: '⇧⌘1 を押す', d: 'Web、PDF、テストアプリ — 問題が画面にあればどこでも。' },
      { t: '画面をそっと読み取り', d: 'スクリーンショットは回答生成にのみ使われ、即座に破棄されます。' },
      { t: 'ノッチから答えが流れる', d: '解説がリアルタイムでストリーミング表示。録画や共有画面には映りません。' },
    ],
    featTitle: 'まじめに作り込みました',
    feats: [
      { icon: '🎁', t: '最大180問ぶん無料', d: 'インストールするだけで無料枠。クレジットカード登録も不要。' },
      { icon: '🫥', t: '画面キャプチャに映らない', d: 'ノッチパネルは録画・共有・スクリーンショットから除外されます。' },
      { icon: '🌏', t: '日本語・中国語・英語', d: 'UI も答えの言語も切替可能。あいまいな問題は UI の言語で回答。' },
      { icon: '🎚', t: '解説の詳しさを 4 段階で', d: '答えだけ / ヒント / ガイド / 全過程。カプセルをタップで即切替。' },
      { icon: '🧭', t: '性格検査モード', d: 'SPI・玉手箱などの性格検査対策に。目指す人物像に沿った回答例を表示します。' },
      { icon: '🔐', t: 'アカウント不要', d: '匿名のデバイス連携のみ。メールもパスワードも要りません。' },
    ],
    priceTitle: '料金',
    priceSub: (n) => `新規ユーザーには最大 ${n} 問ぶんの無料枠。使い切ったら必要なぶんだけチャージ。サブスクではありません。`,
    freeCard: { name: 'おためし', price: '¥0', unit: (n) => `最大${n}問ぶん`, note: 'インストールで自動付与' },
    packUnit: (n) => `${n}問`,
    perQuestion: '1問あたり約',
    popular: '一番人気',
    priceNote: '1 回の回答につき 1 問消費。エラー時は消費されません。決済は Stripe が安全に処理します。',
    faqTitle: 'よくある質問',
    faqs: [
      { q: 'スクリーンショットは保存されますか？', a: 'いいえ。回答の生成にのみ使用し、処理後すぐに破棄します。学習にも利用しません。' },
      { q: '回答に失敗したら？', a: '1問も消費されません。成功した回答のみカウントされます。' },
      { q: '機種変更したら残高はどうなりますか？', a: '残高はデバイスに紐づきます。移行をご希望の場合はメールでご連絡ください。' },
      { q: '返金はできますか？', a: 'デジタル商品の性質上、チャージ後の返金は原則承っておりませんが、二重課金など当方の不具合による場合は全額返金いたします。下記の返金ポリシーをご覧ください。' },
      { q: '動作環境は？', a: 'ノッチ搭載の Apple Silicon Mac、macOS 14 以降。初回に画面収録の許可が必要です。' },
    ],
    legalTitle: '特定商取引法に基づく表記',
    privacyTitle: 'プライバシーポリシー',
    privacyBody: [
      '収集する情報：匿名のデバイス識別子（ランダム生成トークン）、質問数の残高と利用量（トークン数）。氏名・メールアドレス等の個人情報は収集しません。',
      'スクリーンショット：回答生成のためにのみ AI プロバイダー（{{AI_PROVIDER}}）へ送信され、当社サーバーには保存されません。処理後すぐに破棄されます。',
      '決済情報：Stripe, Inc. が処理します。カード情報が当社に渡ることはありません。',
      '第三者提供：法令に基づく場合を除き、収集した情報を第三者に提供しません。',
      'お問い合わせ・削除請求：下記メールアドレスまでご連絡ください。デバイス残高の削除に対応します。',
    ],
    refundTitle: '返金・キャンセルポリシー',
    refundBody: [
      'デジタル商品（質問数チャージ）の性質上、チャージ完了後のお客様都合による返金は原則承っておりません。',
      '二重課金・チャージ未反映など、当方の責によるトラブルの場合は全額返金いたします。お問い合わせから 7 日以内にメールでご連絡ください。',
      '回答の生成に失敗した場合、質問数は消費されません（自動的に保護されます）。',
    ],
    reqNote: 'macOS 14 以降・ノッチ搭載 Apple Silicon Mac',
    footerContact: 'お問い合わせ',
  },
  zh: {
    metaDesc: 'NotchSPI 是藏在 MacBook 刘海里的 AI 解题助手。一按快捷键，AI 读取屏幕上的题目，答案从刘海流出。录屏与共享画面完全不可见。最多赠送 180 题。',
    navDownload: '下载',
    heroTitle: '藏在刘海里的解题助手。',
    heroSub: '只需按下快捷键，AI 读取屏幕上的题目，答案从 MacBook 刘海悄悄流出——录屏和屏幕共享完全看不见它。',
    heroCTA: '免费下载 Mac 版',
    heroCTASub: 'macOS 14+ · Apple 公证 · 无需注册账号',
    heroFree: (n) => `现在开始最多送 ${n} 题`,
    mockQuestion: '题目留在屏幕上…',
    mockAnswerTitle: '学习辅导',
    mockAnswerBody: '这道题考察等差数列求和。先确认首项和公差：a₁ = 3，d = 4，代入求和公式…',
    mockStatus: '完成 · 剩余 179 题',
    howTitle: '三步用起来',
    how: [
      { t: '按下 ⇧⌘1', d: '网页、PDF、题库软件——题目在屏幕上就行。' },
      { t: '屏幕被轻轻读取', d: '截图只用于生成答案，用完立即销毁。' },
      { t: '答案从刘海流出', d: '讲解实时流式浮现，录屏与共享画面里都不可见。' },
    ],
    featTitle: '每个细节都认真打磨',
    feats: [
      { icon: '🎁', t: '免费最多送 180 题', d: '装上就有，无需绑卡、无需注册。' },
      { icon: '🫥', t: '截屏录屏都拍不到', d: '刘海面板被排除在录屏、共享和截图之外。' },
      { icon: '🌏', t: '中·日·英三语', d: '界面与答案语言均可切换，语言不明的题目按界面语言回答。' },
      { icon: '🎚', t: '讲解深度四档', d: '只要答案 / 提示 / 引导 / 完整推导，点胶囊即切。' },
      { icon: '🧭', t: '性格测试模式', d: '为 SPI、玉手箱等性格测试提供贴合目标人物像的作答参考。' },
      { icon: '🔐', t: '无需账号', d: '只有匿名设备绑定，不要邮箱不要密码。' },
    ],
    priceTitle: '价格',
    priceSub: (n) => `新用户最多送 ${n} 题免费额度，用完按需充值题包，没有订阅。`,
    freeCard: { name: '尝鲜', price: '¥0', unit: (n) => `最多 ${n} 题`, note: '安装即自动到账' },
    packUnit: (n) => `${n} 题`,
    perQuestion: '每题约',
    popular: '最受欢迎',
    priceNote: '每成功答一题消耗 1 题，失败不扣。支付由 Stripe 安全处理（日元结算）。',
    faqTitle: '常见问题',
    faqs: [
      { q: '截图会被保存吗？', a: '不会。截图只用于生成答案，处理后立即销毁，也不用于训练。' },
      { q: '答题失败会扣题吗？', a: '不会，只有成功的回答才计数。' },
      { q: '换电脑后余额怎么办？', a: '额度与设备绑定；如需迁移请邮件联系我们。' },
      { q: '可以退款吗？', a: '数字商品充值到账后原则上不退，但重复扣款等我方问题将全额退款，详见下方退款政策。' },
      { q: '系统要求？', a: '带刘海的 Apple Silicon Mac，macOS 14 及以上，首次使用需授予屏幕录制权限。' },
    ],
    legalTitle: '特定商取引法に基づく表記（日本法定披露）',
    privacyTitle: '隐私政策',
    privacyBody: [
      '收集的信息：匿名设备标识（随机生成的令牌）、题数余额与用量（token 数）。不收集姓名、邮箱等个人信息。',
      '截图：仅为生成答案发送给 AI 服务方（{{AI_PROVIDER}}），不在我方服务器留存，处理后立即销毁。',
      '支付信息：由 Stripe, Inc. 处理，我方不接触任何卡片信息。',
      '第三方提供：除法律要求外，不向第三方提供收集的信息。',
      '咨询与删除请求：请通过下方邮箱联系，我们支持删除设备余额数据。',
    ],
    refundTitle: '退款与取消政策',
    refundBody: [
      '题数充值属数字商品，到账后原则上不支持因个人原因的退款。',
      '如遇重复扣款、支付后未到账等我方原因的问题，将全额退款；请在 7 天内邮件联系。',
      '答题失败不消耗题数（系统自动保障）。',
    ],
    reqNote: 'macOS 14+ · 带刘海的 Apple Silicon Mac',
    footerContact: '联系我们',
  },
  en: {
    metaDesc: 'NotchSPI is the AI answer assistant hiding in your MacBook notch. One hotkey reads the question on your screen and streams the answer from the notch — invisible to recordings and screen shares. Up to 180 questions free.',
    navDownload: 'Download',
    heroTitle: 'The answer assistant hiding in your notch.',
    heroSub: 'Press one hotkey. AI reads the question on your screen and the answer flows quietly from your MacBook’s notch — invisible to screen recordings and shares.',
    heroCTA: 'Download free for Mac',
    heroCTASub: 'macOS 14+ · Notarized by Apple · No account needed',
    heroFree: (n) => `Start with up to ${n} free questions`,
    mockQuestion: 'Your question stays on screen…',
    mockAnswerTitle: 'Study Tutor',
    mockAnswerBody: 'This is an arithmetic series. First identify the first term and common difference: a₁ = 3, d = 4, then apply the sum formula…',
    mockStatus: 'Done · 179 questions left',
    howTitle: 'Three steps',
    how: [
      { t: 'Press ⇧⌘1', d: 'Web pages, PDFs, quiz apps — anywhere a question is on screen.' },
      { t: 'Your screen is read, gently', d: 'The screenshot is used only to generate the answer, then destroyed.' },
      { t: 'The answer flows from the notch', d: 'Streams in real time — never visible in recordings or shares.' },
    ],
    featTitle: 'Obsessively crafted',
    feats: [
      { icon: '🎁', t: 'Up to 180 questions free', d: 'Just install. No card, no sign-up.' },
      { icon: '🫥', t: 'Invisible to capture', d: 'The notch panel is excluded from recordings, shares, and screenshots.' },
      { icon: '🌏', t: 'Japanese · Chinese · English', d: 'Switch the UI and answer language anytime.' },
      { icon: '🎚', t: 'Four explanation depths', d: 'Answer-only / hints / guided / full working. One tap to cycle.' },
      { icon: '🧭', t: 'Personality-test mode', d: 'Shows reference answers for SPI-style aptitude questionnaires, aligned to your target persona.' },
      { icon: '🔐', t: 'No account', d: 'Anonymous device binding only. No email, no password.' },
    ],
    priceTitle: 'Pricing',
    priceSub: (n) => `Up to ${n} free questions for every new user. Top up only when you need more — no subscription.`,
    freeCard: { name: 'Starter', price: '¥0', unit: (n) => `up to ${n} questions`, note: 'Granted on install' },
    packUnit: (n) => `${n} questions`,
    perQuestion: 'about',
    popular: 'Most popular',
    priceNote: 'Each successful answer costs one question; failures are never charged. Payments handled securely by Stripe (JPY).',
    faqTitle: 'FAQ',
    faqs: [
      { q: 'Are my screenshots stored?', a: 'No. They are used only to generate the answer, destroyed right after, and never used for training.' },
      { q: 'What if an answer fails?', a: 'You are not charged — only successful answers count.' },
      { q: 'What about my balance on a new Mac?', a: 'Credits are tied to the device; email us to migrate.' },
      { q: 'Can I get a refund?', a: 'Digital credits are generally non-refundable once delivered, but our-fault issues (double charges etc.) are fully refunded — see the policy below.' },
      { q: 'Requirements?', a: 'An Apple Silicon Mac with a notch, macOS 14+. Screen-recording permission is requested on first use.' },
    ],
    legalTitle: '特定商取引法に基づく表記 (Japanese commerce disclosure)',
    privacyTitle: 'Privacy Policy',
    privacyBody: [
      'What we collect: an anonymous device identifier (random token), question balance, and usage (token counts). No names, emails, or other personal data.',
      'Screenshots: sent to the AI provider ({{AI_PROVIDER}}) solely to generate the answer; never stored on our servers; destroyed after processing.',
      'Payments: processed by Stripe, Inc. Card details never reach us.',
      'Third parties: we do not share collected data except as required by law.',
      'Contact & deletion: email us below; we will delete device balance data on request.',
    ],
    refundTitle: 'Refund & Cancellation Policy',
    refundBody: [
      'Question credits are digital goods and are generally non-refundable after delivery.',
      'Issues caused by us — double charges, credits not delivered — are fully refunded; email within 7 days.',
      'Failed answers never consume credits (enforced automatically).',
    ],
    reqNote: 'macOS 14+ · Apple Silicon Mac with a notch',
    footerContact: 'Contact',
  },
};

/** 特定商取引法 disclosure — kept in Japanese in every UI language (it is a JP legal text). */
function tokushohoTable(): string {
  const rows: Array<[string, string]> = [
    ['販売業者', 'NotchSPI（個人事業）'],
    ['運営責任者', 'SHE LINGZHAO'],
    ['所在地・電話番号', 'ご請求をいただければ遅滞なく開示いたします'],
    ['お問い合わせ', `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>（メールにて受付）`],
    ['販売価格', '各チャージページに表示の金額（消費税込み）'],
    ['商品代金以外の必要料金', 'なし（通信料はお客様負担）'],
    ['お支払い方法', 'クレジットカード等（Stripe 決済）'],
    ['支払時期', 'ご購入手続き完了時'],
    ['商品の引渡時期', '決済完了後、ただちに質問数残高へ反映'],
    ['返品・キャンセル', 'デジタル商品の性質上、チャージ後の返金は原則不可。当方の不具合による場合は全額返金いたします（返金ポリシー参照）'],
    ['動作環境', 'ノッチ搭載の Apple Silicon Mac / macOS 14 以降'],
  ];
  return rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join('\n');
}

export function renderLandingPage(input: SiteInput): string {
  const s = S[input.lang];
  const langAttr = input.lang === 'zh' ? 'zh-CN' : input.lang;
  const rose = roseSVGPath();
  const providerName = input.aiProvider === 'deepseek' ? 'DeepSeek'
    : input.aiProvider === 'anthropic' ? 'Anthropic'
      : input.aiProvider === 'openai' ? 'OpenAI' : 'AI';

  const popularIdx = input.packs.length >= 2 ? 1 : 0;
  const packCards = input.packs
    .map((p, i) => {
      const per = `${s.perQuestion} ${formatMoney(Math.round(p.amountCents / p.questions), input.currency)}`;
      const badge = i === popularIdx ? `<div class="badge">${s.popular}</div>` : '';
      return `<div class="card${i === popularIdx ? ' popular' : ''}">
  ${badge}
  <div class="q">${s.packUnit(p.questions)}</div>
  <div class="price">${formatMoney(p.amountCents, input.currency)}</div>
  <div class="per">${per}</div>
</div>`;
    })
    .join('\n');

  const howCards = s.how
    .map((h, i) => `<div class="step"><div class="stepnum">${i + 1}</div><h3>${h.t}</h3><p>${h.d}</p></div>`)
    .join('\n');

  const featCards = s.feats
    .map((f) => `<div class="feat"><div class="ficon">${f.icon}</div><h3>${escapeHtml(f.t)}</h3><p>${escapeHtml(f.d)}</p></div>`)
    .join('\n');

  const faqItems = s.faqs
    .map((f) => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`)
    .join('\n');

  const privacy = s.privacyBody
    .map((p) => `<p>${escapeHtml(p.replaceAll('{{AI_PROVIDER}}', providerName))}</p>`)
    .join('\n');
  const refund = s.refundBody.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');

  const langLink = (l: PageLang, label: string) =>
    `<a class="lang${input.lang === l ? ' on' : ''}" href="/?lang=${l}">${label}</a>`;

  return `<!doctype html>
<html lang="${langAttr}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NotchSPI — ${s.heroTitle}</title>
<meta name="description" content="${escapeHtml(s.metaDesc)}">
<meta property="og:title" content="NotchSPI">
<meta property="og:description" content="${escapeHtml(s.metaDesc)}">
<style>
  :root { --accent:#7aa0ff; --accent-hi:#a3bdff; --ink:#eef1f8; --dim:#9aa3bd; --faint:#626b85; }
  * { box-sizing:border-box; margin:0; }
  html { scroll-behavior:smooth; }
  body {
    font: 16px/1.7 -apple-system, "Hiragino Sans", "PingFang SC", system-ui, sans-serif;
    color:var(--ink); background:#05060c; overflow-x:clip;
  }
  .bg {
    position:fixed; inset:0; z-index:-1;
    background:
      radial-gradient(1100px 520px at 70% -8%, rgba(60,80,180,.35) 0%, transparent 60%),
      radial-gradient(900px 500px at 12% 30%, rgba(90,60,160,.16) 0%, transparent 55%),
      radial-gradient(1200px 600px at 50% 110%, rgba(35,90,120,.15) 0%, transparent 60%),
      #05060c;
  }
  .wrap { max-width: 1020px; margin:0 auto; padding:0 24px; }
  a { color:var(--accent-hi); text-decoration:none; }

  header { display:flex; align-items:center; gap:14px; padding:22px 0; flex-wrap:wrap; row-gap:10px; }
  .logo { display:flex; align-items:center; gap:10px; font-weight:700; font-size:18px; color:var(--ink); }
  .logo svg { width:26px; height:26px; }
  .spacer { flex:1; }
  .lang { font-size:13px; color:var(--faint); padding:4px 8px; border-radius:8px; }
  .lang.on { color:var(--ink); background:rgba(255,255,255,.08); }
  .navbtn {
    font-size:14px; font-weight:600; color:#0b0e1a; padding:8px 16px; border-radius:10px;
    background:linear-gradient(180deg,var(--accent-hi),var(--accent));
  }

  .hero { text-align:center; padding:64px 0 30px; }
  .hero h1 { font-size:clamp(30px,5.4vw,52px); font-weight:800; letter-spacing:-.01em; line-height:1.2; }
  .hero .sub { max-width:640px; margin:20px auto 0; color:var(--dim); font-size:17px; }
  .freeTag {
    display:inline-block; margin-top:22px; font-size:14px; font-weight:600; color:var(--accent-hi);
    border:1px solid rgba(122,160,255,.4); background:rgba(122,160,255,.08);
    padding:6px 16px; border-radius:999px;
  }
  .cta { margin-top:26px; display:flex; flex-direction:column; align-items:center; gap:10px; }
  .dl {
    display:inline-block; font-size:17px; font-weight:700; color:#0b0e1a; padding:14px 34px;
    border-radius:14px; background:linear-gradient(180deg,var(--accent-hi),var(--accent));
    box-shadow:0 8px 32px rgba(122,160,255,.25); transition:transform .15s ease, box-shadow .15s ease;
  }
  .dl:hover { transform:translateY(-2px); box-shadow:0 12px 40px rgba(122,160,255,.35); }
  .ctasub { font-size:12.5px; color:var(--faint); }

  /* CSS mockup: a MacBook-ish top edge with the notch panel expanded */
  .mock { margin:56px auto 0; max-width:760px; }
  .screen {
    border:1px solid rgba(255,255,255,.10); border-bottom:none;
    border-radius:18px 18px 0 0; padding:0 0 150px;
    background:linear-gradient(180deg, rgba(28,34,64,.55), rgba(10,12,24,.65));
    overflow:hidden;
  }
  .menubar { height:34px; display:flex; justify-content:center; align-items:flex-start; }
  .notch {
    width:min(400px, calc(100vw - 72px)); background:#000; border-radius:0 0 18px 18px;
    padding:14px 18px 16px; text-align:left;
    box-shadow:0 14px 44px rgba(0,0,0,.6);
  }
  .nhead { display:flex; align-items:center; gap:8px; font-size:12.5px; white-space:nowrap; }
  .nhead svg { width:13px; height:13px; }
  .nmode { font-weight:600; color:rgba(255,255,255,.95); }
  .nmode,.ncap { flex-shrink:0; }
  .nstat { color:rgba(255,255,255,.55); overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .ncap { margin-left:auto; font-size:10.5px; color:rgba(255,255,255,.6);
    background:rgba(255,255,255,.1); padding:2px 9px; border-radius:999px; }
  .nbody { margin-top:10px; font-size:12.5px; color:rgba(255,255,255,.9); line-height:1.65; }
  .cursor { display:inline-block; width:7px; height:13px; background:var(--accent-hi);
    vertical-align:-2px; border-radius:1px; animation:blink 1.1s steps(1) infinite; }
  @keyframes blink { 50% { opacity:0; } }
  .mockq { text-align:center; font-size:12.5px; color:var(--faint); margin-top:12px; }

  section { padding:72px 0 0; }
  section > h2 { text-align:center; font-size:clamp(24px,3.6vw,34px); font-weight:800; }
  .secsub { text-align:center; color:var(--dim); margin-top:10px; }

  .steps { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:18px; margin-top:36px; }
  .step { border:1px solid rgba(255,255,255,.09); border-radius:16px; padding:24px; background:rgba(255,255,255,.03); }
  .stepnum { width:30px; height:30px; border-radius:999px; display:flex; align-items:center; justify-content:center;
    font-weight:700; font-size:14px; color:#0b0e1a; background:linear-gradient(180deg,var(--accent-hi),var(--accent)); }
  .step h3 { margin-top:14px; font-size:16.5px; }
  .step p { margin-top:8px; color:var(--dim); font-size:14px; }

  .feats { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:18px; margin-top:36px; }
  .feat { border:1px solid rgba(255,255,255,.09); border-radius:16px; padding:22px; background:rgba(255,255,255,.03); }
  .ficon { font-size:24px; }
  .feat h3 { margin-top:10px; font-size:16px; }
  .feat p { margin-top:6px; color:var(--dim); font-size:13.5px; }

  .packs { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:16px; margin-top:36px; }
  .card { position:relative; border:1px solid rgba(255,255,255,.10); border-radius:16px;
    padding:24px 18px; background:rgba(255,255,255,.04); text-align:center; }
  .card.popular { border-color:rgba(122,160,255,.55); background:rgba(122,160,255,.07); }
  .badge { position:absolute; top:-11px; left:50%; transform:translateX(-50%); white-space:nowrap;
    background:linear-gradient(90deg,var(--accent),var(--accent-hi)); color:#0b0e1a;
    font-size:11px; font-weight:700; padding:3px 12px; border-radius:999px; }
  .card .q { font-size:19px; font-weight:700; }
  .card .price { font-size:30px; font-weight:800; margin-top:8px; }
  .card .per, .card .note { color:var(--faint); font-size:12px; margin-top:8px; }
  .pricenote { text-align:center; color:var(--faint); font-size:13px; margin-top:22px; }

  .faq { max-width:720px; margin:32px auto 0; }
  details { border-bottom:1px solid rgba(255,255,255,.08); padding:16px 4px; }
  summary { cursor:pointer; font-weight:600; font-size:15.5px; list-style:none; display:flex; }
  summary::after { content:'+'; margin-left:auto; color:var(--faint); font-weight:400; }
  details[open] summary::after { content:'−'; }
  details p { margin-top:10px; color:var(--dim); font-size:14px; }

  .legal { max-width:760px; margin:36px auto 0; font-size:13.5px; color:var(--dim); }
  .legal h3 { color:var(--ink); font-size:16px; margin:34px 0 12px; }
  .legal p { margin-top:8px; }
  .legal table { width:100%; border-collapse:collapse; margin-top:12px; }
  .legal th, .legal td { text-align:left; padding:10px 12px; border:1px solid rgba(255,255,255,.09);
    vertical-align:top; font-weight:400; font-size:13px; word-break:break-word; }
  .legal th { width:34%; color:var(--ink); background:rgba(255,255,255,.03); }

  footer { margin-top:80px; padding:34px 0 44px; border-top:1px solid rgba(255,255,255,.08);
    text-align:center; color:var(--faint); font-size:13px; }
  footer .logo { justify-content:center; font-size:15px; margin-bottom:10px; }
  footer a { color:var(--dim); }
</style></head>
<body>
<div class="bg"></div>
<div class="wrap">

<header>
  <div class="logo">
    <svg viewBox="0 0 100 100" fill="none"><path d="${rose}" stroke="#a3bdff" stroke-width="4" stroke-linecap="round"/></svg>
    NotchSPI
  </div>
  <div class="spacer"></div>
  ${langLink('ja', '日本語')} ${langLink('zh', '中文')} ${langLink('en', 'EN')}
  <a class="navbtn" href="${DOWNLOAD}">${s.navDownload}</a>
</header>

<div class="hero">
  <h1>${s.heroTitle}</h1>
  <p class="sub">${escapeHtml(s.heroSub)}</p>
  <div class="freeTag">🎁 ${s.heroFree(input.trialQuestions)}</div>
  <div class="cta">
    <a class="dl" href="${DOWNLOAD}">${s.heroCTA}</a>
    <div class="ctasub">${s.heroCTASub}</div>
  </div>

  <div class="mock">
    <div class="screen">
      <div class="menubar">
        <div class="notch">
          <div class="nhead">
            <svg viewBox="0 0 100 100" fill="none"><path d="${rose}" stroke="#a3bdff" stroke-width="6" stroke-linecap="round"/></svg>
            <span class="nmode">${s.mockAnswerTitle}</span>
            <span class="nstat">${s.mockStatus}</span>
            <span class="ncap">⇧⌘1</span>
          </div>
          <div class="nbody">${escapeHtml(s.mockAnswerBody)}<span class="cursor"></span></div>
        </div>
      </div>
    </div>
    <div class="mockq">${s.mockQuestion}</div>
  </div>
</div>

<section id="how">
  <h2>${s.howTitle}</h2>
  <div class="steps">${howCards}</div>
</section>

<section id="features">
  <h2>${s.featTitle}</h2>
  <div class="feats">${featCards}</div>
</section>

<section id="pricing">
  <h2>${s.priceTitle}</h2>
  <p class="secsub">${s.priceSub(input.trialQuestions)}</p>
  <div class="packs">
    <div class="card">
      <div class="q">${s.freeCard.name}</div>
      <div class="price">${s.freeCard.price}</div>
      <div class="per">${s.freeCard.unit(input.trialQuestions)} · ${s.freeCard.note}</div>
    </div>
    ${packCards}
  </div>
  <p class="pricenote">${escapeHtml(s.priceNote)}</p>
</section>

<section id="faq">
  <h2>${s.faqTitle}</h2>
  <div class="faq">${faqItems}</div>
</section>

<section id="legal">
  <div class="legal">
    <h3 id="tokushoho">${s.legalTitle}</h3>
    <table>${tokushohoTable()}</table>
    <h3 id="privacy">${s.privacyTitle}</h3>
    ${privacy}
    <h3 id="refund">${s.refundTitle}</h3>
    ${refund}
  </div>
</section>

<footer>
  <div class="logo">
    <svg viewBox="0 0 100 100" fill="none" width="18" height="18"><path d="${rose}" stroke="#7aa0ff" stroke-width="5" stroke-linecap="round"/></svg>
    NotchSPI
  </div>
  <div>${s.reqNote}</div>
  <div style="margin-top:8px">
    ${s.footerContact}: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> ·
    <a href="#tokushoho">特定商取引法に基づく表記</a>
  </div>
  <div style="margin-top:10px">© 2026 NotchSPI (SHE LINGZHAO)</div>
</footer>

</div>
</body></html>`;
}
