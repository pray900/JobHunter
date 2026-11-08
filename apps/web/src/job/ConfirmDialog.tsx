import { useEffect } from 'react';

export function ConfirmDialog(props: {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { onCancel } = props;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.message}>
        <p>{props.message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={props.onCancel}>
            {props.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" className="btn btn-primary" onClick={props.onConfirm} autoFocus>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
