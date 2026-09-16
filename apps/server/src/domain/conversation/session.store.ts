import { randomUUID } from 'node:crypto';
import type { Slots } from '@hotel/contracts';
import { emptySlots } from './slots.js';

/**
 * Conversation memory.
 *
 * In-memory on purpose. A pre-booking chat is short and disposable, the data is
 * personal, and nothing here is worth surviving a restart — so the simplest
 * store that satisfies "maintain basic conversation context" is the right one.
 * The interface is deliberately narrow so swapping in Redis for a multi-instance
 * deployment is a one-file change (see ARCHITECTURE.md, Known limitations).
 */

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
  slots: Slots;
}

export interface SessionStoreOptions {
  /** How long an idle conversation survives. */
  ttlMs?: number;
  /** Hard cap on concurrent sessions; oldest are evicted first. */
  maxSessions?: number;
  /** Turns retained for prompt context (user + assistant messages). */
  maxTurns?: number;
  now?: () => number;
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 1000;
  const maxTurns = options.maxTurns ?? 10;
  const now = options.now ?? Date.now;

  const sessions = new Map<string, Session>();

  function sweep(): void {
    const cutoff = now() - ttlMs;
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff) sessions.delete(id);
    }
    // Map preserves insertion order, and `touch` re-inserts, so the first
    // entries are the least recently used.
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }

  function create(id: string = randomUUID()): Session {
    const timestamp = now();
    const session: Session = { id, createdAt: timestamp, updatedAt: timestamp, turns: [], slots: emptySlots() };
    sessions.set(id, session);
    sweep();
    return session;
  }

  return {
    /**
     * Fetch an existing conversation or start a new one. An unknown or expired
     * id silently becomes a fresh session rather than an error: a guest whose
     * tab sat open overnight should get a working assistant, not a failure.
     */
    resolve(id?: string): Session {
      sweep();
      if (id) {
        const existing = sessions.get(id);
        if (existing) {
          // Re-insert to mark as most recently used.
          sessions.delete(id);
          sessions.set(id, existing);
          return existing;
        }
        return create(id);
      }
      return create();
    },

    get(id: string): Session | undefined {
      return sessions.get(id);
    },

    append(session: Session, ...turns: ConversationTurn[]): void {
      session.turns.push(...turns);
      if (session.turns.length > maxTurns) {
        session.turns = session.turns.slice(-maxTurns);
      }
      session.updatedAt = now();
    },

    updateSlots(session: Session, slots: Slots): void {
      session.slots = slots;
      session.updatedAt = now();
    },

    get size(): number {
      return sessions.size;
    },

    clear(): void {
      sessions.clear();
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** Process-wide store used by the running server. Tests build their own. */
export const sessionStore = createSessionStore();
