import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Parse and replace `req.body` with the validated, typed value.
 *
 * Replacing rather than merely checking matters: downstream handlers then work
 * with coerced, stripped data and cannot accidentally read an unvalidated extra
 * field that a caller smuggled in.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(
        AppError.validation(
          'Some details in your request were not valid.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || '(body)',
            message: issue.message,
          })),
        ),
      );
      return;
    }
    req.body = parsed.data;
    next();
  };
}
