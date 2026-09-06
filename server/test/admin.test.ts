import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

// Admin grant console with ADMIN_TOKEN configured: the /admin page exists and /admin/grant
// tops up a device's question balance when the secret is presented. Uses the mock provider and
// an in-memory SQLite DB (so the note column + lazy migration are exercised too).
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.CURRENCY = 'JPY';
process.env.QUOTA_POLICY_VERSION = 'legacy-test';
process.env.TRIAL_QUESTIONS = '10';
process.env.TRIAL_MIN_QUESTIONS = '10'; // pin min===max so the trial grant is deterministic (10)
process.env.TRIAL_MAX_QUESTIONS = '10';
process.env.ADMIN_TOKEN = 'admin-secret-xyz';
process.env.ALLOW_STUB_TOPUP = '0';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');

let app: FastifyInstance;
let base: string;

before(async () => {
  app = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
});

async function register(): Promise<string> {
  const res = await fetch(`${base}/v1/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: '2.0' }),
  });
  const body = (await res.json()) as { device_token: string };
  return body.device_token;
}

function grant(body: Record<string, unknown>, adminToken: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (adminToken !== null) headers['x-admin-token'] = adminToken;
  return fetch(`${base}/admin/grant`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function balance(token: string): Promise<number> {
  const r = await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { balance_questions: number };
  return j.balance_questions;
}

test('GET /admin serves the password-protected console with a grant form', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/i);
  const html = await res.text();
  assert.match(html, /管理后台/);
  assert.match(html, /\/admin\/grant/);          // the form posts here
  assert.ok(!html.includes('admin-secret-xyz'), 'the page must not embed the admin secret');
});

test('grant requires the admin secret', async () => {
  const token = await register();
  assert.equal((await grant({ device_token: token, questions: 100 }, null)).status, 401);
  assert.equal((await grant({ device_token: token, questions: 100 }, 'wrong-key')).status, 401);
  assert.equal(await balance(token), 10, 'nothing credited on auth failure');
});

test('a valid grant adds questions and persists an audit note', async () => {
  const token = await register();
  const res = await grant(
    { device_token: token, questions: 100, note: '客服赠送', idempotency_key: 'case-001' },
    'admin-secret-xyz',
  );
  assert.equal(res.status, 200);
  const j = (await res.json()) as { balance_questions: number; questions_granted: number };
  assert.equal(j.questions_granted, 100);
  assert.equal(j.balance_questions, 110); // 10 trial + 100 granted
  assert.equal(await balance(token), 110);
});

test('grant is idempotent on idempotency_key (no double credit)', async () => {
  const token = await register();
  const body = { device_token: token, questions: 50, idempotency_key: 'dupe-key-1' };
  assert.equal((await grant(body, 'admin-secret-xyz')).status, 200);
  assert.equal(await balance(token), 60);
  assert.equal((await grant(body, 'admin-secret-xyz')).status, 200); // redelivery
  assert.equal(await balance(token), 60, 'same key must not credit twice');
});

test('grant validates the device token shape and existence', async () => {
  // Malformed token → 400
  assert.equal((await grant({ device_token: 'not-a-token', questions: 5 }, 'admin-secret-xyz')).status, 400);
  // Well-formed but unregistered → 401
  const ghost = 'dev_' + 'x'.repeat(40);
  assert.equal((await grant({ device_token: ghost, questions: 5 }, 'admin-secret-xyz')).status, 401);
});

test('grant validates the question count', async () => {
  const token = await register();
  for (const q of [0, -5, 100001, 'abc', null]) {
    const res = await grant({ device_token: token, questions: q, idempotency_key: `bad-${q}` }, 'admin-secret-xyz');
    assert.equal(res.status, 400, `questions=${q} must be rejected`);
  }
  assert.equal(await balance(token), 10, 'no partial credit on invalid amounts');
});

test('grant accepts a numeric string amount (curl-friendly)', async () => {
  const token = await register();
  const res = await grant({ device_token: token, questions: '25', idempotency_key: 'str-amt' }, 'admin-secret-xyz');
  assert.equal(res.status, 200);
  assert.equal(await balance(token), 35);
});

function setCli(body: Record<string, unknown>, adminToken: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (adminToken !== null) headers['x-admin-token'] = adminToken;
  return fetch(`${base}/admin/cli`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function cliEnabled(token: string): Promise<boolean> {
  const r = await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { cli_enabled: boolean };
  return j.cli_enabled;
}

test('the admin page includes the CLI switch form', async () => {
  const html = await (await fetch(`${base}/admin`)).text();
  assert.match(html, /CLI 模式开关/);
  assert.match(html, /\/admin\/cli/);
});

test('cli switch requires the admin secret and defaults to off', async () => {
  const token = await register();
  assert.equal(await cliEnabled(token), false, 'new devices start with CLI off');
  assert.equal((await setCli({ device_token: token, enabled: true }, null)).status, 401);
  assert.equal((await setCli({ device_token: token, enabled: true }, 'wrong-key')).status, 401);
  assert.equal(await cliEnabled(token), false, 'nothing flipped on auth failure');
});

test('cli switch flips on and off, mirrored by /v1/account', async () => {
  const token = await register();
  const on = await setCli({ device_token: token, enabled: true }, 'admin-secret-xyz');
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { cli_enabled: true });
  assert.equal(await cliEnabled(token), true);
  const off = await setCli({ device_token: token, enabled: false }, 'admin-secret-xyz');
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { cli_enabled: false });
  assert.equal(await cliEnabled(token), false);
});

test('cli switch validates the token and the enabled flag', async () => {
  const token = await register();
  // Malformed token → 400; well-formed but unregistered → 401.
  assert.equal((await setCli({ device_token: 'not-a-token', enabled: true }, 'admin-secret-xyz')).status, 400);
  const ghost = 'dev_' + 'x'.repeat(40);
  assert.equal((await setCli({ device_token: ghost, enabled: true }, 'admin-secret-xyz')).status, 401);
  // enabled must be a real boolean — strings/numbers/missing are rejected.
  for (const v of ['true', 1, null, undefined]) {
    const res = await setCli({ device_token: token, enabled: v }, 'admin-secret-xyz');
    assert.equal(res.status, 400, `enabled=${String(v)} must be rejected`);
  }
});

// --- Read-only activity view -----------------------------------------------------------------

interface ActivityBody {
  limit: number;
  devices: Array<{
    id: number; platform: string | null; app_version: string | null;
    balance_questions: number; total_questions: number; created_at: string; updated_at: string;
    onboarded: boolean; hotkey_presses: number;
  }>;
  topups: Array<{
    device_id: number; questions: number; amount_cents: number; provider: string;
    note: string | null; device_platform: string | null; device_app_version: string | null;
    device_total_questions: number;
  }>;
}

function activity(adminToken: string | null, query = ''): Promise<Response> {
  const headers: Record<string, string> = {};
  if (adminToken !== null) headers['x-admin-token'] = adminToken;
  return fetch(`${base}/admin/activity${query}`, { headers });
}

test('activity view requires the admin secret', async () => {
  assert.equal((await activity(null)).status, 401);
  assert.equal((await activity('wrong-key')).status, 401);
});

test('activity view lists registrations and grants, newest first, without leaking tokens', async () => {
  const token = await register();
  const res = await activity('admin-secret-xyz');
  assert.equal(res.status, 200);
  const body = (await res.json()) as ActivityBody;

  const newest = body.devices[0];
  assert.ok(newest !== undefined, 'the device just registered must show up');
  assert.equal(newest.platform, 'macos');
  assert.equal(newest.app_version, '2.0');
  assert.equal(newest.balance_questions, 10); // the pinned trial grant
  assert.equal(newest.total_questions, 0);
  assert.ok(Number.isFinite(Date.parse(newest.created_at)), 'created_at is a real timestamp');

  // The bearer credential must never appear anywhere in the payload — the whole view is
  // readable by anyone holding the (weaker, operational) admin key.
  assert.ok(!JSON.stringify(body).includes(token), 'device tokens must not be exposed');

  // A grant on this device shows up as a top-up row carrying the device's own columns.
  const granted = await grant(
    { device_token: token, questions: 7, note: 'activity-test' }, 'admin-secret-xyz');
  assert.equal(granted.status, 200);
  const after = (await (await activity('admin-secret-xyz')).json()) as ActivityBody;
  const row = after.topups[0];
  assert.ok(row !== undefined);
  assert.equal(row.provider, 'admin');
  assert.equal(row.questions, 7);
  assert.equal(row.amount_cents, 0);
  assert.equal(row.note, 'activity-test');
  assert.equal(row.device_id, newest.id);
  assert.equal(row.device_platform, 'macos');
  assert.equal(row.device_app_version, '2.0');
});

test('activity limit is clamped to a sane range', async () => {
  for (const [q, want] of [['?limit=1', 1], ['?limit=9999', 200], ['?limit=0', 1],
                           ['?limit=junk', 50], ['', 50]] as const) {
    const body = (await (await activity('admin-secret-xyz', q)).json()) as ActivityBody;
    assert.equal(body.limit, want, `limit for "${q}"`);
    assert.ok(body.devices.length <= want);
  }
});

test('an upgraded client refreshes app_version on its next authenticated request', async () => {
  const token = await register(); // registers as "2.0"
  const before = (await (await activity('admin-secret-xyz')).json()) as ActivityBody;
  assert.equal(before.devices[0]?.app_version, '2.0');

  // The client now reports a newer build on an ordinary account sync.
  const r = await fetch(`${base}/v1/account`, {
    headers: { authorization: `Bearer ${token}`, 'x-app-version': '2.7' },
  });
  assert.equal(r.status, 200);

  const after = (await (await activity('admin-secret-xyz')).json()) as ActivityBody;
  assert.equal(after.devices[0]?.app_version, '2.7', 'the stored version follows the upgrade');
  // A version refresh is a sign of life, not balance activity: 最后活跃 must not move for it,
  // or the column silently starts meaning two different things.
  assert.equal(after.devices[0]?.updated_at, after.devices[0]?.created_at);
});

test('a missing or unchanged version header leaves the record alone', async () => {
  const token = await register();
  const id = ((await (await activity('admin-secret-xyz')).json()) as ActivityBody).devices[0]?.id;
  const cases: Record<string, string>[] = [
    { authorization: `Bearer ${token}` },                            // no header at all
    { authorization: `Bearer ${token}`, 'x-app-version': '2.0' },    // same version
    { authorization: `Bearer ${token}`, 'x-app-version': '   ' },    // blank
  ];
  for (const headers of cases) {
    assert.equal((await fetch(`${base}/v1/account`, { headers })).status, 200);
  }
  const body = (await (await activity('admin-secret-xyz')).json()) as ActivityBody;
  const row = body.devices.find((d) => d.id === id);
  assert.equal(row?.app_version, '2.0');
  assert.equal(row?.updated_at, row?.created_at, 'a no-op reconcile must not touch the row');
});

test('client signals separate "never pressed" from "pressed and nothing happened"', async () => {
  const token = await register();
  const mine = async () => {
    const body = (await (await activity('admin-secret-xyz', '?limit=50')).json()) as ActivityBody;
    return body.devices[0];
  };
  assert.equal((await mine())?.onboarded, false);
  assert.equal((await mine())?.hotkey_presses, 0);

  // A plain sync during onboarding: reports the build, but onboarding is not finished yet.
  await fetch(`${base}/v1/account`, {
    headers: { authorization: `Bearer ${token}`, 'x-app-version': '2.7', 'x-onboarded': '0' },
  });
  assert.equal((await mine())?.onboarded, false, 'x-onboarded: 0 must not set the flag');

  // Onboarding finished.
  await fetch(`${base}/v1/account`, {
    headers: { authorization: `Bearer ${token}`, 'x-onboarded': '1' },
  });
  assert.equal((await mine())?.onboarded, true);

  // Two hotkey presses whose captures never happened — no question is ever charged.
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/v1/account`, {
      headers: { authorization: `Bearer ${token}`, 'x-client-event': 'hotkey' },
    });
    assert.equal(r.status, 200);
  }
  const row = await mine();
  assert.equal(row?.hotkey_presses, 2);
  assert.equal(row?.total_questions, 0, 'this is the gap the whole signal exists to show');
  assert.equal(row?.updated_at, row?.created_at, 'diagnostics are not balance activity');
});

test('a bad token is still 401 even when it carries client signals', async () => {
  const res = await fetch(`${base}/v1/account`, {
    headers: {
      authorization: 'Bearer dev_' + 'x'.repeat(40),
      'x-onboarded': '1',
      'x-client-event': 'hotkey',
      'x-app-version': '9.9',
    },
  });
  assert.equal(res.status, 401, 'telemetry headers must never soften auth');
});
