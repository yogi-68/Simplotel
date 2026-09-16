'use client';

import type { SlotName, Slots } from '@hotel/contracts';
import { useEffect, useMemo, useState } from 'react';
import { addDaysToInputValue, formatDateLong, nightsBetween, todayInputValue } from '@/lib/format';

/**
 * Structured capture of check-in, check-out and party size.
 *
 * This exists because natural language is the wrong input for a date. "Next
 * Friday" has to be interpreted, and interpretation can be wrong in a way the
 * guest will not notice until they arrive. A date picker cannot be misread.
 *
 * It appears in two places: inline in the thread when the assistant says it
 * needs details, and from the header button when the guest decides to check
 * without being asked. Both paths submit the same structured context, so the
 * reliable route is always one tap away rather than hidden behind phrasing.
 *
 * Validation here is duplicated from the server on purpose: the client version
 * exists to give immediate feedback, the server version exists because the
 * client cannot be trusted. Neither replaces the other.
 */

export interface BookingFormValues {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
}

interface Props {
  slots: Slots;
  /** Fields the assistant asked for, highlighted so the guest knows what to fill. */
  needs?: SlotName[];
  submitLabel?: string;
  busy?: boolean;
  onSubmit: (values: BookingFormValues) => void;
  onCancel?: () => void;
}

export function BookingForm({ slots, needs = [], submitLabel = 'Check availability', busy, onSubmit, onCancel }: Props) {
  const today = useMemo(() => todayInputValue(), []);

  const [checkIn, setCheckIn] = useState(slots.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(slots.checkOut ?? '');
  const [adults, setAdults] = useState(slots.adults ?? 2);
  const [children, setChildren] = useState(slots.children ?? 0);

  // Keep the form in step with details the guest gave in conversation.
  useEffect(() => {
    if (slots.checkIn) setCheckIn(slots.checkIn);
    if (slots.checkOut) setCheckOut(slots.checkOut);
    if (slots.adults !== null) setAdults(slots.adults);
    if (slots.children !== null) setChildren(slots.children);
  }, [slots.checkIn, slots.checkOut, slots.adults, slots.children]);

  // Picking an arrival that lands on or after the departure is a mistake the UI
  // can simply prevent, rather than validate after the fact.
  useEffect(() => {
    if (checkIn && checkOut && checkOut <= checkIn) {
      setCheckOut(addDaysToInputValue(checkIn, 1));
    }
  }, [checkIn, checkOut]);

  const nights = checkIn && checkOut && checkOut > checkIn ? nightsBetween(checkIn, checkOut) : 0;
  const error =
    !checkIn || !checkOut
      ? null
      : checkOut <= checkIn
        ? 'Check-out must be after check-in.'
        : nights > 30
          ? 'For stays longer than 30 nights, please contact the front desk.'
          : null;

  const complete = Boolean(checkIn && checkOut) && !error;

  return (
    <form
      className="card mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!complete || busy) return;
        onSubmit({ checkIn, checkOut, adults, children });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="check-in">
            Check-in {needs.includes('checkIn') && <span style={{ color: 'var(--color-accent)' }}>&bull; needed</span>}
          </label>
          <input
            id="check-in"
            type="date"
            className="field-input"
            value={checkIn}
            min={today}
            onChange={(event) => setCheckIn(event.target.value)}
            required
          />
        </div>

        <div>
          <label className="field-label" htmlFor="check-out">
            Check-out {needs.includes('checkOut') && <span style={{ color: 'var(--color-accent)' }}>&bull; needed</span>}
          </label>
          <input
            id="check-out"
            type="date"
            className="field-input"
            value={checkOut}
            min={checkIn ? addDaysToInputValue(checkIn, 1) : today}
            onChange={(event) => setCheckOut(event.target.value)}
            required
          />
        </div>

        <Stepper
          id="adults"
          label="Adults"
          highlighted={needs.includes('adults')}
          value={adults}
          min={1}
          max={8}
          onChange={setAdults}
        />
        <Stepper id="children" label="Children (under 12)" value={children} min={0} max={6} onChange={setChildren} />
      </div>

      {error ? (
        <p className="mt-3 text-xs font-medium" style={{ color: 'var(--color-danger)' }} role="alert">
          {error}
        </p>
      ) : nights > 0 ? (
        <p className="mt-3 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {nights} {nights === 1 ? 'night' : 'nights'} &middot; {formatDateLong(checkIn)} to {formatDateLong(checkOut)}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={!complete || busy}>
          {busy ? 'Checking…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Stepper({
  id,
  label,
  value,
  min,
  max,
  highlighted,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  highlighted?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label} {highlighted && <span style={{ color: 'var(--color-accent)' }}>&bull; needed</span>}
      </label>
      <div
        className="flex items-center justify-between rounded-xl border px-2 py-1.5"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
      >
        <button
          type="button"
          className="h-8 w-8 rounded-lg text-lg leading-none disabled:opacity-30"
          style={{ backgroundColor: 'var(--color-surface-muted)' }}
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          aria-label={`Decrease ${label}`}
        >
          &minus;
        </button>
        {/* The live region announces the new count to screen readers, which a
            plain disabled-button pair would not. */}
        <output id={id} className="text-sm font-semibold tabular-nums" aria-live="polite">
          {value}
        </output>
        <button
          type="button"
          className="h-8 w-8 rounded-lg text-lg leading-none disabled:opacity-30"
          style={{ backgroundColor: 'var(--color-surface-muted)' }}
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}
