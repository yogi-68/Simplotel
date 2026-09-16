import { z } from 'zod';

/**
 * The contract the model must satisfy on every turn.
 *
 * We ask for structured output rather than free prose for one reason: prose
 * cannot be checked. A JSON object with an explicit `type` and an explicit
 * `sourceIds` list is something the server can *validate* — and reject. That
 * turns "please only use the provided facts" from a hopeful instruction into an
 * enforceable postcondition.
 */
export const AssistantOutputSchema = z.object({
  /** What the guest sees. Plain text, no markdown, no invented figures. */
  answer: z.string().min(1).max(2000),

  type: z.enum(['answer', 'availability', 'clarification', 'fallback', 'handoff', 'smalltalk']),

  /**
   * Knowledge-base ids that justify the answer. Validated server-side against
   * the facts actually retrieved for this turn; anything else is a violation.
   */
  sourceIds: z.array(z.string()).max(8),

  /** The model's own certainty. Blended with retrieval strength, never trusted alone. */
  confidence: z.number().min(0).max(1),

  /** Stay details still missing, so the UI can open exactly the right form fields. */
  needs: z.array(z.enum(['checkIn', 'checkOut', 'adults'])).max(3),

  /** Up to three follow-up prompts to keep the conversation moving. */
  suggestions: z.array(z.string()).max(3),
});

export type AssistantOutput = z.infer<typeof AssistantOutputSchema>;

/**
 * The same shape as JSON Schema for OpenAI structured outputs.
 *
 * Strict mode requires every property to appear in `required` and
 * `additionalProperties: false`, so this cannot be generated from the zod schema
 * with defaults — it is written out explicitly and kept in step by
 * tests/unit/schema.test.ts, which asserts the two definitions agree.
 */
export const ASSISTANT_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'type', 'sourceIds', 'confidence', 'needs', 'suggestions'],
  properties: {
    answer: {
      type: 'string',
      description: 'The reply shown to the guest. Plain text, warm and concise, no markdown.',
    },
    type: {
      type: 'string',
      enum: ['answer', 'availability', 'clarification', 'fallback', 'handoff', 'smalltalk'],
      description:
        'answer = a factual claim taken from the provided facts (sourceIds REQUIRED). availability = narrating a checkAvailability result. clarification = you need more detail from the guest. fallback = the facts do not cover this. handoff = the guest needs a human. smalltalk = greeting, thanks or closing.',
    },
    sourceIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ids of the provided facts that support this answer, for example ["F26"]. Must be non-empty when type is "answer". Never invent an id.',
    },
    confidence: {
      type: 'number',
      description: 'Between 0 and 1. How confident you are that the provided facts fully answer the question.',
    },
    needs: {
      type: 'array',
      items: { type: 'string', enum: ['checkIn', 'checkOut', 'adults'] },
      description: 'Stay details you still need before availability can be checked. Empty otherwise.',
    },
    suggestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 short follow-up questions the guest is likely to ask next.',
    },
  },
} as const;
