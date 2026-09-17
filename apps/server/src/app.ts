import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { createProvider } from './ai/index.js';
import type { LlmProvider } from './ai/provider.js';
import { getEnv } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { availabilityRouter, hotelRouter } from './routes/availability.route.js';
import { chatRouter } from './routes/chat.route.js';
import { healthRouter } from './routes/health.route.js';

export interface AppOptions {
  /** Injected by tests and by the eval harness to swap in a stub model. */
  provider?: LlmProvider;
}

/**
 * Builds the Express app without binding a port.
 *
 * Keeping `createApp` separate from `listen` is what lets the integration suite
 * drive the real routing, validation and error handling in-process with
 * supertest -- no ports, no timing, no flake.
 */
export function createApp(options: AppOptions = {}): Express {
  const env = getEnv();
  const provider = options.provider ?? createProvider();

  const app = express();

  // Behind Render/Vercel proxies, so the rate limiter sees the real client IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  );
  // A guest message is capped at 1000 characters, so anything approaching this
  // limit is not a real conversation.
  app.use(express.json({ limit: '100kb' }));
  app.use(requestId);

  // Platforms and curious visitors hit the bare URL; point them at the API.
  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'hotel-assistant-api', health: '/api/health' });
  });

  app.use('/api', healthRouter());
  app.use('/api', hotelRouter());
  app.use('/api', availabilityRouter());
  app.use('/api', chatRouter(provider));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
