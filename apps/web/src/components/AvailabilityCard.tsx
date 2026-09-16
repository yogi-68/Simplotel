'use client';

import type { AvailabilityResult, RoomOption } from '@hotel/contracts';
import { useState } from 'react';
import { formatDateLong, formatInr } from '@/lib/format';

/**
 * Availability results.
 *
 * Everything rendered here comes from the structured payload the pricing engine
 * produced -- never from the assistant's prose. The model writes a sentence
 * around these cards; it does not write the numbers in them.
 *
 * Two deliberate choices:
 *
 *  - Rooms that were ruled out are shown, with the reason. A guest searching for
 *    three people who sees only two options assumes the hotel is small; a guest
 *    who sees "Deluxe King - sleeps 2 adults" understands the constraint and
 *    knows what to change.
 *  - The nightly breakdown is collapsible rather than hidden. Trust in a price
 *    comes from being able to check it, but most guests only want the total.
 */

export function AvailabilityCard({ availability }: { availability: AvailabilityResult }) {
  const { query, options, excluded, notes } = availability;

  return (
    <section
      className="mt-3 overflow-hidden rounded-2xl border"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
      aria-label="Room availability results"
    >
      <header
        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-4 py-3"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-muted)' }}
      >
        <div className="text-sm font-semibold">
          {formatDateLong(query.checkIn)} &rarr; {formatDateLong(query.checkOut)}
        </div>
        <div className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {query.nights} {query.nights === 1 ? 'night' : 'nights'} &middot; {query.adults}{' '}
          {query.adults === 1 ? 'adult' : 'adults'}
          {query.children > 0 ? ` · ${query.children} children` : ''}
        </div>
      </header>

      {options.length === 0 ? (
        <p className="px-4 py-5 text-sm" style={{ color: 'var(--color-ink-soft)' }}>
          Nothing is available for these dates and party size.
        </p>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
          {options.map((option) => (
            <RoomRow key={option.roomTypeId} option={option} nights={query.nights} />
          ))}
        </ul>
      )}

      {excluded.length > 0 && (
        <div
          className="border-t px-4 py-3"
          style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-muted)' }}
        >
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-ink-faint)' }}>
            Not shown
          </h4>
          <ul className="space-y-1">
            {excluded.map((room) => (
              <li key={room.roomTypeId} className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                <span className="font-medium">{room.name}</span> &mdash; {room.explanation}
              </li>
            ))}
          </ul>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="border-t px-4 py-3 text-xs" style={{ borderColor: 'var(--color-border)', color: 'var(--color-ink-faint)' }}>
          {notes.map((note) => (
            <li key={note} className="flex gap-1.5">
              <span aria-hidden="true">&middot;</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RoomRow({ option, nights }: { option: RoomOption; nights: number }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const scarce = option.roomsLeft > 0 && option.roomsLeft <= 3;

  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">{option.name}</h4>
            {scarce && (
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ backgroundColor: 'var(--color-accent-soft)', color: 'var(--color-accent)' }}
              >
                Only {option.roomsLeft} left
              </span>
            )}
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--color-ink-soft)' }}>
            {option.bedding} &middot; {option.sizeSqft} sq ft &middot; sleeps {option.maxAdults}{' '}
            {option.maxAdults === 1 ? 'adult' : 'adults'}
          </p>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {option.cancellationPolicy}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <div className="text-base font-semibold tabular-nums">{formatInr(option.total)}</div>
          <div className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
            total for {nights} {nights === 1 ? 'night' : 'nights'}
          </div>
          <button
            type="button"
            onClick={() => setShowBreakdown((open) => !open)}
            className="mt-1 text-[11px] font-medium underline underline-offset-2"
            style={{ color: 'var(--color-brand)' }}
            aria-expanded={showBreakdown}
          >
            {showBreakdown ? 'Hide breakdown' : 'See breakdown'}
          </button>
        </div>
      </div>

      {showBreakdown && (
        <div
          className="mt-3 rounded-xl px-3 py-2.5 text-xs"
          style={{ backgroundColor: 'var(--color-surface-muted)' }}
        >
          <table className="w-full">
            <caption className="sr-only">Nightly rate breakdown for {option.name}</caption>
            <tbody>
              {option.nightly.map((night) => (
                <tr key={night.date}>
                  <td className="py-0.5" style={{ color: 'var(--color-ink-soft)' }}>
                    {formatDateLong(night.date)}
                    {night.isWeekend && <span style={{ color: 'var(--color-ink-faint)' }}> &middot; weekend</span>}
                    {night.season !== 'standard' && (
                      <span style={{ color: 'var(--color-ink-faint)' }}> &middot; {night.season}</span>
                    )}
                  </td>
                  <td className="py-0.5 text-right tabular-nums">{formatInr(night.rate)}</td>
                </tr>
              ))}
              <tr>
                <td className="pt-1.5" style={{ color: 'var(--color-ink-soft)' }}>
                  Taxes (GST)
                </td>
                <td className="pt-1.5 text-right tabular-nums">{formatInr(option.taxes)}</td>
              </tr>
              <tr className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                <td className="pt-1.5 font-semibold">Total</td>
                <td className="pt-1.5 text-right font-semibold tabular-nums">{formatInr(option.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}
