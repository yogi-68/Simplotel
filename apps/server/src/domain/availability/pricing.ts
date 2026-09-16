import type { IsoDate, NightlyRate, Season } from '@hotel/contracts';
import { dayOfWeek, isWithinMonthDayRange, monthDay } from '../../lib/dates.js';
import rawInventory from './inventory.json' with { type: 'json' };

export interface RoomType {
  id: string;
  name: string;
  description: string;
  bedding: string;
  sizeSqft: number;
  maxAdults: number;
  maxOccupancy: number;
  baseRate: number;
  totalRooms: number;
  amenities: string[];
}

interface SeasonRule {
  id: string;
  label: string;
  multiplier: number;
  minNights: number;
  ranges: Array<{ from: string; to: string }>;
}

interface Inventory {
  currency: 'INR';
  roomTypes: RoomType[];
  pricingRules: {
    weekendUpliftPct: number;
    weekendDays: number[];
    seasons: SeasonRule[];
    gstTiers: Array<{ upToNightlyRate: number | null; ratePct: number }>;
  };
  policies: {
    standardCancellation: string;
    peakCancellation: string;
    maxNights: number;
    maxAdults: number;
    maxChildren: number;
    bookingHorizonDays: number;
  };
}

export const inventory = rawInventory as Inventory;

export function seasonFor(date: IsoDate): Season {
  const md = monthDay(date);
  for (const season of inventory.pricingRules.seasons) {
    for (const range of season.ranges) {
      if (isWithinMonthDayRange(md, range.from, range.to)) return season.id as Season;
    }
  }
  return 'standard';
}

export function seasonRule(season: Season): SeasonRule | undefined {
  return inventory.pricingRules.seasons.find((s) => s.id === season);
}

export function isWeekendNight(date: IsoDate): boolean {
  return inventory.pricingRules.weekendDays.includes(dayOfWeek(date));
}

/**
 * The nightly rate for one room on one date.
 *
 * Deliberately a pure function of (room, date): no randomness, no clock. The
 * same query quoted twice returns the same price, which is what makes the demo
 * reproducible and the pricing tests meaningful.
 */
export function nightlyRate(room: RoomType, date: IsoDate): NightlyRate {
  const season = seasonFor(date);
  const multiplier = seasonRule(season)?.multiplier ?? 1;
  const weekend = isWeekendNight(date);
  const weekendFactor = weekend ? 1 + inventory.pricingRules.weekendUpliftPct / 100 : 1;

  // Round to whole rupees so displayed totals always add up exactly.
  const rate = Math.round(room.baseRate * multiplier * weekendFactor);
  return { date, rate, isWeekend: weekend, season };
}

/**
 * Indian GST on hotel rooms is slab-based on the per-night tariff, not on the
 * booking total, so tax is computed night by night and then summed.
 */
export function gstForNight(rate: number): number {
  const tiers = inventory.pricingRules.gstTiers;
  for (const tier of tiers) {
    if (tier.upToNightlyRate === null || rate <= tier.upToNightlyRate) {
      return Math.round((rate * tier.ratePct) / 100);
    }
  }
  return 0;
}

export function priceStay(room: RoomType, nights: IsoDate[]): {
  nightly: NightlyRate[];
  subtotal: number;
  taxes: number;
  total: number;
  perNightAverage: number;
} {
  const nightly = nights.map((date) => nightlyRate(room, date));
  const subtotal = nightly.reduce((sum, n) => sum + n.rate, 0);
  const taxes = nightly.reduce((sum, n) => sum + gstForNight(n.rate), 0);
  const total = subtotal + taxes;
  return {
    nightly,
    subtotal,
    taxes,
    total,
    perNightAverage: nightly.length > 0 ? Math.round(subtotal / nightly.length) : 0,
  };
}
