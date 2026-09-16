'use client';

import type { AvailabilityResult, ChatResponse, SlotName, Slots, Source } from '@hotel/contracts';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiClientError, api } from '@/lib/api';

/**
 * The conversation state machine.
 *
 * A reducer rather than a handful of useState calls, because the interesting
 * bugs in a chat UI are all about *combinations* of state: a reply arriving
 * after the guest navigated away, a retry firing while a request is still in
 * flight, an error that must not wipe the thread. Expressing the transitions
 * explicitly makes those cases decidable, and testable without a browser.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Present on assistant turns. */
  reply?: ChatResponse['reply'];
  sources?: Source[];
  availability?: AvailabilityResult | null;
  needs?: SlotName[];
  suggestions?: string[];
  meta?: ChatResponse['meta'];
  /** Set on the assistant turn that failed, so the UI can offer a retry. */
  error?: { message: string; code: string; retryable: boolean; requestId?: string };
  /** Drives the typewriter: only the newest assistant reply animates. */
  animate?: boolean;
}

export type ChatStatus = 'idle' | 'sending' | 'error';

interface State {
  messages: ChatMessage[];
  status: ChatStatus;
  slots: Slots;
  sessionId: string | null;
  /** Non-null when the backend itself is unreachable, not just this turn. */
  connectionError: string | null;
  /** True when the last reply came from the degraded, model-free path. */
  degraded: boolean;
  /** The message text to resend if the guest taps Retry. */
  lastAttempt: { text: string; context?: Partial<Slots> } | null;
}

type Action =
  | { type: 'send'; id: string; text: string; context?: Partial<Slots> }
  | { type: 'received'; id: string; response: ChatResponse }
  | { type: 'failed'; id: string; error: ApiClientError }
  | { type: 'cancelled'; id: string }
  | { type: 'stopAnimation'; id: string }
  | { type: 'connection'; message: string | null }
  | { type: 'reset' };

const emptySlots: Slots = { checkIn: null, checkOut: null, adults: null, children: null };

const initialState: State = {
  messages: [],
  status: 'idle',
  slots: emptySlots,
  sessionId: null,
  connectionError: null,
  degraded: false,
  lastAttempt: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'send':
      return {
        ...state,
        status: 'sending',
        connectionError: null,
        lastAttempt: { text: action.text, context: action.context },
        // The guest's message appears immediately; waiting for the server to
        // echo it would make the interface feel unresponsive.
        messages: [
          ...state.messages.map((m) => ({ ...m, animate: false })),
          { id: action.id, role: 'user', text: action.text },
        ],
      };

    case 'received': {
      const { response } = action;
      return {
        ...state,
        status: 'idle',
        sessionId: response.sessionId,
        slots: response.slots,
        degraded: response.meta.degraded,
        lastAttempt: null,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: 'assistant',
            text: response.reply.text,
            reply: response.reply,
            sources: response.sources,
            availability: response.availability,
            needs: response.needs,
            suggestions: response.suggestions,
            meta: response.meta,
            animate: true,
          },
        ],
      };
    }

    case 'failed':
      return {
        ...state,
        status: 'error',
        // A backend we cannot reach at all is a different problem from a turn
        // that failed, and gets a different affordance.
        connectionError:
          action.error.code === 'NETWORK_ERROR' || action.error.code === 'TIMEOUT'
            ? action.error.userMessage
            : null,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: 'assistant',
            text: action.error.userMessage,
            error: {
              message: action.error.userMessage,
              code: action.error.code,
              retryable: action.error.retryable,
              requestId: action.error.requestId,
            },
          },
        ],
      };

    case 'cancelled':
      return { ...state, status: 'idle' };

    case 'stopAnimation':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === action.id ? { ...m, animate: false } : m)),
      };

    case 'connection':
      return { ...state, connectionError: action.message };

    case 'reset':
      return { ...initialState, messages: [] };

    default:
      return state;
  }
}

let counter = 0;
const nextId = () => `m${(counter += 1)}-${Date.now()}`;

const SESSION_STORAGE_KEY = 'banyan-grove-session';

export function useChat() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const inFlight = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Keep the session id in a ref as well as state: `send` must read the current
  // value without being re-created on every turn.
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
    if (state.sessionId) {
      try {
        window.sessionStorage.setItem(SESSION_STORAGE_KEY, state.sessionId);
      } catch {
        // Private browsing or blocked storage: the conversation still works,
        // it just will not survive a refresh.
      }
    }
  }, [state.sessionId]);

  useEffect(() => {
    try {
      sessionIdRef.current = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      sessionIdRef.current = null;
    }
  }, []);

  // Abandon any in-flight request when the component goes away, so a late reply
  // cannot try to update an unmounted tree.
  useEffect(() => {
    return () => inFlight.current?.abort();
  }, []);

  const send = useCallback(async (text: string, context?: Partial<Slots>) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    const userMessageId = nextId();
    dispatch({ type: 'send', id: userMessageId, text: trimmed, context });

    try {
      const response = await api.chat(
        {
          message: trimmed,
          sessionId: sessionIdRef.current ?? undefined,
          context: context
            ? {
                checkIn: context.checkIn ?? undefined,
                checkOut: context.checkOut ?? undefined,
                adults: context.adults ?? undefined,
                children: context.children ?? undefined,
              }
            : undefined,
        },
        controller.signal,
      );
      sessionIdRef.current = response.sessionId;
      dispatch({ type: 'received', id: nextId(), response });
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ApiClientError)) {
        dispatch({ type: 'cancelled', id: userMessageId });
        return;
      }
      dispatch({
        type: 'failed',
        id: nextId(),
        error:
          error instanceof ApiClientError
            ? error
            : new ApiClientError({ code: 'INTERNAL_ERROR', message: 'Unexpected error', retryable: true }),
      });
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  const retry = useCallback(() => {
    if (state.lastAttempt) void send(state.lastAttempt.text, state.lastAttempt.context);
  }, [send, state.lastAttempt]);

  const stopAnimation = useCallback((id: string) => dispatch({ type: 'stopAnimation', id }), []);

  const reset = useCallback(() => {
    inFlight.current?.abort();
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
    sessionIdRef.current = null;
    dispatch({ type: 'reset' });
  }, []);

  return {
    messages: state.messages,
    status: state.status,
    slots: state.slots,
    degraded: state.degraded,
    connectionError: state.connectionError,
    canRetry: state.status === 'error' && state.lastAttempt !== null,
    send,
    retry,
    reset,
    stopAnimation,
  };
}

export { reducer as chatReducer, initialState as chatInitialState };
export type { State as ChatState, Action as ChatAction };
