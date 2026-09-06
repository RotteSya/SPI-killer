import { CaptureService } from './capture-service.ts';
import { aggregateCohorts, aggregateEconomics, parseReportQuery, reportTime, decimal, ReportLimitError, type ReportExpense } from './reporting.ts';
import { archivePayload, assembleReport, assertReportRetained, parseArchiveCursor, ReportExpiredError } from './report-archive.ts';
import {parseQualitySubmission,parseQualityList,qualityWithdrawal,QualityValidationError,QualityConflictError} from './quality.ts';
import { supportCatalog, SCREEN_QUERY_VERSION } from './screen-query.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import type { Provider } from './providers/types.ts';
import type { PaymentProvider, PageBanner, PageMode } from './payments.ts';
import type { StoreKind } from './storage.ts';
import { ApiError, errorBody } from './http.ts';
import { requireAccount } from './auth.ts';
import { findPack } from './pricing.ts';
import { isValidTokenShape, normalizeLang } from './payments.ts';
import { verifyStripeSignature, createCheckoutSession, stripeReference, retrieveStripeRefund, reconcileStripeRefund, retrieveStripeCheckout, type StripeEvent } from './stripe.ts';
import {checkoutSnapshot,checkoutCaseWire,validateCheckoutQuery,validateCheckoutDecision,type CheckoutSnapshot,type CheckoutQuery,type CheckoutDecision} from './checkout-reconciliation.ts';
import {reconcileCheckout} from './checkout-service.ts';
import {retrieveStripeFinance} from './stripe-finance.ts';
import {reconcilePaymentFinance,financeResource,type FinanceOrder,type FinanceSnapshot} from './payment-finance.ts';
import { renderLandingPage, resolveSiteLang } from './site.ts';
import { renderAdminPage } from './admin.ts';
import {renderPurchase,renderPurchaseComplete,PURCHASE_CSP} from './purchase-page.ts';
import { renderReportsPage, REPORT_PAGE_CSP } from './admin-reports.ts';
import {renderQualityPage,QUALITY_PAGE_CSP} from './admin-quality.ts';
import { createFixedWindowLimiter, clientIp } from './rateLimit.ts';
import { validateProductEvent } from './telemetry.ts';
import { validateEvent, paymentReportWire, type PaymentEvent, type RefundSnapshot } from './payment-ledger.ts';
import { parseObservationPreference, parseObservationCoverage, type ObservationState, type ObservationCoverage } from './observation.ts';

export interface AppContext {
  config: Config;
  store: Store;
  storeKind: StoreKind;
  provider: Provider;
  /** Non-null when a real vendor was configured without its key; captures refuse to run. */
  providerDegraded: string | null;
  objectiveProvider: Provider;
  /** Objective misconfiguration is isolated from control captures but visible in health. */
  objectiveProviderDegraded: string | null;
  payment: PaymentProvider;
  readStripeRefund?: (id: string) => Promise<RefundSnapshot>;
  createStripeCheckout?: typeof createCheckoutSession;
  readStripeCheckout?: (id:string)=>Promise<CheckoutSnapshot>;
  readStripeFinance?: (order:FinanceOrder)=>Promise<FinanceSnapshot>;
}

