import { useEffect, useRef } from 'react';

// Single-key shortcuts for the job page. Never fire while typing or with a modifier held.
export const SHORTCUTS: { key: string; text: string }[] = [
  { key: 'E', text: 'Edit the documents' },
  { key: 'A', text: 'Mark applied' },
  { key: 'S', text: 'Skip (mark closed)' },
  { key: 'G', text: 'Go to the regenerate box' },
];

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export function useShortcuts(handlers: Record<string, (() => void) | undefined>, enabled = true): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      const run = latest.current[e.key.toLowerCase()];
      if (!run) return;
      e.preventDefault();
      run();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
