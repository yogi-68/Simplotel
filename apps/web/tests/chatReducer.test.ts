import { describe, expect, it } from 'vitest';
import { chatInitialState, chatReducer, type ChatState } from '@/hooks/useChat';
import { ApiClientError } from '@/lib/api';
import type { ChatResponse } from '@hotel/contracts';

/**
 * The conversation state machine, tested without a browser.
 *
 * These are the transitions that decide whether the UI recovers from a bad turn
 * or gets stuck in it, so they are worth asserting directly rather than only
 * through rendered output.
 */

const response = (overrides: Partial<ChatResponse> = {}): ChatResponse => ({
  ok: true,
  requestId: 'req-1',
  sessionId: 'sess-1',
  reply: { text: 'Check-in starts at 2:00 PM.', type: 'answer', confidence: 0.9 },
  sources: [{ id: 'F26', label: 'Policies / Check-in time', text: 'Check-in starts at 2:00 PM.' }],
  availability: null,
  slots: { checkIn: null, checkOut: null, adults: null, children: null },
  needs: [],
  suggestions: ['Is breakfast included?'],
  meta: {
    provider: 'mock',
    model: 'test',
    latencyMs: 12,
    toolCalls: [],
    grounded: true,
    degraded: false,
    ...(overrides.meta ?? {}),
  },
  ...overrides,
});

describe('chat reducer', () => {
  it('shows the guest message immediately and enters the sending state', () => {
    const state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'What time is check-in?' });

    expect(state.status).toBe('sending');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: 'user', text: 'What time is check-in?' });
    expect(state.lastAttempt).toMatchObject({ text: 'What time is check-in?' });
  });

  it('appends the reply, stores the session and animates only the newest turn', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'What time is check-in?' });
    state = chatReducer(state, { type: 'received', id: 'a1', response: response() });

    expect(state.status).toBe('idle');
    expect(state.sessionId).toBe('sess-1');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ role: 'assistant', animate: true });
    expect(state.lastAttempt).toBeNull();
  });

  it('stops animating older replies when a new turn starts', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'first' });
    state = chatReducer(state, { type: 'received', id: 'a1', response: response() });
    expect(state.messages[1]?.animate).toBe(true);

    state = chatReducer(state, { type: 'send', id: 'u2', text: 'second' });
    expect(state.messages[1]?.animate).toBe(false);
  });

  it('carries stay details forward from the server', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'rooms?' });
    state = chatReducer(state, {
      type: 'received',
      id: 'a1',
      response: response({ slots: { checkIn: '2026-12-12', checkOut: '2026-12-14', adults: 3, children: 0 } }),
    });

    expect(state.slots).toMatchObject({ checkIn: '2026-12-12', adults: 3 });
  });

  it('records a failure as a message rather than wiping the conversation', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'What time is check-in?' });
    state = chatReducer(state, {
      type: 'received',
      id: 'a1',
      response: response(),
    });
    state = chatReducer(state, { type: 'send', id: 'u2', text: 'and checkout?' });
    state = chatReducer(state, {
      type: 'failed',
      id: 'a2',
      error: new ApiClientError({ code: 'AI_UNAVAILABLE', message: 'down', retryable: true }),
    });

    expect(state.status).toBe('error');
    // The earlier exchange is still on screen.
    expect(state.messages).toHaveLength(4);
    expect(state.messages[0]).toMatchObject({ role: 'user' });
    expect(state.messages[3]?.error).toMatchObject({ retryable: true, code: 'AI_UNAVAILABLE' });
  });

  it('separates an unreachable backend from a turn that failed', () => {
    // A network failure gets a persistent banner; a model failure does not.
    const network = chatReducer(chatInitialState, {
      type: 'failed',
      id: 'a1',
      error: new ApiClientError({ code: 'NETWORK_ERROR', message: 'offline', retryable: true }),
    });
    expect(network.connectionError).not.toBeNull();

    const modelDown = chatReducer(chatInitialState, {
      type: 'failed',
      id: 'a1',
      error: new ApiClientError({ code: 'AI_UNAVAILABLE', message: 'down', retryable: true }),
    });
    expect(modelDown.connectionError).toBeNull();
  });

  it('keeps the failed message so it can be retried', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'What time is check-in?' });
    state = chatReducer(state, {
      type: 'failed',
      id: 'a1',
      error: new ApiClientError({ code: 'INTERNAL_ERROR', message: 'boom', retryable: true }),
    });
    expect(state.lastAttempt?.text).toBe('What time is check-in?');
  });

  it('clears the connection banner when the next turn starts', () => {
    let state: ChatState = chatReducer(chatInitialState, {
      type: 'failed',
      id: 'a1',
      error: new ApiClientError({ code: 'NETWORK_ERROR', message: 'offline', retryable: true }),
    });
    state = chatReducer(state, { type: 'send', id: 'u2', text: 'retrying' });
    expect(state.connectionError).toBeNull();
  });

  it('surfaces the degraded flag so the UI can warn the guest', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'What time is check-in?' });
    state = chatReducer(state, {
      type: 'received',
      id: 'a1',
      response: response({
        meta: { provider: 'mock', model: 'm', latencyMs: 1, toolCalls: [], grounded: true, degraded: true },
      }),
    });
    expect(state.degraded).toBe(true);
  });

  it('empties the thread on reset', () => {
    let state = chatReducer(chatInitialState, { type: 'send', id: 'u1', text: 'hello' });
    state = chatReducer(state, { type: 'received', id: 'a1', response: response() });
    state = chatReducer(state, { type: 'reset' });

    expect(state.messages).toEqual([]);
    expect(state.sessionId).toBeNull();
    expect(state.status).toBe('idle');
  });
});

describe('ApiClientError', () => {
  it('maps each failure to copy a guest can act on', () => {
    const cases: Array<[ApiClientError['code'], RegExp]> = [
      ['NETWORK_ERROR', /cannot reach/i],
      ['TIMEOUT', /longer than expected/i],
      ['RATE_LIMITED', /too quickly/i],
      ['AI_UNAVAILABLE', /temporarily unavailable/i],
    ];

    for (const [code, pattern] of cases) {
      const error = new ApiClientError({ code, message: 'raw internal detail', retryable: true });
      expect(error.userMessage, code).toMatch(pattern);
    }
  });

  it('shows the server message for validation errors, which are guest-fixable', () => {
    const error = new ApiClientError({
      code: 'VALIDATION_ERROR',
      message: 'Check-out must be at least one night after check-in.',
      retryable: false,
    });
    expect(error.userMessage).toBe('Check-out must be at least one night after check-in.');
  });

  it('never leaks an internal message for an unexpected failure', () => {
    const error = new ApiClientError({ code: 'INTERNAL_ERROR', message: 'ECONNREFUSED at pg pool', retryable: true });
    expect(error.userMessage).not.toContain('ECONNREFUSED');
  });
});
