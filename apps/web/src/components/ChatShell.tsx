'use client';

import type { HotelInfoResponse } from '@hotel/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookingForm, type BookingFormValues } from '@/components/BookingForm';
import { MessageBubble } from '@/components/MessageBubble';
import { TypingIndicator } from '@/components/TypingIndicator';
import { useChat } from '@/hooks/useChat';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

/**
 * The whole guest experience: one column, one conversation.
 *
 * The layout is a fixed header, a scrolling thread and a pinned composer. No
 * routing, no modal stack, nothing to navigate. A guest with a question should
 * only ever have to do one thing, which is type it.
 */
export function ChatShell() {
  const { messages, status, slots, degraded, connectionError, canRetry, send, retry, reset, stopAnimation } = useChat();
  const [input, setInput] = useState('');
  const [hotel, setHotel] = useState<HotelInfoResponse | null>(null);
  const [showBookingForm, setShowBookingForm] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  const threadContentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const { scrollToBottom } = useStickToBottom(threadRef, threadContentRef);

  const busy = status === 'sending';
  const lastMessage = messages[messages.length - 1];
  const assistantWantsDetails = lastMessage?.role === 'assistant' && (lastMessage.needs?.length ?? 0) > 0;

  // Bootstrap the hotel identity from the API. Nothing about this property is
  // hardcoded in the frontend, so swapping the knowledge base re-labels the UI.
  useEffect(() => {
    const controller = new AbortController();
    api
      .hotel(controller.signal)
      .then(setHotel)
      .catch(() => {
        // A failure here is not fatal: the chat still works, the header just
        // falls back to neutral copy. The connection banner covers the rest.
      });
    return () => controller.abort();
  }, []);

  // A new turn re-arms sticking, in case the guest had scrolled up to re-read
  // something. Growth after this point is handled by useStickToBottom.
  useEffect(() => {
    scrollToBottom();
    // scrollToBottom is stable for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const submit = useCallback(
    (text: string, context?: BookingFormValues) => {
      setInput('');
      setShowBookingForm(false);
      void send(text, context);
      composerRef.current?.focus();
    },
    [send],
  );

  const submitBooking = useCallback(
    (values: BookingFormValues) => {
      // The form sends a natural sentence *and* the structured context. The
      // sentence keeps the thread readable; the structured values are what the
      // backend actually trusts.
      const guests = `${values.adults} ${values.adults === 1 ? 'adult' : 'adults'}${
        values.children > 0 ? ` and ${values.children} ${values.children === 1 ? 'child' : 'children'}` : ''
      }`;
      submit(`Check availability from ${formatDate(values.checkIn)} to ${formatDate(values.checkOut)} for ${guests}.`, values);
    },
    [submit],
  );

  const suggestions =
    messages.length === 0
      ? (hotel?.suggestedQuestions ?? [])
      : (lastMessage?.role === 'assistant' ? (lastMessage.suggestions ?? []) : []);

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col">
      <Header
        hotel={hotel}
        degraded={degraded}
        hasConversation={messages.length > 0}
        onNewConversation={() => {
          reset();
          setShowBookingForm(false);
        }}
        onCheckAvailability={() => setShowBookingForm((open) => !open)}
        bookingFormOpen={showBookingForm}
      />

      {connectionError && (
        <div
          role="alert"
          className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
          style={{
            borderColor: 'var(--color-danger)',
            backgroundColor: 'var(--color-danger-soft)',
            color: 'var(--color-danger)',
          }}
        >
          <span>{connectionError}</span>
          {canRetry && (
            <button type="button" onClick={retry} className="font-semibold underline underline-offset-2">
              Retry
            </button>
          )}
        </div>
      )}

      <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-5" role="log" aria-live="polite" aria-label="Conversation">
        {/* The inner wrapper is what ResizeObserver watches: the scroll
            container itself never changes size, only its contents do. */}
        <div ref={threadContentRef} className="space-y-4">
        {messages.length === 0 && <Welcome hotel={hotel} />}

        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} onFinishedAnimating={stopAnimation}>
            {/* The assistant asked for dates, so put the right control in the
                thread rather than making the guest find it. */}
            {message.id === lastMessage?.id && assistantWantsDetails && !busy && (
              <BookingForm slots={slots} needs={message.needs} busy={busy} onSubmit={submitBooking} />
            )}

            {message.error?.retryable && message.id === lastMessage?.id && (
              <button type="button" onClick={retry} className="btn btn-ghost mt-2 !py-1.5 !text-xs">
                Try again
              </button>
            )}
          </MessageBubble>
        ))}

        {busy && <TypingIndicator />}

        {showBookingForm && !assistantWantsDetails && (
          <BookingForm
            slots={slots}
            busy={busy}
            onSubmit={submitBooking}
            onCancel={() => setShowBookingForm(false)}
          />
        )}
        </div>
      </div>

      <Composer
        ref={composerRef}
        value={input}
        busy={busy}
        suggestions={suggestions}
        onChange={setInput}
        onSubmit={() => submit(input)}
        onSuggestion={(text) => submit(text)}
      />
    </div>
  );
}

