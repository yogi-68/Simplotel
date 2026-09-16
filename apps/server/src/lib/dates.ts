import type { IsoDate } from '@hotel/contracts';

/**
 * Date helpers, all UTC-based and all pure.
 *
 * Why UTC: a stay is a pair of calendar dates, not instants. Doing the maths in
 * local time makes the number of nights depend on the server timezone and on
 * daylight-saving boundaries. We treat every date as midnight UTC so
 * `2026-12-12 -> 2026-12-14` is always exactly 2 nights, everywhere.
 */

export const MS_PER_DAY = 86_400_000;

export function toUtcDate(iso: IsoDate): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Today as a calendar date in UTC. Injectable so tests are not time-dependent. */
export function todayIso(now: Date = new Date()): IsoDate {
  return toIso(now);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return toIso(new Date(toUtcDate(iso).getTime() + days * MS_PER_DAY));
}

/** Nights between two dates. Check-out day is not a night. */
export function nightsBetween(checkIn: IsoDate, checkOut: IsoDate): number {
  return Math.round((toUtcDate(checkOut).getTime() - toUtcDate(checkIn).getTime()) / MS_PER_DAY);
}

/** Every date the guest actually sleeps at the hotel: [checkIn, checkOut). */
export function eachStayNight(checkIn: IsoDate, checkOut: IsoDate): IsoDate[] {
  const nights: IsoDate[] = [];
  const total = nightsBetween(checkIn, checkOut);
  for (let i = 0; i < total; i += 1) nights.push(addDays(checkIn, i));
  return nights;
}

/** 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(iso: IsoDate): number {
  return toUtcDate(iso).getUTCDay();
}

/** `MM-DD` — used to match season windows without caring about the year. */
export function monthDay(iso: IsoDate): string {
  return iso.slice(5);
}

/**
 * Does `MM-DD` fall inside a window? Handles windows that wrap the new year
 * (for example 12-20 to 01-05), which a naive string comparison gets wrong.
 */
export function isWithinMonthDayRange(target: string, from: string, to: string): boolean {
  if (from <= to) return target >= from && target <= to;
  return target >= from || target <= to;
}

export type DateRuleViolation = { path: string; message: string };

/**
 * The deterministic business rules for a stay request.
 *
 * This is intentionally NOT in the LLM. The model is good at pulling
 * "next Friday for two nights" out of a sentence; it is not a reliable place to
 * enforce that check-out must come after check-in. Extraction is AI, validation
 * is code — and the guest-facing wording lives here so every path (chat, tool
 * call, REST form) reports the same rule the same way.
 */
export function validateStayDates(
  input: { checkIn: IsoDate; checkOut: IsoDate; adults: number; children?: number },
  opts: { today?: IsoDate; maxNights?: number; maxAdults?: number; maxChildren?: number; horizonDays?: number } = {},
): DateRuleViolation[] {
  const today = opts.today ?? todayIso();
  const maxNights = opts.maxNights ?? 30;
  const maxAdults = opts.maxAdults ?? 8;
  const maxChildren = opts.maxChildren ?? 6;
  const horizonDays = opts.horizonDays ?? 540;

  const violations: DateRuleViolation[] = [];

  if (input.checkIn < today) {
    violations.push({
      path: 'checkIn',
      message: `Check-in cannot be in the past. The earliest date you can book is ${today}.`,
    });
  }

  if (input.checkOut <= input.checkIn) {
    violations.push({
      path: 'checkOut',
      message: 'Check-out must be at least one night after check-in.',
    });
  } else {
    const nights = nightsBetween(input.checkIn, input.checkOut);
    if (nights > maxNights) {
      violations.push({
        path: 'checkOut',
        message: `Stays longer than ${maxNights} nights need to be arranged with the front desk.`,
      });
    }
  }

  if (nightsBetween(today, input.checkIn) > horizonDays) {
    violations.push({
      path: 'checkIn',
      message: `We only take bookings up to ${Math.floor(horizonDays / 30)} months ahead.`,
    });
  }

  if (!Number.isInteger(input.adults) || input.adults < 1) {
    violations.push({ path: 'adults', message: 'At least one adult is needed to make a booking.' });
  } else if (input.adults > maxAdults) {
    violations.push({
      path: 'adults',
      message: `For more than ${maxAdults} adults please contact the front desk about a group booking.`,
    });
  }

  const children = input.children ?? 0;
  if (!Number.isInteger(children) || children < 0 || children > maxChildren) {
    violations.push({ path: 'children', message: `Number of children must be between 0 and ${maxChildren}.` });
  }

  return violations;
}

/** Human-friendly rendering for prose the assistant reads back to the guest. */
export function formatFriendlyDate(iso: IsoDate): string {
  return toUtcDate(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
