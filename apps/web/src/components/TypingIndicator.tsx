'use client';

import { useEffect, useState } from 'react';

/**
 * Staged progress rather than a single spinner.
 *
 * A chat turn can involve retrieval, a model call and a tool call, and on a slow
 * connection that is several seconds of nothing. A spinner that never changes
 * reads as broken; labels that advance read as work being done. The stages are
 * time-based rather than reported by the server, so they are written to be
 * honest about the kind of work happening rather than to claim a precise step.
 */
const STAGES = [
  { after: 0, label: 'Thinking' },
  { after: 1200, label: 'Looking through hotel records' },
  { after: 3200, label: 'Checking live availability' },
];

export function TypingIndicator() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 400);
    return () => clearInterval(timer);
  }, []);

  const stage = [...STAGES].reverse().find((s) => elapsed >= s.after) ?? STAGES[0]!;

  return (
    <div className="animate-rise flex justify-start" aria-live="polite" aria-label={`${stage.label}...`}>
      <div
        className="flex items-center gap-2.5 rounded-2xl rounded-bl-md border px-4 py-3"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
      >
        <span className="flex gap-1" aria-hidden="true">
          <span className="dot h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--color-ink-faint)' }} />
          <span
            className="dot h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: 'var(--color-ink-faint)', animationDelay: '0.15s' }}
          />
          <span
            className="dot h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: 'var(--color-ink-faint)', animationDelay: '0.3s' }}
          />
        </span>
        <span className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {stage.label}
          <span aria-hidden="true">&hellip;</span>
        </span>
      </div>
    </div>
  );
}
