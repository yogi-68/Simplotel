import type {
  AvailabilityQuery,
  AvailabilityResponse,
  ChatRequest,
  ChatResponse,
  ErrorCode,
  HotelInfoResponse,
} from '@hotel/contracts';

/**
 * The only place the browser talks to the backend.
 *
 * The browser never calls OpenAI. It knows one URL, it sends guest messages to
 * it, and the API key lives entirely in the server process -- so there is no
 * key to leak in a bundle, a source map or a network tab.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/** A request that never returns is worse than one that fails. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Errors the UI can actually act on.
 *
 * `code` decides the experience: a validation problem is shown inline next to
 * the input, a rate limit gets a wait-and-retry, an AI outage shows a banner but
 * keeps the answer, and an unreachable backend offers a Retry button. Losing
 * that distinction is how apps end up with one useless "Something went wrong".
 */
export class ApiClientError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'TIMEOUT';
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly fieldErrors: Array<{ path: string; message: string }>;

  constructor(opts: {
    code: ApiClientError['code'];
    message: string;
    retryable: boolean;
    requestId?: string;
    fieldErrors?: Array<{ path: string; message: string }>;
  }) {
    super(opts.message);
    this.name = 'ApiClientError';
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.requestId = opts.requestId;
    this.fieldErrors = opts.fieldErrors ?? [];
  }

  /** Guest-facing copy. Never the raw server message for unexpected failures. */
  get userMessage(): string {
    switch (this.code) {
      case 'NETWORK_ERROR':
        return 'I cannot reach the hotel right now. Check your connection and try again.';
      case 'TIMEOUT':
        return 'That took longer than expected. Please try again.';
      case 'RATE_LIMITED':
        return 'You are sending messages a little too quickly. Give it a moment and try again.';
      case 'AI_TIMEOUT':
      case 'AI_UNAVAILABLE':
        return 'The assistant is temporarily unavailable. Please try again shortly, or call the front desk.';
      case 'VALIDATION_ERROR':
        return this.message;
      default:
        return 'Something went wrong on our side. Please try again.';
    }
  }
}

async function requestJson<T>(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
  // Combine our timeout with any caller signal, so an unmounting component and
  // a slow network both abort the same request.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    clearTimeout(timer);
    // An abort from the caller is a deliberate cancellation, not a failure.
    if (init.signal?.aborted) throw error;
    if (timeoutController.signal.aborted) {
      throw new ApiClientError({ code: 'TIMEOUT', message: 'Request timed out', retryable: true });
    }
    throw new ApiClientError({ code: 'NETWORK_ERROR', message: 'Network request failed', retryable: true });
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Fall through: a non-JSON body from a proxy or gateway is still an error.
  }

  if (!response.ok) {
    const error = (body as { error?: { code: ErrorCode; message: string; requestId: string; retryable: boolean; details?: Array<{ path: string; message: string }> } } | null)?.error;
    throw new ApiClientError({
      code: error?.code ?? 'INTERNAL_ERROR',
      message: error?.message ?? `Request failed with status ${response.status}`,
      retryable: error?.retryable ?? response.status >= 500,
      requestId: error?.requestId,
      fieldErrors: error?.details,
    });
  }

  return body as T;
}

export const api = {
  hotel: (signal?: AbortSignal) => requestJson<HotelInfoResponse>('/api/hotel', { signal }),

  chat: (request: ChatRequest, signal?: AbortSignal) =>
    requestJson<ChatResponse>('/api/chat', { method: 'POST', body: JSON.stringify(request), signal }),

  /** Used by the booking form: deterministic, and cheaper than a chat turn. */
  availability: (query: AvailabilityQuery, signal?: AbortSignal) =>
    requestJson<AvailabilityResponse>('/api/availability', {
      method: 'POST',
      body: JSON.stringify(query),
      signal,
    }),

  health: (signal?: AbortSignal) => requestJson<{ ok: boolean }>('/api/health', { signal }),
};

export { BASE_URL };
