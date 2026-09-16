import { z } from 'zod';

/**
 * Bootstrap payload for the UI. The frontend hardcodes no hotel data — swap the
 * knowledge base and the whole interface re-labels itself.
 */
export const HotelInfoResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  hotel: z.object({
    name: z.string(),
    tagline: z.string(),
    city: z.string(),
    phone: z.string(),
    email: z.string(),
    checkInTime: z.string(),
    checkOutTime: z.string(),
  }),
  roomTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      maxAdults: z.number().int(),
      maxOccupancy: z.number().int(),
      baseRate: z.number(),
    }),
  ),
  suggestedQuestions: z.array(z.string()),
});
export type HotelInfoResponse = z.infer<typeof HotelInfoResponseSchema>;
