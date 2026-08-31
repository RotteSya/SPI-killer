import type { Config } from '../config.ts';
import type { Provider } from './types.ts';
import { MockProvider } from './mock.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAIProvider } from './openai.ts';

interface ProviderSelection {
  provider: Config['provider'];
  model: string;
  maxTokens: number;
  configurationError: string | null;
  settingName: 'OFFICIAL_PROVIDER' | 'OBJECTIVE_RESULT_V1_PROVIDER';
}

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
  return makeSelectedProvider(config, {
    provider: config.provider,
    model: config.model,
    maxTokens: config.maxTokens,
    configurationError: config.providerConfigurationError,
    settingName: 'OFFICIAL_PROVIDER',
  }, warn);
}

/** Build the provider used only by requests carrying the Objective Result V1 protocol. */
export function makeObjectiveProvider(
  config: Config,
  warn: (msg: string) => void,
): { provider: Provider; degraded: string | null } {
  return makeSelectedProvider(config, {
    provider: config.objectiveProvider,
    model: config.objectiveModel,
    maxTokens: config.objectiveMaxTokens,
    configurationError: config.objectiveProviderConfigurationError,
    settingName: 'OBJECTIVE_RESULT_V1_PROVIDER',
  }, warn);
}

function makeSelectedProvider(
  config: Config,
  selection: ProviderSelection,
  warn: (msg: string) => void,
): { provider: Provider; degraded: string | null } {
  if (selection.configurationError !== null) {
    warn(`${selection.configurationError} — captures are DISABLED until it is fixed.`);
    return { provider: new MockProvider(), degraded: selection.configurationError };
  }
  switch (selection.provider) {
    case 'anthropic':
      if (!config.anthropicKey) {
        const why = `${selection.settingName}=anthropic but ANTHROPIC_API_KEY is empty`;
        warn(`${why} — captures are DISABLED until it is set.`);
        return { provider: new MockProvider(), degraded: why };
      }
      return {
        provider: new AnthropicProvider(
          config.anthropicKey,
          config.anthropicBaseURL,
          selection.model,
          selection.maxTokens,
        ),
        degraded: null,
      };
    case 'deepseek':
      if (!config.deepseekKey) {
        const why = `${selection.settingName}=deepseek but DEEPSEEK_API_KEY is empty`;
        warn(`${why} — captures are DISABLED until it is set.`);
        return { provider: new MockProvider(), degraded: why };
      }
      return {
        provider: new OpenAIProvider(
          config.deepseekKey,
          config.deepseekBaseURL,
          selection.model,
          selection.maxTokens,
          {
            name: 'deepseek',
            endpointPath: 'chat/completions',
            // V4 defaults to thinking mode. The notch needs the final answer stream with bounded
            // latency; explicit non-thinking mode also avoids paying for hidden reasoning tokens.
            // DeepSeek recommends temperature 0 for math; it also reduces protocol variation.
            extraBody: { thinking: { type: 'disabled' }, temperature: 0 },
          },
        ),
        degraded: null,
      };
    case 'openai':
      if (!config.openaiKey) {
        const why = `${selection.settingName}=openai but OPENAI_API_KEY is empty`;
        warn(`${why} — captures are DISABLED until it is set.`);
        return { provider: new MockProvider(), degraded: why };
      }
      return {
        provider: new OpenAIProvider(
          config.openaiKey,
          config.openaiBaseURL,
          selection.model,
          selection.maxTokens,
        ),
        degraded: null,
      };
    default:
      return { provider: new MockProvider(), degraded: null };
  }
}
