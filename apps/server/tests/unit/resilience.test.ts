import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, withResilience } from '../../src/ai/resilience.js';
import { ProviderError } from '../../src/lib/errors.js';
import type { LlmCompletion, LlmProvider } from '../../src/ai/provider.js';

const ok: LlmCompletion = { content: '{}', toolCalls: [] };

function provider(impl: () => Promise<LlmCompletion>): LlmProvider {
  return { name: 'stub', model: 'stub-1', complete: impl };
}

const request = { messages: [], tools: [] };

describe('circuit breaker', () => {
  it('opens after the configured number of consecutive failures', () => {
    let clock = 0;
    const breaker = new CircuitBreaker(3, 1000, () => clock);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');

    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(() => breaker.assertClosed()).toThrowError(/circuit is open/i);
  });

  it('allows a trial request once the cooldown has passed', () => {
    let clock = 0;
    const breaker = new CircuitBreaker(1, 1000, () => clock);
    breaker.recordFailure();
    expect(breaker.state).toBe('open');

    clock += 1001;
    expect(breaker.state).toBe('half-open');
    expect(() => breaker.assertClosed()).not.toThrow();
  });

  it('resets on any success, so an isolated blip is not held against the provider', () => {
    let clock = 0;
    const breaker = new CircuitBreaker(2, 1000, () => clock);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });
});

describe('retry policy', () => {
  it('passes a successful call straight through', async () => {
    const wrapped = withResilience(provider(async () => ok), { timeoutMs: 100, maxRetries: 2 });
    await expect(wrapped.complete(request)).resolves.toEqual(ok);
  });

  it('retries a transient failure and succeeds', async () => {
    let calls = 0;
    const wrapped = withResilience(
      provider(async () => {
        calls += 1;
        if (calls === 1) throw new ProviderError('server', 'upstream blip');
        return ok;
      }),
      { timeoutMs: 100, maxRetries: 2 },
    );

    await expect(wrapped.complete(request)).resolves.toEqual(ok);
    expect(calls).toBe(2);
  });

  it('does not retry a failure that would fail identically, such as a bad key', async () => {
    let calls = 0;
    const wrapped = withResilience(
      provider(async () => {
        calls += 1;
        throw new ProviderError('client', 'invalid api key');
      }),
      { timeoutMs: 100, maxRetries: 3 },
    );

    await expect(wrapped.complete(request)).rejects.toThrowError(/invalid api key/);
    expect(calls).toBe(1);
  });

  it('gives up after the retry budget and surfaces the last error', async () => {
    let calls = 0;
    const wrapped = withResilience(
      provider(async () => {
        calls += 1;
        throw new ProviderError('rate_limit', 'slow down');
      }),
      { timeoutMs: 100, maxRetries: 2 },
    );

    await expect(wrapped.complete(request)).rejects.toThrowError(/slow down/);
    expect(calls).toBe(3); // the initial attempt plus two retries
  });

  it('aborts an attempt that exceeds the timeout', async () => {
    const wrapped = withResilience(
      provider(
        (...args: unknown[]) =>
          new Promise<LlmCompletion>((_resolve, reject) => {
            const signal = (args[0] as { signal?: AbortSignal })?.signal;
            signal?.addEventListener('abort', () => reject(new ProviderError('timeout', 'aborted')));
          }),
      ),
      { timeoutMs: 20, maxRetries: 0 },
    );

    await expect(wrapped.complete(request)).rejects.toThrowError(/aborted/);
  });

  it('stops calling a provider that is properly down', async () => {
    const complete = vi.fn(async () => {
      throw new ProviderError('server', 'down');
    });
    const wrapped = withResilience(provider(complete), {
      timeoutMs: 50,
      maxRetries: 0,
      failureThreshold: 2,
      cooldownMs: 10_000,
    });

    await expect(wrapped.complete(request)).rejects.toThrow();
    await expect(wrapped.complete(request)).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(2);

    // Third call is short-circuited by the open breaker: the guest gets the
    // degraded answer immediately instead of waiting on a dead dependency.
    await expect(wrapped.complete(request)).rejects.toThrowError(/circuit is open/i);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
