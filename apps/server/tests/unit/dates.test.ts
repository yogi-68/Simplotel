import { describe, expect, it } from 'vitest';
import {
  addDays,
  eachStayNight,
  isWithinMonthDayRange,
  nightsBetween,
  validateStayDates,
} from '../../src/lib/dates.js';

describe('date maths', () => {
  it('counts nights, not days, between check-in and check-out', () => {
    expect(nightsBetween('2026-12-12', '2026-12-14')).toBe(2);
    expect(nightsBetween('2026-12-12', '2026-12-13')).toBe(1);
  });

  it('treats the check-out day as not a night', () => {
    expect(eachStayNight('2026-12-12', '2026-12-14')).toEqual(['2026-12-12', '2026-12-13']);
  });

  it('crosses month and year boundaries correctly', () => {
    expect(nightsBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    // 2028 is a leap year, so February has a 29th.
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('matches season windows that wrap the new year', () => {
    // Peak runs 20 Dec to 5 Jan, which a naive string comparison gets wrong.
    expect(isWithinMonthDayRange('12-25', '12-20', '01-05')).toBe(true);
    expect(isWithinMonthDayRange('01-03', '12-20', '01-05')).toBe(true);
    expect(isWithinMonthDayRange('06-15', '12-20', '01-05')).toBe(false);
  });
});

describe('stay rule validation', () => {
  const today = '2026-09-15';

  it('accepts a normal stay', () => {
    expect(validateStayDates({ checkIn: '2026-12-12', checkOut: '2026-12-14', adults: 2 }, { today })).toEqual([]);
  });

  it('rejects a check-in in the past', () => {
    const violations = validateStayDates({ checkIn: '2026-09-14', checkOut: '2026-09-16', adults: 2 }, { today });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('checkIn');
    expect(violations[0]?.message).toContain('cannot be in the past');
  });

  it('rejects a check-out on or before check-in', () => {
    const same = validateStayDates({ checkIn: '2026-12-12', checkOut: '2026-12-12', adults: 2 }, { today });
    expect(same[0]?.path).toBe('checkOut');

    const reversed = validateStayDates({ checkIn: '2026-12-14', checkOut: '2026-12-12', adults: 2 }, { today });
    expect(reversed[0]?.path).toBe('checkOut');
  });

  it('rejects stays beyond the maximum length', () => {
    const violations = validateStayDates({ checkIn: '2026-10-01', checkOut: '2026-11-15', adults: 2 }, { today });
    expect(violations.some((v) => v.message.includes('30 nights'))).toBe(true);
  });

  it('routes oversized parties to the front desk instead of failing silently', () => {
    const violations = validateStayDates({ checkIn: '2026-12-12', checkOut: '2026-12-14', adults: 12 }, { today });
    expect(violations[0]?.path).toBe('adults');
    expect(violations[0]?.message).toContain('group booking');
  });

  it('reports every broken rule at once, not just the first', () => {
    const violations = validateStayDates({ checkIn: '2026-01-01', checkOut: '2025-12-30', adults: 0 }, { today });
    expect(violations.map((v) => v.path).sort()).toEqual(['adults', 'checkIn', 'checkOut']);
  });
});
