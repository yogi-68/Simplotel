import { describe, expect, it } from 'vitest';
import { checkAvailability, roomsLeftOn } from '../../src/domain/availability/availability.service.js';
import { gstForNight, inventory, nightlyRate, seasonFor } from '../../src/domain/availability/pricing.js';
import { isAppError } from '../../src/lib/errors.js';

// A fixed "today" keeps every case independent of the real clock, so these
// assertions stay valid however long the repository sits on a shelf.
const TODAY = '2026-09-15';
const room = (id: string) => inventory.roomTypes.find((r) => r.id === id)!;

describe('pricing', () => {
  it('classifies seasons, including the window that wraps the new year', () => {
    expect(seasonFor('2026-12-25')).toBe('peak');
    expect(seasonFor('2027-01-02')).toBe('peak');
    expect(seasonFor('2026-08-10')).toBe('monsoon');
    expect(seasonFor('2026-10-15')).toBe('standard');
  });

  it('applies the weekend uplift on Friday and Saturday only', () => {
    // 2026-10-16 is a Friday, 2026-10-17 a Saturday, 2026-10-18 a Sunday.
    const base = room('garden-view-queen').baseRate;
    expect(nightlyRate(room('garden-view-queen'), '2026-10-16').rate).toBe(Math.round(base * 1.15));
    expect(nightlyRate(room('garden-view-queen'), '2026-10-17').rate).toBe(Math.round(base * 1.15));
    expect(nightlyRate(room('garden-view-queen'), '2026-10-18').rate).toBe(base);
  });

  it('compounds the peak multiplier with the weekend uplift', () => {
    const base = room('garden-view-queen').baseRate;
    // 2026-12-25 is a Friday inside peak season.
    expect(nightlyRate(room('garden-view-queen'), '2026-12-25').rate).toBe(Math.round(base * 1.5 * 1.15));
  });

  it('charges GST on the correct slab, per night rather than per booking', () => {
    expect(gstForNight(7500)).toBe(900); // 12% at the boundary
    expect(gstForNight(7501)).toBe(1350); // 18% just above it
    expect(gstForNight(5800)).toBe(696);
  });
});

describe('checkAvailability', () => {
  it('returns the same result for the same query, every time', () => {
    const query = { checkIn: '2026-12-12', checkOut: '2026-12-14', adults: 2, children: 0 };
    const first = checkAvailability(query, { today: TODAY });
    const second = checkAvailability(query, { today: TODAY });
    expect(first).toEqual(second);
  });

  it('computes totals that add up exactly', () => {
    const result = checkAvailability(
      { checkIn: '2026-10-19', checkOut: '2026-10-21', adults: 2, children: 0 },
      { today: TODAY },
    );
    expect(result.available).toBe(true);
    for (const option of result.options) {
      expect(option.nightly).toHaveLength(2);
      expect(option.subtotal).toBe(option.nightly.reduce((sum, n) => sum + n.rate, 0));
      expect(option.total).toBe(option.subtotal + option.taxes);
      expect(option.perNightAverage).toBe(Math.round(option.subtotal / 2));
    }
  });

  it('lists cheapest first so the common scan order works', () => {
    const result = checkAvailability(
      { checkIn: '2026-10-19', checkOut: '2026-10-21', adults: 2, children: 0 },
      { today: TODAY },
    );
    const totals = result.options.map((o) => o.total);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
  });

  it('excludes rooms that cannot hold the party, and says why', () => {
    const result = checkAvailability(
      { checkIn: '2026-10-19', checkOut: '2026-10-21', adults: 3, children: 0 },
      { today: TODAY },
    );

    // Only the Executive Twin and the Banyan Suite sleep three adults.
    for (const option of result.options) {
      expect(option.maxAdults).toBeGreaterThanOrEqual(3);
    }

    const queen = result.excluded.find((e) => e.roomTypeId === 'garden-view-queen');
    expect(queen?.reason).toBe('occupancy');
    expect(queen?.explanation).toContain('party of 3');
  });

  it('enforces the peak-season minimum stay', () => {
    const result = checkAvailability(
      { checkIn: '2026-12-24', checkOut: '2026-12-25', adults: 2, children: 0 },
      { today: TODAY },
    );
    expect(result.available).toBe(false);
    expect(result.excluded.every((e) => e.reason === 'min_stay')).toBe(true);
    expect(result.excluded[0]?.explanation).toContain('minimum of 2 nights');
  });

  it('flags peak dates in the guest-facing notes', () => {
    const result = checkAvailability(
      { checkIn: '2026-12-26', checkOut: '2026-12-28', adults: 2, children: 0 },
      { today: TODAY },
    );
    expect(result.notes.some((n) => n.includes('peak season'))).toBe(true);
    expect(result.options.every((o) => o.cancellationPolicy.includes('7 days'))).toBe(true);
  });

  it('treats a room as unavailable unless it is free on every night', () => {
    // Find a night this room type is sold out, then book across it.
    const target = room('banyan-suite');
    let soldOutNight: string | null = null;
    for (let day = 1; day < 120 && !soldOutNight; day += 1) {
      const date = new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10);
      if (roomsLeftOn(target, date) === 0) soldOutNight = date;
    }
    expect(soldOutNight).not.toBeNull();

    const checkIn = soldOutNight!;
    const checkOut = new Date(new Date(`${checkIn}T00:00:00Z`).getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const result = checkAvailability(
      { checkIn, checkOut, adults: 4, children: 0, roomTypeId: 'banyan-suite' },
      { today: TODAY },
    );
    expect(result.options.find((o) => o.roomTypeId === 'banyan-suite')).toBeUndefined();
    expect(result.excluded.find((e) => e.roomTypeId === 'banyan-suite')?.reason).toBe('sold_out');
  });

  it('rejects impossible stays at the domain boundary, not just at the route', () => {
    expect(() =>
      checkAvailability({ checkIn: '2026-12-14', checkOut: '2026-12-12', adults: 2, children: 0 }, { today: TODAY }),
    ).toThrowError(/at least one night/i);

    try {
      checkAvailability({ checkIn: '2020-01-01', checkOut: '2020-01-03', adults: 2, children: 0 }, { today: TODAY });
      expect.unreachable('a past date should be rejected');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('narrows to a single room type when one was asked for', () => {
    const result = checkAvailability(
      { checkIn: '2026-10-19', checkOut: '2026-10-21', adults: 2, children: 0, roomTypeId: 'deluxe-king' },
      { today: TODAY },
    );
    expect(result.options.every((o) => o.roomTypeId === 'deluxe-king')).toBe(true);
    expect(result.excluded.some((e) => e.reason === 'not_requested')).toBe(true);
  });

  it('always includes breakfast and tax notes so the total is never a surprise', () => {
    const result = checkAvailability(
      { checkIn: '2026-10-19', checkOut: '2026-10-21', adults: 2, children: 0 },
      { today: TODAY },
    );
    expect(result.notes.some((n) => /breakfast/i.test(n))).toBe(true);
    expect(result.notes.some((n) => /GST/.test(n))).toBe(true);
  });
});
