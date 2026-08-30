// Central configuration, read from environment with safe defaults so the server boots
// out-of-the-box for local development (mock provider, in-repo SQLite file). Every value
// an operator must set for production (vendor keys, payment provider) is surfaced here and
// documented in .env.example.

import { parsePacks, DEFAULT_PACKS_JSON } from './pricing.ts';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function boundedInt(value: number, fallback: number, minimum: number, maximum: number): number {
  return value >= minimum && value <= maximum ? value : fallback;
}

// Which vendor the official service proxies to. "mock" streams a canned answer with synthetic
// usage so the whole billing pipeline runs end-to-end without any real API key.
export type ProviderName = 'anthropic' | 'openai' | 'mock';

function envProvider(): ProviderName {
  const v = envStr('OFFICIAL_PROVIDER', 'mock').toLowerCase();
  return v === 'anthropic' || v === 'openai' ? v : 'mock';
}

export const config = {
  host: envStr('HOST', '0.0.0.0'),
  port: envInt('PORT', 8787),

  // Storage (see storage.ts): Postgres in production, SQLite locally, memory as the
  // serverless fallback. POSTGRES_URL (or DATABASE_URL) wins whenever set.
  postgresUrl: envStr('POSTGRES_URL', envStr('DATABASE_URL', '')),
  dbPath: envStr('DB_PATH', './data/notchspi.db'),

  // Postgres TLS. The billing DB connection VERIFIES the server certificate by default; the old
  // encrypt-but-don't-authenticate mode (a MITM hole) is now reachable only via an explicit
  // POSTGRES_SSL_MODE=require. Values: 'verify-full' (default) | 'require' | 'disable'. Managed
  // providers whose cert isn't in the system trust store (e.g. AWS RDS, a private CA) supply a CA
  // via POSTGRES_CA_CERT (inline PEM) or POSTGRES_CA_CERT_FILE (path); Neon/Supabase verify with
  // the public roots already trusted by Node.
  postgresSSLMode: envStr('POSTGRES_SSL_MODE', ''),
  postgresCACert: envStr('POSTGRES_CA_CERT', ''),
  postgresCACertFile: envStr('POSTGRES_CA_CERT_FILE', ''),
  // Serverless platforms have read-only filesystems; VERCEL=1 is set automatically there.
  isServerless: envStr('VERCEL', '') !== '',

  // Public base URL of THIS server, used to build absolute links (the top-up page and the
  // Stripe checkout return URLs). On Vercel it derives from the auto-injected production URL
  // so no manual configuration is needed; PUBLIC_BASE_URL still overrides (custom domains).
  publicBaseURL: envStr(
    'PUBLIC_BASE_URL',
    envStr('VERCEL_PROJECT_PRODUCTION_URL', '') !== ''
      ? `https://${envStr('VERCEL_PROJECT_PRODUCTION_URL', '')}`
      : 'http://localhost:8787',
  ),

  // ---- Quota model (题数额度制) ----------------------------------------------------------
  // The account balance is an integer number of QUESTIONS; one successful capture costs one
  // question. Money only appears at purchase time (the top-up page sells question packs).

  // Free questions granted to each newly registered device. The grant is RANDOMIZED per device
  // across [trialMinQuestions, trialMaxQuestions] (see the register route) so the onboarding
  // "welcome gift" feels personal — no two players get the same number. The range defaults to
  // 100–180; set min === max for a fixed grant (the deterministic route tests do exactly this).
  // `trialQuestions` remains the advertised ceiling used by the public site copy.
  trialQuestions: envInt('TRIAL_QUESTIONS', 180),
  trialMinQuestions: envInt('TRIAL_MIN_QUESTIONS', 100),
  trialMaxQuestions: envInt('TRIAL_MAX_QUESTIONS', 180),

  // Question packs sold on the top-up page: JSON `[{"id":"pack100","questions":100,"amount_cents":900}, …]`.
  // Prices are cents in `currency`. Falls back to the default catalog on parse errors.
  packs: parsePacks(envStr('PACKS_JSON', DEFAULT_PACKS_JSON)),

  // Currency the packs are priced in (display + payment provider). Defaults to JPY to match
  // the production Stripe account's settlement currency; override with CURRENCY for others.
  currency: envStr('CURRENCY', 'JPY'),

  provider: envProvider(),
  // Model the official service uses. The client never chooses; the server decides.
  model: envStr('OFFICIAL_MODEL', 'claude-opus-4-8'),
  maxTokens: envInt('OFFICIAL_MAX_TOKENS', 4096),

  anthropicKey: envStr('ANTHROPIC_API_KEY', ''),
  anthropicBaseURL: envStr('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
  openaiKey: envStr('OPENAI_API_KEY', ''),
  openaiBaseURL: envStr('OPENAI_BASE_URL', 'https://api.openai.com'),

  // ---- Payments ---------------------------------------------------------------------------
  // Real payments: Stripe Checkout (hosted page; card / Alipay / WeChat Pay etc. are picked
  // dynamically from the Dashboard's payment-method settings). Setting STRIPE_SECRET_KEY
  // activates the Stripe provider automatically — prefer a RESTRICTED key (rk_…) with only
  // Checkout Sessions write permission. STRIPE_WEBHOOK_SECRET (whsec_…) verifies the
  // checkout.session.completed webhook that actually credits the questions.
  stripeSecretKey: envStr('STRIPE_SECRET_KEY', ''),
  stripeWebhookSecret: envStr('STRIPE_WEBHOOK_SECRET', ''),

  // Without a Stripe key the dev stub remains: its top-up endpoint can arbitrarily credit
  // balances and is unauthenticated, so it is DISABLED by default — a production deploy stays
  // safe unless an operator explicitly sets ALLOW_STUB_TOPUP=1 for local development.
  paymentProvider: envStr('PAYMENT_PROVIDER', envStr('STRIPE_SECRET_KEY', '') !== '' ? 'stripe' : 'stub'),
  allowStubTopUp: envStr('ALLOW_STUB_TOPUP', '0') === '1',

  // Admin grant tool (manual quota top-ups for support / comps): a secret required to authorize
  // GET /admin and POST /admin/grant. If empty, the entire /admin path is DISABLED (404) — the
  // feature simply does not exist unless an operator sets ADMIN_TOKEN, so it is safe by default.
  adminToken: envStr('ADMIN_TOKEN', ''),

  // ---- Where the app itself is distributed from --------------------------------------------
  // The notarized DMG and its release metadata. Both are INTERNAL: GET /dl streams the bytes and
  // GET /update relays the version JSON, so no user-facing surface — site, alert, or redirect —
  // ever names the host these come from. Overridable so the origin can move (or point at a local
  // fixture in tests) without a code change.
  dmgUrl: envStr('DMG_URL', 'https://github.com/RotteSya/notch-SPI/releases/latest/download/NotchSPI.dmg'),
  releaseApiUrl: envStr('RELEASE_API_URL', 'https://api.github.com/repos/RotteSya/notch-SPI/releases/latest'),

  // ---- Best-effort rate limits (see rateLimit.ts) -----------------------------------------
  // Defense in depth against free-quota farming and parallel-capture balance abuse. In-memory
  // and per-instance, so treat a platform WAF as the real hard limit. Set a knob to 0 to disable.
  // Max anonymous device registrations per client IP per hour.
  deviceRegPerHour: envInt('DEVICE_REG_PER_HOUR', 30),
  // Max simultaneous in-flight captures for a single device token.
  captureConcurrencyPerToken: envInt('CAPTURE_CONCURRENCY_PER_TOKEN', 3),

  // Objective Result V1 is remotely assigned per anonymous bearer token. Invalid percentages
  // fail closed to control; changing the revision never reshuffles devices.
  objectiveResultV1Bps: boundedInt(envInt('OBJECTIVE_RESULT_V1_BPS', 0), 0, 0, 10_000),
  objectiveResultExperimentSalt: envStr('OBJECTIVE_RESULT_EXPERIMENT_SALT', ''),
  clientConfigRevision: envStr('CLIENT_CONFIG_REVISION', '2026-objective-v1-r1'),
  telemetryEnabled: envStr('TELEMETRY_ENABLED', '1') === '1',
  eventBatchPerMinute: boundedInt(envInt('EVENT_BATCH_PER_MINUTE', 30), 30, 0, 10_000),
  modelPricingJSON: envStr('MODEL_PRICING_JSON', '[]'),
  modelPricingVersion: envStr('MODEL_PRICING_VERSION', 'unset'),
} as const;

export type Config = typeof config;
