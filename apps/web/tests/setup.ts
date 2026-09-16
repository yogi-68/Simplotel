import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom implements neither of these, and both are used by the chat UI.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never;
}

// jsdom has no layout, so scrollTo is missing on elements.
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
