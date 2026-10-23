import { Check, Copy, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n/I18nContext';

/**
 * One-time credential display (decision D1).
 *
 * Shared by the invite and admin-password-reset flows: both produce a
 * temporary password that exists nowhere but in this component's props and on
 * screen. It is deliberately uncontrolled — the parent hands the value in and
 * drops it when the dialog closes, so nothing is left in a store, a cache or
 * the URL.
 *
 * Accessibility follows the rest of the screen: portal, focus trap, Escape,
 * `role="dialog"` + `aria-modal` + `aria-label`, and focus restored to the
 * element that opened it.
 *
 * The password is rendered as selectable text inside a `dir="ltr"` island so a
 * mixed-direction UI cannot reorder the characters when it is read or copied.
 */
export interface PasswordRevealDialogProps {
  readonly password: string;
  /** Extra line shown under the copy field, e.g. a missing-audit warning. */
  readonly notice?: string | null;
  /** TRUE while the operation that produced this password is still settling. */
  readonly busy?: boolean;
  readonly onClose: () => void;
}

export function PasswordRevealDialog({
  password,
  notice = null,
  busy = false,
  onClose,
}: PasswordRevealDialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const passwordId = useId();
  const [copied, setCopied] = useState(false);

  /* Focus the least destructive action first (Close, not Copy) and restore the
     trigger on unmount, exactly like the other dialogs on this screen. */
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  /* "Copied" is a transient state, so its timer must not outlive the dialog. */
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = useCallback(() => {
    /* The clipboard API is unavailable on insecure origins and in some
       embedded browsers; a failure is reported by simply not flipping the
       confirmation, and the value stays selectable so it can be copied by
       hand. Never throw out of an event handler. */
    void navigator.clipboard
      ?.writeText(password)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [password]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) {
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([aria-disabled="true"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('users.password.reveal.title')}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-md rounded-2xl border p-5 shadow-xl motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-card-foreground text-base font-semibold">
          {t('users.password.reveal.title')}
        </h2>
        <p id={bodyId} className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {t('users.password.reveal.body')}
        </p>

        {/* Selectable, LTR-pinned credential. Not an <input>: a masked or
            readonly input invites the assumption that it is stored. */}
        <output
          id={passwordId}
          dir="ltr"
          className="border-border bg-muted text-foreground mt-4 block rounded-lg border px-3.5 py-3 font-mono text-base tracking-wider break-all select-all"
        >
          {password}
        </output>

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleCopy}
            className="border-border bg-background text-foreground hover:bg-accent inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors"
          >
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied ? t('users.password.reveal.copied') : t('users.password.reveal.copy')}
          </button>
          <span className="text-muted-foreground text-xs">
            {t('users.password.reveal.warning')}
          </span>
        </div>

        {notice !== null && notice !== '' && (
          <div
            role="alert"
            className="border-warning/40 bg-warning/10 text-warning mt-4 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-disabled={busy}
            className="bg-primary text-primary-foreground inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            {t('users.password.reveal.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
