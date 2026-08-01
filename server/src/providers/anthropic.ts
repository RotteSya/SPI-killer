import type { CaptureRequest, Provider, Usage } from './types.ts';
import { readVendorSSE } from './types.ts';

// Proxies to the Anthropic Messages API (streaming). The server holds the key; the client
// never sees it. Input tokens come from the message_start usage; output tokens from the final
// message_delta usage. Vision image travels as a base64 image content block.
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
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
      system: req.system,
      messages: [
        {
          role: 'user',
          content: [
            ...req.images.map((img) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mediaType,
                data: img.base64,
              },
            })),
            { type: 'text', text: req.task },
          ],
        },
      ],
    };

    const res = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(await vendorErrorMessage(res));
    }

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    await readVendorSSE(res.body, (payload) => {
      const ev = payload as AnthropicEvent;
      switch (ev.type) {
        case 'message_start':
          usage.inputTokens = ev.message?.usage?.input_tokens ?? usage.inputTokens;
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
            onDelta(ev.delta.text);
          }
          break;
        case 'message_delta':
          usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
          break;
        case 'error':
          throw new Error(ev.error?.message ?? 'Anthropic 流式错误');
      }
    });
    return usage;
  }
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { type?: string; text?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

export async function vendorErrorMessage(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  try {
    const obj = JSON.parse(text) as { error?: { message?: string } };
    if (obj.error?.message) return `模型服务错误（${res.status}）：${obj.error.message}`;
  } catch {
    /* not JSON */
  }
  return `模型服务错误（HTTP ${res.status}）`;
}
