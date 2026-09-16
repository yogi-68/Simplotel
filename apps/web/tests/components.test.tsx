import type { AvailabilityResult } from '@hotel/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AvailabilityCard } from '@/components/AvailabilityCard';
import { BookingForm } from '@/components/BookingForm';
import { MessageBubble } from '@/components/MessageBubble';
import { SourceChips } from '@/components/SourceChips';
import { TypingIndicator } from '@/components/TypingIndicator';
import type { ChatMessage } from '@/hooks/useChat';

const availability: AvailabilityResult = {
  query: { checkIn: '2026-12-15', checkOut: '2026-12-17', nights: 2, adults: 3, children: 0 },
  available: true,
  currency: 'INR',
  options: [
    {
      roomTypeId: 'executive-twin',
      name: 'Executive Twin',
      description: 'Two double beds.',
      maxAdults: 3,
      maxOccupancy: 4,
      bedding: '2 double beds',
      sizeSqft: 400,
      amenities: ['Work desk'],
      roomsLeft: 1,
      nightly: [
        { date: '2026-12-15', rate: 8900, isWeekend: false, season: 'standard' },
        { date: '2026-12-16', rate: 8900, isWeekend: false, season: 'standard' },
      ],
      subtotal: 17800,
      taxes: 3204,
      total: 21004,
      perNightAverage: 8900,
      cancellationPolicy: 'Free cancellation until 48 hours before 2:00 PM on the check-in date.',
    },
  ],
  excluded: [
    {
      roomTypeId: 'garden-view-queen',
      name: 'Garden View Queen',
      reason: 'occupancy',
      explanation: 'Sleeps up to 2 adults, so it cannot take a party of 3.',
    },
  ],
  notes: ['Buffet breakfast for all guests is included in every rate shown.'],
};

const assistantMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  text: 'Check-in starts at 2:00 PM.',
  reply: { text: 'Check-in starts at 2:00 PM.', type: 'answer', confidence: 0.9 },
  sources: [],
  availability: null,
  needs: [],
  suggestions: [],
  ...overrides,
});

