'use client';

import type { Source } from '@hotel/contracts';
import { useState } from 'react';

/**
 * The evidence behind an answer, made visible.
 *
 * The backend refuses to emit a factual claim that is not tied to a knowledge
 * base entry. Surfacing those entries turns that guarantee into something the
 * guest can actually check: tap the chip, read the exact sentence the answer
 * came from. It is also the fastest way for hotel staff to spot a stale fact,
 * because the wrong answer and its source are shown together.
 */
export function SourceChips({ sources }: { sources: Source[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium" style={{ color: 'var(--color-ink-faint)' }}>
          Based on
        </span>
        {sources.map((source) => {
          const open = openId === source.id;
          return (
            <button
              key={source.id}
              type="button"
              className="chip"
              aria-expanded={open}
              aria-controls={`source-${source.id}`}
              onClick={() => setOpenId(open ? null : source.id)}
              style={open ? { borderColor: 'var(--color-brand)', color: 'var(--color-brand)' } : undefined}
            >
              {source.label}
            </button>
          );
        })}
      </div>

      {sources.map((source) =>
        openId === source.id ? (
          <p
            key={source.id}
            id={`source-${source.id}`}
            className="mt-2 rounded-xl border-l-2 px-3 py-2 text-xs leading-relaxed"
            style={{
              borderColor: 'var(--color-brand)',
              backgroundColor: 'var(--color-brand-soft)',
              color: 'var(--color-ink-soft)',
            }}
          >
            {source.text}
          </p>
        ) : null,
      )}
    </div>
  );
}
