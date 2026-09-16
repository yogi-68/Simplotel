import { ChatRequestSchema } from '@hotel/contracts';
import { Router, type Response } from 'express';
import type { LlmProvider } from '../ai/provider.js';
import { validateBody } from '../middleware/validate.js';
import { createChatRateLimiter } from '../middleware/rateLimit.js';
import { handleChat } from '../orchestrator/assistant.service.js';

/**
 * The conversational endpoint.
 *
 * The route itself stays thin: validate, delegate, respond. Every interesting
 * decision -- retrieval, tool dispatch, grounding, degradation -- lives in the
 * orchestrator, which is why the whole pipeline is testable without HTTP.
 */
export function chatRouter(provider: LlmProvider): Router {
  const router = Router();

  router.post('/chat', createChatRateLimiter(), validateBody(ChatRequestSchema), async (req, res) => {
    // Express 5 forwards rejected promises to the error handler automatically,
    // so a thrown AppError becomes the correct status without a try/catch here.
    const response = await handleChat(
      { request: req.body, requestId: req.requestId, signal: abortOnClientDisconnect(res) },
      { provider },
    );

    res.json(response);
  });

  return router;
}

/**
 * Stop paying for a model call the guest will never see.
 *
 * We watch the *response*, not the request: the request stream closes as soon as
 * its body has been read, which on a normal turn happens long before the
 * assistant has answered. `writableEnded` distinguishes a real disconnect from
 * an ordinary completed response.
 */
function abortOnClientDisconnect(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
