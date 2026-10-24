import { Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  MIN_NAME_LENGTH,
  validateName,
  type NameValidationFailure,
} from '@/hooks/useStationsMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Dialogs for the Stations & Warehouses write path.
 *
 * Both carry exactly one editable field — the name. The code is deliberately
 * absent from the create form (it is minted server-side by a sequence-backed
 * SECURITY DEFINER generator) and shown read-only on edit, so there is no way
 * for the UI to send a forged or colliding code.
 */

const FIELD_CLASS =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 mt-1 w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';

const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

function useEscapeKey(onClose: () => void, active: boolean) {
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

interface DialogShellProps {
  readonly titleId: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly children: React.ReactNode;
}

function DialogShell({ titleId, title, closeLabel, onClose, busy, children }: DialogShellProps) {
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
        className="bg-card text-card-foreground border-border w-full max-w-md rounded-2xl border p-5 shadow-xl"
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

export type StationFormKind = 'station' | 'warehouse';

export interface StationFormDialogProps {
  readonly kind: StationFormKind;
  /** `edit` renders the existing code read-only; `create` never shows a code. */
  readonly mode: 'create' | 'edit';
  readonly initialName?: string;
  readonly code?: string;
  readonly busy: boolean;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}

export function StationFormDialog({
  kind,
  mode,
  initialName = '',
  code,
  busy,
  onSubmit,
  onClose,
}: StationFormDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const nameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [failure, setFailure] = useState<NameValidationFailure | null>(null);

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const titleKey: TranslationKey =
    mode === 'create'
      ? kind === 'station'
        ? 'settings.project.stations.dialog.addStation'
        : 'settings.project.stations.dialog.addWarehouse'
      : kind === 'station'
        ? 'settings.project.stations.dialog.editStation'
        : 'settings.project.stations.dialog.editWarehouse';

  const labelKey: TranslationKey =
    kind === 'station'
      ? 'settings.project.stations.dialog.stationName'
      : 'settings.project.stations.dialog.warehouseName';

  const codeLabelKey: TranslationKey =
    kind === 'station'
      ? 'settings.project.stations.dialog.stationCode'
      : 'settings.project.stations.dialog.warehouseCode';

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = validateName(name);
    if (!result.ok) {
      setFailure(result.code);
      return;
    }
    setFailure(null);
    onSubmit(result.value);
  }

  return (
    <DialogShell
      titleId={titleId}
      title={t(titleKey)}
      closeLabel={t('settings.project.stations.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div>
          <label htmlFor={nameId} className="text-foreground text-sm font-medium">
            {t(labelKey)}
          </label>
          <input
            id={nameId}
            ref={inputRef}
            type="text"
            value={name}
            disabled={busy}
            autoComplete="off"
            aria-invalid={failure !== null}
            aria-describedby={failure !== null ? `${nameId}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              if (failure !== null) {
                setFailure(null);
              }
            }}
            className={FIELD_CLASS}
          />
          {failure !== null ? (
            <p id={`${nameId}-error`} role="alert" className="text-destructive mt-1.5 text-xs">
              {t(
                failure === 'required'
                  ? 'settings.project.stations.validation.required'
                  : 'settings.project.stations.validation.tooShort',
              )}
            </p>
          ) : (
            <p className="text-muted-foreground mt-1.5 text-xs">
              {t('settings.project.stations.validation.tooShort')}
            </p>
          )}
        </div>

        {/* The code exists only once the row does, and is never editable. */}
        {mode === 'edit' && code !== undefined ? (
          <div>
            <span className="text-foreground block text-sm font-medium">{t(codeLabelKey)}</span>
            <p className="text-muted-foreground mt-1 font-mono text-sm">{code}</p>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${BUTTON_CLASS} border-border text-foreground border`}
          >
            {t('settings.project.stations.dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`${BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t('settings.project.stations.dialog.saving')
              : t('settings.project.stations.dialog.save')}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export interface ConfirmDeleteDialogProps {
  readonly kind: StationFormKind;
  readonly name: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function ConfirmDeleteDialog({
  kind,
  name,
  busy,
  onConfirm,
  onClose,
}: ConfirmDeleteDialogProps) {
  const { t } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, !busy);

  return (
    <DialogShell
      titleId={titleId}
      title={t(
        kind === 'station'
          ? 'settings.project.stations.delete.stationTitle'
          : 'settings.project.stations.delete.warehouseTitle',
      )}
      closeLabel={t('settings.project.stations.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        {t('settings.project.stations.delete.body', { name })}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={`${BUTTON_CLASS} border-border text-foreground border`}
        >
          {t('settings.project.stations.dialog.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`${BUTTON_CLASS} bg-destructive text-destructive-foreground`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t('settings.project.stations.delete.confirm')}
        </button>
      </div>
    </DialogShell>
  );
}

/** Exposed so the form's own copy can state the rule it enforces. */
export { MIN_NAME_LENGTH };
