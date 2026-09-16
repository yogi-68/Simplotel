import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMockProvider } from '../../src/ai/mock.provider.js';
import { sessionStore } from '../../src/domain/conversation/session.store.js';
import { addDays, todayIso } from '../../src/lib/dates.js';
import { stubProvider, throwingProvider } from '../helpers/stubProvider.js';

const app = () => createApp({ provider: createMockProvider() });

const checkIn = addDays(todayIso(), 30);
const checkOut = addDays(todayIso(), 32);

beforeEach(() => {
  // The store is a process singleton, so conversations must not leak between cases.
  sessionStore.clear();
});

describe('POST /api/chat - answering property questions', () => {
  it('answers a factual question and shows the guest where the answer came from', async () => {
    const res = await request(app()).post('/api/chat').send({ message: 'What time is check-in?' }).expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.reply.type).toBe('answer');
    expect(res.body.reply.text).toContain('2:00 PM');
    expect(res.body.meta.grounded).toBe(true);
    expect(res.body.meta.degraded).toBe(false);
    expect(res.body.sources.map((s: { id: string }) => s.id)).toContain('F26');
    expect(res.body.sources[0].text).toBeTruthy();
  });

  it('returns a session id the client can carry into the next turn', async () => {
    const res = await request(app()).post('/api/chat').send({ message: 'Is breakfast included?' }).expect(200);
    expect(res.body.sessionId).toMatch(/[0-9a-f-]{16,}/);
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('answers each of the questions from the brief from the knowledge base', async () => {
    const cases: Array<[string, string]> = [
      ['Does the hotel have a swimming pool?', 'F13'],
      ['Which room is suitable for three guests?', 'F08'],
      ['Is breakfast included?', 'F22'],
      ['What is the cancellation policy?', 'F29'],
    ];

    for (const [message, expectedSource] of cases) {
      const res = await request(app()).post('/api/chat').send({ message }).expect(200);
      expect(res.body.reply.type, message).toBe('answer');
      expect(res.body.sources.map((s: { id: string }) => s.id), message).toContain(expectedSource);
    }
  });

  it('carries context into a follow-up question', async () => {
    const agent = app();
    const first = await request(agent).post('/api/chat').send({ message: 'What time is check-in?' }).expect(200);

    const second = await request(agent)
      .post('/api/chat')
      .send({ message: 'and checkout?', sessionId: first.body.sessionId })
      .expect(200);

    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(second.body.reply.text).toContain('11:00 AM');
    expect(second.body.sources.map((s: { id: string }) => s.id)).toContain('F27');
  });

  it('refuses honestly when the knowledge base does not cover the question', async () => {
    const res = await request(app()).post('/api/chat').send({ message: 'What time does the casino open?' }).expect(200);

    expect(res.body.reply.type).toBe('fallback');
    expect(res.body.sources).toEqual([]);
    expect(res.body.reply.confidence).toBeLessThanOrEqual(0.3);
    // It must not invent an opening time, and it should route the guest onward.
    expect(res.body.reply.text).not.toMatch(/\d{1,2}[:.]\d{2}\s*(am|pm)/i);
    expect(res.body.reply.text.toLowerCase()).toContain('front desk');
  });

  it('does not let history hijack a short question that stands on its own', async () => {
    // "What is the cancellation policy?" is short enough to look like a
    // follow-up, but it retrieves perfectly well alone. Widening it with the
    // previous turn made the breakfast fact outrank the cancellation policy and
    // the guest was answered about the wrong thing entirely -- so widening only
    // ever runs when the message failed to retrieve on its own.
    const agent = app();
    const first = await request(agent).post('/api/chat').send({ message: 'Is breakfast included?' }).expect(200);
    expect(first.body.sources.map((s: { id: string }) => s.id)).toContain('F22');

    const second = await request(agent)
      .post('/api/chat')
      .send({ message: 'What is the cancellation policy?', sessionId: first.body.sessionId })
      .expect(200);

    expect(second.body.sources.map((s: { id: string }) => s.id)).toContain('F29');
    expect(second.body.sources.map((s: { id: string }) => s.id)).not.toContain('F22');
    expect(second.body.reply.text).toMatch(/48 hours/);
  });

  it('does not let conversation history manufacture context for a new topic', async () => {
    // Short messages get widened with the previous turn so that follow-ups like
    // "and checkout?" retrieve properly. A short question about something we
    // have never heard of must NOT be rescued that way -- borrowing words from
    // the last turn would lift it over the context floor and turn an honest
    // refusal into a confident answer about an unrelated fact.
    const agent = app();
    const first = await request(agent)
      .post('/api/chat')
      .send({ message: 'Do you have rooms available?', context: { checkIn, checkOut, adults: 2 } })
      .expect(200);

    const second = await request(agent)
      .post('/api/chat')
      .send({ message: 'What time does the casino open?', sessionId: first.body.sessionId })
      .expect(200);

    expect(second.body.reply.type).toBe('fallback');
    expect(second.body.sources).toEqual([]);
  });
});

describe('POST /api/chat - availability', () => {
  it('calls the availability tool and returns a structured result', async () => {
    const res = await request(app())
      .post('/api/chat')
      .send({ message: 'Do you have any rooms available?', context: { checkIn, checkOut, adults: 2 } })
      .expect(200);

    expect(res.body.meta.toolCalls).toContain('check_availability');
    expect(res.body.reply.type).toBe('availability');
    expect(res.body.availability).not.toBeNull();
    expect(res.body.availability.query).toMatchObject({ checkIn, checkOut, nights: 2, adults: 2 });
    expect(res.body.slots).toMatchObject({ checkIn, checkOut, adults: 2 });
  });

  it('returns prices computed by the engine, with totals that add up', async () => {
    const res = await request(app())
      .post('/api/chat')
      .send({ message: 'Any rooms free?', context: { checkIn, checkOut, adults: 2 } })
      .expect(200);

    for (const option of res.body.availability.options) {
      expect(option.total).toBe(option.subtotal + option.taxes);
      expect(option.nightly).toHaveLength(2);
    }
  });

  it('asks only for the stay details it does not already have', async () => {
    const res = await request(app())
      .post('/api/chat')
      .send({ message: 'Do you have rooms available?', context: { adults: 2 } })
      .expect(200);

    expect(res.body.reply.type).toBe('clarification');
    expect(res.body.needs).toEqual(['checkIn', 'checkOut']);
    expect(res.body.needs).not.toContain('adults');
    expect(res.body.availability).toBeNull();
  });

  it('collects stay details across turns rather than re-asking', async () => {
    const agent = app();
    const first = await request(agent)
      .post('/api/chat')
      .send({ message: 'Do you have rooms available?' })
      .expect(200);
    expect(first.body.needs).toEqual(['checkIn', 'checkOut', 'adults']);

    const second = await request(agent)
      .post('/api/chat')
      .send({
        message: 'Any rooms?',
        sessionId: first.body.sessionId,
        context: { checkIn, checkOut, adults: 3 },
      })
      .expect(200);

    expect(second.body.reply.type).toBe('availability');
    expect(second.body.availability.query.adults).toBe(3);
  });

  it('checks availability without asking the model to decide, when the form supplied a stay', async () => {
    // The guest used a date picker and pressed "Check availability", so there is
    // no intent left to infer. Live evaluation caught gpt-4o-mini ignoring the
    // stay details in its prompt and asking the guest to repeat dates they had
    // just entered, so the engine now runs before the model does.
    //
    // The stub never emits a tool call, which is exactly the misbehaviour being
    // guarded against: availability must still be computed and returned.
    const provider = stubProvider([{ answer: 'Here are your options.', type: 'availability', sourceIds: [] }]);
    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'Anything free?', context: { checkIn, checkOut, adults: 2 } })
      .expect(200);

    expect(res.body.meta.toolCalls).toContain('check_availability');
    expect(res.body.availability).not.toBeNull();
    expect(res.body.availability.query).toMatchObject({ checkIn, checkOut, adults: 2 });
  });

  it('does not run availability for an ordinary question with no stay supplied', async () => {
    const res = await request(app()).post('/api/chat').send({ message: 'What time is check-in?' }).expect(200);
    expect(res.body.meta.toolCalls).toEqual([]);
    expect(res.body.availability).toBeNull();
  });

  it('labels a rejected stay as a clarification even when the model calls it something else', async () => {
    // gpt-4o-mini labelled "your check-out is before your check-in" as
    // `fallback`, which the UI badges "Not in our records" -- misleading, since
    // our records are fine and the guest's dates are not. The backend knows a
    // business rule failed, so it fixes the label and keeps the model's wording.
    const provider = stubProvider([
      { answer: 'Your check-out date is before your check-in date.', type: 'fallback', sourceIds: [] },
    ]);
    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'Book me in', context: { checkIn, checkOut: checkIn, adults: 2 } })
      .expect(200);

    expect(res.body.reply.type).toBe('clarification');
    expect(res.body.reply.text).toContain('check-out');
    expect(res.body.availability).toBeNull();
    // The form should point at the field the engine actually rejected.
    expect(res.body.needs).toEqual(['checkOut']);
  });

  it('turns a broken date rule into a question rather than an error', async () => {
    // The model asks for a stay that ends before it starts. The engine rejects
    // it, and that rejection is handed back as something the guest can fix.
    const provider = stubProvider([
      { toolCalls: [{ id: 't1', name: 'check_availability', arguments: { checkIn, checkOut: checkIn, adults: 2 } }] },
    ]);
    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'Do you have a room for one night?' })
      .expect(200);

    expect(res.body.availability).toBeNull();
    expect(res.body.reply.type).not.toBe('answer');
    expect(res.statusCode).toBe(200);
  });

  it('rejects a tool call for a date in the past', async () => {
    const provider = stubProvider([
      {
        toolCalls: [
          { id: 't1', name: 'check_availability', arguments: { checkIn: '2020-01-01', checkOut: '2020-01-03', adults: 2 } },
        ],
      },
    ]);
    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'Rooms for the first of January 2020?' })
      .expect(200);

    expect(res.body.availability).toBeNull();
  });
});

