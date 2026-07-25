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
  const reported = req.headers['x-app-version'];
  const version = (Array.isArray(reported) ? reported[0] : reported)?.trim().slice(0, 32) ?? '';
  if (version !== '' && version !== account.appVersion) {
    try {
      await store.updateAppVersion(token, version);
      account.appVersion = version;
    } catch {
      // Ignore: reporting the build is telemetry, not part of the contract.
    }
  }
  return { token, account };
}
