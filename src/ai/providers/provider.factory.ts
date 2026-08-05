import {AnthropicProvider} from './anthropic.provider';
import {GeminiProvider} from './gemini.provider';
import {AiProviderId, LlmProvider} from './llm-provider.interface';
import {OpenAiProvider} from './openai.provider';

/**
 * Builds the adapter for a business's configured provider.
 *
 * Deliberately a plain function rather than a Nest provider: an instance is
 * per-request (it carries that business's decrypted key) and must never be
 * cached in the DI container where another tenant could reach it.
 */
export function createProvider(
  provider: AiProviderId,
  apiKey: string,
  model: string,
): LlmProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, model);
    case 'openai':
      return new OpenAiProvider(apiKey, model);
    case 'gemini':
      return new GeminiProvider(apiKey, model);
  }
}
