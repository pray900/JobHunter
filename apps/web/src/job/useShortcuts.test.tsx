import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { useShortcuts } from './useShortcuts';

function Harness({ handlers, enabled = true }: { handlers: Record<string, () => void>; enabled?: boolean }) {
  useShortcuts(handlers, enabled);
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="area" />
      <select aria-label="pick">
        <option>a</option>
      </select>
      <div aria-label="rich" contentEditable suppressContentEditableWarning />
      <button type="button">btn</button>
    </div>
  );
}

describe('useShortcuts', () => {
  test('runs the handler for its key, any case', async () => {
    const e = vi.fn();
    const a = vi.fn();
    render(<Harness handlers={{ e, a }} />);
    await userEvent.keyboard('e');
    await userEvent.keyboard('A');
    expect(e).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  test('ignored while typing in a field, a select or contenteditable', async () => {
    const e = vi.fn();
    const { getByLabelText } = render(<Harness handlers={{ e }} />);
    for (const label of ['field', 'area', 'pick']) {
      getByLabelText(label).focus();
      await userEvent.keyboard('e');
    }
    const rich = getByLabelText('rich');
    rich.focus();
    rich.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(e).not.toHaveBeenCalled();
  });

  test('ignored when a modifier is held, and when disabled', async () => {
    const e = vi.fn();
    const { rerender } = render(<Harness handlers={{ e }} />);
    await userEvent.keyboard('{Control>}e{/Control}');
    await userEvent.keyboard('{Meta>}e{/Meta}');
    await userEvent.keyboard('{Alt>}e{/Alt}');
    expect(e).not.toHaveBeenCalled();
    rerender(<Harness handlers={{ e }} enabled={false} />);
    await userEvent.keyboard('e');
    expect(e).not.toHaveBeenCalled();
  });

  test('uses the latest handler and stops on unmount', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<Harness handlers={{ e: first }} />);
    rerender(<Harness handlers={{ e: second }} />);
    await userEvent.keyboard('e');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    await userEvent.keyboard('e');
    expect(second).toHaveBeenCalledTimes(1);
  });
});
