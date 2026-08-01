import type { CaptureRequest, Provider, Usage } from './types.ts';
import { readVendorSSE } from './types.ts';
import { vendorErrorMessage } from './anthropic.ts';

// Proxies to the OpenAI Chat Completions API (streaming). `stream_options.include_usage`
// makes the final chunk carry token usage. Vision image travels as a data-URI image_url.
export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(apiKey: string, baseURL: string, model: string, maxTokens: number) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.maxTokens = maxTokens;
  }

  async stream(
    req: CaptureRequest,
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Usage> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: req.task },
            ...req.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
            })),
          ],
        },
      ],
    };

    const res = await fetch(`${this.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(await vendorErrorMessage(res));
    }

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    await readVendorSSE(res.body, (payload) => {
      const ev = payload as OpenAIChunk;
      // An OpenAI-compatible endpoint can emit `{"error":{...}}` on an HTTP-200 stream. Throw so
      // the capture route treats it as a failure and never charges (mirrors the Anthropic
      // provider); otherwise it would look like an empty but successful answer.
      if (ev.error) throw new Error(ev.error.message ?? 'OpenAI 流式错误');
      const text = ev.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text.length > 0) onDelta(text);
      if (ev.usage) {
        usage.inputTokens = ev.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = ev.usage.completion_tokens ?? usage.outputTokens;
      }
    });
    return usage;
  }
}

interface OpenAIChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}
