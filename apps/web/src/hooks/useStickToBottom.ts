'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a scrolling thread pinned to the newest content.
 *
 * Scrolling once when a message arrives is not enough: the reply then *grows*
 * as the typewriter reveals it, and grows again if the guest expands a rate
 * breakdown. Each of those pushes the newest line below the fold, which reads as
 * the assistant having stopped mid-sentence.
 *
 * A ResizeObserver on the content catches every one of those growth events,
 * whatever caused them. The `nearBottom` check is what makes it bearable: a
 * guest who has deliberately scrolled up to re-read an earlier answer is left
 * alone rather than being yanked back down every 14 milliseconds.
 */
const NEAR_BOTTOM_PX = 120;

export function useStickToBottom(
  viewport: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
) {
  // Whether the guest was at the bottom *before* the content grew. Read inside
  // the observer, so it must not be state.
  const stick = useRef(true);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;

    const onScroll = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      stick.current = distanceFromBottom <= NEAR_BOTTOM_PX;
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [viewport]);

  useEffect(() => {
    const element = viewport.current;
    const inner = content.current;
    if (!element || !inner || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!stick.current) return;
      // `auto` rather than `smooth`: during the typewriter this fires many times
      // a second, and queuing smooth scrolls makes the thread visibly lag.
      element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });

    observer.observe(inner);
    return () => observer.disconnect();
  }, [viewport, content]);

  /** Force a scroll to the bottom and re-arm sticking, e.g. when a turn starts. */
  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    stick.current = true;
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior });
  };

  return { scrollToBottom };
}
