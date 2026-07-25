import type { FastifyRequest } from 'fastify';
import type { Account, Store } from './db.ts';
import { ApiError } from './http.ts';

/** Extract and validate the Bearer device token, returning its account. Throws 401 otherwise. */
export async function requireAccount(
  req: FastifyRequest,
  store: Store,
): Promise<{ token: string; account: Account }> {
  const header = req.headers['authorization'];
  const token = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
  if (!token) throw new ApiError(401, '缺少设备令牌');
  const account = await store.getAccount(token);
  if (!account) throw new ApiError(401, '设备令牌无效');

  // Keep devices.app_version honest. It used to be written once at registration and never
  // again, so a machine that registered on 2.0.1 and upgraded still read as 2.0.1 — which made
  // the admin view actively misleading about who is running what. Clients report their build in
  // `x-app-version`; the write happens ONLY when it actually changed, i.e. once per upgrade,
  // never on the hot path. Best-effort: a failed write must never break a paid request.
  const version = header1(req, 'x-app-version').slice(0, 32);
  if (version !== '' && version !== account.appVersion) {
    await bestEffort(async () => {
      await store.updateAppVersion(token, version);
      account.appVersion = version;
    });
  }

  // Two client signals that answer the one question usage counts cannot: a device with zero
  // questions asked — did the user never get that far, or did they try and hit a dead end?
  //   • `x-onboarded` flips once the onboarding flow was completed.
  //   • `x-client-event: hotkey` rides the pre-capture warm-up ping, which the client fires the
  //     instant the hotkey is pressed — BEFORE the screenshot and before the quota gate. So a
  //     press still counts when the screenshot fails, the permission is missing, or the balance
  //     is empty. presses > 0 with questions === 0 means the client-side pipeline is broken;
  //     presses === 0 means the hotkey never reached the app at all.
  if (!account.onboarded && header1(req, 'x-onboarded') === '1') {
    await bestEffort(async () => {
      await store.markOnboarded(token);
      account.onboarded = true;
    });
  }
  if (header1(req, 'x-client-event') === 'hotkey') {
    await bestEffort(() => store.recordHotkeyPress(token));
  }
  return { token, account };
}

/** First value of a header, trimmed. Headers may arrive repeated; only the first is meaningful. */
function header1(req: FastifyRequest, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
}

/**
 * Run a telemetry write, swallowing any failure. These signals are diagnostics: losing one is
 * a gap in a chart, while letting it throw would fail a request the user has paid for.
 */
async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Intentionally ignored.
  }
}
