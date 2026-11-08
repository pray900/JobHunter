import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <ConfirmDialog message="Discard your changes?" confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={onConfirm} onCancel={() => setOpen(false)} />}
    </>
  );
}

describe('ConfirmDialog (M7)', () => {
  test('the safe choice has focus, so one Enter never discards', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('Tab stays inside the dialog, and focus goes back to the trigger on close', async () => {
    render(<Harness onConfirm={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await userEvent.click(trigger);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Discard changes' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
