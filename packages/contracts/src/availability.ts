import { z } from 'zod';
import { IsoDateSchema } from './common.js';

/** Guest-supplied stay parameters. Shared by the chat tool and POST /api/availability. */
export const AvailabilityQuerySchema = z.object({
  checkIn: IsoDateSchema,
  checkOut: IsoDateSchema,
  adults: z.number().int().min(1).max(8),
  children: z.number().int().min(0).max(6).default(0),
  /** Optional narrowing when the guest already named a room. */
  roomTypeId: z.string().min(1).optional(),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

export const SeasonSchema = z.enum(['peak', 'monsoon', 'standard']);
export type Season = z.infer<typeof SeasonSchema>;

/** One night's computed rate — this is what makes the total auditable. */
export const NightlyRateSchema = z.object({
  date: IsoDateSchema,
  /** Pre-tax rate for this night, in minor-unit-free INR (whole rupees). */
  rate: z.number().nonnegative(),
  isWeekend: z.boolean(),
  season: SeasonSchema,
});
export type NightlyRate = z.infer<typeof NightlyRateSchema>;

export const RoomOptionSchema = z.object({
  roomTypeId: z.string(),
  name: z.string(),
  description: z.string(),
  maxAdults: z.number().int(),
  maxOccupancy: z.number().int(),
  bedding: z.string(),
  sizeSqft: z.number().int(),
  amenities: z.array(z.string()),
  /** Drives the "only 2 left" urgency cue in the UI. */
  roomsLeft: z.number().int().nonnegative(),
  nightly: z.array(NightlyRateSchema),
  subtotal: z.number().nonnegative(),
  taxes: z.number().nonnegative(),
  total: z.number().nonnegative(),
  perNightAverage: z.number().nonnegative(),
  cancellationPolicy: z.string(),
});
export type RoomOption = z.infer<typeof RoomOptionSchema>;

/**
 * Why a room was excluded. We return these rather than silently dropping rooms:
 * a guest searching for 3 people needs to know the Deluxe King *exists* and was
 * ruled out on occupancy, otherwise the result looks like a thin inventory.
 */
export const ExclusionReasonSchema = z.enum([
  'sold_out',
  'occupancy',
  'min_stay',
  'not_requested',
]);
export type ExclusionReason = z.infer<typeof ExclusionReasonSchema>;

export const ExcludedRoomSchema = z.object({
  roomTypeId: z.string(),
  name: z.string(),
  reason: ExclusionReasonSchema,
  /** Human-readable, safe to render verbatim. */
  explanation: z.string(),
});
export type ExcludedRoom = z.infer<typeof ExcludedRoomSchema>;

export const AvailabilityResultSchema = z.object({
  query: z.object({
    checkIn: IsoDateSchema,
    checkOut: IsoDateSchema,
    nights: z.number().int().positive(),
    adults: z.number().int(),
    children: z.number().int(),
  }),
  available: z.boolean(),
  currency: z.literal('INR'),
  options: z.array(RoomOptionSchema),
  excluded: z.array(ExcludedRoomSchema),
  notes: z.array(z.string()),
});
export type AvailabilityResult = z.infer<typeof AvailabilityResultSchema>;

export const AvailabilityResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  availability: AvailabilityResultSchema,
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;
