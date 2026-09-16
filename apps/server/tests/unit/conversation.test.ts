import { describe, expect, it } from 'vitest';
import { createSessionStore } from '../../src/domain/conversation/session.store.js';
import {
  emptySlots,
  hasCompleteStay,
  mergeSlots,
  missingSlots,
  slotsFromRequestContext,
  slotsFromToolArguments,
} from '../../src/domain/conversation/slots.js';

describe('slot filling', () => {
  it('accumulates stay details across turns', () => {
    const afterFirst = mergeSlots(emptySlots(), { checkIn: '2026-12-12', checkOut: '2026-12-14' });
    expect(missingSlots(afterFirst)).toEqual(['adults']);

    const afterSecond = mergeSlots(afterFirst, { adults: 3 });
    expect(hasCompleteStay(afterSecond)).toBe(true);
    expect(afterSecond.checkIn).toBe('2026-12-12');
  });

  it('lets later layers override earlier ones', () => {
    const merged = mergeSlots({ adults: 2 }, { adults: 4 });
    expect(merged.adults).toBe(4);
  });

  it('never lets a null or invalid value erase a known one', () => {
    // A malformed tool argument must not wipe a date the guest already gave.
    const known = mergeSlots(emptySlots(), { checkIn: '2026-12-12', adults: 2 });
    const merged = mergeSlots(known, { checkIn: null, adults: 0 });
    expect(merged.checkIn).toBe('2026-12-12');
    expect(merged.adults).toBe(2);
  });

  it('discards values that are not real dates or plausible party sizes', () => {
    const merged = mergeSlots(emptySlots(), {
      checkIn: 'next Friday' as unknown as string,
      checkOut: '2026-02-30', // not a real calendar date
      adults: 99,
    });
    expect(merged.checkIn).toBeNull();
    expect(merged.checkOut).toBeNull();
    expect(merged.adults).toBeNull();
  });

  it('treats booking-form input as authoritative over remembered values', () => {
    const remembered = mergeSlots(emptySlots(), { checkIn: '2026-12-12', adults: 2 });
    const fromForm = slotsFromRequestContext({ checkIn: '2027-01-10', adults: 4 });
    const merged = mergeSlots(remembered, fromForm);
    expect(merged.checkIn).toBe('2027-01-10');
    expect(merged.adults).toBe(4);
  });

  it('treats model tool arguments as untrusted input', () => {
    const parsed = slotsFromToolArguments({ checkIn: 'tomorrow', checkOut: '2026-12-14', adults: '3' });
    expect(parsed.checkIn).toBeNull();
    expect(parsed.checkOut).toBe('2026-12-14');
    expect(parsed.adults).toBeNull(); // a string is not an integer
  });

  it('reports exactly which details are still missing', () => {
    expect(missingSlots(emptySlots())).toEqual(['checkIn', 'checkOut', 'adults']);
    expect(missingSlots(mergeSlots(emptySlots(), { checkIn: '2026-12-12', adults: 2 }))).toEqual(['checkOut']);
  });
});

describe('session store', () => {
  it('starts a new conversation when no id is supplied', () => {
    const store = createSessionStore();
    const first = store.resolve();
    const second = store.resolve();
    expect(first.id).not.toBe(second.id);
  });

  it('returns the same conversation for a known id', () => {
    const store = createSessionStore();
    const created = store.resolve();
    store.append(created, { role: 'user', content: 'hello' });
    expect(store.resolve(created.id).turns).toHaveLength(1);
  });

  it('treats an unknown id as a fresh conversation rather than an error', () => {
    // A guest whose tab sat open overnight should get a working assistant.
    const store = createSessionStore();
    const session = store.resolve('some-expired-id');
    expect(session.id).toBe('some-expired-id');
    expect(session.turns).toEqual([]);
  });

  it('keeps only the most recent turns so the prompt cannot grow without bound', () => {
    const store = createSessionStore({ maxTurns: 4 });
    const session = store.resolve();
    for (let i = 0; i < 10; i += 1) {
      store.append(session, { role: 'user', content: `message ${i}` });
    }
    expect(session.turns).toHaveLength(4);
    expect(session.turns[3]?.content).toBe('message 9');
  });

  it('expires conversations that have gone idle', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ ttlMs: 60_000, now: () => clock });
    const session = store.resolve();
    clock += 61_000;
    expect(store.resolve(session.id).turns).toEqual([]);
    expect(store.get(session.id)?.createdAt).toBe(clock);
  });

  it('evicts the least recently used conversation when at capacity', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ maxSessions: 2, now: () => clock });
    const a = store.resolve('a');
    store.resolve('b');
    // Touch 'a' so 'b' becomes the least recently used.
    clock += 10;
    store.resolve(a.id);
    clock += 10;
    store.resolve('c');

    expect(store.size).toBe(2);
    expect(store.get('a')).toBeDefined();
    expect(store.get('b')).toBeUndefined();
  });

  it('carries stay details forward with the conversation', () => {
    const store = createSessionStore();
    const session = store.resolve();
    store.updateSlots(session, mergeSlots(emptySlots(), { checkIn: '2026-12-12', adults: 2 }));
    expect(store.resolve(session.id).slots.checkIn).toBe('2026-12-12');
  });
});
