import type { ErrorCode } from '@hotel/contracts';

/**
 * A single error type carrying everything the HTTP layer needs to produce the
 * contract's error envelope. Throwing these from anywhere in the stack means
 * the error handler never has to guess a status code or invent a message.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Array<{ path: string; message: string }>;
  /** Internal context for logs only — never serialised to the guest. */
  override readonly cause?: unknown;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    status: number;
    retryable?: boolean;
    details?: Array<{ path: string; message: string }>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'AppError';
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.cause = opts.cause;
  }

  static validation(message: string, details?: Array<{ path: string; message: string }>): AppError {
    return new AppError({ code: 'VALIDATION_ERROR', message, status: 400, retryable: false, details });
  }

  static notFound(message: string): AppError {
    return new AppError({ code: 'NOT_FOUND', message, status: 404, retryable: false });
  }

  static rateLimited(message: string): AppError {
    return new AppError({ code: 'RATE_LIMITED', message, status: 429, retryable: true });
  }

  static aiTimeout(cause?: unknown): AppError {
    return new AppError({
      code: 'AI_TIMEOUT',
      message: 'The assistant took too long to respond.',
      status: 503,
      retryable: true,
      cause,
    });
  }

  static aiUnavailable(cause?: unknown): AppError {
    return new AppError({
      code: 'AI_UNAVAILABLE',
      message: 'The assistant is temporarily unavailable.',
      status: 503,
      retryable: true,
      cause,
    });
  }

  static internal(message = 'Something went wrong on our side.', cause?: unknown): AppError {
    return new AppError({ code: 'INTERNAL_ERROR', message, status: 500, retryable: true, cause });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Errors raised inside the AI adapter, so the resilience layer can tell a
 * retryable upstream blip apart from a permanent configuration mistake.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly kind: 'timeout' | 'rate_limit' | 'server' | 'network' | 'client' | 'parse';

  constructor(kind: ProviderError['kind'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.kind = kind;
    // A bad API key or a malformed request will fail identically on retry;
    // only transient classes are worth a second attempt.
    this.retryable = kind === 'timeout' || kind === 'rate_limit' || kind === 'server' || kind === 'network';
  }
}
