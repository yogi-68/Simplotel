import type { ApiError } from '@hotel/contracts';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getEnv } from '../config/env.js';

/**
 * Per-IP throttle on the AI endpoints.
 *
 * Every chat turn costs a model call, so an unthrottled endpoint is both a bill
 * and an availability risk. The limit is generous enough that no real guest will
 * meet it and tight enough that a script will.
 */
export function createChatRateLimiter() {
  const env = getEnv();
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Tests would otherwise inherit rate limits from earlier cases in the file.
    skip: () => env.NODE_ENV === 'test' && process.env.RATE_LIMIT_ENABLED !== 'true',
    handler: (req: Request, res: Response) => {
      const body: ApiError = {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'You are sending messages a little too quickly. Please wait a moment and try again.',
          requestId: req.requestId,
          retryable: true,
        },
      };
      res.status(429).json(body);
    },
  });
}
