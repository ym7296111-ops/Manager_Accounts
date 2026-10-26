import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * The shared modal shell for the project-settings directories.
 *
 * Extracted from the stations dialogs so the classifications dialogs are the
 * same widget rather than a look-alike: same overlay, same focus target, same
 * Escape and backdrop dismissal, same disabled-while-busy behaviour.
 *
 * Notes that matter for behaviour, not style:
 * * the backdrop closes only on a `mousedown` that started on the backdrop
 *   itself, so dragging text out of the dialog does not dismiss it;
 * * dismissal is refused while `busy` — a request in flight must finish before
 *   the dialog (and the values the user typed) can disappear;
 * * content portals to `document.body`, so no ancestor with `overflow: hidden`
 *   or a stacking context can clip it;
 * * the panel is capped to the viewport height (minus the overlay padding)
 *   and scrolls internally, so a tall form on a short viewport can never push
 *   its title/close button or actions off-screen.
 */

export interface ModalShellProps {
  readonly titleId: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly children: ReactNode;
}

export function ModalShell({
  titleId,
  title,
  closeLabel,
  onClose,
  busy,
  children,
}: ModalShellProps) {
  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card text-card-foreground border-border max-h-[calc(100dvh-2rem)] w-full max-w-md min-w-0 overflow-y-auto rounded-2xl border p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={closeLabel}
            className="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-60"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
