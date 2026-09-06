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
  entry?: 'spi' | 'reading_practice';
  entryStatus?: 'beta' | 'disabled';
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
  zh: {
  metaDesc: "NotchSPI：Mac 屏幕查题助手。新设备注册一次性获得免费额度，按题包付费。",
  navDownload: "下载",
  heroTitle: "在 Mac 屏幕上，一次查清一道题。",
  heroSub: "选择屏幕上的一道题，在原位置附近查看答案。NotchSPI 是从刘海或屏幕顶部面板使用的 AI 学习助手。",
  heroCTA: "免费下载 Mac 版",
  heroCTASub: "macOS 14+ · Apple Silicon · 无需注册账号",
  heroFree: (n: number) => "新设备首次注册，一次性获得 {n} 题".replace('{n}', String(n)),
  mockQuestion: "操作说明 · 实际答案取决于你的题目",
  mockAnswerTitle: "屏幕查题",
  mockAnswerBody: "将一道题和选项显示在屏幕上，按 ⇧⌘1。答案生成后，请对照原题核验。",
  mockStatus: "准备查题",
  howTitle: "从题目到答案",
  how: [
  {
    "t": "显示一道完整题目",
    "d": "准备好题干和选项，按 ⇧⌘1。题型、语言和版面以已公布的支持范围为准。"
  },
  {
    "t": "查看并核对答案",
    "d": "当前选用的 AI 服务处理截图。得到答案后，对照原题核验。"
  },
  {
    "t": "继续你的学习",
    "d": "看不清时重新截图，缺材料时补齐。官方服务的实际余额可在 App 中核对。"
  }
],
  featTitle: "围绕一次查题任务",
  feats: [
  {
    "icon": "🎁",
    "t": "新设备注册免费 {{TRIAL}} 题",
    "d": "一次性发放，历史余额保留，无需绑卡。"
  },
  {
    "icon": "◉",
    "t": "工作状态可见",
    "d": "由你控制开始和停止。不能保证第三方录屏或共享工具看不到面板。"
  },
  {
    "icon": "🌏",
    "t": "中·日·英界面",
    "d": "界面语言可切换。语言选择不会改变已验证的支持范围。"
  },
  {
    "icon": "⌘",
    "t": "快捷键查题",
    "d": "在当前材料附近查看答案，减少复制粘贴。"
  },
  {
    "icon": "🧭",
    "t": "保留 SPI 入口",
    "d": "SPI 备考与阅读练习使用同一 App；能力按实际开放范围启用。"
  },
  {
    "icon": "🔐",
    "t": "无需账号密码",
    "d": "额度绑定本机设备凭证，请妥善保留。"
  }
],
  priceTitle: "题包价格",
  priceSub: (n: number) => "新设备注册一次性获得 {n} 题，历史余额完整保留。需要时按题包购买，无订阅。".replace('{n}', String(n)),
  freeCard: {
  name: "免费体验",
  price: "0",
  unit: (n: number) => "{n} 题".replace('{n}', String(n)),
  note: "首次设备注册一次性发放",
},
  packUnit: (n: number) => "{n} 题".replace('{n}', String(n)),
  perQuestion: "平均每题约",
  popular: "题包",
  priceNote: "一次请求交付可用答案扣 1 题；没有可用答案的失败不扣。可用不等于保证答对，重新执行是新请求。支付由 Stripe 处理。",
  faqTitle: "常见问题",
  faqs: [
  {
    "q": "截图会被保存吗？",
    "a": "默认服务端不保存图片和答案正文。新题组材料在本机最多保留 15 分钟；你主动导出的反馈文件会保留到自行删除。"
  },
  {
    "q": "答题失败会扣题吗？",
    "a": "没有可用答案的失败不扣题。断线后请先核对本次结算状态；再次执行可能产生新请求。"
  },
  {
    "q": "换电脑后余额怎么办？",
    "a": "额度与设备凭证绑定；如需迁移请邮件联系支持。"
  },
  {
    "q": "可以退款吗？",
    "a": "题包退款规则见下方政策。答错反馈需核验，额度补偿与现金退款分别处理。"
  },
  {
    "q": "系统要求？",
    "a": "Apple Silicon Mac，macOS 14 及以上。无刘海屏幕使用顶部面板；首次使用需授予屏幕录制权限。"
  }
],
  legalTitle: "特定商取引法に基づく表記（日本法定披露）",
  privacyTitle: "隐私与数据使用",
  privacyBody: [
  "服务记录包含随机设备凭证、额度、请求结算、模型用量与成本及付款核对信息。正常注册无需姓名和邮箱。",
  "官方服务将截图和必要指令交给 AI 服务方（{{AI_PROVIDER}}）处理，实际模型按服务配置选择。图片、题目和答案正文不写入默认数据库或日志。自带 Key 时由你选择的服务处理。",
  "支付由 Stripe 处理，我方不接收卡片信息。支持邮件及你主动提交的材料按相应用途单独处理。",
  "自愿的可靠性数据可在设置关闭。关闭即删除待发送队列并停止行为上传，必要的计费记录仍保留。详细事件保留 90 天，本机待发送队列最多 7 天。",
  "来源选择可在首次引导跳过。你选择的来源与本机注册关联，不根据题目场景或界面语言推断来源。",
  "问题反馈先预览并导出到本机，由你自行提交。默认仅排查本次问题；质量评测用途需另选，授权最长 90 天，外部模型处理需另行同意。收取的材料在到期或撤回时删除，本机原件由你删除。咨询、撤回或删除请联系下方邮箱，并附导出文件中的反馈编号。"
],
  refundTitle: "退款与取消政策",
  refundBody: [
  "题数充值属数字商品，到账后原则上不支持因个人原因的退款。",
  "如遇重复扣款、支付后未到账等我方原因的问题，将全额退款；请在 7 天内邮件联系。",
  "答题失败不消耗题数（系统自动保障）。"
],
  reqNote: "macOS 14+ · Apple Silicon Mac",
  footerContact: "联系我们",
},
  ja: {
  metaDesc: "NotchSPI は Mac の画面から使う AI 学習アシスタントです。新規デバイス登録時に一度だけ無料枠を付与します。",
  navDownload: "ダウンロード",
  heroTitle: "Mac の画面から、一問ずつ。",
  heroSub: "画面上の一問を選び、回答をその場で確認。NotchSPI はノッチや画面上部のパネルから使える AI 学習アシスタントです。",
  heroCTA: "Mac 用に無料ダウンロード",
  heroCTASub: "macOS 14+ · Apple Silicon · アカウント登録不要",
  heroFree: (n: number) => "新規デバイス登録時に一度だけ {n} 問ぶん無料".replace('{n}', String(n)),
  mockQuestion: "操作案内 · 回答内容は問題によって異なります",
  mockAnswerTitle: "画面の問題",
  mockAnswerBody: "一問と選択肢を画面に表示し、⇧⌘1。生成された回答は、元の問題と照らし合わせて確認してください。",
  mockStatus: "準備",
  howTitle: "問題から回答へ",
  how: [
  {
    "t": "一問を表示する",
    "d": "問題文と選択肢を揃え、⇧⌘1。対応する題型・言語・レイアウトは公開範囲を確認してください。"
  },
  {
    "t": "回答を確認する",
    "d": "選択中の AI サービスが画像を処理します。回答を元の問題と照らし合わせます。"
  },
  {
    "t": "次の学習へ進む",
    "d": "読めない部分は撮り直し、必要な材料を揃えます。公式サービスの残高はアプリで確認できます。"
  }
],
  featTitle: "一回の学習を支える機能",
  feats: [
  {
    "icon": "🎁",
    "t": "新規登録時に{{TRIAL}}問無料",
    "d": "一度だけ付与。既存残高は維持され、カード登録も不要です。"
  },
  {
    "icon": "◉",
    "t": "動作状況が見える",
    "d": "開始・停止を自分で操作できます。他社の録画や画面共有から見えなくなることは保証しません。"
  },
  {
    "icon": "🌏",
    "t": "日本語・中国語・英語 UI",
    "d": "表示言語を切り替えられます。言語の選択によって検証済みの対応範囲が広がることはありません。"
  },
  {
    "icon": "⌘",
    "t": "ショートカットで質問",
    "d": "表示中の材料の近くで回答を確認し、コピー操作を減らします。"
  },
  {
    "icon": "🧭",
    "t": "SPI の入口を維持",
    "d": "SPI 対策と読解練習は同じアプリを利用し、機能は公開範囲に応じて有効になります。"
  },
  {
    "icon": "🔐",
    "t": "アカウント不要",
    "d": "残高はデバイス認証情報に紐づきます。認証情報は大切に保管してください。"
  }
],
  priceTitle: "題数パック",
  priceSub: (n: number) => "新規デバイス登録時に {n} 問ぶんを一度だけ付与。既存の残高は維持されます。必要な分だけ追加購入でき、サブスクはありません。".replace('{n}', String(n)),
  freeCard: {
  name: "おためし",
  price: "0",
  unit: (n: number) => "{n}問ぶん".replace('{n}', String(n)),
  note: "初回のデバイス登録で一度だけ",
},
  packUnit: (n: number) => "{n}問".replace('{n}', String(n)),
  perQuestion: "1問あたり約",
  popular: "題数パック",
  priceNote: "一つの依頼で利用可能な回答を受け取ると 1 問分を消費。回答なしの失敗は消費しません。利用可能は正解保証ではありません。別の再実行は新しい依頼です。決済は Stripe が処理します。",
  faqTitle: "よくある質問",
  faqs: [
  {
    "q": "スクリーンショットは保存されますか？",
    "a": "通常のサーバー処理では画像や回答本文を保存しません。新しい材料グループは本機で最大 15 分保持。自分で書き出したフィードバックは自分で削除するまで残ります。"
  },
  {
    "q": "回答に失敗したら？",
    "a": "利用可能な回答がない失敗では消費しません。切断した場合は精算状況を確認してください。再実行は新しい依頼になる場合があります。"
  },
  {
    "q": "機種変更したら残高は？",
    "a": "残高はデバイス認証情報に紐づきます。移行はメールでサポートにご相談ください。"
  },
  {
    "q": "返金はできますか？",
    "a": "下記の返金ポリシーをご覧ください。誤答の報告は確認が必要で、題数の補償と返金は別に処理します。"
  },
  {
    "q": "動作環境は？",
    "a": "Apple Silicon Mac、macOS 14 以降。ノッチのない画面では上部パネルを使います。初回に画面収録の許可が必要です。"
  }
],
  legalTitle: "特定商取引法に基づく表記",
  privacyTitle: "プライバシーとデータ利用",
  privacyBody: [
  "サービス記録にはランダムなデバイス認証情報、残高、依頼の精算、モデル利用量・費用、決済の照合情報を含みます。通常の登録に氏名やメールは不要です。",
  "公式サービスでは画像と必要な指示を AI プロバイダー（{{AI_PROVIDER}}）で処理します。実際のモデル構成は配信設定に従います。画像・問題・回答本文は通常のデータベースやログに保存しません。自分のキーでは選択したサービスを利用します。",
  "決済は Stripe が処理し、カード情報は当方には届きません。問い合わせメールや自発的に提供された材料は、その用途に沿って別に扱います。",
  "任意の信頼性データは設定で停止できます。停止時に未送信キューを消去し、行動記録を送りません。必要な請求記録は残ります。詳細イベントは 90 日、本機の送信待ちは最大 7 日です。",
  "入口の回答は任意で、初回案内からスキップできます。選んだ回答はデバイス登録と関連付けます。問題の種類や表示言語から入口を推測しません。",
  "問題フィードバックは確認して本機へ書き出し、自分で送信します。標準では今回の問題調査のみ。品質評価は別途選び、許諾は最大 90 日間です。外部モデル処理は別の同意が必要です。受領資料は期限・撤回時に削除し、本機の原本は自分で削除してください。問い合わせ・撤回・削除は下記メールへ、書き出したファイルのフィードバック番号を添えてください。"
],
  refundTitle: "返金・キャンセルポリシー",
  refundBody: [
  "デジタル商品（質問数チャージ）の性質上、チャージ完了後のお客様都合による返金は原則承っておりません。",
  "二重課金・チャージ未反映など、当方の責によるトラブルの場合は全額返金いたします。お問い合わせから 7 日以内にメールでご連絡ください。",
  "回答の生成に失敗した場合、質問数は消費されません（自動的に保護されます）。"
],
  reqNote: "macOS 14 以降・Apple Silicon Mac",
  footerContact: "お問い合わせ",
},
  en: {
  metaDesc: "NotchSPI is an AI study assistant for questions on your Mac screen. New devices receive a one-time free grant, with question packs for further use.",
  navDownload: "Download",
  heroTitle: "One question, right on your Mac.",
  heroSub: "Select a question on screen and review the answer nearby. NotchSPI is an AI study assistant in your notch or at the top of your display.",
  heroCTA: "Download free for Mac",
  heroCTASub: "macOS 14+ · Apple Silicon · No account needed",
  heroFree: (n: number) => "{n} free questions, once on first device registration".replace('{n}', String(n)),
  mockQuestion: "How to use it · Actual answers depend on your question",
  mockAnswerTitle: "Screen question",
  mockAnswerBody: "Show one question and its options, then press ⇧⌘1. Check the generated answer against the original question.",
  mockStatus: "Ready to start",
  howTitle: "From question to answer",
  how: [
  {
    "t": "Show one complete question",
    "d": "Include the question and options, then press ⇧⌘1. Check the published support for question types, languages and layouts."
  },
  {
    "t": "Review the answer",
    "d": "Your selected AI service processes the screenshot. Compare the answer with the original question."
  },
  {
    "t": "Continue studying",
    "d": "Retake unclear images and supply missing material. Check the actual official-service balance in the app."
  }
],
  featTitle: "Built around one question",
  feats: [
  {
    "icon": "🎁",
    "t": "{{TRIAL}} questions on first registration",
    "d": "A one-time grant. Existing balances are preserved; no card is required."
  },
  {
    "icon": "◉",
    "t": "Visible working state",
    "d": "You control when it starts and stops. Invisibility to third-party recording or sharing tools is not guaranteed."
  },
  {
    "icon": "🌏",
    "t": "Japanese · Chinese · English UI",
    "d": "Switch the interface language. This does not expand the evaluated support range."
  },
  {
    "icon": "⌘",
    "t": "A hotkey for your question",
    "d": "Review the answer near your material, with less copying and pasting."
  },
  {
    "icon": "🧭",
    "t": "The SPI entry stays",
    "d": "SPI preparation and reading practice use the same app, with features enabled for their released scope."
  },
  {
    "icon": "🔐",
    "t": "No account password",
    "d": "Credits are tied to this device credential. Keep it safe."
  }
],
  priceTitle: "Question packs",
  priceSub: (n: number) => "New device registrations receive {n} questions once. Existing balances are preserved. Buy question packs when needed, with no subscription.".replace('{n}', String(n)),
  freeCard: {
  name: "Try it",
  price: "0",
  unit: (n: number) => "{n} questions".replace('{n}', String(n)),
  note: "Once on first device registration",
},
  packUnit: (n: number) => "{n} questions".replace('{n}', String(n)),
  perQuestion: "Per question, about",
  popular: "Question pack",
  priceNote: "One request delivering a usable answer costs one question. Failures without a usable answer are not charged. Usable does not guarantee correct; running it again is a new request. Stripe processes payments.",
  faqTitle: "FAQ",
  faqs: [
  {
    "q": "Are my screenshots stored?",
    "a": "The server does not store images or answer text by default. New question groups keep local material for up to 15 minutes. Feedback files you export remain until you delete them."
  },
  {
    "q": "What if an answer fails?",
    "a": "A failure without a usable answer is not charged. After a disconnect, check settlement first. Running it again may create a new request."
  },
  {
    "q": "What about my balance on a new Mac?",
    "a": "Credits are tied to the device credential. Contact support by email about migration."
  },
  {
    "q": "Can I get a refund?",
    "a": "See the policy below. Reports of incorrect answers require review; credit compensation and cash refunds are handled separately."
  },
  {
    "q": "Requirements?",
    "a": "Apple Silicon Mac, macOS 14+. Displays without a notch use a top panel. Screen-recording permission is requested on first use."
  }
],
  legalTitle: "特定商取引法に基づく表記 (Japanese commerce disclosure)",
  privacyTitle: "Privacy and data use",
  privacyBody: [
  "Service records include a random device credential, balance, request settlement, model usage and costs, and payment reconciliation. Normal registration needs no name or email.",
  "The official service processes screenshots and necessary instructions through the AI provider ({{AI_PROVIDER}}); actual model routing follows service configuration. Images, questions and answer text are excluded from the default database and logs. Your own key uses the service you select.",
  "Stripe processes payments; card details do not reach us. Support emails and material you voluntarily submit are handled separately for their stated purpose.",
  "Optional reliability sharing can be disabled in Settings. Disabling clears queued events and stops behavioral uploads; necessary billing records remain. Detailed events are kept for 90 days, with up to 7 days queued locally.",
  "The onboarding source question is optional. A selected answer is linked to this device registration. Question profile and display language do not determine your source.",
  "Preview and export problem feedback locally, then submit it yourself. Permission defaults to investigating this problem; quality evaluation is a separate choice. Permission lasts at most 90 days, and external model processing needs separate consent. Received material is deleted at expiry or withdrawal; delete your own local originals yourself. Email below for support, withdrawal or deletion, including the feedback reference in your export."
],
  refundTitle: "Refund & Cancellation Policy",
  refundBody: [
  "Question credits are digital goods and are generally non-refundable after delivery.",
  "Issues caused by us — double charges, credits not delivered — are fully refunded; email within 7 days.",
  "Failed answers never consume credits (enforced automatically)."
],
  reqNote: "macOS 14+ · Apple Silicon Mac",
  footerContact: "Contact",
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
    ['動作環境', 'Apple Silicon Mac / macOS 14 以降（ノッチのない画面では上部パネル）'],
  ];
  return rows
    .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
    .join('\n');
}

