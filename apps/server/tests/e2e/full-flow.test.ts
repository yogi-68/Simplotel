import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMockProvider } from '../../src/ai/mock.provider.js';
import { addDays, todayIso } from '../../src/lib/dates.js';

/**
 * End-to-end over real HTTP.
 *
 * Everything else in the suite drives the app in-process. This one binds an
 * actual port and talks to it with `fetch`, exactly as the browser does -- so it
 * catches the class of problem that only appears once a real socket, real JSON
 * serialisation and real headers are involved.
 *
 * The conversation below is the full guest journey from the brief: ask, follow
 * up, check availability, then hit something we cannot answer.
 */

let server: Server;
let baseUrl: string;

const checkIn = addDays(todayIso(), 30);
const checkOut = addDays(todayIso(), 32);

beforeAll(async () => {
  const app = createApp({ provider: createMockProvider() });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('failed to bind a port');
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function chat(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

describe('the guest journey, over real HTTP', () => {
  it('serves health before anything else', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'up' });
  });

  it('bootstraps the UI with hotel details', async () => {
    const res = await fetch(`${baseUrl}/api/hotel`);
    const body = (await res.json()) as any;
    expect(body.hotel.name).toBe('The Banyan Grove');
    expect(body.suggestedQuestions.length).toBeGreaterThan(0);
  });

  it('walks a full conversation: question, follow-up, availability, refusal', async () => {
    // 1. A factual question, answered from the knowledge base with a citation.
    const first = await chat({ message: 'What time is check-in?' });
    expect(first.status).toBe(200);
    expect(first.body.reply.text).toContain('2:00 PM');
    expect(first.body.sources[0].id).toBe('F26');
    const sessionId = first.body.sessionId;

    // 2. A follow-up that is meaningless without the previous turn.
    const second = await chat({ message: 'and checkout?', sessionId });
    expect(second.body.sessionId).toBe(sessionId);
    expect(second.body.reply.text).toContain('11:00 AM');

    // 3. Availability, asked without dates: the assistant must ask, not guess.
    const third = await chat({ message: 'Do you have rooms available?', sessionId });
    expect(third.body.reply.type).toBe('clarification');
    expect(third.body.needs).toContain('checkIn');
    expect(third.body.availability).toBeNull();

    // 4. The guest supplies the details, as the booking form would.
    const fourth = await chat({
      message: 'Here are my dates',
      sessionId,
      context: { checkIn, checkOut, adults: 3 },
    });
    expect(fourth.body.meta.toolCalls).toContain('check_availability');
    expect(fourth.body.availability.query).toMatchObject({ checkIn, checkOut, nights: 2, adults: 3 });
    expect(fourth.body.availability.options.length).toBeGreaterThan(0);
    // Every room offered must actually fit the party.
    for (const option of fourth.body.availability.options) {
      expect(option.maxAdults).toBeGreaterThanOrEqual(3);
      expect(option.total).toBe(option.subtotal + option.taxes);
    }
    // And the stay is remembered for the rest of the conversation.
    expect(fourth.body.slots).toMatchObject({ checkIn, checkOut, adults: 3 });

    // 5. Something we genuinely do not know: refuse rather than invent.
    const fifth = await chat({ message: 'What time does the casino open?', sessionId });
    expect(fifth.body.reply.type).toBe('fallback');
    expect(fifth.body.sources).toEqual([]);
    expect(fifth.body.reply.text.toLowerCase()).toContain('front desk');
  });

  it('returns the error contract, not an HTML page, for a bad request', async () => {
    const res = await chat({ message: '' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR', retryable: false } });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('exposes the request id header the browser needs for CORS tracing', async () => {
    const res = await fetch(`${baseUrl}/api/health/ready`, { headers: { Origin: 'http://localhost:3000' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('refuses a browser origin that is not on the allowlist', async () => {
    const res = await fetch(`${baseUrl}/api/hotel`, { headers: { Origin: 'https://evil.example' } });
    // The request still completes server-side, but without the CORS grant the
    // browser will not hand the body to the page.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps two guests in separate conversations', async () => {
    const guestA = await chat({ message: 'What time is check-in?' });
    const guestB = await chat({ message: 'Is breakfast included?' });
    expect(guestA.body.sessionId).not.toBe(guestB.body.sessionId);

    const followUp = await chat({ message: 'and checkout?', sessionId: guestA.body.sessionId });
    expect(followUp.body.reply.text).toContain('11:00 AM');
  });
});
