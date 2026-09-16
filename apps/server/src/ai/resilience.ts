import { ProviderError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { LlmCompletion, LlmProvider, LlmRequest } from './provider.js';

/**
 * Timeout, retry and circuit-breaking, applied as a decorator around any
 * provider so the policy is identical whichever model is behind it.
 *
 * The ordering matters: timeout is innermost (per attempt), retry wraps it, and
 * the breaker wraps everything. That way a slow model produces several bounded
 * attempts rather than one unbounded hang, and a model that is properly down
 * stops being called at all instead of adding latency to every single guest.
 */

export interface ResilienceOptions {
  timeoutMs: number;
  maxRetries: number;
  /** Consecutive failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a trial request. */
  cooldownMs?: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  /** Throws immediately when the circuit is open, saving the guest a long wait. */
  assertClosed(): void {
    if (this.state === 'open') {
      throw new ProviderError('server', 'AI provider circuit is open after repeated failures');
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, so retries do not arrive in lockstep. */
function backoffMs(attempt: number): number {
  const base = 250 * 2 ** attempt;
  return base + Math.random() * 150;
}

export function withResilience(provider: LlmProvider, options: ResilienceOptions): LlmProvider {
  const breaker = new CircuitBreaker(options.failureThreshold ?? 5, options.cooldownMs ?? 30_000);

  return {
    name: provider.name,
    model: provider.model,

    async complete(request: LlmRequest): Promise<LlmCompletion> {
      breaker.assertClosed();

      let lastError: unknown;

      for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs);

        // Respect a caller-supplied signal (client disconnect) as well as ours.
        const onExternalAbort = () => controller.abort();
        request.signal?.addEventListener('abort', onExternalAbort, { once: true });

        try {
          const result = await provider.complete({ ...request, signal: controller.signal });
          breaker.recordSuccess();
          return result;
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ProviderError ? error.retryable : false;
          const attemptsLeft = attempt < options.maxRetries;

          logger.warn(
            {
              provider: provider.name,
              attempt: attempt + 1,
              retryable,
              kind: error instanceof ProviderError ? error.kind : 'unknown',
              err: error instanceof Error ? error.message : String(error),
            },
            'AI provider call failed',
          );

          if (!retryable || !attemptsLeft) break;
          await sleep(backoffMs(attempt));
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onExternalAbort);
        }
      }

      breaker.recordFailure();
      throw lastError instanceof ProviderError
        ? lastError
        : new ProviderError('server', 'AI provider failed', lastError);
    },
  };
}
