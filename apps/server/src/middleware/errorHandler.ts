import type { ApiError } from '@hotel/contracts';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError, ProviderError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * The single place an error becomes an HTTP response.
 *
 * Two rules hold everywhere: the guest never sees a stack trace or an internal
 * message, and the response always matches the `ApiError` contract so the
 * frontend can switch on `code` instead of parsing prose.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = normalise(err);

  const logPayload = {
    requestId: req.requestId,
    path: req.path,
    method: req.method,
    code: appError.code,
    status: appError.status,
    err: err instanceof Error ? err.message : String(err),
  };

  // Client mistakes are expected traffic; only our own failures are alarming.
  if (appError.status >= 500) logger.error({ ...logPayload, stack: err instanceof Error ? err.stack : undefined }, 'request failed');
  else logger.warn(logPayload, 'request rejected');

  const body: ApiError = {
    ok: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      requestId: req.requestId,
      retryable: appError.retryable,
    },
  };

  res.status(appError.status).json(body);
}

function normalise(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (err instanceof ZodError) {
    return AppError.validation(
      'Some details in your request were not valid.',
      err.issues.map((issue) => ({ path: issue.path.join('.') || '(body)', message: issue.message })),
    );
  }

  if (err instanceof ProviderError) {
    return err.kind === 'timeout' ? AppError.aiTimeout(err) : AppError.aiUnavailable(err);
  }

  // Express body-parser errors arrive as plain errors with a status.
  if (typeof err === 'object' && err !== null && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    return AppError.validation('That message is too large.');
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return AppError.validation('The request body was not valid JSON.');
  }

  return AppError.internal();
}

/** 404 handler, so unknown paths return the contract shape rather than Express HTML. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`No route for ${req.method} ${req.path}`));
}
