import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { CaptureRequest, Provider, Usage } from '../src/providers/types.ts';

process.env.DB_PATH = ':memory:';
process.env.OFFICIAL_PROVIDER = 'mock';
process.env.OBJECTIVE_RESULT_V1_PROVIDER = 'mock';
process.env.TRIAL_MIN_QUESTIONS = '3';
process.env.TRIAL_MAX_QUESTIONS = '3';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../src/index.ts');

let controlCalls = 0;
let treatmentCalls = 0;
const controlProvider: Provider = {
  name: 'control-vendor',
  async stream(_req: CaptureRequest, onDelta: (text: string) => void): Promise<Usage> {
    controlCalls += 1;
    onDelta('CONTROL ANSWER');
    return { inputTokens: 10, outputTokens: 2 };
  },
};
const treatmentProvider: Provider = {
  name: 'treatment-vendor',
  async stream(_req: CaptureRequest, onDelta: (text: string) => void): Promise<Usage> {
    treatmentCalls += 1;
    onDelta('TREATMENT\nFINAL: B\nNSPI_RESULT_V1: '
      + '{"v":1,"kind":"single_choice","state":"ready","answer":"B","reason":"none"}');
    return { inputTokens: 20, outputTokens: 4 };
  },
};

let app: FastifyInstance;
let base = '';
before(async () => {
  app = await buildApp({ provider: controlProvider, objectiveProvider: treatmentProvider });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => app.close());

async function register(): Promise<string> {
  const response = await fetch(`${base}/v1/devices`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'macos', app_version: 'test' }),
  });
  return ((await response.json()) as { device_token: string }).device_token;
}

async function capture(token: string, objective: boolean): Promise<string> {
  const response = await fetch(`${base}/v1/captures`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      system: 'system', task: 'task', image_base64: 'QUJD', image_media_type: 'image/jpeg',
      ...(objective ? {
        result_protocol: 'objective_v1',
        capture_id: '3e7979c6-20cb-4c12-a23e-ece6eb3aa52d',
      } : {}),
    }),
  });
  return response.text();
}

test('legacy/control and Objective requests use different server-owned providers', async () => {
  const token = await register();
  const legacy = await capture(token, false);
  assert.match(legacy, /CONTROL ANSWER/);
  assert.doesNotMatch(legacy, /TREATMENT/);
  assert.match(legacy, /"questions_charged":1/);
  assert.equal(controlCalls, 1);
  assert.equal(treatmentCalls, 0);

  const objective = await capture(token, true);
  assert.match(objective, /TREATMENT/);
  assert.doesNotMatch(objective, /CONTROL ANSWER/);
  assert.match(objective, /"questions_charged":1/);
  assert.equal(controlCalls, 1);
  assert.equal(treatmentCalls, 1);

  const account = await fetch(`${base}/v1/account`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(((await account.json()) as { balance_questions: number }).balance_questions, 1);
});
