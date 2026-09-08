const REAP_URL = 'https://notchspi-api.vercel.app/api/internal/reap';
const MAX_RESPONSE_BYTES = 4096;
const DEADLINE_MS = 45_000;
const COUNTERS = ['processed', 'refunds_reconciled', 'refunds_failed', 'checkouts_credited',
  'checkouts_review', 'checkouts_failed', 'finance_reconciled', 'finance_failed', 'events_pruned'] as const;

async function readResult(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) {
    await response.body?.cancel();
    throw new Error('reaper_invalid_response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('reaper_response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('reaper_invalid_response');
  const record = result as Record<string, unknown>;
  if (typeof record.checked_at !== 'string' || !Number.isFinite(Date.parse(record.checked_at)) ||
      typeof record.more_possible !== 'boolean' ||
      COUNTERS.some(key => !Number.isSafeInteger(record[key]) || Number(record[key]) < 0)) {
    throw new Error('reaper_invalid_response');
  }
  return record;
}

export default {
  fetch() { return new Response(null, { status: 404 }); },
  async scheduled(controller, env) {
    const started = Date.now();
    let status = 0;
    try {
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.CRON_SECRET ?? '')) throw new Error('reaper_missing_secret');
      // Fixed origin and no redirects prevent sending the credential to another service.
      // Each tick makes one attempt; the server's durable, idempotent sweep owns recovery.
      const response = await fetch(REAP_URL, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(DEADLINE_MS),
        headers: { Authorization: `Bearer ${env.CRON_SECRET}`, Accept: 'application/json', 'Cache-Control': 'no-store' },
      });
      status = response.status;
      if (status !== 200) {
        await response.body?.cancel();
        throw new Error('reaper_http_failed');
      }
      const result = await readResult(response);
      const partial = ['refunds_failed', 'checkouts_failed', 'finance_failed'].some(key => Number(result[key]) > 0);
      console.log(JSON.stringify({ event: 'reaper_result', scheduled_at: controller.scheduledTime,
        duration_ms: Date.now() - started, status, more_possible: result.more_possible,
        ...Object.fromEntries(COUNTERS.map(key => [key, result[key]])) }));
      if (partial) throw new Error('reaper_partial_failure');
    } catch {
      // Never include response bodies, credentials or raw network/parser exceptions in logs.
      console.error(JSON.stringify({ event: 'reaper_failed', scheduled_at: controller.scheduledTime,
        duration_ms: Date.now() - started, status }));
      throw new Error('reaper_failed');
    }
  },
} satisfies ExportedHandler<Env>;
