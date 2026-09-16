import type {
  AvailabilityQuery,
  AvailabilityResult,
  ExcludedRoom,
  IsoDate,
  RoomOption,
} from '@hotel/contracts';
import { eachStayNight, formatFriendlyDate, nightsBetween, validateStayDates } from '../../lib/dates.js';
import { AppError } from '../../lib/errors.js';
import { inventory, priceStay, seasonFor, type RoomType } from './pricing.js';

/**
 * The mock property-management system.
 *
 * In production this would be an HTTP call to a channel manager or CRS. Here it
 * is a pure function of (roomType, date) via a seeded PRNG, which buys two
 * things a random mock cannot: the same search always returns the same result,
 * so screenshots, tests and the eval harness stay valid forever; and some dates
 * are genuinely sold out, so the sold-out path is exercised rather than theorised.
 */

/** 32-bit string hash (FNV-1a). Stable across platforms and Node versions. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 — small, fast, well-distributed seeded PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many rooms of a type remain on a given night. Deterministic. */
export function roomsLeftOn(room: RoomType, date: IsoDate): number {
  const random = mulberry32(hashString(`${room.id}|${date}`))();
  let soldFraction = 0.2 + random * 0.65;

  // Demand pressure that a guest would actually recognise.
  const season = seasonFor(date);
  if (season === 'peak') soldFraction += 0.15;
  if (season === 'monsoon') soldFraction -= 0.1;

  // Allow the fraction past 1 so genuine sell-outs occur instead of always
  // leaving a token room behind.
  const clamped = Math.min(soldFraction, 1.08);
  return Math.max(0, Math.floor(room.totalRooms * (1 - clamped)));
}

function occupancyExplanation(room: RoomType, adults: number, children: number): string | null {
  if (adults > room.maxAdults) {
    return `Sleeps up to ${room.maxAdults} adult${room.maxAdults === 1 ? '' : 's'}, so it cannot take a party of ${adults}.`;
  }
  if (adults + children > room.maxOccupancy) {
    return `Maximum occupancy is ${room.maxOccupancy} guests, and you are ${adults + children}.`;
  }
  return null;
}

function cancellationFor(nights: IsoDate[]): string {
  const touchesPeak = nights.some((n) => seasonFor(n) === 'peak');
  return touchesPeak ? inventory.policies.peakCancellation : inventory.policies.standardCancellation;
}

function buildNotes(nights: IsoDate[]): string[] {
  const notes = [
    'Buffet breakfast for all guests is included in every rate shown.',
    'Totals include GST, charged at 12% for nightly rates up to INR 7,500 and 18% above that.',
  ];
  if (nights.some((n) => seasonFor(n) === 'peak')) {
    notes.push('These dates fall in peak season (20 Dec - 5 Jan): rates are higher and a 2-night minimum applies.');
  }
  if (nights.every((n) => seasonFor(n) === 'monsoon')) {
    notes.push('Monsoon saver rates are applied to these dates.');
  }
  return notes;
}

/**
 * `checkAvailability(checkIn, checkOut, adults)` — the tool the assistant calls.
 *
 * Every number the guest ends up seeing is produced here, not by the model. The
 * LLM is handed this object and may only narrate it.
 */
export function checkAvailability(query: AvailabilityQuery, opts: { today?: IsoDate } = {}): AvailabilityResult {
  const children = query.children ?? 0;

  // Re-validate at the domain boundary. The route validates too, but the tool
  // path reaches this function with arguments invented by a language model, and
  // those are exactly the ones worth distrusting.
  const violations = validateStayDates(
    { checkIn: query.checkIn, checkOut: query.checkOut, adults: query.adults, children },
    {
      today: opts.today,
      maxNights: inventory.policies.maxNights,
      maxAdults: inventory.policies.maxAdults,
      maxChildren: inventory.policies.maxChildren,
      horizonDays: inventory.policies.bookingHorizonDays,
    },
  );
  if (violations.length > 0) {
    throw AppError.validation(violations[0]!.message, violations);
  }

  const nights = eachStayNight(query.checkIn, query.checkOut);
  const nightCount = nightsBetween(query.checkIn, query.checkOut);
  const peakMinNights = inventory.pricingRules.seasons.find((s) => s.id === 'peak')?.minNights ?? 1;
  const violatesMinStay = nights.some((n) => seasonFor(n) === 'peak') && nightCount < peakMinNights;

  const options: RoomOption[] = [];
  const excluded: ExcludedRoom[] = [];

  for (const room of inventory.roomTypes) {
    if (query.roomTypeId && room.id !== query.roomTypeId) {
      excluded.push({
        roomTypeId: room.id,
        name: room.name,
        reason: 'not_requested',
        explanation: 'Not included because you asked about a specific room type.',
      });
      continue;
    }

    if (violatesMinStay) {
      excluded.push({
        roomTypeId: room.id,
        name: room.name,
        reason: 'min_stay',
        explanation: `Peak-season stays need a minimum of ${peakMinNights} nights.`,
      });
      continue;
    }

    const occupancyIssue = occupancyExplanation(room, query.adults, children);
    if (occupancyIssue) {
      excluded.push({ roomTypeId: room.id, name: room.name, reason: 'occupancy', explanation: occupancyIssue });
      continue;
    }

    // A room is only bookable if the same room type is free on every night.
    let minRoomsLeft = Number.POSITIVE_INFINITY;
    let soldOutNight: IsoDate | null = null;
    for (const night of nights) {
      const left = roomsLeftOn(room, night);
      if (left < minRoomsLeft) minRoomsLeft = left;
      if (left === 0 && soldOutNight === null) soldOutNight = night;
    }

    if (soldOutNight !== null) {
      excluded.push({
        roomTypeId: room.id,
        name: room.name,
        reason: 'sold_out',
        explanation: `Fully booked on ${formatFriendlyDate(soldOutNight)}.`,
      });
      continue;
    }

    const pricing = priceStay(room, nights);
    options.push({
      roomTypeId: room.id,
      name: room.name,
      description: room.description,
      maxAdults: room.maxAdults,
      maxOccupancy: room.maxOccupancy,
      bedding: room.bedding,
      sizeSqft: room.sizeSqft,
      amenities: room.amenities,
      roomsLeft: minRoomsLeft,
      cancellationPolicy: cancellationFor(nights),
      ...pricing,
    });
  }

  // Cheapest first: the overwhelmingly common way a guest scans results.
  options.sort((a, b) => a.total - b.total);

  return {
    query: {
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      nights: nightCount,
      adults: query.adults,
      children,
    },
    available: options.length > 0,
    currency: 'INR',
    options,
    excluded,
    notes: buildNotes(nights),
  };
}

export function listRoomTypes(): RoomType[] {
  return inventory.roomTypes;
}
