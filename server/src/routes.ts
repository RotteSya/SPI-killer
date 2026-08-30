import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { Provider, CaptureRequest } from './providers/types.ts';
import type { PaymentProvider, PageBanner, PageMode } from './payments.ts';
import type { StoreKind } from './storage.ts';
import { ApiError, errorBody, beginSSE, SSE_DONE, type StreamEvent } from './http.ts';
import { requireAccount } from './auth.ts';
import { findPack } from './pricing.ts';
import { isValidTokenShape, normalizeLang } from './payments.ts';
import { verifyStripeSignature, createCheckoutSession, type StripeEvent } from './stripe.ts';
import { renderLandingPage, resolveSiteLang } from './site.ts';
import { renderAdminPage } from './admin.ts';
import { createFixedWindowLimiter, createConcurrencyLimiter, clientIp } from './rateLimit.ts';
import { composeObjectiveResult, objectiveResultIsBillable } from './objective-result.ts';
import { estimateModelCostMicros, validateProductEvent } from './telemetry.ts';

export interface AppContext {
  config: Config;
  store: Store;
  storeKind: StoreKind;
  provider: Provider;
  /** Non-null when a real vendor was configured without its key; captures refuse to run. */
  providerDegraded: string | null;
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
  /** 上下文追问: ordered image list (context first, fresh capture last). Wins over image_base64. */
  images_base64?: unknown;
  result_protocol?: unknown;
  capture_id?: unknown;
}
interface EventBatchBody { schema_version?: unknown; events?: unknown }
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

// Capture input bounds. The prompt cap is generous next to the client's own prompts (a few KB)
// but small enough that a crafted request cannot turn a one-question price into a six-figure
// token bill. The image cap is ~8 MB of base64, comfortably above the client's ~1568px JPEG.
const MAX_PROMPT_CHARS = 32_000;
const MAX_IMAGE_B64_CHARS = 8 * 1024 * 1024;
// One capture still costs one question regardless of image count, so the array length is what
// bounds the vendor bill per question. The client sends at most 2 (context + fresh shot);
// 4 leaves headroom without changing the price model materially.
const MAX_IMAGES_PER_CAPTURE = 4;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * How much delivered text makes a disconnected stream count as an answer the user received.
 * Below it, a hang-up is treated as a failed attempt and refunded; above it, the answer was on
 * screen and the question is charged. Chosen to sit above a false start (a greeting, the first
 * reasoning tokens) and well below any complete answer this product produces.
 */
const MIN_BILLABLE_CHARS = 200;
const MAX_OBJECTIVE_BUFFER_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function objectiveExperimentBucket(token: string, salt: string): number {
  const digest = createHmac('sha256', salt).update(token).digest();
  return digest.readUInt32BE(0) % 10_000;
}

