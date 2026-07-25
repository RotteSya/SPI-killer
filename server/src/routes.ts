import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { Provider, CaptureRequest } from './providers/types.ts';
import type { PaymentProvider, PageBanner, PageMode } from './payments.ts';
import type { StoreKind } from './storage.ts';
import { ApiError, errorBody, beginSSE, SSE_DONE } from './http.ts';
import { requireAccount } from './auth.ts';
import { findPack } from './pricing.ts';
import { isValidTokenShape, normalizeLang } from './payments.ts';
import { verifyStripeSignature, createCheckoutSession, type StripeEvent } from './stripe.ts';
import { renderLandingPage, resolveSiteLang, DOWNLOAD_URL } from './site.ts';
import { renderAdminPage } from './admin.ts';
import { createFixedWindowLimiter, createConcurrencyLimiter, clientIp } from './rateLimit.ts';

export interface AppContext {
  config: Config;
  store: Store;
  storeKind: StoreKind;
  provider: Provider;
  payment: PaymentProvider;
}

// Body shapes coming off the wire (all fields untrusted; validated in the handlers).
interface DeviceBody {
  platform?: unknown;
  app_version?: unknown;
}
interface CaptureBody {
  system?: unknown;
  task?: unknown;
  image_base64?: unknown;
  image_media_type?: unknown;
}
interface StubTopUpBody {
  device_token?: unknown;
  pack_id?: unknown;
}
interface CheckoutBody {
  device_token?: unknown;
  pack_id?: unknown;
  lang?: unknown;
}
interface AdminGrantBody {
  device_token?: unknown;
  questions?: unknown;
  note?: unknown;
  idempotency_key?: unknown;
}
interface AdminCliBody {
  device_token?: unknown;
  enabled?: unknown;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Constant-time compare of a caller-supplied admin token against the configured secret. */
function adminTokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, store, storeKind, provider, payment } = ctx;
  const stripeLive = payment.name === 'stripe' && config.stripeSecretKey !== '';
  // The admin grant console exists only when a secret is configured — otherwise /admin 404s.
  const adminEnabled = config.adminToken !== '';

  /** Gate every /admin/* handler: 404 when the console is off, 401 on a bad key. */
  const requireAdmin = (req: FastifyRequest): void => {
    if (!adminEnabled) throw new ApiError(404, '未启用');
    const provided = typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'] : '';
    if (!adminTokenMatches(provided, config.adminToken)) throw new ApiError(401, '管理员密钥无效', 'invalid_token');
  };

  // Best-effort abuse limits (see rateLimit.ts): a per-IP cap on anonymous registration and a
  // per-token cap on concurrent captures. Instantiated once so state lives for the process.
  const registerLimiter = createFixedWindowLimiter(config.deviceRegPerHour, 60 * 60 * 1000);
  const captureLimiter = createConcurrencyLimiter(config.captureConcurrencyPerToken);

  // Config-at-a-glance for operators: which provider answers, where data lives, how payments
  // are wired. `db: "memory"` on a production deployment means POSTGRES_URL is missing.
  // GET / — the public product site (also the "company website" for payment-provider review).
  // Language: ?lang wins, then Accept-Language, defaulting to Japanese. Cacheable at the CDN;
  // Vary keeps the language negotiation honest.
  app.get('/', async (req, reply) => {
    const q = (req.query ?? {}) as { lang?: unknown };
    const lang = resolveSiteLang(str(q.lang), str(req.headers['accept-language']));
    const html = renderLandingPage({
      packs: config.packs,
      trialQuestions: config.trialQuestions,
      currency: config.currency,
      lang,
    });
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('Vary', 'Accept-Language')
      .type('text/html; charset=utf-8')
      .send(html);
  });

  // GET /dl — tally a download-button click, then 302 to the real GitHub DMG. Counting is
  // best-effort: a DB hiccup must never block the download, so a failure is logged and ignored.
  // Browser prefetch can inflate this slightly; GitHub's own asset counter stays the ground
  // truth for completed downloads — this measures clicks on the site's download buttons.
  app.get('/dl', async (req, reply) => {
    try {
      await store.bumpCounter('download_clicks');
    } catch (err) {
      req.log.error({ err }, 'download counter bump failed');
    }
    return reply.header('Cache-Control', 'no-store').redirect(DOWNLOAD_URL, 302);
  });

  // GET /stats — public, read-only tally of download-button clicks.
  app.get('/stats', async (_req, reply) => {
    const downloadClicks = await store.getCounter('download_clicks');
    return reply.header('Cache-Control', 'no-store').send({ download_clicks: downloadClicks });
  });

  app.get('/healthz', async () => ({
    ok: true,
    provider: provider.name,
    db: storeKind,
    payments: stripeLive ? 'stripe' : config.allowStubTopUp ? 'stub' : 'disabled',
    webhook: stripeLive ? (config.stripeWebhookSecret !== '' ? 'configured' : 'MISSING_SECRET') : 'n/a',
  }));

  // POST /v1/devices — anonymous registration, grants the free question quota. No auth, so a
  // per-IP cap keeps this from being a free-quota faucet (best-effort; see rateLimit.ts).
  app.post('/v1/devices', async (req, reply) => {
    if (!registerLimiter.hit(clientIp(req))) {
      throw new ApiError(429, '注册过于频繁，请稍后再试', 'rate_limited');
    }
    const body = (req.body ?? {}) as DeviceBody;
    // The welcome gift is randomized per device across the configured range, so the onboarding
    // reveal lands on a different number for each player. Clamp defensively (min ≥ 0, max ≥ min)
    // so a misconfigured range can never grant a negative balance — while still allowing an
    // explicit 0 (a deployment that disables the free trial, as some tests configure).
    const lo = Math.max(0, Math.min(config.trialMinQuestions, config.trialMaxQuestions));
    const hi = Math.max(lo, config.trialMaxQuestions);
    const trialQuestions = lo + Math.floor(Math.random() * (hi - lo + 1));
    const platform = str(body.platform, 'unknown').slice(0, 32);
    const appVersion = str(body.app_version, 'unknown').slice(0, 32);
    const device = await store.registerDevice({ platform, appVersion, trialQuestions });
    // Every registration hands out a free grant that costs real model spend, so leave a trail:
    // the device row id plus the caller's IP is what tells a client-side credential bug (one IP,
    // one app version, repeated) apart from deliberate free-quota farming. No token is logged —
    // the row id is enough to look the device up in the admin view.
    req.log.info(
      { deviceId: device.id, ip: clientIp(req), platform, appVersion, trialQuestions },
      'device registered',
    );
    return reply.send({
      device_token: device.token,
      balance_questions: device.balanceQuestions,
    });
  });

  // GET /v1/account — question balance + lifetime usage + per-device feature switches. Auth.
  app.get('/v1/account', async (req, reply) => {
    const { account } = await requireAccount(req, store);
    return reply.send({
      balance_questions: account.balanceQuestions,
      total_questions: account.totalQuestions,
      total_input_tokens: account.totalInputTokens,
      total_output_tokens: account.totalOutputTokens,
      cli_enabled: account.cliEnabled,
    });
  });

  // POST /v1/captures — streamed answer; one successful capture costs one question. Auth.
  app.post('/v1/captures', async (req, reply) => {
    const { token, account } = await requireAccount(req, store);
    const body = (req.body ?? {}) as CaptureBody;

    const captureReq: CaptureRequest = {
      system: str(body.system),
      task: str(body.task),
      imageBase64: str(body.image_base64),
      imageMediaType: str(body.image_media_type, 'image/jpeg'),
    };
    // Contract requires system, task, and image. Validate up front (JSON 400) rather than
    // streaming with empty prompts and failing mid-stream inside the vendor call.
    if (!captureReq.system) throw new ApiError(400, '缺少 system 提示词');
    if (!captureReq.task) throw new ApiError(400, '缺少 task 文本');
    if (!captureReq.imageBase64) throw new ApiError(400, '缺少截图数据');

    // Pre-request gate: no questions left is refused as JSON 402 BEFORE any streaming.
    if (account.balanceQuestions <= 0) {
      throw new ApiError(402, '额度已用完，请充值后继续', 'insufficient_quota');
    }

    // Concurrency cap: stop one token from opening several streams at once to drive its balance
    // deeply negative in parallel. Refused as JSON 429 BEFORE hijacking the socket.
    if (!captureLimiter.tryAcquire(token)) {
      throw new ApiError(429, '同一设备的并发请求过多，请等上一题完成后再试', 'rate_limited');
    }

    // Take over the socket for manual SSE writing.
    reply.hijack();
    const send = beginSSE(reply);

    // Abort the upstream call only on a real client disconnect. We listen on the RESPONSE
    // socket (not req.raw, whose 'close' fires as soon as the request body is fully read) and
    // guard with `done` so our own end() doesn't trigger an abort.
    const abort = new AbortController();
    let done = false;
    reply.raw.on('close', () => {
      if (!done) abort.abort();
    });

    try {
      // A question is charged ONLY for an answer that actually produced text. A vendor can
      // resolve an HTTP-200 stream with no deltas (empty completion / content-filter block);
      // billing that would break the product's "失败不扣题" promise.
      let sawDelta = false;
      const usage = await provider.stream(
        captureReq,
        (text) => {
          if (text.length > 0) sawDelta = true;
          send({ type: 'delta', text });
        },
        abort.signal,
      );
      if (!sawDelta) {
        send({ type: 'error', error: { message: '答案生成服务未返回内容，本次未消耗额度，请重试', code: 'upstream_error' } });
      } else {
        const newBalance = await store.chargeForUsage({
          token,
          questions: 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          model: `${provider.name}:${config.model}`,
        });
        if (newBalance === null) {
          // Token vanished mid-request (deleted); report as a stream error, no charge applied.
          send({ type: 'error', error: { message: '设备令牌无效', code: 'invalid_token' } });
        } else {
          send({
            type: 'usage',
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            questions_charged: 1,
            balance_questions: newBalance,
          });
          reply.raw.write(SSE_DONE);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '模型服务错误';
      // On failure we do NOT charge — a broken answer never costs a question.
      send({ type: 'error', error: { message, code: 'upstream_error' } });
    } finally {
      done = true;
      captureLimiter.release(token);
      reply.raw.end();
    }
  });

  // GET /topup?device=<token>&lang=<zh|ja|en>[&paid=1|&canceled=1] — payment web page.
  // No bearer auth; the client passes its resolved UI language so the page matches the app.
  app.get('/topup', async (req, reply) => {
    const q = (req.query ?? {}) as { device?: unknown; lang?: unknown; paid?: unknown; canceled?: unknown };
    const raw = str(q.device);
    // Only ever reflect a well-formed token; anything else renders as empty (belt-and-suspenders
    // with jsStringLiteral, since this endpoint is unauthenticated).
    const device = isValidTokenShape(raw) ? raw : '';
    const mode: PageMode = stripeLive ? 'stripe' : config.allowStubTopUp && payment.name === 'stub' ? 'stub' : 'disabled';
    const banner: PageBanner = str(q.paid) === '1' ? 'paid' : str(q.canceled) === '1' ? 'canceled' : null;
    const html = payment.renderTopUpPage({
      deviceToken: device,
      packs: config.packs,
      currency: config.currency,
      baseURL: config.publicBaseURL,
      lang: normalizeLang(str(q.lang)),
      mode,
      banner,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // POST /topup/checkout — create a Stripe Checkout session for a pack. Called by the page.
  app.post('/topup/checkout', async (req, reply) => {
    if (!stripeLive) throw new ApiError(404, '未启用');
    const body = (req.body ?? {}) as CheckoutBody;
    const token = str(body.device_token);
    if (!isValidTokenShape(token)) throw new ApiError(400, '设备令牌无效');
    // The token must belong to a real account — no checkout sessions for junk tokens.
    if ((await store.getAccount(token)) === null) throw new ApiError(401, '设备令牌无效');
    const pack = findPack(config.packs, str(body.pack_id));
    if (!pack) throw new ApiError(400, '题包无效');

    const result = await createCheckoutSession(config.stripeSecretKey, {
      pack,
      deviceToken: token,
      currency: config.currency,
      publicBaseURL: config.publicBaseURL,
      lang: normalizeLang(str(body.lang)),
    });
    if ('error' in result) {
      req.log.error({ stripeError: result.error }, 'checkout session creation failed');
      throw new ApiError(502, '支付服务暂时不可用，请稍后再试', 'upstream_error');
    }
    return reply.send({ url: result.url });
  });

  // POST /webhooks/stripe — Stripe calls this after payment. Signature-verified against the
  // RAW body; `checkout.session.completed` credits the pack idempotently (session id is the
  // reference, so Stripe's redeliveries are clean no-ops).
  app.post('/webhooks/stripe', async (req, reply) => {
    if (!stripeLive) throw new ApiError(404, '未启用');
    if (!config.stripeWebhookSecret) {
      req.log.error('STRIPE_WEBHOOK_SECRET is not configured; rejecting webhook');
      throw new ApiError(500, 'webhook 未配置');
    }
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['stripe-signature'];
    if (!rawBody || typeof signature !== 'string' ||
        !verifyStripeSignature(rawBody.toString('utf8'), signature, config.stripeWebhookSecret)) {
      throw new ApiError(400, '签名校验失败');
    }

    const event = (req.body ?? {}) as StripeEvent;
    if (event.type !== 'checkout.session.completed') {
      return reply.send({ received: true }); // acknowledge everything else
    }
    const session = event.data?.object;
    if (!session?.id || session.payment_status !== 'paid') {
      return reply.send({ received: true });
    }
    const token = session.metadata?.device_token ?? '';
    const pack = findPack(config.packs, session.metadata?.pack_id ?? '');
    if (!isValidTokenShape(token) || !pack) {
      req.log.error({ sessionId: session.id }, 'paid session with unusable metadata');
      return reply.send({ received: true }); // don't make Stripe retry something unfixable
    }
    // Defense in depth: the paid amount must match the catalog — a mismatch means the catalog
    // changed mid-flight or the session was tampered with; log loudly, don't credit.
    if (session.amount_total !== pack.amountCents ||
        (session.currency ?? '').toLowerCase() !== config.currency.toLowerCase()) {
      req.log.error({ sessionId: session.id, amount: session.amount_total, currency: session.currency },
        'paid amount does not match the pack catalog; NOT crediting');
      return reply.send({ received: true });
    }

    const newBalance = await store.credit({
      token,
      questions: pack.questions,
      amountCents: pack.amountCents,
      currency: config.currency,
      provider: 'stripe',
      reference: session.id, // idempotency key: redelivered webhooks are no-ops
    });
    if (newBalance === null) {
      req.log.error({ sessionId: session.id }, 'paid session for an unknown device token');
    } else {
      req.log.info({ sessionId: session.id, questions: pack.questions, newBalance }, 'pack credited');
    }
    return reply.send({ received: true });
  });

  // POST /topup/stub-complete — DEV-ONLY credit endpoint used by the stub top-up page. The
  // Stripe webhook above replaces this in production; guarded so it can't run there.
  app.post('/topup/stub-complete', async (req, reply) => {
    if (!(config.allowStubTopUp && payment.name === 'stub')) {
      throw new ApiError(404, '未启用');
    }
    const body = (req.body ?? {}) as StubTopUpBody;
    const token = str(body.device_token);
    if (!token) throw new ApiError(400, '缺少设备令牌');
    const pack = findPack(config.packs, str(body.pack_id));
    if (!pack) throw new ApiError(400, '题包无效');

    const newBalance = await store.credit({
      token,
      questions: pack.questions,
      amountCents: pack.amountCents,
      currency: config.currency,
      provider: 'stub',
      reference: `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (newBalance === null) throw new ApiError(401, '设备令牌无效');
    return reply.send({ balance_questions: newBalance });
  });

  // GET /admin — the password-protected manual-grant console. It exists only when ADMIN_TOKEN is
  // set (otherwise 404). The page carries no secret; the operator's key is entered client-side and
  // sent to /admin/grant. noindex so it never lands in search results.
  app.get('/admin', async (_req, reply) => {
    if (!adminEnabled) throw new ApiError(404, '未启用');
    return reply
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderAdminPage({ currency: config.currency }));
  });

  // POST /admin/grant — grant N free questions to a device, authorized by the admin secret in the
  // `x-admin-token` header (constant-time compare). Records a topups row (provider="admin",
  // amount 0, optional note) for audit and is idempotent on the reference. Grants only ADD
  // questions — there is deliberately no deduct path here.
  app.post('/admin/grant', async (req, reply) => {
    requireAdmin(req);

    const body = (req.body ?? {}) as AdminGrantBody;
    const token = str(body.device_token);
    if (!isValidTokenShape(token)) throw new ApiError(400, '设备令牌格式无效');
    // Accept a number or a numeric string (curl-friendly); must be a positive integer in range.
    const raw = body.questions;
    const questions =
      typeof raw === 'number' ? Math.trunc(raw)
      : typeof raw === 'string' && raw.trim() !== '' ? Math.trunc(Number(raw))
      : Number.NaN;
    if (!Number.isFinite(questions) || !(questions > 0 && questions <= 100_000)) {
      throw new ApiError(400, '题数必须是 1–100000 的整数');
    }
    const note = str(body.note).slice(0, 200).trim();
    const idem = str(body.idempotency_key).trim();
    const reference = idem !== ''
      ? `admin:${idem}`
      : `admin:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const newBalance = await store.credit({
      token,
      questions,
      amountCents: 0,
      currency: config.currency,
      provider: 'admin',
      reference,
      note: note !== '' ? note : undefined,
    });
    if (newBalance === null) throw new ApiError(401, '设备不存在，请确认 token 是否正确', 'invalid_token');
    req.log.info({ questions, newBalance, reference }, 'admin grant');
    return reply.send({ balance_questions: newBalance, questions_granted: questions });
  });

  // GET /admin/activity — READ-ONLY operations view: the most recent device registrations and
  // the most recent top-ups (with the paying device's platform/version joined in). Same admin
  // secret as the write endpoints. Answers the two questions the raw platform logs cannot:
  // "what is a paying customer actually running" and "is this registration burst one broken
  // client or somebody farming the free grant" (compare each row's total_questions).
  // Never returns device tokens — only row ids, which cannot be spent.
  app.get('/admin/activity', async (req, reply) => {
    requireAdmin(req);
    const raw = (req.query as { limit?: string } | undefined)?.limit;
    const parsed = raw !== undefined ? Math.trunc(Number(raw)) : Number.NaN;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
    const [devices, topups] = await Promise.all([
      store.listRecentDevices(limit),
      store.listRecentTopups(limit),
    ]);
    return reply.header('Cache-Control', 'no-store').send({
      limit,
      devices: devices.map((d) => ({
        id: d.id,
        platform: d.platform,
        app_version: d.appVersion,
        balance_questions: d.balanceQuestions,
        total_questions: d.totalQuestions,
        created_at: d.createdAt,
      })),
      topups: topups.map((t) => ({
        id: t.id,
        device_id: t.deviceId,
        questions: t.questions,
        amount_cents: t.amountCents,
        currency: t.currency,
        provider: t.provider,
        reference: t.reference,
        note: t.note,
        created_at: t.createdAt,
        device_platform: t.devicePlatform,
        device_app_version: t.deviceAppVersion,
        device_created_at: t.deviceCreatedAt,
        device_total_questions: t.deviceTotalQuestions,
      })),
    });
  });

  // POST /admin/cli — flip the per-device CLI switch, same manual flow (and same admin secret)
  // as question grants: the operator pastes a device token and enables/disables the retired CLI
  // channel for that machine. The client mirrors the flag on its next account sync. Idempotent.
  app.post('/admin/cli', async (req, reply) => {
    requireAdmin(req);

    const body = (req.body ?? {}) as AdminCliBody;
    const token = str(body.device_token);
    if (!isValidTokenShape(token)) throw new ApiError(400, '设备令牌格式无效');
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'enabled 必须是 true 或 false');

    const stored = await store.setCliEnabled(token, body.enabled);
    if (stored === null) throw new ApiError(401, '设备不存在，请确认 token 是否正确', 'invalid_token');
    req.log.info({ cliEnabled: stored }, 'admin cli switch');
    return reply.send({ cli_enabled: stored });
  });

  // Uniform error body: {"error":{"message":"…","code":"…"}} with the right status code.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(errorBody(err.message, err.code));
    }
    const e = err as { statusCode?: number; message?: string };
    const statusCode = typeof e.statusCode === 'number' ? e.statusCode : 500;
    const message = statusCode === 500 ? '服务器内部错误' : (e.message ?? '请求错误');
    return reply.code(statusCode).send(errorBody(message, statusCode === 500 ? 'internal' : 'bad_request'));
  });
}
