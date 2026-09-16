import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { ProviderError } from '../lib/errors.js';
import type { LlmCompletion, LlmMessage, LlmProvider, LlmRequest, LlmToolCall } from './provider.js';
import { ASSISTANT_OUTPUT_JSON_SCHEMA } from './schema.js';

/**
 * OpenAI adapter.
 *
 * Two deliberate choices here:
 *
 * 1. Structured outputs (`response_format: json_schema`, strict) rather than
 *    "please reply in JSON". Strict mode makes the shape a decoding constraint,
 *    so a malformed reply is close to impossible and the citation validator
 *    downstream always has a `sourceIds` array to check.
 *
 * 2. `temperature: 0.2`. This is a factual customer-service assistant. Variety
 *    has no value here; reproducibility does.
 */

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

function toOpenAiMessages(messages: LlmMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? '' };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    }
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'assistant') return { role: 'assistant', content: message.content };
    return { role: 'user', content: message.content };
  });
}

function toOpenAiTools(request: LlmRequest): ChatCompletionTool[] {
  return request.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Map SDK failures onto our retryable/not-retryable taxonomy. */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return new ProviderError('rate_limit', 'OpenAI rate limit reached', error);
    if (error.status !== undefined && error.status >= 500) {
      return new ProviderError('server', `OpenAI server error (${error.status})`, error);
    }
    // 401/403/400 will fail identically on retry — surface them as terminal.
    return new ProviderError('client', `OpenAI rejected the request (${error.status ?? 'unknown'})`, error);
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError('timeout', 'OpenAI request timed out', error);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError('network', 'Could not reach OpenAI', error);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('timeout', 'OpenAI request aborted after timeout', error);
  }
  return new ProviderError('server', 'Unexpected error calling OpenAI', error);
}

export function createOpenAiProvider(options: OpenAiProviderOptions): LlmProvider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    // Our own resilience layer owns retries so the policy is uniform across
    // providers and observable in one place.
    maxRetries: 0,
  });

  return {
    name: 'openai',
    model: options.model,

    async complete(request: LlmRequest): Promise<LlmCompletion> {
      try {
        const completion = await client.chat.completions.create(
          {
            model: options.model,
            temperature: 0.2,
            messages: toOpenAiMessages(request.messages),
            tools: toOpenAiTools(request),
            tool_choice: 'auto',
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'assistant_reply',
                strict: true,
                schema: ASSISTANT_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
              },
            },
          },
          { signal: request.signal },
        );

        const choice = completion.choices[0];
        if (!choice) throw new ProviderError('parse', 'OpenAI returned no choices');

        const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).flatMap((call) => {
          if (call.type !== 'function') return [];
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            // A tool call we cannot parse is dropped rather than thrown: the
            // orchestrator treats "no usable tool call" as a clarification path,
            // which degrades far better than failing the whole turn.
            return [];
          }
          return [{ id: call.id, name: call.function.name, arguments: args }];
        });

        return {
          content: choice.message.content ?? null,
          toolCalls,
          usage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens,
                completionTokens: completion.usage.completion_tokens,
              }
            : undefined,
        };
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw toProviderError(error);
      }
    },
  };
}
