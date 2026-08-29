import Fastify from 'fastify';
import { pathToFileURL } from 'node:url';
import { config } from './config.ts';
import { makeStore } from './storage.ts';
import { makeProvider } from './providers/index.ts';
import type { Provider } from './providers/types.ts';
import { StubPaymentProvider, type PaymentProvider } from './payments.ts';
import { StripePaymentProvider } from './stripe.ts';
import { registerRoutes } from './routes.ts';

// Compose the app so it can also be built in-process by tests (no listen). `overrides.provider`
// is a test-only seam for exercising vendor-failure paths (the real provider is chosen by config).
export async function buildApp(overrides: { provider?: Provider } = {}) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Screenshots arrive as base64 JPEG; allow generous bodies.
    bodyLimit: 16 * 1024 * 1024,
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
    config, store, storeKind, provider: built.provider, providerDegraded: built.degraded, payment,
  });
  app.addHook('onClose', async () => store.close());
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
        `NotchSPI official server up — provider=${config.provider} model=${config.model} payments=${config.paymentProvider}`,
      );
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
