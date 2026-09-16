import { z } from 'zod';

/**
 * A calendar date in `YYYY-MM-DD`. We validate the *shape* and the *calendar
 * validity* (so `2026-02-30` is rejected) but deliberately NOT the business
 * rules (past dates, ordering, max stay). Those live in the availability
 * domain, because they need "today" and produce guest-facing messages.
 */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return (
      parsed.getUTCFullYear() === y &&
      parsed.getUTCMonth() === m - 1 &&
      parsed.getUTCDate() === d
    );
  }, 'Not a real calendar date');

export type IsoDate = z.infer<typeof IsoDateSchema>;

/**
 * Every failure the API can return, as a closed set. The frontend switches on
 * `code` to decide the UX (inline fix vs. retry vs. degraded banner), so this
 * union is part of the contract — not an implementation detail.
 */
export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR', // 400 — guest can fix it (bad dates, empty message)
  'NOT_FOUND', // 404
  'RATE_LIMITED', // 429 — back off and retry
  'AI_TIMEOUT', // 503 — model took too long
  'AI_UNAVAILABLE', // 503 — model/circuit breaker down
  'UPSTREAM_ERROR', // 502 — dependency misbehaved
  'INTERNAL_ERROR', // 500 — our bug
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    /** Field-level detail for VALIDATION_ERROR, so the UI can point at the input. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string(),
    /** Tells the client whether a retry button is worth showing. */
    retryable: z.boolean(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