describe('POST /api/chat - grounding enforcement', () => {
  it('discards a factual answer that cites nothing', async () => {
    const provider = stubProvider([
      { answer: 'Check-in is at 9:00 AM and the rooftop casino opens at noon.', type: 'answer', sourceIds: [] },
    ]);

    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'What time is check-in?' })
      .expect(200);

    expect(res.body.meta.grounded).toBe(false);
    expect(res.body.reply.type).toBe('fallback');
    expect(res.body.reply.text).not.toContain('9:00 AM');
    expect(res.body.reply.text).not.toContain('casino');
    expect(res.body.sources).toEqual([]);
  });

  it('discards a factual answer that cites a fact it was never shown', async () => {
    const provider = stubProvider([
      { answer: 'The hotel has a helipad on the roof.', type: 'answer', sourceIds: ['F99'] },
    ]);

    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'What time is check-in?' })
      .expect(200);

    expect(res.body.meta.grounded).toBe(false);
    expect(res.body.reply.text).not.toContain('helipad');
  });

  it('serves a fallback when the model returns unparseable output', async () => {
    const provider = stubProvider([{ raw: 'this is not json at all' }]);
    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'What time is check-in?' })
      .expect(200);

    expect(res.body.reply.type).toBe('fallback');
    expect(res.body.ok).toBe(true);
  });

  it('serves a fallback when the model returns JSON of the wrong shape', async () => {
    const provider = stubProvider([{ raw: JSON.stringify({ reply: 'hello', certainty: 'high' }) }]);
    const res = await request(createApp({ provider }))
      .post('/api/chat')
      .send({ message: 'What time is check-in?' })
      .expect(200);

    expect(res.body.reply.type).toBe('fallback');
  });
});

