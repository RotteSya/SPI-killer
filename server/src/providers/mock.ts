import type { CaptureRequest, Provider, Usage } from './types.ts';

// A dependency-free, key-free provider used for local development and end-to-end tests. It
// streams a short canned answer token-by-token and reports synthetic usage derived from the
// input size, so the entire register → capture → meter → charge → 402 pipeline runs for real
// without contacting any vendor. Select with OFFICIAL_PROVIDER=mock (the default).
export class MockProvider implements Provider {
  readonly name = 'mock';

  async stream(
    req: CaptureRequest,
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<Usage> {
    const answer =
      '这是官方服务的示例回答（mock 模式）。真实部署时会由服务端配置的模型生成。' +
      '题目已收到，正在按步骤讲解……';
    const chunks = answer.match(/.{1,8}/gu) ?? [answer];
    for (const chunk of chunks) {
      if (signal.aborted) break;
      onDelta(chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
    // Synthetic but deterministic: roughly proportional to the base64 image(s) + prompt size.
    const imageChars = req.images.reduce((sum, img) => sum + img.base64.length, 0);
    const inputTokens = Math.max(
      1,
      Math.round((imageChars / 4 + req.system.length + req.task.length) / 4),
    );
    const outputTokens = Math.max(1, Math.round([...answer].length / 2));
    return { inputTokens, outputTokens };
  }
}
