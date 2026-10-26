import { createContext, useContext, useEffect } from 'react';

/**
 * Unsaved-changes guard for the project-settings tabs.
 *
 * The tabs are local state, and the inactive panel is unmounted, so switching
 * away from «أرصدة أول المدة» silently discards whatever was typed. The router
 * cannot help: the app uses `BrowserRouter` without a data router, so there is
 * no `useBlocker`. Instead the two tab bars ask a provider whether anything is
 * dirty before they change the panel.
 *
 * A provider is not mandatory. Outside one, `confirmNavigation` just proceeds
 * and `setDirty` is a no-op, so a screen that registers a guard still renders
 * standalone (tests, previews) with no behaviour change.
 */

export interface UnsavedChangesApi {
  readonly isDirty: boolean;
  /** Register or clear one source of unsaved work, keyed by caller identity. */
  readonly setDirty: (key: string, dirty: boolean) => void;
  /** Run `proceed` now, or after the user confirms discarding their changes. */
  readonly confirmNavigation: (proceed: () => void) => void;
}

const UNGUARDED: UnsavedChangesApi = {
  isDirty: false,
  setDirty: () => undefined,
  confirmNavigation: (proceed) => {
    proceed();
  },
};

export const UnsavedChangesContext = createContext<UnsavedChangesApi>(UNGUARDED);

export function useUnsavedChanges(): UnsavedChangesApi {
  return useContext(UnsavedChangesContext);
}

/**
 * Keep one screen's dirty flag registered for as long as it is mounted.
 *
 * The cleanup clears the key, so unmounting a panel (which is what a tab switch
 * does) cannot leave a stale `true` behind and block every later navigation.
 */
export function useUnsavedChangesRegistration(dirty: boolean, key: string): void {
  const { setDirty } = useUnsavedChanges();

  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [dirty, key, setDirty]);
}
