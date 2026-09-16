'use client';

import type { ReplyType, Source } from '@hotel/contracts';
import { useEffect, useState } from 'react';
import { AvailabilityCard } from '@/components/AvailabilityCard';
import { SourceChips } from '@/components/SourceChips';
import type { ChatMessage } from '@/hooks/useChat';

/**
 * One turn in the thread.
 *
 * Assistant replies are not all the same thing, and the UI says so: an honest
 * "I do not know" is visually distinct from an answer, so a guest can tell at a
 * glance whether they were told something or told nothing. Blurring those two
 * is how a confident-sounding non-answer gets mistaken for a fact.
 */

const TYPE_LABEL: Partial<Record<ReplyType, { label: string; tone: 'neutral' | 'warn' | 'info' }>> = {
  fallback: { label: 'Not in our records', tone: 'warn' },
  handoff: { label: 'Front desk can help', tone: 'warn' },
  clarification: { label: 'Needs a detail', tone: 'info' },
};

export function MessageBubble({
  message,
  onFinishedAnimating,
  children,
}: {
  message: ChatMessage;
  onFinishedAnimating?: (id: string) => void;
  children?: React.ReactNode;
}) {
  const isUser = message.role === 'user';
  const text = useTypewriter(message.text, Boolean(message.animate), () => onFinishedAnimating?.(message.id));

  if (isUser) {
    return (
      <div className="animate-rise flex justify-end">
        <div
          className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-sm sm:max-w-[75%]"
          style={{ backgroundColor: 'var(--color-brand)', color: '#ffffff' }}
        >
          {message.text}
        </div>
      </div>
    );
  }

  const badge = message.reply ? TYPE_LABEL[message.reply.type] : undefined;
  const isError = Boolean(message.error);

  return (
    <div className="animate-rise flex flex-col items-start">
      <div className="w-full max-w-[92%] sm:max-w-[82%]">
        {/* `w-fit` so a two-word answer is a two-word bubble. The wrapper keeps
            the 82% ceiling, and the availability card below still spans it. */}
        <div
          className="w-fit max-w-full rounded-2xl rounded-bl-md border px-4 py-3 text-sm"
          style={{
            borderColor: isError ? 'var(--color-danger)' : 'var(--color-border)',
            backgroundColor: isError ? 'var(--color-danger-soft)' : 'var(--color-surface)',
            color: isError ? 'var(--color-danger)' : 'var(--color-ink)',
          }}
        >
          {badge && (
            <span
              className="mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{
                backgroundColor: badge.tone === 'warn' ? 'var(--color-warning-soft)' : 'var(--color-brand-soft)',
                color: badge.tone === 'warn' ? 'var(--color-warning)' : 'var(--color-brand)',
              }}
            >
              {badge.label}
            </span>
          )}

          <p className={`whitespace-pre-wrap leading-relaxed ${message.animate ? 'typing-caret' : ''}`}>{text}</p>

          {message.meta?.degraded && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-warning)' }}>
              Answered directly from our records while the assistant is unavailable.
            </p>
          )}
        </div>

        {message.sources && message.sources.length > 0 && <SourceChips sources={message.sources as Source[]} />}
        {message.availability && <AvailabilityCard availability={message.availability} />}
        {children}
      </div>
    </div>
  );
}

/**
 * Reveals text a character at a time.
 *
 * A structured JSON response arrives all at once, which lands as a wall of text
 * appearing from nowhere. Revealing it progressively reads at a human pace and
 * makes a 900ms wait feel like the assistant was thinking rather than stalling.
 *
 * It yields immediately to `prefers-reduced-motion`, and the full text is always
 * in the DOM for assistive technology within one tick -- the animation is a
 * visual nicety, never a gate on the content.
 */
function useTypewriter(full: string, enabled: boolean, onDone: () => void): string {
  const [shown, setShown] = useState(enabled ? '' : full);

  useEffect(() => {
    if (!enabled) {
      setShown(full);
      return;
    }

    const reduceMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setShown(full);
      onDone();
      return;
    }

    setShown('');
    let index = 0;
    // Longer answers speed up so a detailed policy never feels slow to read.
    const step = full.length > 320 ? 3 : full.length > 160 ? 2 : 1;
    const timer = setInterval(() => {
      index = Math.min(full.length, index + step);
      setShown(full.slice(0, index));
      if (index >= full.length) {
        clearInterval(timer);
        onDone();
      }
    }, 14);

    return () => clearInterval(timer);
    // `onDone` is stable via useCallback in the parent; re-running on identity
    // changes would restart the animation mid-sentence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, enabled]);

  return shown;
}
