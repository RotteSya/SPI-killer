import {reconcileCheckout} from './checkout-service.ts';
import {retrieveStripeFinance} from './stripe-finance.ts';
import {reconcilePaymentFinance,type FinanceOrder,type FinanceSnapshot} from './payment-finance.ts';
import type {CheckoutSnapshot} from './checkout-reconciliation.ts';
import Fastify from 'fastify';
import { pathToFileURL } from 'node:url';
import { config, validateTrialPolicy } from './config.ts';
import { makeStore } from './storage.ts';
import { makeObjectiveProvider, makeProvider } from './providers/index.ts';
import type { Provider } from './providers/types.ts';
import { StubPaymentProvider, type PaymentProvider } from './payments.ts';
import { StripePaymentProvider, retrieveStripeRefund, reconcileStripeRefund, retrieveStripeCheckout } from './stripe.ts';
import type { RefundSnapshot } from './payment-ledger.ts';
import { registerRoutes } from './routes.ts';

// Compose the app so it can also be built in-process by tests (no listen). `overrides.provider`
// is a test-only seam for exercising vendor-failure paths (the real provider is chosen by config).
export async function buildApp(overrides: { provider?: Provider; objectiveProvider?: Provider; readStripeRefund?: (id:string)=>Promise<RefundSnapshot>; createStripeCheckout?: typeof import('./stripe.ts').createCheckoutSession; readStripeCheckout?: (id:string)=>Promise<CheckoutSnapshot>; readStripeFinance?:(order:FinanceOrder)=>Promise<FinanceSnapshot> } = {}) {
  validateTrialPolicy(config);
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Vercel rejects bodies above 4.5 MB before invoking the function. Match that ceiling
    // locally in serverless mode; the new official client leaves margin at 4 MiB JSON.
    bodyLimit: config.isServerless ? 4_500_000 : 16 * 1024 * 1024,
  });

  // Parse JSON while KEEPING the raw bytes on the request — Stripe webhook signatures are
  // computed over the exact payload, so re-serialized JSON would never verify.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as typeof req & { rawBody?: Buffer }).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const { store, kind: storeKind } = await makeStore(config);
  if (storeKind === 'memory') {
    app.log.warn('storage: in-memory fallback — data is EPHEMERAL; set POSTGRES_URL for production');
  }
  // A test-supplied provider is always taken at face value; only the config-driven path can be
  // degraded (a real vendor named without its key).
  const built = overrides.provider
    ? { provider: overrides.provider, degraded: null }
    : makeProvider(config, (msg) => app.log.warn(msg));
  // A provider override is a test seam and intentionally applies to both paths unless the test
  // supplies a dedicated Objective provider. Production always builds both configured slots.
  const objectiveBuilt = overrides.objectiveProvider
    ? { provider: overrides.objectiveProvider, degraded: null }
    : overrides.provider
      ? { provider: overrides.provider, degraded: null }
      : makeObjectiveProvider(config, (msg) => app.log.warn(msg));
  const payment: PaymentProvider =
    config.paymentProvider === 'stripe' && config.stripeSecretKey !== ''
      ? new StripePaymentProvider()
      : new StubPaymentProvider();
  // Selling question packs while the webhook that credits them cannot be verified means taking
  // money and never delivering. Loud at boot, and visible in /healthz.
  if (config.paymentProvider === 'stripe' && config.stripeSecretKey !== '' && config.stripeWebhookSecret === '') {
    app.log.error('STRIPE_WEBHOOK_SECRET is empty — purchases will be charged but NEVER credited');
  }
  registerRoutes(app, {
    config, store, storeKind,
    provider: built.provider, providerDegraded: built.degraded,
    objectiveProvider: objectiveBuilt.provider, objectiveProviderDegraded: objectiveBuilt.degraded,
    payment, readStripeRefund:overrides.readStripeRefund, createStripeCheckout:overrides.createStripeCheckout, readStripeCheckout:overrides.readStripeCheckout,readStripeFinance:overrides.readStripeFinance,
  });
  let paymentRecovery:Promise<void>|null=null;
  const reaper = setInterval(() => {
    void store.billing.reap().catch(() => app.log.error('reservation recovery failed'));
    void store.pruneProductEvents(new Date(Date.now()-90*86_400_000).toISOString()).catch(()=>app.log.error('event retention failed'));
    if(payment.name==='stripe'&&!paymentRecovery) paymentRecovery=(async()=>{
      const read=overrides.readStripeRefund??((id:string)=>retrieveStripeRefund(config.stripeSecretKey,id));
      await Promise.all((await store.payments.pendingRefunds(undefined,5)).map(async event=>{
        try {await reconcileStripeRefund(store.payments,event,read);} catch {app.log.error('refund reconciliation failed');}
      }));
      const readCheckout=overrides.readStripeCheckout??((id:string)=>retrieveStripeCheckout(config.stripeSecretKey,id));
      await Promise.all((await store.payments.checkouts.pending(undefined,3)).map(async reference=>{
        try{await reconcileCheckout(store.payments.checkouts,reference,{currency:config.currency,version:config.catalogVersion,packs:config.packs},readCheckout);}
        catch{app.log.error('checkout reconciliation failed');}
      }));
      const readFinance=overrides.readStripeFinance??((order:FinanceOrder)=>retrieveStripeFinance(config.stripeSecretKey,order));
      await Promise.all((await store.finance.pending(undefined,3)).map(async reference=>{
        try{await reconcilePaymentFinance(store.finance,reference,readFinance,false,store.payments);}catch{app.log.error('payment finance reconciliation failed');}
      }));
    })().catch(()=>app.log.error('payment recovery failed')).finally(()=>{paymentRecovery=null;});
  }, 60_000);
  reaper.unref();
  app.addHook('onClose', async () => { clearInterval(reaper); await paymentRecovery; await store.close(); });
  return app;
}

// Only start listening when run directly (not when imported by a test). Compare via
// pathToFileURL so a relative entry path (e.g. `node src/index.ts`) still matches.
const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
  const app = await buildApp();
  app
    .listen({ host: config.host, port: config.port })
    .then(() => {
      app.log.info(
        `NotchSPI official server up — control=${config.provider}:${config.model} objective=${config.objectiveProvider}:${config.objectiveModel} payments=${config.paymentProvider}`,
      );
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
