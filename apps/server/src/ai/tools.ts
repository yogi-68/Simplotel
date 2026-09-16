import type { LlmToolDefinition } from './provider.js';

export const CHECK_AVAILABILITY_TOOL = 'check_availability';

/**
 * The single tool the assistant may call.
 *
 * Note what the description does NOT do: it never asks the model to compute a
 * price, judge whether dates are valid, or decide which rooms fit the party.
 * All of that is the engine's job. The model's only responsibility is turning
 * "next Friday for two nights, three of us" into three typed arguments — the
 * one part of this flow where natural language actually needs a language model.
 */
export const checkAvailabilityTool: LlmToolDefinition = {
  name: CHECK_AVAILABILITY_TOOL,
  description:
    'Check live room availability and pricing for a stay. Call this whenever the guest asks whether rooms are free, ' +
    'asks for prices for specific dates, or wants to book. Only call it once you know check-in date, check-out date ' +
    'and the number of adults; if any of those is missing, reply with type "clarification" and list what you need ' +
    'instead of guessing. Never guess or invent dates.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['checkIn', 'checkOut', 'adults'],
    properties: {
      checkIn: {
        type: 'string',
        description: 'Arrival date as YYYY-MM-DD. Resolve relative phrases like "next Friday" against today.',
      },
      checkOut: {
        type: 'string',
        description: 'Departure date as YYYY-MM-DD. Must be after checkIn.',
      },
      adults: {
        type: 'integer',
        description: 'Number of adults, 1 to 8.',
      },
      children: {
        type: 'integer',
        description: 'Number of children under 12. Use 0 if the guest did not mention any.',
      },
      roomTypeId: {
        type: 'string',
        description:
          'Optional. Only set when the guest named one room type: garden-view-queen, deluxe-king, executive-twin or banyan-suite.',
      },
    },
  },
};

export const allTools: LlmToolDefinition[] = [checkAvailabilityTool];
