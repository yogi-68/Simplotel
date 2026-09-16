import { z } from 'zod';
import { AvailabilityResultSchema } from './availability.js';
import { IsoDateSchema } from './common.js';

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty').max(1000, 'Message is too long'),
  /** Omit on the first turn; the server mints one and returns it. */
  sessionId: z.string().min(8).max(64).optional(),
  /**
   * Structured stay details captured by the UI's booking form. When present
   * these are *authoritative* — they bypass natural-language date extraction
   * entirely, which is why the form path is more reliable than typing dates.
   */
  context: z
    .object({
      checkIn: IsoDateSchema.optional(),
      checkOut: IsoDateSchema.optional(),
      adults: z.number().int().min(1).max(8).optional(),
      children: z.number().int().min(0).max(6).optional(),
    })
    .optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * What kind of turn the assistant produced. The frontend renders each type
 * differently, and the backend's citation validator only demands sources for
 * `answer` — a clarifying question or a greeting has nothing to cite.
 */
export const ReplyTypeSchema = z.enum([
  'answer', // a factual claim about the hotel — MUST be cited
  'availability', // wraps a deterministic availability result
  'clarification', // needs more info from the guest before it can answer
  'fallback', // we don't know; say so honestly
  'handoff', // route the guest to a human
  'smalltalk', // greeting / thanks / closing
]);
export type ReplyType = z.infer<typeof ReplyTypeSchema>;

/** A knowledge-base fact that justifies the answer, surfaced to the guest as a chip. */
export const SourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  text: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

/** Which stay details are still missing, so the UI can open the right form fields. */
export const SlotNameSchema = z.enum(['checkIn', 'checkOut', 'adults']);
export type SlotName = z.infer<typeof SlotNameSchema>;

export const SlotsSchema = z.object({
  checkIn: IsoDateSchema.nullable(),
  checkOut: IsoDateSchema.nullable(),
  adults: z.number().int().nullable(),
  children: z.number().int().nullable(),
});
export type Slots = z.infer<typeof SlotsSchema>;

export const ChatResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  sessionId: z.string(),
  reply: z.object({
    text: z.string(),
    type: ReplyTypeSchema,
    /** 0–1. Retrieval strength blended with the model's self-report. */
    confidence: z.number().min(0).max(1),
  }),
  sources: z.array(SourceSchema),
  /** Structured, engine-computed. Never parsed back out of the model's prose. */
  availability: AvailabilityResultSchema.nullable(),
  /** Stay details known so far, echoed so the UI form stays in sync. */
  slots: SlotsSchema,
  /** Fields the assistant still needs — drives the inline booking form. */
  needs: z.array(SlotNameSchema),
  /** Follow-up prompts to keep the conversation moving. */
  suggestions: z.array(z.string()),
  meta: z.object({
    provider: z.string(),
    model: z.string(),
    latencyMs: z.number().int().nonnegative(),
    toolCalls: z.array(z.string()),
    /** True when the reply's factual claims were validated against the KB. */
    grounded: z.boolean(),
    /** True when the LLM was unreachable and we served a retrieval-only answer. */
    degraded: z.boolean(),
  }),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