describe('POST /api/chat - when the model is down', () => {
  it('still answers from the knowledge base instead of failing', async () => {
    const res = await request(createApp({ provider: throwingProvider() }))
      .post('/api/chat')
      .send({ message: 'What time is check-in?' })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.meta.degraded).toBe(true);
    expect(res.body.reply.text).toContain('2:00 PM');
    expect(res.body.reply.text).toMatch(/temporarily unavailable/i);
    expect(res.body.sources.map((s: { id: string }) => s.id)).toContain('F26');
  });

  it('hands the guest to a human when it has nothing to fall back on', async () => {
    const res = await request(createApp({ provider: throwingProvider() }))
      .post('/api/chat')
      .send({ message: 'Do you have a helipad?' })
      .expect(200);

    expect(res.body.meta.degraded).toBe(true);
    expect(res.body.reply.type).toBe('handoff');
    expect(res.body.reply.text).toContain('+91 80 4567 1200');
  });

  it('caps confidence while degraded so the UI can be honest about it', async () => {
    const res = await request(createApp({ provider: throwingProvider() }))
      .post('/api/chat')
      .send({ message: 'What time is check-in?' })
      .expect(200);

    expect(res.body.reply.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('POST /api/chat - request validation', () => {
  it('rejects an empty message with a field-level error', async () => {
    const res = await request(app()).post('/api/chat').send({ message: '   ' }).expect(400);

    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.retryable).toBe(false);
    expect(res.body.error.details[0].path).toBe('message');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects a message that is too long', async () => {
    const res = await request(app()).post('/api/chat').send({ message: 'x'.repeat(1001) }).expect(400);
    expect(res.body.error.details[0].message).toMatch(/too long/i);
  });

  it('rejects a malformed date in the booking context', async () => {
    const res = await request(app())
      .post('/api/chat')
      .send({ message: 'Any rooms?', context: { checkIn: '12/12/2026' } })
      .expect(400);

    expect(res.body.error.details[0].path).toBe('context.checkIn');
  });

  it('rejects a date that looks valid but is not a real day', async () => {
    const res = await request(app())
      .post('/api/chat')
      .send({ message: 'Any rooms?', context: { checkIn: '2026-02-30' } })
      .expect(400);

    expect(res.body.error.details[0].message).toMatch(/not a real calendar date/i);
  });

  it('never returns a stack trace or internal detail to the guest', async () => {
    const res = await request(app()).post('/api/chat').send({}).expect(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(/);
    expect(res.body.error).not.toHaveProperty('stack');
  });
});
