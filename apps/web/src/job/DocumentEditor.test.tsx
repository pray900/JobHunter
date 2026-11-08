import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { DocumentEditor } from './DocumentEditor';
import { baseVersion } from './detailFixtures';

function setup(over: Partial<React.ComponentProps<typeof DocumentEditor>> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(<DocumentEditor cv={baseVersion.cv} letter={baseVersion.coverLetter} saving={false} error={null} onSave={onSave} onCancel={onCancel} {...over} />);
  return { onSave, onCancel };
}

describe('DocumentEditor', () => {
  test('editor edits a bullet and saves a new version', async () => {
    const { onSave } = setup();
    const bullet = screen.getByLabelText('Developer bullet 1');
    await userEvent.clear(bullet);
    await userEvent.type(bullet, 'Built LWC components used by 40 reps.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [cv, letter] = onSave.mock.calls[0];
    expect(cv.experience[0].bullets).toEqual(['Built LWC components used by 40 reps.']);
    expect(cv.experience[0].title).toBe('Developer');
    expect(letter).toEqual(baseVersion.coverLetter);
  });

  test('copied fields are read-only', () => {
    setup();
    for (const name of ['Name', 'Work rights', 'Role title 1', 'Employer 1', 'Role dates 1', 'Qualification 1', 'Institution 1', 'Education dates 1', 'Education status 1']) {
      expect(screen.getByLabelText(name), name).toHaveAttribute('readonly');
    }
    expect(screen.getAllByText('Copied from your base CV — change it there').length).toBeGreaterThan(0);
    for (const name of ['Headline', 'Summary', 'Location', 'Email', 'Phone', 'Addressee', 'Salutation', 'Sign-off']) {
      expect(screen.getByLabelText(name), name).not.toHaveAttribute('readonly');
    }
  });

  test('bullets can be added, removed and moved', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Developer bullet' }));
    await userEvent.type(screen.getByLabelText('Developer bullet 2'), 'Second');
    await userEvent.click(screen.getByRole('button', { name: 'Move Developer bullet 2 up' }));
    expect(screen.getByLabelText('Developer bullet 1')).toHaveValue('Second');
    expect(screen.getByRole('button', { name: 'Move Developer bullet 1 up' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move Developer bullet 1 down' }));
    expect(screen.getByLabelText('Developer bullet 2')).toHaveValue('Second');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Developer bullet 1' }));
    expect(screen.getByLabelText('Developer bullet 1')).toHaveValue('Second');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave.mock.calls[0][0].experience[0].bullets).toEqual(['Second']);
  });

  test('blank entries are dropped and empty contact fields become null', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Developer bullet' }));
    await userEvent.clear(screen.getByLabelText('Phone'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const cv = onSave.mock.calls[0][0];
    expect(cv.experience[0].bullets).toEqual(['Built LWC components.']);
    expect(cv.contact.phone).toBeNull();
    expect(cv.contact.email).toBe('sam@example.com');
  });

  test('skills groups and items, projects and letter paragraphs are editable', async () => {
    const { onSave } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Add Languages item' }));
    await userEvent.type(screen.getByLabelText('Languages item 3'), 'SOQL');
    await userEvent.click(screen.getByRole('button', { name: 'Add skill group' }));
    await userEvent.type(screen.getByLabelText('Skill group name 2'), 'Tools');
    await userEvent.click(screen.getByRole('button', { name: 'Add Tools item' }));
    await userEvent.type(screen.getByLabelText('Tools item 1'), 'Git');
    await userEvent.type(screen.getByLabelText('JobHunter bullet 1'), ' Now with edits.');
    await userEvent.clear(screen.getByLabelText('Paragraph 2'));
    await userEvent.type(screen.getByLabelText('Paragraph 2'), 'Apex is my daily tool.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const [cv, letter] = onSave.mock.calls[0];
    expect(cv.skills).toEqual([
      { group: 'Languages', items: ['Apex', 'JavaScript', 'SOQL'] },
      { group: 'Tools', items: ['Git'] },
    ]);
    expect(cv.projects[0].bullets).toEqual(['Local job tracker. Now with edits.']);
    expect(letter.paragraphs).toEqual(['I am keen on this role.', 'Apex is my daily tool.']);
  });

  test('cancel without changes just closes', async () => {
    const { onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('cancel with changes asks first', async () => {
    const { onCancel } = setup();
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('M5: Save is off until something changed, and the page is told when there are unsaved edits', async () => {
    const onDirtyChange = vi.fn();
    setup({ onDirtyChange });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  test('a version finished while editing is mentioned in the editor', () => {
    setup({ notice: 'A new version finished while you were editing.' });
    expect(screen.getByRole('status', { name: 'A new version finished' })).toHaveTextContent('A new version finished while you were editing.');
  });

  test('Save is disabled while saving and an error shows in amber', () => {
    setup({ saving: true, error: 'Could not save.' });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
    expect(screen.getByRole('alert')).toHaveClass('attention');
  });
});
