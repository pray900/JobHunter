import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// leaveTo for the browser's Back button (not an address).
const BACK = '\u0000back';

// While `active` (unsaved edits), reload, closing the tab, in-app links and Back / Forward ask first.
// `pending` says a question is waiting; show a ConfirmDialog and wire it to `confirm` / `cancel`.
// `onLeave` runs when he confirms, just before leaving (close the editor there).
export function useLeaveGuard(active: boolean, onLeave: () => void) {
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  // Set when he confirms leaving with Back: the guard cleanup must not step back on its own.
  const leavingBack = useRef(false);
  const navigate = useNavigate();
  const latestLeave = useRef(onLeave);
  latestLeave.current = onLeave;

  useEffect(() => {
    if (!active) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(a instanceof HTMLAnchorElement) || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      // Downloads and other sites do not leave the editor.
      if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    }
    // Back / Forward: a guard entry (same address) sits on top of the page, so Back first lands on the page
    // itself; that pop is caught, the guard entry is put back and he is asked.
    function onPopState() {
      window.history.pushState({ ...(window.history.state ?? {}), jhGuard: true }, '', window.location.href);
      setLeaveTo(BACK);
    }
    if (!window.history.state?.jhGuard) window.history.pushState({ ...(window.history.state ?? {}), jhGuard: true }, '', window.location.href);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('popstate', onPopState);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('click', onClick, true);
      // Edits saved or discarded: take the guard entry off again (unless he chose to leave, which goes past it).
      if (leavingBack.current) leavingBack.current = false;
      else if (window.history.state?.jhGuard) window.history.back();
    };
  }, [active]);

  const confirm = useCallback(() => {
    const to = leaveTo;
    setLeaveTo(null);
    if (to === null) return;
    if (to === BACK) {
      // Past the guard entry and the page entry: where Back would have gone.
      leavingBack.current = true;
      latestLeave.current();
      window.history.go(-2);
      return;
    }
    latestLeave.current();
    navigate(to);
  }, [leaveTo, navigate]);

  const cancel = useCallback(() => setLeaveTo(null), []);

  return { pending: leaveTo !== null, confirm, cancel };
}