function Header({
  hotel,
  degraded,
  hasConversation,
  bookingFormOpen,
  onNewConversation,
  onCheckAvailability,
}: {
  hotel: HotelInfoResponse | null;
  degraded: boolean;
  hasConversation: boolean;
  bookingFormOpen: boolean;
  onNewConversation: () => void;
  onCheckAvailability: () => void;
}) {
  return (
    <header
      className="sticky top-0 z-10 border-b px-4 py-3"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-canvas)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold" style={{ fontFamily: 'var(--font-serif)' }}>
            {hotel?.hotel.name ?? 'Guest Assistant'}
          </h1>
          <p className="truncate text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {hotel ? `${hotel.hotel.city} · Guest assistant` : 'Connecting…'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onCheckAvailability}
            className="btn btn-ghost !px-3 !py-2 !text-xs"
            aria-pressed={bookingFormOpen}
          >
            Check availability
          </button>
          {hasConversation && (
            <button type="button" onClick={onNewConversation} className="btn btn-ghost !px-3 !py-2 !text-xs">
              New chat
            </button>
          )}
        </div>
      </div>

      {degraded && (
        <p
          role="status"
          className="mt-2 rounded-lg px-2.5 py-1.5 text-xs"
          style={{ backgroundColor: 'var(--color-warning-soft)', color: 'var(--color-warning)' }}
        >
          The AI assistant is temporarily unavailable. Answers are coming straight from the hotel records and may be
          less conversational.
        </p>
      )}
    </header>
  );
}

function Welcome({ hotel }: { hotel: HotelInfoResponse | null }) {
  return (
    <div className="py-6 text-center">
      <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--font-serif)' }}>
        {hotel ? `Welcome to ${hotel.hotel.name}` : 'Welcome'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm" style={{ color: 'var(--color-ink-soft)' }}>
        {hotel ? `${hotel.hotel.tagline}.` : 'Ask about the property, our policies and amenities.'} Ask me anything, or
        check room availability for your dates.
      </p>
    </div>
  );
}

interface ComposerProps {
  value: string;
  busy: boolean;
  suggestions: string[];
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSuggestion: (text: string) => void;
  ref?: React.Ref<HTMLTextAreaElement>;
}

function Composer({ value, busy, suggestions, onChange, onSubmit, onSuggestion, ref }: ComposerProps) {
  const tooLong = value.length > 1000;

  return (
    <div
      className="sticky bottom-0 border-t px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-canvas)' }}
    >
      {suggestions.length > 0 && !busy && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {suggestions.slice(0, 3).map((suggestion) => (
            <button key={suggestion} type="button" className="chip" onClick={() => onSuggestion(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && value.trim() && !tooLong) onSubmit();
        }}
      >
        <label htmlFor="composer" className="sr-only">
          Ask a question about the hotel
        </label>
        {/* Deliberately NOT disabled while a reply is in flight. Disabling it
            blurs the field, so the guest's next keystrokes go nowhere and they
            have to click back in. Enter is gated on `busy` instead, which keeps
            focus and lets them compose the next question while they wait. */}
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={value}
          aria-busy={busy}
          placeholder="Ask about check-in, the pool, breakfast, availability…"
          className="field-input max-h-32 min-h-[46px] flex-1 resize-none py-3"
          onChange={(event) => {
            onChange(event.target.value);
            // Grow with the content, but never past the max-height above.
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(event.target.scrollHeight, 128)}px`;
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a new line -- the convention every
            // chat interface has trained people to expect.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!busy && value.trim() && !tooLong) onSubmit();
            }
          }}
        />
        <button type="submit" className="btn btn-primary !px-4 !py-3" disabled={busy || !value.trim() || tooLong}>
          <span className="sr-only">Send message</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>

      {tooLong && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--color-danger)' }} role="alert">
          That message is too long. Please keep it under 1000 characters.
        </p>
      )}
    </div>
  );
}