describe('AvailabilityCard', () => {
  it('shows the engine-computed total and stay summary', () => {
    render(<AvailabilityCard availability={availability} />);

    expect(screen.getByText('₹21,004')).toBeInTheDocument();
    expect(screen.getByText('Executive Twin')).toBeInTheDocument();
    // The header states the stay it is quoting for, so a stale result is obvious.
    expect(screen.getByText(/Tue, 15 Dec 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Thu, 17 Dec 2026/)).toBeInTheDocument();
  });

  it('warns when a room is nearly gone', () => {
    render(<AvailabilityCard availability={availability} />);
    expect(screen.getByText('Only 1 left')).toBeInTheDocument();
  });

  it('explains which rooms were ruled out and why', () => {
    // A guest who sees only one option assumes the hotel is tiny; showing the
    // rejected room with its reason tells them what to change instead.
    render(<AvailabilityCard availability={availability} />);

    expect(screen.getByText('Not shown')).toBeInTheDocument();
    expect(screen.getByText(/Sleeps up to 2 adults/)).toBeInTheDocument();
  });

  it('reveals a nightly breakdown that adds up to the total', async () => {
    const user = userEvent.setup();
    render(<AvailabilityCard availability={availability} />);

    expect(screen.queryByText('Taxes (GST)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see breakdown/i }));

    expect(screen.getByText('Taxes (GST)')).toBeInTheDocument();
    expect(screen.getByText('₹3,204')).toBeInTheDocument();
    expect(screen.getAllByText('₹8,900')).toHaveLength(2);
  });

  it('says so plainly when nothing is available', () => {
    render(<AvailabilityCard availability={{ ...availability, available: false, options: [] }} />);
    expect(screen.getByText(/Nothing is available/i)).toBeInTheDocument();
  });
});

describe('SourceChips', () => {
  it('expands a chip to show the exact fact behind the answer', async () => {
    const user = userEvent.setup();
    render(<SourceChips sources={[{ id: 'F26', label: 'Policies / Check-in time', text: 'Check-in starts at 2:00 PM.' }]} />);

    const chip = screen.getByRole('button', { name: /Policies \/ Check-in time/ });
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Check-in starts at 2:00 PM.')).toBeInTheDocument();
  });
});

describe('MessageBubble', () => {
  it('marks a refusal so it cannot be mistaken for an answer', () => {
    render(
      <MessageBubble
        message={assistantMessage({
          text: 'I do not have that information.',
          reply: { text: 'I do not have that information.', type: 'fallback', confidence: 0.2 },
        })}
      />,
    );

    expect(screen.getByText('Not in our records')).toBeInTheDocument();
  });

  it('does not badge an ordinary answer', () => {
    render(<MessageBubble message={assistantMessage()} />);
    expect(screen.queryByText('Not in our records')).not.toBeInTheDocument();
    expect(screen.getByText('Check-in starts at 2:00 PM.')).toBeInTheDocument();
  });

  it('tells the guest when the answer bypassed the model', () => {
    render(
      <MessageBubble
        message={assistantMessage({
          meta: { provider: 'mock', model: 'm', latencyMs: 1, toolCalls: [], grounded: true, degraded: true },
        })}
      />,
    );

    expect(screen.getByText(/directly from our records/i)).toBeInTheDocument();
  });

  it('renders an error turn with its message', () => {
    render(
      <MessageBubble
        message={{
          id: 'e1',
          role: 'assistant',
          text: 'I cannot reach the hotel right now.',
          error: { message: 'I cannot reach the hotel right now.', code: 'NETWORK_ERROR', retryable: true },
        }}
      />,
    );

    expect(screen.getByText(/cannot reach the hotel/i)).toBeInTheDocument();
  });

  it('reveals animated text progressively but still ends with the full reply', async () => {
    render(<MessageBubble message={assistantMessage({ animate: true })} onFinishedAnimating={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Check-in starts at 2:00 PM.')).toBeInTheDocument(), {
      timeout: 4000,
    });
  });
});

describe('TypingIndicator', () => {
  it('announces progress to assistive technology', () => {
    render(<TypingIndicator />);
    expect(screen.getByLabelText(/Thinking/i)).toBeInTheDocument();
  });
});

describe('BookingForm', () => {
  const emptySlots = { checkIn: null, checkOut: null, adults: null, children: null };

  it('cannot be submitted without dates', () => {
    render(<BookingForm slots={emptySlots} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /check availability/i })).toBeDisabled();
  });

  it('pre-fills from details already known in the conversation', () => {
    render(
      <BookingForm
        slots={{ checkIn: '2026-12-15', checkOut: '2026-12-17', adults: 3, children: 0 }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/check-in/i)).toHaveValue('2026-12-15');
    expect(screen.getByText('2 nights · Tue, 15 Dec 2026 to Thu, 17 Dec 2026')).toBeInTheDocument();
  });

  it('submits the structured values the backend trusts', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <BookingForm
        slots={{ checkIn: '2026-12-15', checkOut: '2026-12-17', adults: 2, children: 0 }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: /increase adults/i }));
    await user.click(screen.getByRole('button', { name: /check availability/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      checkIn: '2026-12-15',
      checkOut: '2026-12-17',
      adults: 3,
      children: 0,
    });
  });

  it('will not let the party exceed what a single booking allows', async () => {
    const user = userEvent.setup();
    render(<BookingForm slots={{ ...emptySlots, adults: 8 }} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /increase adults/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /decrease adults/i }));
    expect(screen.getByRole('button', { name: /increase adults/i })).toBeEnabled();
  });

  it('repairs a check-out that would land before check-in', async () => {
    // Prevented in the UI rather than validated after the fact.
    render(
      <BookingForm slots={{ checkIn: '2026-12-20', checkOut: '2026-12-18', adults: 2, children: 0 }} onSubmit={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByLabelText(/check-out/i)).toHaveValue('2026-12-21'));
  });

  it('highlights the fields the assistant actually asked for', () => {
    render(<BookingForm slots={emptySlots} needs={['checkIn']} onSubmit={vi.fn()} />);
    const checkInLabel = screen.getByText(/check-in/i, { selector: 'label' });
    expect(checkInLabel.textContent).toMatch(/needed/i);
  });
});
