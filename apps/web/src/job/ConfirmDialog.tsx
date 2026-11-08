import { useEffect, useRef } from 'react';

// A small modal confirm. The safe choice (cancel) has focus, so one Enter never confirms; Tab stays
// inside the dialog; on close, focus goes back to where it was.
export function ConfirmDialog(props: {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { onCancel } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (before && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const buttons = Array.from(box.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : at === buttons.length - 1 ? 0 : at + 1;
      e.preventDefault();
      buttons[next]!.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.message} ref={box}>
        <p>{props.message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={props.onCancel} ref={cancel}>
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" className="btn btn-primary" onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
