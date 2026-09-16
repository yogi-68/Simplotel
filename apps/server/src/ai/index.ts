import { getEnv } from '../config/env.js';
import { ProviderError } from '../lib/errors.js';
import { createMockProvider } from './mock.provider.js';
import { createOpenAiProvider } from './openai.provider.js';
import type { LlmProvider } from './provider.js';
import { withResilience } from './resilience.js';

/**
 * A provider that always fails.
 *
 * Fault injection is a first-class feature, not a test-only hack: `AI_PROVIDER=failing`
 * lets anyone reviewing this project see the degraded path in the real UI in one
 * command, and lets the integration suite prove that a dead model produces a
 * useful 200 rather than a 500.
 */
export function createFailingProvider(): LlmProvider {
  return {
    name: 'failing',
    model: 'always-throws',
    async complete() {
      throw new ProviderError('server', 'Injected provider failure (AI_PROVIDER=failing)');
    },
  };
}

export function createProvider(): LlmProvider {
  const env = getEnv();

  const base: LlmProvider =
    env.AI_PROVIDER === 'openai'
      ? createOpenAiProvider({
          apiKey: env.OPENAI_API_KEY!,
          model: env.OPENAI_MODEL,
          timeoutMs: env.AI_TIMEOUT_MS,
        })
      : env.AI_PROVIDER === 'failing'
        ? createFailingProvider()
        : createMockProvider();

  return withResilience(base, {
    timeoutMs: env.AI_TIMEOUT_MS,
    maxRetries: env.AI_PROVIDER === 'failing' ? 0 : env.AI_MAX_RETRIES,
  });
}

export type { LlmProvider } from './provider.js';
