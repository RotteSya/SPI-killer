import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Provider, Usage, CaptureRequest } from '../src/providers/types.ts';

// The product promise is "失败不扣题": a capture that produces no answer must never cost a
// question. We inject a scripted provider (a test-only buildApp seam) to exercise the three
// outcomes — vendor throw, empty HTTP-200 stream, and a normal answer — and assert the balance.
process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock'; // ignored: we inject a provider below
process.env.TRIAL_QUESTIONS = '3';
process.env.TRIAL_MIN_QUESTIONS = '3'; // pin min===max so the trial grant is deterministic (3)
process.env.TRIAL_MAX_QUESTIONS = '3';
process.env.CURRENCY = 'CNY';
process.env.LOG_LEVEL = 'silent';
process.env.DEVICE_REG_PER_HOUR = '1000'; // don't let the abuse limits interfere with this suite
process.env.CAPTURE_CONCURRENCY_PER_TOKEN = '1000';

const { buildApp } = await import('../src/index.ts');

// Scripted provider whose behavior is flipped per test via `mode`.
let mode: 'throw' | 'empty' | 'ok' | 'slow' | 'answerThenStall' | 'objectiveReady' | 'objectiveRetake' = 'ok';

/** Comfortably past the route's MIN_BILLABLE_CHARS — a complete answer, not a false start. */
const LONG_ANSWER = 'x'.repeat(400);

/** Resolve after `ms`, or reject the moment the client goes away — what a real vendor client does. */
function sleepHonoringAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

const provider: Provider = {
  name: 'scripted',
  async stream(_req: CaptureRequest, onDelta: (t: string) => void, signal: AbortSignal): Promise<Usage> {
    if (mode === 'throw') throw new Error('vendor exploded');
    if (mode === 'slow') {
      // Hold the quota reservation open long enough for another request to race it.
      await sleepHonoringAbort(120, signal);
      onDelta('hello');
    } else if (mode === 'answerThenStall') {
      // Deliver a full answer, then keep the stream open. Models the client reading the answer
      // and closing the connection rather than waiting for the trailing usage frame.
      onDelta(LONG_ANSWER);
      await sleepHonoringAbort(2_000, signal);
    } else if (mode === 'objectiveReady') {
      onDelta('work\nFINAL: B\nNSPI_RESULT_V1: {"v":1,"kind":"single_choice","state":"ready","answer":"B","reason":"none"}');
    } else if (mode === 'objectiveRetake') {
      onDelta('NSPI_RESULT_V1: {"v":1,"kind":"single_choice","state":"retake","answer":null,"reason":"cropped"}');
    } else if (mode === 'ok') {
      onDelta('hello');
    }
    // 'empty' resolves with usage but never emits a delta (e.g. a content-filter block).
    return { inputTokens: 5, outputTokens: 7 };
  },
};

let app: FastifyInstance;
let base: string;

before(async () => {
  app = await buildApp({ provider });
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
    body: JSON.stringify({ platform: 'macos', app_version: 'test' }),
  });
  const body = (await res.json()) as { device_token: string };
  return body.device_token;
}

async function capture(token: string): Promise<string> {
  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
  });
  return res.text();
}

async function objectiveCapture(token: string): Promise<string> {
  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg',
      result_protocol: 'objective_v1', capture_id: '3e7979c6-20cb-4c12-a23e-ece6eb3aa52d' }),
  });
  return res.text();
}

