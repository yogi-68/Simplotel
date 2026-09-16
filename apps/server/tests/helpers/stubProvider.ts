import type { AssistantOutput } from '../../src/ai/schema.js';
import type { LlmCompletion, LlmProvider, LlmToolCall } from '../../src/ai/provider.js';

/**
 * A provider that returns exactly what a test tells it to.
 *
 * The mock provider is deliberately well-behaved, which makes it useless for
 * testing what happens when a model misbehaves. This stub lets a test script a
 * specific bad reply -- an uncited claim, malformed JSON, a nonsense tool call
 * -- and assert that the pipeline defends against it.
 */
export function stubProvider(
  script: Array<Partial<AssistantOutput> | { toolCalls: LlmToolCall[] } | { raw: string | null }>,
): LlmProvider & { calls: number } {
  let index = 0;

  const provider = {
    name: 'stub',
    model: 'scripted',
    calls: 0,
    async complete(): Promise<LlmCompletion> {
      provider.calls += 1;
      const step = script[Math.min(index, script.length - 1)];
      index += 1;

      if (step && 'toolCalls' in step) return { content: null, toolCalls: step.toolCalls };
      if (step && 'raw' in step) return { content: step.raw, toolCalls: [] };

      const output: AssistantOutput = {
        answer: 'Stubbed answer.',
        type: 'answer',
        sourceIds: [],
        confidence: 0.8,
        needs: [],
        suggestions: [],
        ...(step as Partial<AssistantOutput>),
      };
      return { content: JSON.stringify(output), toolCalls: [] };
    },
  };

  return provider;
}

/** A provider that always throws, for exercising the degraded path. */
export function throwingProvider(message = 'provider exploded'): LlmProvider {
  return {
    name: 'throwing',
    model: 'always-fails',
    async complete(): Promise<LlmCompletion> {
      throw new Error(message);
    },
  };
}
