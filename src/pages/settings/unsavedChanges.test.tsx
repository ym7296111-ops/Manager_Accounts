import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import { UnsavedChangesProvider } from './UnsavedChangesProvider';
import { useUnsavedChanges, useUnsavedChangesRegistration } from './unsavedChanges';

/**
 * The unsaved-changes guard (design study §8, U14/U15).
 *
 * Covered here: the provider's two answers, Escape, the registration cleanup
 * that keeps a tab switch from leaving a stale `true` behind, and the
 * unguarded fallback a screen gets when it renders outside the provider.
 */

function Dirty({ dirty }: { readonly dirty: boolean }) {
  useUnsavedChangesRegistration(dirty, 'opening-balances');
  return null;
}

function Navigate({ onProceed }: { readonly onProceed: () => void }) {
  const { confirmNavigation } = useUnsavedChanges();
  return (
    <button type="button" onClick={() => confirmNavigation(onProceed)}>
      switch tab
    </button>
  );
}

function renderGuard(dirty: boolean, onProceed: () => void) {
  return render(
    <I18nProvider>
      <UnsavedChangesProvider>
        <Dirty dirty={dirty} />
        <Navigate onProceed={onProceed} />
      </UnsavedChangesProvider>
    </I18nProvider>,
  );
}

describe('UnsavedChangesProvider', () => {
  it('navigates immediately when nothing is dirty', () => {
    const onProceed = vi.fn();
    renderGuard(false, onProceed);

    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));

    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks first, and "back to editing" keeps the user in place', () => {
    const onProceed = vi.fn();
    renderGuard(true, onProceed);

    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('لديك تغييرات غير محفوظة');

    fireEvent.click(screen.getByRole('button', { name: 'العودة للحفظ' }));

    expect(onProceed).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"leave without saving" runs the pending navigation once', () => {
    const onProceed = vi.fn();
    renderGuard(true, onProceed);

    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'مغادرة بدون حفظ' }));

    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape is the same answer as staying', () => {
    const onProceed = vi.fn();
    renderGuard(true, onProceed);

    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onProceed).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('forgets a dirty flag when its screen unmounts', async () => {
    const onProceed = vi.fn();
    const { rerender } = renderGuard(true, onProceed);
    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'العودة للحفظ' }));

    /* Unmounting the dirty screen is what a tab switch does; the stale flag
       must not block the next navigation. */
    rerender(
      <I18nProvider>
        <UnsavedChangesProvider>
          <Navigate onProceed={onProceed} />
        </UnsavedChangesProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));
    await waitFor(() => expect(onProceed).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('unguarded fallback', () => {
  it('proceeds without a dialog when the screen renders outside a provider', () => {
    const onProceed = vi.fn();
    render(
      <I18nProvider>
        <Dirty dirty />
        <Navigate onProceed={onProceed} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'switch tab' }));

    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