async function balance(token: string): Promise<{ balance_questions: number; total_questions: number }> {
  const res = await fetch(`${base}/v1/account`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as { balance_questions: number; total_questions: number };
}

test('a vendor error mid-stream is reported and does NOT charge a question', async () => {
  const token = await register();
  mode = 'throw';
  const text = await capture(token);
  assert.match(text, /"type":"error"/);
  assert.doesNotMatch(text, /"questions_charged"/);
  assert.doesNotMatch(text, /\[DONE\]/);
  const acct = await balance(token);
  assert.equal(acct.balance_questions, 3, 'balance unchanged after a failed answer');
  assert.equal(acct.total_questions, 0);
});

test('an empty (no-delta) stream is treated as a failure and does NOT charge', async () => {
  const token = await register();
  mode = 'empty';
  const text = await capture(token);
  assert.match(text, /"type":"error"/);
  assert.doesNotMatch(text, /"questions_charged"/);
  const acct = await balance(token);
  assert.equal(acct.balance_questions, 3, 'an empty answer must be free');
  assert.equal(acct.total_questions, 0);
});

test('a normal answer charges exactly one question', async () => {
  const token = await register();
  mode = 'ok';
  const text = await capture(token);
  assert.match(text, /"type":"delta"/);
  assert.match(text, /"questions_charged":1/);
  assert.match(text, /\[DONE\]/);
  const acct = await balance(token);
  assert.equal(acct.balance_questions, 2);
  assert.equal(acct.total_questions, 1);
});

test('objective ready charges once and objective retake releases the hold', async () => {
  const token = await register();
  mode = 'objectiveReady';
  const ready = await objectiveCapture(token);
  assert.match(ready, /"questions_charged":1/);
  assert.equal((await balance(token)).balance_questions, 2);

  mode = 'objectiveRetake';
  const retake = await objectiveCapture(token);
  assert.match(retake, /"questions_charged":0/);
  assert.match(retake, /"balance_questions":2/);
  const acct = await balance(token);
  assert.equal(acct.balance_questions, 2);
  assert.equal(acct.total_questions, 1);
});

test('objective request with no usable result is released', async () => {
  const token = await register();
  mode = 'ok'; // "hello" has neither FINAL nor V1
  const text = await objectiveCapture(token);
  assert.match(text, /"questions_charged":0/);
  const acct = await balance(token);
  assert.equal(acct.balance_questions, 3);
  assert.equal(acct.total_questions, 0);
});

test('a client that hangs up before receiving an answer gets its question back', async () => {
  const token = await register();
  mode = 'slow';
  const ctrl = new AbortController();
  const inflight = fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
    signal: ctrl.signal,
  });
  // Walk away while the vendor is still working. The question was already held at this point,
  // so the refund path in the route's `finally` is the only thing that gives it back.
  setTimeout(() => ctrl.abort(), 40);
  await assert.rejects(inflight);
  await new Promise((r) => setTimeout(r, 300)); // let the server finish its cleanup

  const acct = await balance(token);
  assert.equal(acct.balance_questions, 3, 'an abandoned attempt must not cost a question');
  assert.equal(acct.total_questions, 0);
});

test('a client that hangs up AFTER getting its answer still pays for it', async () => {
  const token = await register();
  mode = 'answerThenStall';
  const ctrl = new AbortController();
  // Node flushes the response headers with the FIRST body write, so this resolves as soon as the
  // answer delta goes out — unlike the no-answer case above, where the promise is still pending
  // when the abort lands. Read the stream, then walk away mid-answer.
  const res = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ system: 's', task: 't', image_base64: 'QUJD', image_media_type: 'image/jpeg' }),
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  // The answer is already on screen; the client just stops listening. Refunding here would make
  // `curl --max-time 2` in a loop a free-answer tap, since the useful text arrives first.
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 300));

  const acct = await balance(token);
  assert.equal(acct.balance_questions, 2, 'a delivered answer costs a question even unacknowledged');
  assert.equal(acct.total_questions, 1);
});

test('captures racing on the last question cannot overspend it', async () => {
  const token = await register();
  mode = 'slow';
  // Burn the grant down to a single question, then fire four captures at once. Under the old
  // read-then-charge order every one of them passed the same stale balance check and the balance
  // landed at -3; the answers were generated and the vendor billed for all four.
  mode = 'ok';
  await capture(token);
  await capture(token);
  assert.equal((await balance(token)).balance_questions, 1);

  mode = 'slow';
  const bodies = await Promise.all([capture(token), capture(token), capture(token), capture(token)]);
  const charged = bodies.filter((b) => b.includes('"questions_charged":1')).length;
  const refused = bodies.filter((b) => b.includes('insufficient_quota')).length;
  assert.equal(charged, 1, 'exactly one racer may spend the last question');
  assert.equal(refused, 3);

  const acct = await balance(token);
  assert.equal(acct.balance_questions, 0, 'the balance must never go negative');
  assert.equal(acct.total_questions, 3);
});
