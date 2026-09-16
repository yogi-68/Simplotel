import { Router } from 'express';
import { getEnv } from '../config/env.js';
import { knowledgeBase } from '../domain/knowledge/kb.repository.js';
import { listRoomTypes } from '../domain/availability/availability.service.js';

/**
 * Liveness and readiness are separate on purpose. Liveness answers "is the
 * process up" for a platform health check. Readiness also asserts that the data
 * the assistant depends on actually loaded, so a deploy with a broken knowledge
 * base fails the check instead of silently serving an assistant that knows
 * nothing.
 */
export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, status: 'up', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/health/ready', (req, res) => {
    const env = getEnv();
    const facts = knowledgeBase.facts().length;
    const rooms = listRoomTypes().length;
    const ready = facts > 0 && rooms > 0;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      requestId: req.requestId,
      checks: { knowledgeBaseFacts: facts, roomTypes: rooms },
      config: { provider: env.AI_PROVIDER, model: env.OPENAI_MODEL, retrievalMode: env.RETRIEVAL_MODE },
    });
  });

  return router;
}
