import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordRevealDialog } from '@/components/ui/PasswordRevealDialog';
import { I18nProvider } from '@/i18n/I18nContext';

/**
 * The one-time credential dialog (decision D1). It is the only place a
 * generated password is ever rendered, so its open/close/copy behaviour is
 * tested directly rather than through either calling screen.
 */

const PASSWORD = 'Ab2Cd4Ef6Gh8Jk1L';

function renderDialog(props: Partial<Parameters<typeof PasswordRevealDialog>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <I18nProvider defaultLocale="en">
      <button type="button">trigger</button>
      <PasswordRevealDialog password={PASSWORD} onClose={onClose} {...props} />
    </I18nProvider>,
  );
  return { onClose, ...view };
}

describe('PasswordRevealDialog', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens as a modal dialog and shows the credential in full', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Temporary password' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The value must be complete and unmasked — it exists nowhere else.
    expect(screen.getByText(PASSWORD)).toBeTruthy();
    expect(screen.getByText(PASSWORD).getAttribute('dir')).toBe('ltr');
  });

  it('closes on the Close button', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Temporary password' }), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop click, but not on a click inside the panel', () => {
    const { onClose } = renderDialog();
    fireEvent.mouseDown(screen.getByText(PASSWORD));
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = screen.getByRole('dialog', { name: 'Temporary password' }).parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close while the operation is still settling', () => {
    const { onClose } = renderDialog({ busy: true });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Temporary password' }), {
      key: 'Escape',
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('copies the credential to the clipboard and confirms it', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PASSWORD));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
  });

  it('keeps the credential selectable when the clipboard is unavailable', () => {
    /* Insecure origins and some embedded browsers expose no clipboard at all.
       The dialog must still render — the value stays selectable text. */
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    renderDialog();
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy password' })),
    ).not.toThrow();
    expect(screen.getByText(PASSWORD)).toBeTruthy();
  });

  it('surfaces a notice (e.g. a missing audit row) as an alert', () => {
    renderDialog({ notice: 'The audit entry could not be written.' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The audit entry could not be written.');
  });

  it('renders no alert when the operation was recorded cleanly', () => {
    renderDialog({ notice: null });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('restores focus to the element that opened it', () => {
    const { onClose, unmount } = renderDialog();
    // The least destructive action is focused first, not Copy.
    expect(screen.getByRole('button', { name: 'Close' })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    unmount();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
