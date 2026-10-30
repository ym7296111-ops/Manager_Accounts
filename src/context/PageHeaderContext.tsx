import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PageHeaderOverride } from '@/lib/pageHeader';

/**
 * The sticky top bar owns the page title, so a screen that changes the meaning
 * of the page (a new inbound letter is not a new outbound letter) has to change
 * that title itself. Doing it here keeps ONE header on screen: the shell's.
 *
 * A screen never renders its own band or heading for this — that duplicated the
 * title and pushed the form down. It publishes an override for as long as it is
 * mounted, and clears it on unmount or on a route change.
 */

interface PageHeaderValue {
  readonly header: PageHeaderOverride | null;
  readonly setHeader: (header: PageHeaderOverride | null) => void;
}

/* The default is deliberately inert: a screen rendered on its own — in a unit
   test, or in any future shell — must not crash for the lack of a provider. */
const PageHeaderContext = createContext<PageHeaderValue>({
  header: null,
  setHeader: () => undefined,
});

export function PageHeaderProvider({ children }: { readonly children: ReactNode }) {
  const [header, setHeaderState] = useState<PageHeaderOverride | null>(null);
  const setHeader = useCallback((next: PageHeaderOverride | null) => setHeaderState(next), []);
  const value = useMemo(() => ({ header, setHeader }), [header, setHeader]);
  return <PageHeaderContext.Provider value={value}>{children}</PageHeaderContext.Provider>;
}

/** Read side, used by the top bar. */
export function usePageHeader(): PageHeaderOverride | null {
  return useContext(PageHeaderContext).header;
}

/**
 * Publish an override for as long as the calling screen is mounted.
 *
 * The effect depends on the three primitive parts, not on the object, so a
 * re-render that rebuilds an identical override does not loop.
 */
export function usePageHeaderOverride(header: PageHeaderOverride | null): void {
  const { setHeader } = useContext(PageHeaderContext);
  const titleKey = header?.titleKey ?? null;
  const tone = header?.tone ?? null;
  const icon = header?.icon ?? null;

  useEffect(() => {
    setHeader(
      titleKey !== null && tone !== null && icon !== null ? { titleKey, tone, icon } : null,
    );
    return () => setHeader(null);
  }, [icon, setHeader, titleKey, tone]);
}