/** Constant-time compare of a caller-supplied admin token against the configured secret. */
function adminTokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, store, storeKind, provider, providerDegraded, payment } = ctx;
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
  const eventLimiter = createFixedWindowLimiter(config.eventBatchPerMinute, 60 * 1000);
  let lastEventPruneDay = '';

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

  // GET /dl — tally a download-button click, then stream the DMG back from this origin.
  //
  // Deliberately a proxy and NOT a 302: a redirect would put the GitHub asset URL in the user's
  // address bar and download list, and nothing user-facing is allowed to point at GitHub. The
  // repo stays the release pipeline's storage, invisible to the people downloading the app.
  //
  // Counting is best-effort: a DB hiccup must never block the download, so a failure is logged
  // and ignored. Browser prefetch can inflate this slightly — it measures button clicks, not
  // completed downloads.
  app.get('/dl', async (req, reply) => {
    try {
      await store.bumpCounter('download_clicks');
    } catch (err) {
      req.log.error({ err }, 'download counter bump failed');
    }

    const upstream = await fetch(config.dmgUrl, { redirect: 'follow' });
    if (!upstream.ok || !upstream.body) {
      req.log.error({ status: upstream.status }, 'DMG fetch failed');
      return reply.code(502).type('text/plain; charset=utf-8').send('Download temporarily unavailable.');
    }

    // Content-Length lets the browser show a real progress bar; it is absent on a chunked
    // upstream, in which case we simply omit it rather than buffering the whole file to measure.
    const len = upstream.headers.get('content-length');
    if (len) reply.header('Content-Length', len);
    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', 'attachment; filename="NotchSPI.dmg"')
      .type('application/x-apple-diskimage')
      .send(upstream.body);
  });

  // GET /update — release metadata for the in-app "check for updates", relayed from GitHub so the
  // client never talks to (or links to) github.com. Shape is our own, not GitHub's:
  //   { version: "2.6", tag: "v2.6", notes: "…" }
  // No download URL is returned: the client already knows this origin (it just called it) and
  // composes `<baseURL>/dl` itself, which keeps the response independent of proxy headers.
  // Cached for 10 minutes — releases change a few times a month, and this keeps the
  // unauthenticated GitHub API well clear of its 60-requests/hour/IP limit.
  app.get('/update', async (req, reply) => {
    const upstream = await fetch(config.releaseApiUrl, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'NotchSPI' },
    });
    if (!upstream.ok) {
      req.log.error({ status: upstream.status }, 'release lookup failed');
      return reply.code(502).send(errorBody('Could not read the latest release.', 'upstream_error'));
    }
    const rel = (await upstream.json()) as { tag_name?: unknown; body?: unknown };
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
    if (!tag) {
      return reply.code(502).send(errorBody('Latest release has no tag.', 'upstream_error'));
    }
    return reply.header('Cache-Control', 'public, max-age=600').send({
      version: tag.replace(/^[vV]/, ''),
      tag,
      notes: typeof rel.body === 'string' ? rel.body : '',
    });
  });

  // GET /stats — public, read-only tally of download-button clicks.
  app.get('/stats', async (_req, reply) => {
    const downloadClicks = await store.getCounter('download_clicks');
    return reply.header('Cache-Control', 'no-store').send({ download_clicks: downloadClicks });
  });

  app.get('/healthz', async (_req, reply) => {
    const body = {
      ok: providerDegraded === null,
      provider: provider.name,
      // Present only when broken, so a healthy deployment's output is unchanged.
      ...(providerDegraded === null ? {} : { provider_error: providerDegraded }),
      db: storeKind,
      payments: stripeLive ? 'stripe' : config.allowStubTopUp ? 'stub' : 'disabled',
      webhook: stripeLive ? (config.stripeWebhookSecret !== '' ? 'configured' : 'MISSING_SECRET') : 'n/a',
    };
    // 503 so an uptime check pages on a misconfigured deploy instead of reporting it healthy.
    return reply.code(providerDegraded === null ? 200 : 503).send(body);
  });

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

  app.get('/v1/client-config', async (req, reply) => {
    const { token } = await requireAccount(req, store);
    const treatment = config.objectiveResultV1Bps > 0
      && config.objectiveResultExperimentSalt !== ''
      && objectiveExperimentBucket(token, config.objectiveResultExperimentSalt) < config.objectiveResultV1Bps;
    return reply.header('Cache-Control', 'private, max-age=300').send({
      schema_version: 1,
      revision: config.clientConfigRevision,
      objective_result_v1: treatment
        ? { variant: 'objective_v1', protocol: 'objective_v1', prompt_variant: 'objective_v1' }
        : { variant: 'control', protocol: null, prompt_variant: 'legacy' },
      telemetry: { enabled: config.telemetryEnabled, max_batch_size: 50, max_queue_age_days: 7 },
    });
  });

  app.post('/v1/events/batch', async (req, reply) => {
    const { token } = await requireAccount(req, store);
    if (!eventLimiter.hit(token)) throw new ApiError(429, '事件上传过于频繁', 'rate_limited');
    const body = (req.body ?? {}) as EventBatchBody;
    const encodedSize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (encodedSize > 64 * 1024) throw new ApiError(413, '事件批次过大');
    if (body.schema_version !== 1 || !Array.isArray(body.events)
        || body.events.length < 1 || body.events.length > 50) {
      throw new ApiError(400, '事件批次格式无效');
    }
    if (!config.telemetryEnabled) {
      return reply.code(202).send({ accepted: 0, duplicate: 0, rejected: 0 });
    }
    const appVersion = typeof req.headers['x-app-version'] === 'string'
      ? req.headers['x-app-version'].slice(0, 32) : null;
    const valid = body.events.flatMap((event) => {
      const parsed = validateProductEvent(event, appVersion);
      return parsed ? [parsed] : [];
    });
    const result = await store.recordProductEvents(token, valid);
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastEventPruneDay) {
      lastEventPruneDay = today;
      const before = new Date(Date.now() - 90 * 86_400_000).toISOString();
      void store.pruneProductEvents(before).catch((err: unknown) => req.log.error({ err }, 'event prune failed'));
    }
    const rejected = body.events.length - valid.length;
    req.log.info({ count: body.events.length, accepted: result.accepted, rejected }, 'product events');
    return reply.code(202).send({ accepted: result.accepted, duplicate: result.duplicate, rejected });
  });

  // POST /v1/captures — streamed answer; one successful capture costs one question. Auth.
  //
  // Billing is RESERVE-then-SETTLE. The question is held against the balance in one atomic
  // statement before the vendor is called, and only converted into a charge once an answer has
  // actually been delivered; anything else refunds the hold. The previous order (stream first,
  // charge at the very end) had two holes: concurrent captures all passed the same stale balance
  // check, and a client that hung up mid-stream took the failure path and got its answer free.
  app.post('/v1/captures', async (req, reply) => {
    const { token } = await requireAccount(req, store);
    // Refuse rather than bill a real question for the mock provider's canned placeholder.
    if (providerDegraded !== null) {
      req.log.error({ providerDegraded }, 'capture refused: model provider is not configured');
      throw new ApiError(503, '答案生成服务暂时不可用，本次未消耗额度', 'upstream_error');
    }
    const body = (req.body ?? {}) as CaptureBody;
    const resultProtocol = body.result_protocol === undefined ? null : str(body.result_protocol);
    const captureId = body.capture_id === undefined ? null : str(body.capture_id);
    if (resultProtocol !== null && resultProtocol !== 'objective_v1') {
      throw new ApiError(400, 'result_protocol 无效');
    }
    if (captureId !== null && !UUID.test(captureId)) throw new ApiError(400, 'capture_id 必须是 UUID');

    // Image list: `images_base64` (ordered, context first) wins when present; the legacy
    // single `image_base64` remains the wire shape for plain captures and old clients.
    const mediaType = str(body.image_media_type, 'image/jpeg');
    let imagesBase64: string[];
    if (body.images_base64 !== undefined) {
      if (!Array.isArray(body.images_base64) || body.images_base64.some((v) => typeof v !== 'string')) {
        throw new ApiError(400, 'images_base64 必须是字符串数组');
      }
      imagesBase64 = body.images_base64 as string[];
    } else {
      const single = str(body.image_base64);
      imagesBase64 = single === '' ? [] : [single];
    }

    const captureReq: CaptureRequest = {
      system: str(body.system),
      task: str(body.task),
      images: imagesBase64.map((base64) => ({ base64, mediaType })),
    };
    // Contract requires system, task, and at least one image. Validate up front (JSON 400)
    // rather than streaming with empty prompts and failing mid-stream inside the vendor call.
    if (!captureReq.system) throw new ApiError(400, '缺少 system 提示词');
    if (!captureReq.task) throw new ApiError(400, '缺少 task 文本');
    if (captureReq.images.length === 0 || captureReq.images.some((img) => img.base64 === '')) {
      throw new ApiError(400, '缺少截图数据');
    }
    // Size caps. One capture costs the user exactly one question no matter how large the prompt,
    // so an unbounded text leg — or an unbounded image list — is an unbounded vendor bill for a
    // fixed price. The image leg is additionally pinned to a media type the vendors accept.
    if (captureReq.system.length > MAX_PROMPT_CHARS) throw new ApiError(400, 'system 提示词过长');
    if (captureReq.task.length > MAX_PROMPT_CHARS) throw new ApiError(400, 'task 文本过长');
    if (captureReq.images.length > MAX_IMAGES_PER_CAPTURE) throw new ApiError(400, '截图数量过多');
    if (captureReq.images.some((img) => img.base64.length > MAX_IMAGE_B64_CHARS)) {
      throw new ApiError(400, '截图数据过大');
    }
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
      throw new ApiError(400, '不支持的图片格式');
    }

    // Concurrency cap: stop one token from opening several streams at once. Refused as JSON 429
    // BEFORE hijacking the socket, and before the hold, so a burst can't churn the database.
    if (!captureLimiter.tryAcquire(token)) {
      throw new ApiError(429, '同一设备的并发请求过多，请等上一题完成后再试', 'rate_limited');
    }

    // From here every exit path must release the concurrency slot.
    let balanceAfterHold: number;
    try {
      const hold = await store.reserveQuestions({ token, questions: 1 });
      if (!hold.ok) {
        throw hold.reason === 'insufficient_quota'
          ? new ApiError(402, '额度已用完，请充值后继续', 'insufficient_quota')
          : new ApiError(401, '设备令牌无效', 'invalid_token');
      }
      balanceAfterHold = hold.balanceQuestions;
    } catch (err) {
      captureLimiter.release(token);
      throw err;
    }

    // Take over the socket for manual SSE writing. hijack() only tells Fastify not to reply, so
    // it cannot fail; everything after it CAN — writeHead throws on a socket whose peer went away
    // during the reservation round trip above — and a throw there would strand the hold, silently
    // costing the user a question. So the hold and the try/finally that settles it are adjacent,
    // with nothing fallible in between.
    reply.hijack();

    const model = `${provider.name}:${config.model}`;
    const abort = new AbortController();
    let settled = false;
    let deliveredChars = 0;
    let objectiveRaw = '';
    let objectiveBufferOverflow = false;
    let done = false;
    let send: (event: StreamEvent) => void = () => {};
    const settle = async (
      inputTokens: number, outputTokens: number,
      resultState?: string, parserPath?: string,
    ): Promise<void> => {
      await store.settleReservation({
        token, questions: 1, inputTokens, outputTokens, model,
        captureId: captureId ?? undefined,
        resultProtocol: resultProtocol ?? undefined,
        resultState, parserPath,
        estimatedCostMicros: estimateModelCostMicros(
          config.modelPricingJSON, model, inputTokens, outputTokens,
        ) ?? estimateModelCostMicros(config.modelPricingJSON, config.model, inputTokens, outputTokens),
        pricingVersion: config.modelPricingVersion,
      });
      settled = true;
    };
    const release = async (): Promise<number> => {
      const balance = await store.releaseReservation({ token, questions: 1 });
      settled = true; // reservation is resolved; the historical name means "do not release again"
      return balance ?? balanceAfterHold + 1;
    };
    const objectiveComposition = () => objectiveBufferOverflow
      ? composeObjectiveResult('', true)
      : composeObjectiveResult(objectiveRaw, true);

    try {
      const rawSend = beginSSE(reply);
      // Once the peer is gone the socket is destroyed, and a raw write to it surfaces as an
      // asynchronous 'error' with no listener — which would take down the whole warm instance and
      // every request sharing it. Terminal writes are therefore always best-effort.
      send = (event: StreamEvent): void => {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        try {
          rawSend(event);
        } catch {
          /* peer vanished mid-write */
        }
      };

      // Abort the upstream call only on a real client disconnect. We listen on the RESPONSE
      // socket (not req.raw, whose 'close' fires as soon as the request body is fully read) and
      // guard with `done` so our own end() doesn't trigger an abort.
      reply.raw.on('close', () => {
        if (!done) abort.abort();
      });

      const usage = await provider.stream(
        captureReq,
        (text) => {
          deliveredChars += text.length;
          if (resultProtocol === 'objective_v1' && !objectiveBufferOverflow) {
            const candidate = objectiveRaw + text;
            if (Buffer.byteLength(candidate, 'utf8') <= MAX_OBJECTIVE_BUFFER_BYTES) objectiveRaw = candidate;
            else objectiveBufferOverflow = true;
          }
          send({ type: 'delta', text });
        },
        abort.signal,
      );
      // A vendor can resolve an HTTP-200 stream with no deltas (empty completion, content-filter
      // block). That is not an answer, so it is not a charge.
      if (resultProtocol === 'objective_v1') {
        const composition = objectiveComposition();
        if (objectiveResultIsBillable(composition)) {
          await settle(usage.inputTokens, usage.outputTokens, composition.state ?? undefined, composition.parserPath);
          send({
            type: 'usage', input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
            questions_charged: 1, balance_questions: balanceAfterHold,
          });
        } else {
          const restored = await release();
          send({
            type: 'usage', input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
            questions_charged: 0, balance_questions: restored,
          });
        }
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(SSE_DONE);
      } else if (deliveredChars === 0) {
        send({
          type: 'error',
          error: { message: '答案生成服务未返回内容，本次未消耗额度，请重试', code: 'upstream_error' },
        });
      } else {
        await settle(usage.inputTokens, usage.outputTokens);
        send({
          type: 'usage',
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          questions_charged: 1,
          balance_questions: balanceAfterHold,
        });
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(SSE_DONE);
      }
    } catch (err) {
      // A client that walked away AFTER receiving a usable answer keeps the charge: it was
      // delivered, and refunding it would make `curl --max-time 2` in a loop a free-answer tap.
      // A vendor failure always refunds, so "失败不扣题" still holds for every real failure.
      const objective = resultProtocol === 'objective_v1' ? objectiveComposition() : null;
      if (objective && objectiveResultIsBillable(objective)) {
        await settle(0, 0, objective.state ?? undefined, objective.parserPath).catch((e: unknown) => {
          req.log.error({ err: e }, 'settle failed after a delivered objective result; hold will be refunded');
        });
        if (settled) {
          send({ type: 'usage', input_tokens: 0, output_tokens: 0,
            questions_charged: 1, balance_questions: balanceAfterHold });
          if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(SSE_DONE);
        }
      } else if (objective?.parserPath === 'v1' && objective.state === 'retake') {
        const restored = await release().catch((e: unknown) => {
          req.log.error({ err: e }, 'release failed after delivered retake result');
          return balanceAfterHold;
        });
        if (settled) {
          send({ type: 'usage', input_tokens: 0, output_tokens: 0,
            questions_charged: 0, balance_questions: restored });
          if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(SSE_DONE);
        }
      } else if (abort.signal.aborted && resultProtocol === null && deliveredChars >= MIN_BILLABLE_CHARS) {
        // Token counts are unknown on this path (the vendor never reported usage); the question
        // count is what bills, so it stays exact and only the lifetime token stats under-count.
        await settle(0, 0).catch((e: unknown) => {
          req.log.error({ err: e }, 'settle failed after a delivered answer; hold will be refunded');
        });
        req.log.info({ deliveredChars }, 'client disconnected after a delivered answer; charge kept');
      } else {
        const message = err instanceof Error ? err.message : '模型服务错误';
        send({ type: 'error', error: { message, code: 'upstream_error' } });
      }
    } finally {
      done = true;
      if (!settled) {
        // Refund the hold. If this throws, the user is short exactly one question and the log
        // line is the record an operator needs to make it right via /admin/grant.
        await store
          .releaseReservation({ token, questions: 1 })
          .catch((e: unknown) => req.log.error({ err: e }, 'quota hold refund FAILED'));
      }
      captureLimiter.release(token);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
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
    // Card payments settle inside `checkout.session.completed`. Delayed-notification methods
    // (konbini, bank transfer, boleto — any of which the Dashboard may enable, since the session
    // deliberately does not pin payment_method_types) deliver that event as `unpaid` and settle
    // later via `async_payment_succeeded`. Listening only for the first meant the customer paid
    // and was never credited. Both events carry the same session id, so the reference-based
    // idempotency below still makes a double delivery a no-op.
    if (event.type !== 'checkout.session.completed' &&
        event.type !== 'checkout.session.async_payment_succeeded') {
      return reply.send({ received: true }); // acknowledge everything else
    }
    const session = event.data?.object;
    if (!session?.id || session.payment_status !== 'paid') {
      // The `completed`-but-unpaid half of a delayed method: nothing owed yet, and
      // `async_payment_succeeded` will arrive when it settles.
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
      .send(renderAdminPage());
  });

  app.get('/admin/metrics', async (req, reply) => {
    requireAdmin(req);
    const query = (req.query ?? {}) as { from?: unknown; to?: unknown; variant?: unknown };
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 7 * 86_400_000);
    const from = query.from === undefined ? defaultFrom : new Date(str(query.from));
    const to = query.to === undefined ? now : new Date(str(query.to));
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())
        || from >= to || to.getTime() - from.getTime() > 90 * 86_400_000) {
      throw new ApiError(400, '指标时间范围必须有效且不超过 90 天');
    }
    const variant = query.variant === undefined ? undefined : str(query.variant);
    if (variant !== undefined && !['control', 'objective_v1'].includes(variant)) {
      throw new ApiError(400, 'variant 无效');
    }
    return reply.send(await store.getProductMetrics({
      from: from.toISOString(), to: to.toISOString(), ...(variant ? { variant } : {}),
    }));
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
        updated_at: d.updatedAt,
        onboarded: d.onboarded,
        hotkey_presses: d.hotkeyPresses,
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
