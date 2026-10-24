import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ModalShell } from '@/components/ui/ModalShell';
import { MODAL_BUTTON_CLASS, MODAL_FIELD_CLASS, useEscapeKey } from '@/components/ui/modalStyles';
import { MIN_NAME_LENGTH, validateName } from '@/lib/nameValidation';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Dialogs for the classifications write path.
 *
 * One editable field, always: the name.
 *
 * * On create there is no code field — the code is minted server-side from
 *   `classification_code_seq`, and the level is derived from `parent_id`. The
 *   dialog shows which parent the node will land under, so the user can see the
 *   level they are about to create without being able to type it.
 * * On rename the code and level are rendered as plain text: they are the
 *   database's, and neither the form nor the mutation that follows it carries
 *   them.
 */

export type ClassificationNodeKind = 'category' | 'group' | 'item';

export interface ClassificationFormTarget {
  readonly kind: ClassificationNodeKind;
  readonly mode: 'create' | 'edit';
  /** Present on create-under-a-parent; absent for a new category. */
  readonly parentId?: string;
  readonly parentName?: string;
  /** Present on edit only. */
  readonly nodeId?: string;
  readonly code?: string;
  readonly initialName?: string;
}

const KIND_LABEL_KEY: Record<ClassificationNodeKind, TranslationKey> = {
  category: 'settings.project.classifications.level.category',
  group: 'settings.project.classifications.level.group',
  item: 'settings.project.classifications.level.item',
};

function titleKeyOf(target: ClassificationFormTarget): TranslationKey {
  if (target.mode === 'edit') {
    return 'settings.project.classifications.dialog.edit';
  }
  if (target.kind === 'category') {
    return 'settings.project.classifications.dialog.addCategory';
  }
  if (target.kind === 'group') {
    return 'settings.project.classifications.dialog.addGroup';
  }
  return 'settings.project.classifications.dialog.addItem';
}

export interface ClassificationFormDialogProps {
  readonly target: ClassificationFormTarget;
  readonly busy: boolean;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}

export function ClassificationFormDialog({
  target,
  busy,
  onSubmit,
  onClose,
}: ClassificationFormDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const nameId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(target.initialName ?? '');
  const [failure, setFailure] = useState<'required' | 'tooShort' | null>(null);

  useEscapeKey(onClose, !busy);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const kindLabel = t(KIND_LABEL_KEY[target.kind]);

  return (
    <ModalShell
      titleId={titleId}
      title={t(titleKeyOf(target))}
      closeLabel={t('settings.project.classifications.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {/* Where the node will land. Read-only by design: the parent is what
            decides the level, so it is stated rather than offered. */}
        {target.mode === 'create' ? (
          <p className="text-muted-foreground text-xs">
            {target.parentName === undefined
              ? t('settings.project.classifications.dialog.rootHint', { kind: kindLabel })
              : t('settings.project.classifications.dialog.underParent', {
                  kind: kindLabel,
                  parent: target.parentName,
                })}
          </p>
        ) : null}

        <div>
          <label htmlFor={nameId} className="text-foreground text-sm font-medium">
            {t('settings.project.classifications.dialog.name', { kind: kindLabel })}
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
            className={MODAL_FIELD_CLASS}
          />
          {failure !== null ? (
            <p id={`${nameId}-error`} role="alert" className="text-destructive mt-1.5 text-xs">
              {t(
                failure === 'required'
                  ? 'settings.project.classifications.validation.required'
                  : 'settings.project.classifications.validation.tooShort',
              )}
            </p>
          ) : (
            <p className="text-muted-foreground mt-1.5 text-xs">
              {t('settings.project.classifications.validation.tooShort')}
            </p>
          )}
        </div>

        {/* Code and level exist only once the row does, and are never editable. */}
        {target.mode === 'edit' && target.code !== undefined ? (
          <div>
            <span className="text-foreground block text-sm font-medium">
              {t('settings.project.classifications.dialog.code')}
            </span>
            <p className="text-muted-foreground mt-1 font-mono text-sm">{target.code}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('settings.project.classifications.dialog.immutable')}
            </p>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
          >
            {t('settings.project.classifications.dialog.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`${MODAL_BUTTON_CLASS} bg-primary text-primary-foreground`}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {busy
              ? t('settings.project.classifications.dialog.saving')
              : t('settings.project.classifications.dialog.save')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export interface ClassificationDeleteDialogProps {
  readonly name: string;
  readonly code: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

export function ClassificationDeleteDialog({
  name,
  code,
  busy,
  onConfirm,
  onClose,
}: ClassificationDeleteDialogProps) {
  const { t } = useI18n();
  const titleId = useId();

  useEscapeKey(onClose, !busy);

  return (
    <ModalShell
      titleId={titleId}
      title={t('settings.project.classifications.delete.title')}
      closeLabel={t('settings.project.classifications.dialog.close')}
      onClose={onClose}
      busy={busy}
    >
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        {t('settings.project.classifications.delete.body', { name, code })}
      </p>
      {/* The constraint is the real guard; saying so keeps the copy honest even
          when a child is added between render and click. */}
      <p className="text-muted-foreground mt-2 text-xs">
        {t('settings.project.classifications.delete.childGuard')}
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} border-border text-foreground border`}
        >
          {t('settings.project.classifications.dialog.cancel')}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className={`${MODAL_BUTTON_CLASS} bg-destructive text-destructive-foreground`}
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t('settings.project.classifications.delete.confirm')}
        </button>
      </div>
    </ModalShell>
  );
}

/** Exposed so the form's own copy can state the rule it enforces. */
export { MIN_NAME_LENGTH };
