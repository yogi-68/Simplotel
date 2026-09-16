import type { ChatRequest, SlotName, Slots } from '@hotel/contracts';
import { IsoDateSchema } from '@hotel/contracts';

/**
 * Slot filling for a stay request.
 *
 * The three facts needed to quote a room — arrival, departure, party size —
 * accumulate across turns. A guest typically gives them in pieces ("do you have
 * anything next weekend?" ... "three of us"), so the assistant has to remember
 * what it already knows rather than re-interrogating on every message.
 *
 * Precedence is the interesting decision: structured UI input beats anything
 * extracted from language. When the guest picks dates in the booking form we
 * take those verbatim, because a date picker cannot be misread the way "next
 * Friday" can.
 */

export function emptySlots(): Slots {
  return { checkIn: null, checkOut: null, adults: null, children: null };
}

function validDate(value: unknown): string | null {
  const parsed = IsoDateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validCount(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

/**
 * Layer new information over what we already knew. Later arguments win, but a
 * null or invalid value never erases a good one — a malformed tool argument
 * should not wipe a date the guest already confirmed.
 */
export function mergeSlots(...layers: Array<Partial<Slots> | undefined>): Slots {
  const merged = emptySlots();
  for (const layer of layers) {
    if (!layer) continue;
    const checkIn = validDate(layer.checkIn);
    const checkOut = validDate(layer.checkOut);
    const adults = validCount(layer.adults, 1, 8);
    const children = validCount(layer.children, 0, 6);
    if (checkIn) merged.checkIn = checkIn;
    if (checkOut) merged.checkOut = checkOut;
    if (adults !== null) merged.adults = adults;
    if (children !== null) merged.children = children;
  }
  return merged;
}

/** Structured context from the UI booking form, normalised into slot shape. */
export function slotsFromRequestContext(context: ChatRequest['context']): Partial<Slots> | undefined {
  if (!context) return undefined;
  return {
    checkIn: context.checkIn ?? null,
    checkOut: context.checkOut ?? null,
    adults: context.adults ?? null,
    children: context.children ?? null,
  };
}

/** Tool arguments produced by the model, treated as untrusted input. */
export function slotsFromToolArguments(args: Record<string, unknown>): Partial<Slots> {
  return {
    checkIn: validDate(args.checkIn),
    checkOut: validDate(args.checkOut),
    adults: validCount(args.adults, 1, 8),
    children: validCount(args.children, 0, 6),
  };
}

export function missingSlots(slots: Slots): SlotName[] {
  const missing: SlotName[] = [];
  if (!slots.checkIn) missing.push('checkIn');
  if (!slots.checkOut) missing.push('checkOut');
  if (slots.adults === null) missing.push('adults');
  return missing;
}

export function hasCompleteStay(slots: Slots): boolean {
  return missingSlots(slots).length === 0;
}