// Body shapes coming off the wire (all fields untrusted; validated in the handlers).
interface DeviceBody {
  platform?: unknown;
  app_version?: unknown;
  registration_attempt_id?: unknown;
}
interface EventBatchBody { schema_version?: unknown; events?: unknown }
function observationStateWire(state:ObservationState) {
  return {server_time:state.serverTime,preference:state.preference?{consent_epoch:state.preference.consentEpoch,
    sharing_enabled:state.preference.sharingEnabled,valid_from:state.preference.validFrom}:null};
}
function observationCoverageWire(coverage:ObservationCoverage) {
  return {observation_id:coverage.observationId,consent_epoch:coverage.consentEpoch,valid_from:coverage.validFrom,valid_to:coverage.validTo,
    sequence_from:coverage.sequenceFrom,sequence_to:coverage.sequenceTo,queue_drop_count:coverage.queueDropCount,
    coverage_status:coverage.coverageStatus,gap_reason:coverage.gapReason};
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
interface PurchaseSessionBody { pack_id?: unknown; catalog_version?: unknown; lang?: unknown; purchase_id?: unknown; session?: unknown }
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
  const {
    config, store, storeKind,
    provider, providerDegraded, objectiveProviderDegraded,
    payment,
  } = ctx;
  const captureService = new CaptureService(ctx);
  const stripeLive = payment.name === 'stripe' && config.stripeSecretKey !== '';
  const readRefund=ctx.readStripeRefund??((id:string)=>retrieveStripeRefund(config.stripeSecretKey,id));
  const readCheckout=ctx.readStripeCheckout??((id:string)=>retrieveStripeCheckout(config.stripeSecretKey,id));
  const readFinance=ctx.readStripeFinance??((order:FinanceOrder)=>retrieveStripeFinance(config.stripeSecretKey,order));
  const checkoutCatalog={currency:config.currency,version:config.catalogVersion,packs:config.packs};
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
  const eventLimiter = createFixedWindowLimiter(config.eventBatchPerMinute, 60 * 1000);
  let lastEventPruneDay = '';

  // Independently scheduled recovery is required on platforms that suspend idle HTTP instances.
  // A bounded, idempotent sweep may overlap with another worker or a capture's final transaction.
  app.get('/api/internal/reap', async (req, reply) => {
    reply.header('Cache-Control','no-store');
    if(!config.cronSecret) throw new ApiError(404,'未启用','not_found');
    const auth=typeof req.headers.authorization==='string'?req.headers.authorization:'';
    if(!adminTokenMatches(auth,'Bearer '+config.cronSecret)) throw new ApiError(401,'凭证无效','invalid_token');
    const started=Date.now(), now=new Date().toISOString();
    let processed=0, batch=0;
    do {
      batch=await store.billing.reap(now); processed+=batch;
    } while(batch===100&&processed<1000&&Date.now()-started<20_000);
    let refundsReconciled=0,refundsFailed=0;
    if(stripeLive&&Date.now()-started<20_000) {
      const pending=await store.payments.pendingRefunds(now,5);
      await Promise.all(pending.map(async event=>{
        try {if(await reconcileStripeRefund(store.payments,event,readRefund)) refundsReconciled++;}
        catch {refundsFailed++;}
      }));
    }
    let checkoutsCredited=0,checkoutsReview=0,checkoutsFailed=0;
    if(stripeLive&&Date.now()-started<20_000){
      const pending=await store.payments.checkouts.pending(now,3);
      await Promise.all(pending.map(async reference=>{try{const result=await reconcileCheckout(store.payments.checkouts,reference,checkoutCatalog,readCheckout);
        if(result==='credited')checkoutsCredited++;else if(result==='review'||result==='conflict')checkoutsReview++;}catch{checkoutsFailed++;}}));
    }
    let financeReconciled=0,financeFailed=0;
    if(stripeLive&&Date.now()-started<20_000)await Promise.all((await store.finance.pending(undefined,3)).map(async reference=>{
      try{if(await reconcilePaymentFinance(store.finance,reference,readFinance,false,store.payments))financeReconciled++;}catch{financeFailed++;}
    }));
    const eventsPruned=await store.pruneProductEvents(new Date(Date.parse(now)-90*86_400_000).toISOString());
    return {processed,checked_at:now,more_possible:batch===100,refunds_reconciled:refundsReconciled,refunds_failed:refundsFailed,
      checkouts_credited:checkoutsCredited,checkouts_review:checkoutsReview,checkouts_failed:checkoutsFailed,finance_reconciled:financeReconciled,finance_failed:financeFailed,events_pruned:eventsPruned};
  });

  // Config-at-a-glance for operators: which provider answers, where data lives, how payments
  // are wired. `db: "memory"` on a production deployment means POSTGRES_URL is missing.
  // GET / — the public product site (also the "company website" for payment-provider review).
  // Language: ?lang wins, then Accept-Language, defaulting to Japanese. Cacheable at the CDN;
  // Vary keeps the language negotiation honest.
  for(const [path,entry] of [['/',undefined],['/spi','spi'],['/reading-practice','reading_practice']] as const)app.get(path, async (req, reply) => {
    const q = (req.query ?? {}) as { lang?: unknown };
    const lang = resolveSiteLang(str(q.lang), str(req.headers['accept-language']));
    const html = renderLandingPage({
      packs: config.packs,
      trialQuestions: config.trialQuestions,
      currency: config.currency,
      lang,
      aiProvider: config.provider,
      entry,
      entryStatus: entry&&supportCatalog(config).profiles.find(p=>p.id===entry)?.status==='beta'?'beta':'disabled',
    });
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .header('Vary', 'Accept-Language')
      .header('Referrer-Policy','no-referrer')
      .header('X-Content-Type-Options','nosniff')
      .header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
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
    const objectiveActive = config.objectiveResultV1Bps > 0;
    const ok = providerDegraded === null && (!objectiveActive || objectiveProviderDegraded === null);
    const body = {
      ok,
      provider: provider.name,
      objective_provider: config.objectiveProvider,
      objective_provider_active: objectiveActive,
      // Error details name only environment-variable keys, never their secret values.
      ...(providerDegraded === null ? {} : { provider_error: providerDegraded }),
      ...(objectiveProviderDegraded === null ? {} : { objective_provider_error: objectiveProviderDegraded }),
      db: storeKind,
      payments: stripeLive ? 'stripe' : config.allowStubTopUp ? 'stub' : 'disabled',
      webhook: stripeLive ? (config.stripeWebhookSecret !== '' ? 'configured' : 'MISSING_SECRET') : 'n/a',
    };
    // 503 so an uptime check pages on a misconfigured deploy instead of reporting it healthy.
    return reply.code(ok ? 200 : 503).send(body);
  });

  // POST /v1/devices — anonymous registration, grants the free question quota. No auth, so a
  // per-IP cap keeps this from being a free-quota faucet (best-effort; see rateLimit.ts).
  app.post('/v1/devices', async (req, reply) => {
    if (!registerLimiter.hit(clientIp(req))) {
      throw new ApiError(429, '注册过于频繁，请稍后再试', 'rate_limited');
    }
    const body = (req.body ?? {}) as DeviceBody;
    const trialQuestions = config.trialQuestions;
    let registration = {};
    if (body.registration_attempt_id !== undefined) {
      const attempt = str(body.registration_attempt_id);
      try {
        registration = captureService.keys.registration(attempt);
        for (const version of captureService.keys.versions()) {
          const candidate = captureService.keys.registration(attempt, version);
          if (await store.getAccount(candidate.token)) { registration = candidate; break; }
        }
      } catch { throw new ApiError(400, '注册重试凭证无效'); }
    }
    if (!await store.billing.rateLimit(captureService.keys.digest('registration-ip', clientIp(req)), config.deviceRegPerHour, 3_600_000)) {
      throw new ApiError(429, '注册过于频繁，请稍后再试', 'rate_limited');
    }
    const platform = str(body.platform, 'unknown').slice(0, 32);
    const appVersion = str(body.app_version, 'unknown').slice(0, 32);
    const device = await store.registerDevice({ platform, appVersion, trialQuestions, policyVersion: config.quotaPolicyVersion, ...registration });
    // Every registration hands out a free grant that costs real model spend, so leave a trail:
    // the device row id plus the caller's IP is what tells a client-side credential bug (one IP,
    // one app version, repeated) apart from deliberate free-quota farming. No token is logged —
    // the row id is enough to look the device up in the admin view.
    req.log.info(
      { deviceId: device.id, ip: clientIp(req), platform, appVersion, trialQuestions },
      'device registered',
    );
    const quota = await store.billing.quota(device.token);
    if (!quota) throw new ApiError(503, '暂时无法核验注册额度，请使用原凭证重试');
    return reply.header('Cache-Control', 'no-store').send({
      policy_version: quota.policyVersion, initial_grant: quota.initialGrantQuestions, balance_version: quota.balanceVersion,
      device_token: device.token,
      balance_questions: quota.balanceQuestions,
    });
  });

  // GET /v1/account — question balance + lifetime usage + per-device feature switches. Auth.
  app.get('/v1/account', async (req, reply) => {
    const { token } = await requireAccount(req, store);
    await store.billing.reap();
    const account = await store.billing.accountSnapshot(token);
    if (!account) throw new ApiError(401, '设备令牌无效');
    return reply.header('Cache-Control', 'no-store').send({
      balance_version: account.balanceVersion, held_questions: account.heldQuestions,
      policy_version: account.policyVersion, quota_breakdown: account.quotaBreakdown,
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
      screen_query: { capabilities: config.screenQueryEnabled ? ['screen_query_v1', 'capture_status'] : ['capture_status'],
        support_revision: SCREEN_QUERY_VERSION, enabled_profiles: config.enabledSupportProfiles.split(',').filter(Boolean), limits: { max_images: 4, max_targets: 1, material_ttl_seconds: 900 },
        trial_policy: { version: config.quotaPolicyVersion, initial_grant: config.trialQuestions } },
      payments: { purchase_sessions: stripeLive, catalog_version: config.catalogVersion, currency: config.currency,
        packs: stripeLive ? config.packs.map(pack => ({ id: pack.id, questions: pack.questions, amount_minor: pack.amountCents })) : [] },
      telemetry: { enabled: config.telemetryEnabled, max_batch_size: 50, max_queue_age_days: 7 },
    });
  });

  app.post('/v1/events/batch', async (req, reply) => {
    const { token } = await requireAccount(req, store);
    if (!eventLimiter.hit(token)) throw new ApiError(429, '事件上传过于频繁', 'rate_limited');
    const body = (req.body ?? {}) as EventBatchBody;
    const encodedSize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (encodedSize > 64 * 1024) throw new ApiError(413, '事件批次过大');
    if (typeof body.schema_version !== 'number' || !Number.isInteger(body.schema_version) || ![1, 2].includes(body.schema_version) || !Array.isArray(body.events)
        || body.events.length < 1 || body.events.length > 50) {
      throw new ApiError(400, '事件批次格式无效');
    }
    if (!config.telemetryEnabled) {
      return reply.code(202).send({ accepted: 0, duplicate: 0, rejected: 0 });
    }
    const appVersion = typeof req.headers['x-app-version'] === 'string'
      ? req.headers['x-app-version'].slice(0, 32) : null;
    const valid = body.events.flatMap((event) => {
      const parsed = validateProductEvent(event, appVersion,new Date(),body.schema_version as number);
      return parsed ? [parsed] : [];
    });
    const result = await store.recordProductEvents(token, valid);
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastEventPruneDay) {
      lastEventPruneDay = today;
      const before = new Date(Date.now() - 90 * 86_400_000).toISOString();
      void store.pruneProductEvents(before).catch((err: unknown) => req.log.error({ err }, 'event prune failed'));
    }
    const rejected = body.events.length - valid.length+(result.rejected??0);
    req.log.info({ count: body.events.length, accepted: result.accepted, rejected }, 'product events');
    return reply.code(202).send({ accepted: result.accepted, duplicate: result.duplicate, rejected });
  });
  app.get('/v1/device-observation',async(req,reply)=>{
    const {token}=await requireAccount(req,store);const state=await store.observations.state(token);
    if(!state)throw new ApiError(401,'设备令牌无效','invalid_token');
    return reply.header('Cache-Control','no-store').send({...observationStateWire(state),telemetry_enabled:config.telemetryEnabled});
  });
  app.post('/v1/device-observation',async(req,reply)=>{
    const {token}=await requireAccount(req,store);
    if(!await store.billing.rateLimit(captureService.keys.digest('observation-device',token),30,60_000))throw new ApiError(429,'观察状态同步过于频繁','rate_limited');
    const body=(req.body??{}) as Record<string,unknown>;
    if(body.schema_version!==1||Object.keys(body).some(k=>!['schema_version','preference','coverage'].includes(k))||
      ('preference' in body)===('coverage' in body)||Buffer.byteLength(JSON.stringify(body))>4096)throw new ApiError(400,'观察状态格式无效');
    reply.header('Cache-Control','no-store');
    if('preference' in body) {
      const input=parseObservationPreference(body.preference);if(!input)throw new ApiError(400,'观察偏好格式无效');
      const accepted=await store.observations.preference(token,input);
      const state=await store.observations.state(token);if(!state)throw new ApiError(401,'设备令牌无效','invalid_token');
      return reply.code(accepted?200:409).send({accepted,...observationStateWire(state)});
    }
    const input=parseObservationCoverage(body.coverage);if(!input)throw new ApiError(400,'观察覆盖格式无效');
    const coverage=await store.observations.coverage(token,input,config.telemetryEnabled);
    if(!coverage)throw new ApiError(409,'观察覆盖标识冲突','idempotency_conflict');
    return reply.send({accepted:true,coverage:observationCoverageWire(coverage)});
  });

  // POST /v1/captures — streamed answer; one successful capture costs one question. Auth.
  //
  // Billing is RESERVE-then-SETTLE. The question is held against the balance in one atomic
  // statement before the vendor is called, and only converted into a charge once an answer has
  // actually been delivered; anything else refunds the hold. The previous order (stream first,
  // charge at the very end) had two holes: concurrent captures all passed the same stale balance
  // check, and a client that hung up mid-stream took the failure path and got its answer free.
  app.post('/v1/captures', (req, reply) => captureService.solve(req, reply));
  app.get('/v1/captures/:id/status', (req, reply) => captureService.status(req, reply));
  app.post('/v1/captures/:id/explanation', (req, reply) => captureService.auxiliary(req, reply, 'explain'));
  app.post('/v1/captures/:id/recovery', (req, reply) => captureService.auxiliary(req, reply, 'recover'));
  app.get('/v1/support', async (req, reply) => {
    const catalog = supportCatalog(config);
    const etag = '"' + createHmac('sha256', 'support-catalog').update(JSON.stringify(catalog)).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.header('ETag', etag).header('Cache-Control', 'public, max-age=300').send(catalog);
  });

  // New clients create a short-lived purchase handoff with their authenticated bearer. The
  // browser URL contains only the session id and one-time secret; the long device token never
  // leaves this request and is not placed in HTML, query parameters, or Stripe metadata.
  app.post('/v1/purchase-sessions', {bodyLimit:4096}, async (req, reply) => {
    if (!stripeLive) throw new ApiError(404, '未启用');
    const { token } = await requireAccount(req, store);
    reply.header('Cache-Control','no-store');
    const body=(req.body??{}) as PurchaseSessionBody;
    const pack=findPack(config.packs,str(body.pack_id));
    if(!pack) throw new ApiError(400,'题包无效');
    if(str(body.catalog_version)!==config.catalogVersion) throw new ApiError(409,'价格目录已更新，请刷新后重试','idempotency_conflict');
    const purchaseId=str(body.purchase_id);
    if(!/^[0-9a-f-]{16,80}$/i.test(purchaseId)) throw new ApiError(400,'purchase_id 无效');
    const session=await store.createPurchaseSession({token,purchaseId,packId:pack.id,catalogVersion:config.catalogVersion,
      questions:pack.questions,amountCents:pack.amountCents,currency:config.currency,lang:normalizeLang(str(body.lang))});
    if(!session) throw new ApiError(409,'购买请求已存在或无法创建','idempotency_conflict');
    return reply.code(201).send({purchase_url:`${config.publicBaseURL}/purchase?session=${session.sessionId}.${session.secret}`,
      expires_at:session.expiresAt,catalog_version:session.catalogVersion,pack_id:session.packId,questions:session.questions,
      amount_minor:session.amountCents,currency:session.currency});
  });

  app.get('/purchase', async (req, reply) => {
    const raw=str((req.query as {session?:unknown}|undefined)?.session);
    const dot=raw.indexOf('.');
    if(dot<1) throw new ApiError(404,'购买链接无效','not_found');
    const session=await store.getPurchaseSession(raw.slice(0,dot),raw.slice(dot+1));
    if(!session) throw new ApiError(410,'购买链接已失效','expired');
    return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',PURCHASE_CSP)
      .header('X-Content-Type-Options','nosniff').type('text/html; charset=utf-8').send(renderPurchase(session,raw));
  });

  app.get('/purchase/complete',async(req,reply)=>{
    if(!stripeLive)throw new ApiError(404,'未启用');
    const query=(req.query??{}) as {lang?:unknown;canceled?:unknown};
    return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',PURCHASE_CSP)
      .header('X-Content-Type-Options','nosniff').type('text/html; charset=utf-8').send(renderPurchaseComplete(str(query.lang),query.canceled==='1'));
  });

  app.post('/purchase/checkout', {bodyLimit:4096}, async (req, reply) => {
    reply.header('Cache-Control','no-store');
    if(!stripeLive) throw new ApiError(404,'未启用');
    const raw=str((req.body as PurchaseSessionBody|undefined)?.session),dot=raw.indexOf('.');
    if(dot<1) throw new ApiError(400,'购买链接无效');
    const session=await store.getPurchaseSession(raw.slice(0,dot),raw.slice(dot+1));
    if(!session) throw new ApiError(410,'购买链接已失效','expired');
    const pack=findPack(config.packs,session.packId);
    if(!pack||pack.questions!==session.questions||pack.amountCents!==session.amountCents||config.currency!==session.currency||config.catalogVersion!==session.catalogVersion)
      throw new ApiError(409,'价格目录已更新，请重新发起购买','idempotency_conflict');
    if(session.checkoutSessionId&&session.checkoutURL)return reply.send({url:session.checkoutURL});
    const result=await (ctx.createStripeCheckout??createCheckoutSession)(config.stripeSecretKey,{pack,purchaseSessionId:session.sessionId,currency:session.currency,publicBaseURL:config.publicBaseURL,lang:normalizeLang(session.lang)});
    if('error' in result||!result.id) { req.log.error({stripeError:'error' in result?result.error:'missing checkout id'},'checkout session creation failed'); throw new ApiError(502,'支付服务暂时不可用，请稍后再试','upstream_error'); }
    if(!await store.attachPurchaseCheckout(session.sessionId,result.id,result.url)) throw new ApiError(409,'购买请求已处理','capture_already_finalized');
    return reply.send({url:result.url});
  });
  app.post('/admin/reservations/recover', async (req, reply) => {
    requireAdmin(req);
    return reply.send({ released: await store.billing.reap() });
  });
  const financeReference=(raw:unknown):string=>{
    if(typeof raw!=='string'||!/^cs_[A-Za-z0-9_]{1,160}$/.test(raw))throw new ApiError(400,'订单引用无效');return raw;
  };
  app.get('/admin/payments/finance',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');const raw=(req.query??{}) as Record<string,unknown>;
    if(Object.keys(raw).some(k=>k!=='reference'))throw new ApiError(400,'查询字段无效');
    return reply.send(await store.finance.inspect(financeReference(raw.reference)));
  });
  app.post('/admin/payments/finance/reconcile',{bodyLimit:4096},async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');if(!stripeLive)throw new ApiError(409,'未启用真实支付');
    const raw=(req.body??{}) as Record<string,unknown>;if(Object.keys(raw).some(k=>k!=='reference'))throw new ApiError(400,'核对字段无效');
    const reference=financeReference(raw.reference);
    if(!await store.billing.rateLimit('admin_payment_finance',12,60_000))throw new ApiError(429,'核对过于频繁','rate_limited');
    try{const applied=await reconcilePaymentFinance(store.finance,reference,readFinance,true,store.payments);return reply.send({applied,...await store.finance.inspect(reference)});}
    catch{throw new ApiError(503,'费用与拒付状态暂时无法核对','upstream_error');}
  });
  app.get('/admin/payments', async(req,reply)=>{
    requireAdmin(req);
    const reference=str((req.query as {order_reference?:unknown}|undefined)?.order_reference);
    if(reference&&!/^cs_[A-Za-z0-9_]{1,160}$/.test(reference)) throw new ApiError(400,'订单标识无效');
    return reply.header('Cache-Control','no-store').send(paymentReportWire(await store.payments.report(100,reference||undefined)));
  });
  app.get('/admin/payments/checkouts',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const raw=(req.query??{}) as Record<string,unknown>;let query:CheckoutQuery;
    try{if(Object.keys(raw).some(k=>!['state','before','limit'].includes(k))||
      (raw.limit!==undefined&&(typeof raw.limit!=='string'||! /^(?:[1-9][0-9]?|100)$/.test(raw.limit))))throw new Error();
      query={limit:raw.limit===undefined?50:Number(raw.limit),...(raw.state!==undefined?{state:raw.state as CheckoutQuery['state']}:{}),...(raw.before!==undefined?{before:raw.before as string}:{})};validateCheckoutQuery(query);
    }catch{throw new ApiError(400,'付款核对筛选无效');}
    const page=await store.payments.checkouts.list(query);return {...page,items:page.items.map(checkoutCaseWire)};
  });
  app.get('/admin/payments/checkouts/:reference',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');const {reference}=req.params as {reference:string};
    if(!/^cs_[A-Za-z0-9_]{1,160}$/.test(reference))throw new ApiError(400,'付款标识无效');
    const entry=await store.payments.checkouts.get(reference);if(!entry)throw new ApiError(404,'未找到付款核对记录');return checkoutCaseWire(entry);
  });
  app.post('/admin/payments/checkouts/:reference/recheck',{bodyLimit:4096},async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');const {reference}=req.params as {reference:string};
    if(!/^cs_[A-Za-z0-9_]{1,160}$/.test(reference)||(req.body!==undefined&&req.body!==null&&
      (typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)))throw new ApiError(400,'付款重核请求无效');
    if(!await store.payments.checkouts.get(reference))throw new ApiError(404,'未找到付款核对记录');
    if(!stripeLive)throw new ApiError(503,'支付核对服务未启用','upstream_error');
    try{await reconcileCheckout(store.payments.checkouts,reference,checkoutCatalog,readCheckout,undefined,true);}catch{throw new ApiError(503,'当前付款状态暂时无法读取','upstream_error');}
    return checkoutCaseWire((await store.payments.checkouts.get(reference))!);
  });
  app.post('/admin/payments/checkouts/:reference/decision',{bodyLimit:4096},async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');const {reference}=req.params as {reference:string};
    const raw=(req.body??{}) as Record<string,unknown>;let decision:CheckoutDecision;
    try{if(!/^cs_[A-Za-z0-9_]{1,160}$/.test(reference)||Object.keys(raw).sort().join(',')!==
      ['review_reference','fingerprint','evidence_sha256','device_id','questions','pack_id','catalog_version'].sort().join(','))throw new Error();
      decision={reference:raw.review_reference as string,fingerprint:raw.fingerprint as string,evidenceSha256:raw.evidence_sha256 as string,
        deviceId:raw.device_id as number,questions:raw.questions as number,packId:raw.pack_id as string,catalogVersion:raw.catalog_version as string};validateCheckoutDecision(decision);
    }catch{throw new ApiError(400,'付款审查须包含当前指纹、证据摘要、明确设备及题包题数');}
    if(!await store.payments.checkouts.get(reference))throw new ApiError(404,'未找到付款核对记录');
    if(!stripeLive)throw new ApiError(503,'支付核对服务未启用','upstream_error');
    let result;try{result=await reconcileCheckout(store.payments.checkouts,reference,checkoutCatalog,readCheckout,decision);}
    catch{throw new ApiError(503,'当前付款状态暂时无法读取','upstream_error');}
    if(result!=='credited')throw new ApiError(409,'付款事实或审查已变化，请重新核对记录','idempotency_conflict');
    return {applied:true,record:checkoutCaseWire((await store.payments.checkouts.get(reference))!)};
  });
  app.post('/admin/payments/refund-decision',async(req,reply)=>{
    requireAdmin(req);
    const body=(req.body??{}) as Record<string,unknown>;
    if(typeof body.questions!=='number'||!Number.isSafeInteger(body.questions)||body.questions<0||
      !/^[a-f0-9]{64}$/.test(str(body.fingerprint))||!/^[A-Za-z0-9_-]{1,100}$/.test(str(body.decision_reference))) throw new ApiError(400,'退款额度审核记录无效');
    const applied=await store.payments.decidePartial(str(body.order_reference),{
      reference:str(body.decision_reference),fingerprint:str(body.fingerprint),questions:body.questions,
    });
    if(!applied) throw new ApiError(409,'退款状态已更新或需要重新审核','idempotency_conflict');
    return reply.header('Cache-Control','no-store').send({applied:true});
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
    const object=event.data?.object;
    const createdAt=typeof event.created==='number'&&Number.isSafeInteger(event.created)&&event.created>=0&&event.created<8_640_000_000_000
      ? new Date(event.created*1000).toISOString():null;
    const receipt:PaymentEvent={id:str(event.id),type:str(event.type),resourceId:str(object?.id),createdAt,
      payloadHash:createHash('sha256').update(rawBody).digest('hex')};
    try { validateEvent(receipt); } catch { throw new ApiError(400,'支付事件格式无效'); }
    if(/^(?:checkout\.session\.(?:completed|async_payment_succeeded)|refund\.(?:created|updated|failed)|charge\.(?:succeeded|updated|refunded|refund\.updated|dispute\.(?:created|updated|closed|funds_withdrawn|funds_reinstated)))$/.test(event.type)){
      const financialObject=object as unknown as Record<string,unknown>;
      const resources=[receipt.resourceId,stripeReference(financialObject?.payment_intent),stripeReference(financialObject?.charge)].filter((id):id is string=>id!==null);
      if(resources.some(id=>!financeResource(id)))throw new ApiError(400,'支付资源关联格式无效');
      await store.finance.observe({event:receipt,resources});
    }
    if(['refund.created','refund.updated','refund.failed','charge.refund.updated'].includes(event.type)) {
      try { await reconcileStripeRefund(store.payments,receipt,readRefund); }
      catch { throw new ApiError(503,'退款状态暂时无法核对，请重试','upstream_error'); }
      return reply.send({received:true});
    }
    // charge.refunded is an aggregate notification, not a second cash-refund fact.
    // Each re_ resource is reconciled separately through refund.* notifications.
    if(/^charge\.dispute\.(?:created|updated|closed|funds_withdrawn|funds_reinstated)$/.test(event.type)) {
      const amount=object?.amount;
      if(!Number.isSafeInteger(amount)||typeof amount!=='number'||amount<0||! /^[a-z]{3}$/i.test(str(object?.currency))) throw new ApiError(400,'争议事件格式无效');
      await store.recordWebhookEvent({providerEventId:receipt.id,eventType:receipt.type,resourceId:receipt.resourceId,eventCreatedAt:receipt.createdAt});
      await store.recordPaymentAdjustment({providerRef:receipt.id,orderReference:stripeReference(object?.payment_intent)??receipt.resourceId,
        type:'dispute',amountCents:amount,currency:object!.currency!.toUpperCase(),status:'observed',effectiveAt:createdAt??new Date().toISOString()});
      await store.payments.acknowledge(receipt); return reply.send({received:true});
    }
    if((event.type!=='checkout.session.completed'&&event.type!=='checkout.session.async_payment_succeeded')||object?.payment_status!=='paid') {
      await store.payments.acknowledge(receipt); return reply.send({received:true});
    }
    let snapshot:CheckoutSnapshot;
    try{snapshot=checkoutSnapshot(object);}catch{throw new ApiError(400,'付款资源格式无效');}
    // Commit the signed, content-free receipt before resolving any quota or catalog facts.
    await store.payments.checkouts.receive(receipt,snapshot);
    const claim=await store.payments.checkouts.claim(snapshot.id);
    if(claim){try{await store.payments.checkouts.finish(claim,claim.signed,'signed_event',checkoutCatalog);}
      catch{await store.payments.checkouts.defer(claim);throw new ApiError(503,'付款核对暂时不可用，记录已保留','upstream_error');}}
    return reply.send({received:true});
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

  app.get('/admin/reports',async(_req,reply)=>{
    if(!adminEnabled)throw new ApiError(404,'未启用');
    return reply.header('Cache-Control','no-store').header('X-Robots-Tag','noindex, nofollow')
      .header('Content-Security-Policy',REPORT_PAGE_CSP).header('Referrer-Policy','no-referrer')
      .header('X-Content-Type-Options','nosniff').type('text/html; charset=utf-8').send(renderReportsPage());
  });

  for(const economics of [false,true])app.get(economics?'/admin/economics':'/admin/cohorts',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    let input;try{input=parseReportQuery((req.query??{}) as Record<string,unknown>,Date.now(),economics);}
    catch{throw new ApiError(400,'报表筛选无效，请使用 UTC 时间及支持的筛选项');}
    try{
      assertReportRetained(input);
      const facts=await store.reporting.snapshot(input);
      return reply.send(economics?aggregateEconomics(facts,input):aggregateCohorts(facts,input));
    }catch(error){if(error instanceof ReportExpiredError)throw new ApiError(410,'批次已超出明细保留期，请读取已保存的归档','report_details_expired');
      if(error instanceof ReportLimitError)throw new ApiError(413,'报表范围过大，请缩小注册批次');throw error;}
  });
  async function buildReport(raw:Record<string,unknown>){
    let input;try{input=parseReportQuery(raw);}catch{throw new ApiError(400,'报表筛选无效，请使用 UTC 时间及支持的筛选项');}
    try{assertReportRetained(input);return assembleReport(await store.reporting.snapshot(input),input);}
    catch(error){if(error instanceof ReportExpiredError)throw new ApiError(410,'批次已超出明细保留期，请读取已保存的归档','report_details_expired');
      if(error instanceof ReportLimitError)throw new ApiError(413,'报表范围过大，请缩小注册批次');throw error;}
  }
  app.get('/admin/reports/data',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const report=await buildReport((req.query??{}) as Record<string,unknown>);
    return {report,payload_sha256:archivePayload(report).digest};
  });
  app.post('/admin/reports/archive',{bodyLimit:4096},async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const body=(req.body??{}) as Record<string,unknown>;
    if(Object.keys(body).sort().join(',')!=='expected_payload_sha256,query'||!body.query||typeof body.query!=='object'||Array.isArray(body.query)||
      typeof body.expected_payload_sha256!=='string'||! /^[a-f0-9]{64}$/.test(body.expected_payload_sha256))throw new ApiError(400,'请提供已查看报表的筛选和内容摘要');
    const report=await buildReport(body.query as Record<string,unknown>);
    if(archivePayload(report).digest!==body.expected_payload_sha256)throw new ApiError(409,'报表事实已变化，请重新加载后保存','report_changed');
    return store.reporting.archives.save(report);
  });
  app.get('/admin/reports/archives',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const raw=(req.query??{}) as Record<string,unknown>;let limit=20,cursor:string|undefined;
    try{
      if(Object.keys(raw).some(k=>!['limit','cursor'].includes(k)))throw new Error();
      if(raw.limit!==undefined){if(typeof raw.limit!=='string'||! /^(?:[1-9]|[1-4][0-9]|50)$/.test(raw.limit))throw new Error();limit=Number(raw.limit);}
      if(raw.cursor!==undefined){if(typeof raw.cursor!=='string')throw new Error();parseArchiveCursor(raw.cursor);cursor=raw.cursor;}
    }catch{throw new ApiError(400,'归档页码或每页条数无效');}
    return store.reporting.archives.list(limit,cursor);
  });
  app.get('/admin/reports/archives/:id',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const id=(req.params as {id:string}).id;
    if(! /^[a-f0-9]{64}$/.test(id))throw new ApiError(400,'归档标识无效');
    const archive=await store.reporting.archives.get(id);if(!archive)throw new ApiError(404,'未找到归档');
    return archive;
  });
  app.post('/admin/quality',{bodyLimit:2*1024*1024},async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    try{return await store.reporting.quality.record(parseQualitySubmission(req.body));}
    catch(error){if(error instanceof QualityValidationError)throw new ApiError(400,'质量记录须包含有版本绑定的逐题核验与独立复核声明');
      if(error instanceof QualityConflictError)throw new ApiError(409,'评测 ID 已绑定其他执行记录','idempotency_conflict');throw error;}
  });
  app.get('/admin/quality',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    let query;try{query=parseQualityList((req.query??{}) as Record<string,unknown>);}catch{throw new ApiError(400,'质量筛选或页码无效');}
    return store.reporting.quality.list(query);
  });
  app.get('/admin/quality/reports',async(_req,reply)=>{
    if(!adminEnabled)throw new ApiError(404,'未启用');
    return reply.header('Cache-Control','no-store').header('X-Robots-Tag','noindex, nofollow').header('Content-Security-Policy',QUALITY_PAGE_CSP)
      .header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').type('text/html; charset=utf-8').send(renderQualityPage());
  });
  app.get('/admin/quality/:id',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const id=(req.params as {id:string}).id;if(! /^[a-f0-9]{64}$/.test(id))throw new ApiError(400,'质量报告 ID 无效');
    const record=await store.reporting.quality.get(id);if(!record)throw new ApiError(404,'未找到质量报告');return record;
  });
  app.post('/admin/quality/:id/withdraw',{bodyLimit:4096},async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const id=(req.params as {id:string}).id,body=(req.body??{}) as Record<string,unknown>;
    if(! /^[a-f0-9]{64}$/.test(id)||Object.keys(body).sort().join(',')!=='reason,reference')throw new ApiError(400,'撤回记录格式无效');
    let input;try{input=qualityWithdrawal(body.reference,body.reason);}catch{throw new ApiError(400,'撤回引用或原因无效');}
    if(!await store.reporting.quality.withdraw(id,input.reference,input.reason))throw new ApiError(409,'报告不存在、已撤回或审计引用冲突','idempotency_conflict');
    return {accepted:true};
  });
  app.post('/admin/devices/internal',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const body=(req.body??{}) as Record<string,unknown>;
    if(Object.keys(body).some(k=>!['device_id','is_internal','reference'].includes(k))||typeof body.device_id!=='number'||!Number.isSafeInteger(body.device_id)||body.device_id<=0||
      typeof body.is_internal!=='boolean'||typeof body.reference!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(body.reference))throw new ApiError(400,'内部设备标记格式无效');
    if(!await store.reporting.setInternal(body.device_id,body.is_internal,body.reference))throw new ApiError(409,'设备不存在或审计标识冲突','idempotency_conflict');
    return {accepted:true};
  });
  app.post('/v1/device-source',{bodyLimit:4096},async(req,reply)=>{
    const {token}=await requireAccount(req,store);reply.header('Cache-Control','no-store');
    const body=(req.body??{}) as Record<string,unknown>;
    if(Object.keys(body).some(k=>k!=='source_group')||typeof body.source_group!=='string'||!['spi_entry','reading_practice_entry','direct','unknown'].includes(body.source_group))throw new ApiError(400,'来源格式无效');
    if(!await store.reporting.source(token,body.source_group,'self_reported'))throw new ApiError(409,'已记录来源','idempotency_conflict');
    return {accepted:true};
  });
  app.post('/admin/economics/expense-allocation',async(req,reply)=>{
    requireAdmin(req);reply.header('Cache-Control','no-store');
    const body=(req.body??{}) as Record<string,unknown>;let input:Omit<ReportExpense,'recordedAt'>;
    try{
      if(Object.keys(body).some(k=>!['reference','kind','currency','amount_micros','cohort_from','cohort_to','coverage_through','source','policy_version'].includes(k))||
        typeof body.reference!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(body.reference)||!['service','acquisition'].includes(String(body.kind))||
        typeof body.kind!=='string'||typeof body.currency!=='string'||! /^[A-Z]{3}$/.test(body.currency)||typeof body.amount_micros!=='string')throw new Error('Invalid expense');
      input={reference:body.reference,kind:body.kind as 'service'|'acquisition',currency:body.currency,amountMicros:decimal(body.amount_micros),
        cohortFrom:reportTime(body.cohort_from),cohortTo:reportTime(body.cohort_to),coverageThrough:reportTime(body.coverage_through)};
      const dimensions=parseReportQuery({cohort_from:body.cohort_from,cohort_to:body.cohort_to,source:body.source,policy_version:body.policy_version});
      if(dimensions.source)input.sourceGroup=dimensions.source;if(dimensions.policyVersion)input.policyVersion=dimensions.policyVersion;
      if(input.cohortFrom>=input.cohortTo||input.cohortTo>input.coverageThrough)throw new Error('Invalid expense coverage');
    }catch{throw new ApiError(400,'费用分摊必须包含已核对的金额、币种、注册批次、覆盖截止时间和唯一审计引用');}
    if(!await store.reporting.expense(input))throw new ApiError(409,'费用审计引用冲突','idempotency_conflict');return {accepted:true};
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
    if (statusCode === 413) return reply.code(413).send(errorBody('请求数据过大，请减少内容后重试。', 'payload_too_large'));
    const message = statusCode === 500 ? '服务器内部错误' : (e.message ?? '请求错误');
    return reply.code(statusCode).send(errorBody(message, statusCode === 500 ? 'internal' : 'bad_request'));
  });
}
