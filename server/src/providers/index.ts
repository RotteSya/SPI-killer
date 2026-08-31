import type { Config } from '../config.ts';
import type { Provider } from './types.ts';
import { MockProvider } from './mock.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';

/**
 * Build the configured provider once at boot.
 *
 * A real vendor selected WITHOUT a key still falls back to the mock so the server boots and
 * `/healthz` stays reachable to diagnose it — but that fallback is now marked `degraded`, and
 * the capture route refuses to serve (and never charges) while it is set. The mock streams
 * plausible-looking text, so an emptied `ANTHROPIC_API_KEY` used to bill paying users a real
 * question for a canned Chinese placeholder, with nothing failing loudly enough to notice.
 * An intentional `OFFICIAL_PROVIDER=mock` is not degraded and serves normally.
 */
export function makeProvider(
  config: Config,
  warn: (msg: string) => void,
): { provider: Provider; degraded: string | null } {
  switch (config.provider) {
    case 'anthropic':
      if (!config.anthropicKey) {
        const why = 'OFFICIAL_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty';
        warn(`${why} — captures are DISABLED until it is set.`);
        return { provider: new MockProvider(), degraded: why };
      }
      return {
        provider: new AnthropicProvider(
          config.anthropicKey,
          config.anthropicBaseURL,
          config.model,
          config.maxTokens,
        ),
        degraded: null,
      };
    case 'deepseek':
      if (!config.deepseekKey) {
        const why = 'OFFICIAL_PROVIDER=deepseek but DEEPSEEK_API_KEY is empty';
        warn(`${why} — captures are DISABLED until it is set.`);
        return { provider: new MockProvider(), degraded: why };
      }
      return {
        provider: new OpenAIProvider(
          config.deepseekKey,
          config.deepseekBaseURL,
          config.model,
          config.maxTokens,
          {
            name: 'deepseek',
            endpointPath: 'chat/completions',
            // V4 defaults to thinking mode. The notch needs the final answer stream with bounded
            // latency; explicit non-thinking mode also avoids paying for hidden reasoning tokens.
            extraBody: { thinking: { type: 'disabled' } },
          },
        ),
        degraded: null,
      };
    case 'openai':
      if (!config.openaiKey) {
        const why = 'OFFICIAL_PROVIDER=openai but OPENAI_API_KEY is empty';
        warn(`${why} — captures are DISABLED until it is set.`);
        return { provider: new MockProvider(), degraded: why };
      }
      return {
        provider: new OpenAIProvider(
          config.openaiKey,
          config.openaiBaseURL,
          config.model,
          config.maxTokens,
        ),
        degraded: null,
      };
    default:
      return { provider: new MockProvider(), degraded: null };
  }
}
