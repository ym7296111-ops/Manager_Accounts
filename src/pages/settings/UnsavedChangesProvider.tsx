import { LogOut, PencilLine } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { useI18n } from '@/i18n/I18nContext';
import { UnsavedChangesContext, type UnsavedChangesApi } from './unsavedChanges';

/**
 * Owns the dirty-flag registry and the one dialog both tab bars share.
 *
 * The dirty set lives in a ref mirrored by a boolean because `confirmNavigation`
 * must have a stable identity: the tab buttons hold it in a closure, and a new
 * identity on every keystroke would re-render every tab.
 *
 * The dialog offers exactly two answers. «حفظ ثم مغادرة» is deliberately absent:
 * a save can target more than one warehouse and can fail halfway, which would
 * turn one confirmation into a partial, unrecoverable state.
 */
export function UnsavedChangesProvider({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const dirtyKeys = useRef(new Set<string>());
  const [isDirty, setIsDirty] = useState(false);
  const [pendingProceed, setPendingProceed] = useState<(() => void) | null>(null);

  const setDirty = useCallback((key: string, dirty: boolean) => {
    const keys = dirtyKeys.current;
    if (keys.has(key) === dirty) {
      return;
    }
    if (dirty) {
      keys.add(key);
    } else {
      keys.delete(key);
    }
    setIsDirty(keys.size > 0);
  }, []);

  const confirmNavigation = useCallback((proceed: () => void) => {
    if (dirtyKeys.current.size === 0) {
      proceed();
      return;
    }
    setPendingProceed(() => proceed);
  }, []);

  const stay = useCallback(() => setPendingProceed(null), []);
  const leave = useCallback(() => {
    const proceed = pendingProceed;
    setPendingProceed(null);
    if (proceed !== null) {
      proceed();
    }
  }, [pendingProceed]);

  useEscapeKey(stay, pendingProceed !== null);

  const api = useMemo<UnsavedChangesApi>(
    () => ({ isDirty, setDirty, confirmNavigation }),
    [isDirty, setDirty, confirmNavigation],
  );

  return (
    <UnsavedChangesContext.Provider value={api}>
      {children}
      {pendingProceed !== null ? (
        <ModalShell
          titleId="unsaved-changes-title"
          title={t('settings.project.fiscal.openingBalances.guard.title')}
          closeLabel={t('settings.project.fiscal.openingBalances.picker.close')}
          onClose={stay}
          busy={false}
        >
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            {t('settings.project.fiscal.openingBalances.guard.body')}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={stay}
              className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
            >
              <PencilLine className="size-4" aria-hidden="true" />
              {t('settings.project.fiscal.openingBalances.guard.stay')}
            </button>
            <button
              type="button"
              onClick={leave}
              className={`${MODAL_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
            >
              <LogOut className="size-4" aria-hidden="true" />
              {t('settings.project.fiscal.openingBalances.guard.leave')}
            </button>
          </div>
        </ModalShell>
      ) : null}
    </UnsavedChangesContext.Provider>
  );
}
