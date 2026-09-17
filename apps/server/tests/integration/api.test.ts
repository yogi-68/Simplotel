import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMockProvider } from '../../src/ai/mock.provider.js';
import { resetEnvCache } from '../../src/config/env.js';
import { addDays, todayIso } from '../../src/lib/dates.js';

const app = () => createApp({ provider: createMockProvider() });

const checkIn = addDays(todayIso(), 30);
const checkOut = addDays(todayIso(), 32);

describe('POST /api/availability - deterministic, no model involved', () => {
  it('returns priced options for a valid stay', async () => {
    const res = await request(app()).post('/api/availability').send({ checkIn, checkOut, adults: 2 }).expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.availability.query.nights).toBe(2);
    expect(res.body.availability.currency).toBe('INR');
    expect(res.body.availability.options.length).toBeGreaterThan(0);
  });

  it('gives byte-identical results for the same query', async () => {
    const body = { checkIn, checkOut, adults: 2 };
    const first = await request(app()).post('/api/availability').send(body).expect(200);
    const second = await request(app()).post('/api/availability').send(body).expect(200);
    expect(first.body.availability).toEqual(second.body.availability);
  });

  it('explains which rooms were ruled out and why', async () => {
    const res = await request(app()).post('/api/availability').send({ checkIn, checkOut, adults: 3 }).expect(200);

    const excluded = res.body.availability.excluded;
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.some((e: { reason: string }) => e.reason === 'occupancy')).toBe(true);
    for (const option of res.body.availability.options) {
      expect(option.maxAdults).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects a check-out that is not after check-in', async () => {
    const res = await request(app())
      .post('/api/availability')
      .send({ checkIn, checkOut: checkIn, adults: 2 })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/at least one night/i);
  });

  it('rejects a stay in the past', async () => {
    const res = await request(app())
      .post('/api/availability')
      .send({ checkIn: '2020-01-01', checkOut: '2020-01-03', adults: 2 })
      .expect(400);

    expect(res.body.error.message).toMatch(/past/i);
  });

  it('rejects a party larger than a room booking allows', async () => {
    const res = await request(app()).post('/api/availability').send({ checkIn, checkOut, adults: 20 }).expect(400);
    expect(res.body.error.details[0].path).toBe('adults');
  });

  it('defaults children to zero when not supplied', async () => {
    const res = await request(app()).post('/api/availability').send({ checkIn, checkOut, adults: 2 }).expect(200);
    expect(res.body.availability.query.children).toBe(0);
  });
});

describe('GET /api/hotel', () => {
  it('gives the frontend everything it needs to label itself', async () => {
    const res = await request(app()).get('/api/hotel').expect(200);

    expect(res.body.hotel.name).toBe('The Banyan Grove');
    expect(res.body.hotel.phone).toBeTruthy();
    expect(res.body.roomTypes).toHaveLength(4);
    expect(res.body.suggestedQuestions.length).toBeGreaterThanOrEqual(4);
  });
});

describe('health checks', () => {
  it('answers on the bare root URL', async () => {
    const res = await request(app()).get('/').expect(200);
    expect(res.body.health).toBe('/api/health');
  });

  it('reports liveness', async () => {
    const res = await request(app()).get('/api/health').expect(200);
    expect(res.body.status).toBe('up');
  });

  it('reports readiness only when the assistant actually has data to work with', async () => {
    const res = await request(app()).get('/api/health/ready').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks.knowledgeBaseFacts).toBeGreaterThan(0);
    expect(res.body.checks.roomTypes).toBe(4);
    expect(res.body.config.provider).toBeTruthy();
  });

  it('does not leak the API key through the config summary', async () => {
    const res = await request(app()).get('/api/health/ready').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-/);
    expect(res.body.config).not.toHaveProperty('OPENAI_API_KEY');
  });
});

describe('CORS', () => {
  const original = process.env.WEB_ORIGIN;
  afterAll(() => {
    if (original === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = original;
    resetEnvCache();
  });

  it('accepts an allowlisted origin configured with a trailing slash', async () => {
    process.env.WEB_ORIGIN = 'https://guest.example.com/';
    resetEnvCache();
    const res = await request(app())
      .options('/api/chat')
      .set('Origin', 'https://guest.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://guest.example.com');
  });
});

describe('error handling', () => {
  it('returns the contract shape for an unknown route, not Express HTML', async () => {
    const res = await request(app()).get('/api/nope').expect(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects a malformed JSON body cleanly', async () => {
    const res = await request(app())
      .post('/api/chat')
      .set('Content-Type', 'application/json')
      .send('{"message": ')
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('echoes a caller-supplied request id so traces can be correlated', async () => {
    const res = await request(app()).get('/api/health/ready').set('X-Request-Id', 'trace-abc-123').expect(200);
    expect(res.body.requestId).toBe('trace-abc-123');
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('does not advertise the server implementation', async () => {
    const res = await request(app()).get('/api/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rate limiting', () => {
  beforeAll(() => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_MAX = '3';
    resetEnvCache();
  });

  afterAll(() => {
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.RATE_LIMIT_MAX;
    resetEnvCache();
  });

  it('throttles a caller that is sending too fast, with a retryable error', async () => {
    const agent = app();
    const send = () => request(agent).post('/api/chat').send({ message: 'What time is check-in?' });

    await send().expect(200);
    await send().expect(200);
    await send().expect(200);

    const limited = await send().expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.body.error.retryable).toBe(true);
    expect(limited.body.error.message).toMatch(/too quickly/i);
  });

  it('leaves the deterministic availability endpoint unthrottled', async () => {
    // Only the model-backed endpoint costs money, so only it is limited.
    const agent = app();
    for (let i = 0; i < 5; i += 1) {
      await request(agent).post('/api/availability').send({ checkIn, checkOut, adults: 2 }).expect(200);
    }
  });
});
