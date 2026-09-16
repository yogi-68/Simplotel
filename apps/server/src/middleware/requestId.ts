import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Every request gets an id, echoed in the response body and the `X-Request-Id`
 * header and attached to every log line for the turn. When a guest reports a bad
 * answer, that id is the thread that ties their screenshot to the retrieval
 * scores, the tool calls and the grounding verdict behind it.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