function entryCopy(input:SiteInput) {
  if(!input.entry)return null;
  const reading=input.entry==='reading_practice',beta=input.entryStatus==='beta';
  if(input.lang==='zh')return {
    title:reading?'在 Mac 上练习阅读题。':'在 Mac 上准备 SPI。',
    description:reading?'把题目、选项和阅读材料放在一起，围绕一道题练习理解。与 SPI 入口使用同一 NotchSPI、下载和题包。':'保留熟悉的 SPI 备考入口，围绕屏幕上的一道题查看答案。与阅读练习共用 NotchSPI、下载和题包。',
    scopeTitle:'当前支持与开放状态',
    scope:reading?(beta?'阅读练习处于内部测试，尚无完成独立评测的公开支持组合。':'阅读练习尚未开放，授权题集与独立评测仍在准备。'):
      '既有 SPI 入口继续可用。新版查题合约的题型、语言和版面组合仍待独立评测；不能把历史 SPI 结果视为所有题目的正确率。',
    journey:'一次只处理一个目标问题。新版材料补充、先看答案和按需解释按 App 的实际开放范围提供；未开放功能不会因下载此页面的安装包而启用。AI 答案需要核验。',
    attribution:'安装后的来源选择可以跳过。选择仅用于比较入口，不改变题目模式、免费额度或功能；下载点击不等于安装记录。',
  };
  if(input.lang==='ja')return {
    title:reading?'Mac で読解練習。':'Mac で SPI 対策。',
    description:reading?'問題・選択肢・文章を揃えて、一問の理解に取り組みます。SPI の入口と同じ NotchSPI、ダウンロード、題数パックを使います。':'慣れた SPI 対策の入口から、画面上の一問の回答を確認。読解練習と同じ NotchSPI、ダウンロード、題数パックです。',
    scopeTitle:'現在の対応範囲と公開状況',
    scope:reading?(beta?'読解練習は内部テスト中です。独立評価が完了した公開対応の組み合わせはまだありません。':'読解練習はまだ公開されていません。許諾済みの問題集と独立評価を準備しています。'):
      '既存の SPI 入口は継続します。新しい質問機能の題型・言語・レイアウトは独立評価待ちです。過去の SPI 結果を全問題の正解率とは扱いません。',
    journey:'一度に対象とするのは一問です。材料追加、回答優先、任意の説明はアプリで公開された範囲で提供します。このページからダウンロードしても未公開機能は有効になりません。AI の回答は確認してください。',
    attribution:'インストール後の入口選択はスキップできます。入口の比較にのみ使い、問題モード・無料枠・機能は変えません。ダウンロードのクリックはインストール記録ではありません。',
  };
  return {
    title:reading?'Practice reading questions on your Mac.':'Prepare for SPI on your Mac.',
    description:reading?'Bring the question, options and reading material together to work through one question. Use the same NotchSPI app, download and question packs as the SPI entry.':'Keep the familiar SPI preparation entry and review one question on screen. It shares the NotchSPI app, download and question packs with reading practice.',
    scopeTitle:'Current scope and availability',
    scope:reading?(beta?'Reading practice is in internal testing. No public support combinations have completed independent evaluation yet.':'Reading practice is not open yet. Authorized material and independent evaluation are being prepared.'):
      'The existing SPI entry continues. Question types, languages and layouts for the new query contract await independent evaluation. Historical SPI results do not establish accuracy for all questions.',
    journey:'Work on one target question at a time. Material support, answers first and optional explanations follow the features actually enabled in the app. Downloading here does not enable unreleased features. Verify AI answers against your material.',
    attribution:'You can skip the source choice after installation. It helps compare entry points and does not change modes, free credits or features. A download click is not an installation record.',
  };
}

