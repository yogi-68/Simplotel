import pino from 'pino';
import { getEnv } from '../config/env.js';

const env = getEnv();

/**
 * Structured JSON logs in production, readable lines in development.
 *
 * Guest messages are personal data and can be long, so we never log them whole
 * — callers pass a truncated preview via `truncate()`. Everything else we log
 * is operational: timings, intents, which tools ran, whether the answer was
 * grounded. That set is deliberately chosen so the logs alone can answer
 * "is this feature working?" (see the metrics section in PRODUCT_NOTES.md).
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'hotel-assistant-api' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'openaiApiKey', '*.apiKey'],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } }
      : undefined,
});

export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export type Logger = typeof logger;
