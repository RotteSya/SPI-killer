import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { makeProvider } from '../src/providers/index.ts';
import { OpenAIProvider } from '../src/providers/openai.ts';

test('DeepSeek provider uses the vision endpoint, non-thinking mode, and OpenAI SSE usage', async (t) => {
  let calledURL = '';
  let calledInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calledURL = String(input);
    calledInit = init;
    const stream = [
      'data: {"choices":[{"delta":{"content":"B"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":347,"completion_tokens":1}}',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const provider = new OpenAIProvider('secret-value', 'https://api.deepseek.com/',
    'deepseek-v4-flash-vision-exp', 4096, {
      name: 'deepseek',
      endpointPath: 'chat/completions',
      extraBody: { thinking: { type: 'disabled' }, temperature: 0 },
    });
  let text = '';
  const usage = await provider.stream({
    system: 'system',
    task: 'task',
    images: [{ mediaType: 'image/png', base64: 'QUJD' }],
  }, (delta) => { text += delta; }, new AbortController().signal);

  assert.equal(provider.name, 'deepseek');
  assert.equal(calledURL, 'https://api.deepseek.com/chat/completions');
  assert.equal(calledInit?.headers && (calledInit.headers as Record<string, string>).authorization,
    'Bearer secret-value');
  const body = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'deepseek-v4-flash-vision-exp');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.ok(messages[1]);
  assert.deepEqual(messages[1].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,QUJD' },
  });
  assert.equal(text, 'B');
  assert.deepEqual(usage, { inputTokens: 347, outputTokens: 1 });
});

test('DeepSeek configuration without its dedicated key fails closed', () => {
  const warnings: string[] = [];
  const built = makeProvider({ ...config, provider: 'deepseek', deepseekKey: '' },
    (warning) => warnings.push(warning));
  assert.equal(built.provider.name, 'mock');
  assert.match(built.degraded ?? '', /DEEPSEEK_API_KEY/);
  assert.equal(warnings.length, 1);
});