export function renderLandingPage(input: SiteInput): string {
  const s = S[input.lang];
  const entry = entryCopy(input);
  const pagePath = input.entry === 'spi' ? '/spi' : input.entry === 'reading_practice' ? '/reading-practice' : '/';
  const trialText = (value: string): string => value
    .replaceAll('{{TRIAL}}', String(input.trialQuestions))
    .replaceAll('{{REMAINING}}', String(Math.max(0, input.trialQuestions - 1)));
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
    .map((f) => `<div class="feat"><div class="ficon">${f.icon}</div><h3>${escapeHtml(trialText(f.t))}</h3><p>${escapeHtml(trialText(f.d))}</p></div>`)
    .join('\n');

  const faqItems = s.faqs
    .map((f) => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`)
    .join('\n');

  const privacy = s.privacyBody
    .map((p) => `<p>${escapeHtml(p.replaceAll('{{AI_PROVIDER}}', providerName))}</p>`)
    .join('\n');
  const refund = s.refundBody.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');

  const langLink = (l: PageLang, label: string) =>
    `<a class="lang${input.lang === l ? ' on' : ''}" href="${pagePath}?lang=${l}"${input.lang===l?' aria-current="page"':''}>${label}</a>`;

  return `<!doctype html>
<html lang="${langAttr}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NotchSPI — ${escapeHtml(entry?.title??s.heroTitle)}</title>
<meta name="description" content="${escapeHtml(entry ? entry.description + ' ' + entry.scope : trialText(s.metaDesc))}">
<meta property="og:title" content="NotchSPI">
<meta property="og:description" content="${escapeHtml(entry ? entry.description + ' ' + entry.scope : trialText(s.metaDesc))}">
<style>
  :root { --accent:#7aa0ff; --accent-hi:#a3bdff; --ink:#eef1f8; --dim:#9aa3bd; --faint:#626b85; }
  * { box-sizing:border-box; margin:0; }
  a:focus-visible, summary:focus-visible { outline:3px solid var(--accent-hi); outline-offset:5px; }
  .entrylinks { display:flex; justify-content:center; flex-wrap:wrap; gap:12px; margin:20px 0; }
  .entrylinks a { border:1px solid #687899; border-radius:12px; padding:10px 16px; color:var(--ink); text-decoration:none; }
  .entrylinks a[aria-current] { background:#273650; }
  .scope { max-width:680px; margin:28px auto; padding:22px; border:1px solid #687899; border-radius:16px; text-align:left; }
  .scope p { margin-top:12px; color:var(--dim); }
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
  <h1>${escapeHtml(entry?.title??s.heroTitle)}</h1>
  <p class="sub">${escapeHtml(entry?.description??s.heroSub)}</p>
  <nav class="entrylinks" aria-label="${escapeHtml(input.lang==='zh'?'学习入口':input.lang==='ja'?'学習の入口':'Study entry points')}">
    <a href="/spi?lang=${input.lang}"${input.entry==='spi'?' aria-current="page"':''}>${input.lang==='zh'?'SPI 备考':input.lang==='ja'?'SPI 対策':'SPI preparation'}</a>
    <a href="/reading-practice?lang=${input.lang}"${input.entry==='reading_practice'?' aria-current="page"':''}>${input.lang==='zh'?'阅读练习':input.lang==='ja'?'読解練習':'Reading practice'}</a>
  </nav>
  ${entry?`<section class="scope" aria-labelledby="scope-title"><h2 id="scope-title">${escapeHtml(entry.scopeTitle)}</h2><p>${escapeHtml(entry.scope)}</p><p>${escapeHtml(entry.journey)}</p><p>${escapeHtml(entry.attribution)}</p></section>`:''}
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
            <span class="nstat">${escapeHtml(trialText(s.mockStatus))}</span>
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
      <div class="price">${formatMoney(0,input.currency)}</div>
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
