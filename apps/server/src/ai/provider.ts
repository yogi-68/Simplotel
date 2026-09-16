/**
 * The seam between the orchestrator and whatever model is behind it.
 *
 * Everything above this interface — retrieval, slot state, tool dispatch,
 * citation validation, the response envelope — is provider-agnostic. That is
 * what lets the identical test suite run against a real model, a deterministic
 * offline stub, and a provider that always throws, without the orchestrator
 * knowing the difference.
 */

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on `tool` messages: which call this is the result of. */
  toolCallId?: string;
  /** Present on `assistant` messages that requested tools. */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmCompletion {
  /** JSON text matching AssistantOutputSchema, or null when tools were called. */
  content: string | null;
  toolCalls: LlmToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** Reported in `meta.provider` so responses are traceable to their source. */
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmCompletion>;
}
