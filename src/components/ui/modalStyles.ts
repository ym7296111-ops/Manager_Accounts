/**
 * Styling tokens and the Escape-key helper shared by the project-settings
 * dialogs.
 *
 * They live apart from `ModalShell.tsx` so that module exports components only:
 * a module mixing a component with plain functions breaks React Fast Refresh
 * (the component's identity is lost on every edit), and `eslint` says so.
 */
import { useEffect } from 'react';

export const MODAL_FIELD_CLASS =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 mt-1 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';

export const MODAL_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

export function useEscapeKey(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, active]);
}
