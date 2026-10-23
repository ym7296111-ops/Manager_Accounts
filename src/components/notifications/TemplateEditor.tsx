import { Check, Code2, FileEdit, Loader2, Send, ShieldAlert, Sparkles } from 'lucide-react';
import { useId, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import {
  fallbackNotificationTemplate,
  toTemplateError,
  useNotificationTemplates,
  validateTemplateContent,
  type NotificationTemplateRecord,
  type TemplateDirection,
  type TemplateError,
  type TemplateLocale,
  type TemplateVariableDefinition,
} from '@/hooks/useNotificationTemplates';
import {
  usePublishTemplate,
  useUpsertTemplateDraft,
  type PublishTemplateAck,
  type UpsertTemplateDraftAck,
} from '@/hooks/useTemplateMutations';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Notification Message Template Editor (Phase 3.2).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §2.1 & §3.6.2: Edits `subject` (`dir="auto"`), `body_text` (`dir="auto"`), and `body_html`
 *   (`dir="ltr"` monospace code input).
 * - §2.3 & §3.6.3: Displays whitelisted `variables` as clickable Variable Chips that insert
 *   `{{variable_name}}` at the current cursor position (`selectionStart`/`selectionEnd`).
 * - §2.4, §2.5 & §3.4: Real-time and on-save whitelist verification displaying `TPL04`
 *   (rejected HTML tags/attributes) and `TPL01` (unknown/reserved variables) clearly below fields
 *   with `role="status"` and `aria-live="polite"`.
 * - §2.7 & §3.3: Saves drafts via `useUpsertTemplateDraft` with `p_expected_hash` optimistic locking
 *   and publishes via `usePublishTemplate`.
 * - §3.6.1 & §3.6.2: `@container` root and responsive container-query `grid` (`grid-cols-1 @2xl:grid-cols-2`).
 */

export type EditableTemplateField = 'subject' | 'body_text' | 'body_html';

export interface TemplateEditorValues {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
  readonly direction: TemplateDirection;
  readonly locale: TemplateLocale;
  readonly variables: readonly TemplateVariableDefinition[];
}

export interface TemplateEditorProps {
  /** Optional pre-loaded template record; falls back to `useNotificationTemplates` or seed. */
  readonly template?: NotificationTemplateRecord | null;
  /** Event key to load when `template` prop is not provided. */
  readonly templateKey?: string;
  /** Locale to load when `template` prop is not provided. */
  readonly locale?: TemplateLocale;
  /** Disables editing when the caller lacks `notifications.manage` (§3.2 / §3.6.4). */
  readonly disabled?: boolean;
  /** Callback fired whenever the editor fields change (for parent live preview synchronization). */
  readonly onChange?: (values: TemplateEditorValues) => void;
  /** Callback fired after a draft is saved via `admin_upsert_notification_template_draft`. */
  readonly onSaved?: (ack: UpsertTemplateDraftAck) => void;
  /** Callback fired after a template version is published via `admin_publish_notification_template`. */
  readonly onPublished?: (ack: PublishTemplateAck) => void;
}

interface DraftFieldsState {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
}

interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

const INPUT_CLASS =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-shadow focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';

const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

function draftFromTemplate(record: NotificationTemplateRecord): DraftFieldsState {
  return {
    subject: record.subject,
    body_text: record.body_text ?? '',
    body_html: record.body_html ?? '',
  };
}

export function TemplateEditor({
  template: templateProp,
  templateKey = 'auth.welcome_invitation',
  locale = 'ar',
  disabled = false,
  onChange,
  onSaved,
  onPublished,
}: TemplateEditorProps) {
  const { t } = useI18n();
  const { currentTemplate: queriedTemplate } = useNotificationTemplates({
    key: templateKey,
    locale,
    enabled: templateProp === undefined,
  });

  const upsertDraft = useUpsertTemplateDraft();
  const publishTemplate = usePublishTemplate();

  const resolvedTemplate = useMemo<NotificationTemplateRecord>(
    () => templateProp ?? queriedTemplate ?? fallbackNotificationTemplate(templateKey, locale),
    [templateProp, queriedTemplate, templateKey, locale],
  );

  const [draft, setDraft] = useState<DraftFieldsState>(() => draftFromTemplate(resolvedTemplate));
  const [baselineKey, setBaselineKey] = useState<string>(
    `${resolvedTemplate.id}:${resolvedTemplate.content_hash}`,
  );
  const [activeField, setActiveField] = useState<EditableTemplateField>('body_text');
  const [selectionMap, setSelectionMap] = useState<
    Record<EditableTemplateField, SelectionRange | null>
  >({
    subject: null,
    body_text: null,
    body_html: null,
  });
  const [serverError, setServerError] = useState<TemplateError | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const subjectId = useId();
  const bodyTextId = useId();
  const bodyHtmlId = useId();

  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyTextRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyHtmlRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync draft state when the underlying template record changes.
  const currentRecordIdentity = `${resolvedTemplate.id}:${resolvedTemplate.content_hash}`;
  if (currentRecordIdentity !== baselineKey) {
    setDraft(draftFromTemplate(resolvedTemplate));
    setBaselineKey(currentRecordIdentity);
    setServerError(null);
    setStatusBanner(null);
  }

  // §2.4, §2.5 & §3.6.3: Immediate client-side validation for TPL04 (HTML allowlist) and TPL01 (variable whitelist).
  const validation = useMemo(
    () =>
      validateTemplateContent({
        subject: draft.subject,
        body_text: draft.body_text,
        body_html: draft.body_html,
        variables: resolvedTemplate.variables,
      }),
    [draft.subject, draft.body_text, draft.body_html, resolvedTemplate.variables],
  );

  const notifyChange = (nextDraft: DraftFieldsState) => {
    onChange?.({
      subject: nextDraft.subject,
      body_text: nextDraft.body_text,
      body_html: nextDraft.body_html,
      direction: resolvedTemplate.direction,
      locale: resolvedTemplate.locale,
      variables: resolvedTemplate.variables,
    });
  };

  const recordFieldSelection = (
    field: EditableTemplateField,
    event: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const element = event.currentTarget;
    setActiveField(field);
    if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      setSelectionMap((prev) => ({
        ...prev,
        [field]: { start, end },
      }));
    }
  };

  const updateFieldValue = (field: EditableTemplateField, value: string) => {
    setServerError(null);
    setStatusBanner(null);
    const nextDraft: DraftFieldsState = {
      ...draft,
      [field]: value,
    };
    setDraft(nextDraft);
    notifyChange(nextDraft);
  };

  /**
   * §3.6.3: Insert `{{variable_name}}` at the current cursor position (`selectionStart`/`selectionEnd`)
   * of the active field (`subject`, `body_text`, or `body_html`).
   */
  const handleInsertVariable = (variableName: string) => {
    if (disabled) {
      return;
    }

    const token = `{{${variableName}}}`;

    let targetField: EditableTemplateField = activeField;
    if (typeof document !== 'undefined') {
      if (document.activeElement === subjectRef.current) {
        targetField = 'subject';
      } else if (document.activeElement === bodyTextRef.current) {
        targetField = 'body_text';
      } else if (document.activeElement === bodyHtmlRef.current) {
        targetField = 'body_html';
      }
    }

    const elementMap: Record<EditableTemplateField, HTMLInputElement | HTMLTextAreaElement | null> =
      {
        subject: subjectRef.current,
        body_text: bodyTextRef.current,
        body_html: bodyHtmlRef.current,
      };

    const element = elementMap[targetField];
    const currentValue = draft[targetField];
    const savedRange = selectionMap[targetField];

    const start =
      element !== null && typeof element.selectionStart === 'number'
        ? element.selectionStart
        : (savedRange?.start ?? currentValue.length);
    const end =
      element !== null && typeof element.selectionEnd === 'number'
        ? element.selectionEnd
        : (savedRange?.end ?? start);

    const safeStart = Math.max(0, Math.min(start, currentValue.length));
    const safeEnd = Math.max(safeStart, Math.min(end, currentValue.length));

    const nextValue = currentValue.slice(0, safeStart) + token + currentValue.slice(safeEnd);
    const nextCursor = safeStart + token.length;

    setSelectionMap((prev) => ({
      ...prev,
      [targetField]: {
        start: nextCursor,
        end: nextCursor,
      },
    }));

    updateFieldValue(targetField, nextValue);

    if (element !== null) {
      element.focus();
      queueMicrotask(() => {
        try {
          element.setSelectionRange(nextCursor, nextCursor);
        } catch {
          // Ignore selection errors on unsupported input states.
        }
      });
    }
  };

  const handleSaveDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || upsertDraft.isPending || publishTemplate.isPending) {
      return;
    }

    setServerError(null);
    setStatusBanner(null);

    if (!validation.ok) {
      if (validation.htmlViolations.length > 0) {
        setServerError(
          toTemplateError({
            code: 'TPL04',
            details: `names: ${validation.htmlViolations.join(',')}`,
          }),
        );
      } else {
        setServerError(
          toTemplateError({
            code: 'TPL01',
            details: `names: ${validation.variableViolations.join(',')}`,
          }),
        );
      }
      return;
    }

    try {
      const ack = await upsertDraft.mutateAsync({
        key: resolvedTemplate.key,
        locale: resolvedTemplate.locale,
        subject: draft.subject,
        body_text: draft.body_text,
        body_html: draft.body_html,
        variables: resolvedTemplate.variables,
        sample_variables: resolvedTemplate.sample_variables,
        requires_tokens: resolvedTemplate.requires_tokens,
        channel: resolvedTemplate.channel,
        layout_key: resolvedTemplate.layout_key,
        direction: resolvedTemplate.direction,
        notes: resolvedTemplate.notes,
        // §2.7 & §3.3: Optimistic lock hash when updating an existing draft.
        expected_hash: resolvedTemplate.status === 'draft' ? resolvedTemplate.content_hash : null,
      });
      setStatusBanner(`DRAFT_SAVED_V${ack.version}`);
      onSaved?.(ack);
    } catch (caught) {
      setServerError(toTemplateError(caught));
    }
  };

  const handlePublish = async () => {
    if (disabled || upsertDraft.isPending || publishTemplate.isPending) {
      return;
    }

    setServerError(null);
    setStatusBanner(null);

    if (!validation.ok) {
      if (validation.htmlViolations.length > 0) {
        setServerError(
          toTemplateError({
            code: 'TPL04',
            details: `names: ${validation.htmlViolations.join(',')}`,
          }),
        );
      } else {
        setServerError(
          toTemplateError({
            code: 'TPL01',
            details: `names: ${validation.variableViolations.join(',')}`,
          }),
        );
      }
      return;
    }

    try {
      let targetVersion = resolvedTemplate.version;
      let expectedUpdatedAt: string | null = resolvedTemplate.updated_at;

      if (
        resolvedTemplate.status !== 'draft' ||
        draft.subject !== resolvedTemplate.subject ||
        draft.body_text !== (resolvedTemplate.body_text ?? '') ||
        draft.body_html !== (resolvedTemplate.body_html ?? '')
      ) {
        const savedDraft = await upsertDraft.mutateAsync({
          key: resolvedTemplate.key,
          locale: resolvedTemplate.locale,
          subject: draft.subject,
          body_text: draft.body_text,
          body_html: draft.body_html,
          variables: resolvedTemplate.variables,
          sample_variables: resolvedTemplate.sample_variables,
          requires_tokens: resolvedTemplate.requires_tokens,
          channel: resolvedTemplate.channel,
          layout_key: resolvedTemplate.layout_key,
          direction: resolvedTemplate.direction,
          notes: resolvedTemplate.notes,
          expected_hash: resolvedTemplate.status === 'draft' ? resolvedTemplate.content_hash : null,
        });
        targetVersion = savedDraft.version;
        expectedUpdatedAt = savedDraft.updated_at;
      }

      const published = await publishTemplate.mutateAsync({
        key: resolvedTemplate.key,
        locale: resolvedTemplate.locale,
        version: targetVersion,
        expected_updated_at: expectedUpdatedAt,
      });
      setStatusBanner(`PUBLISHED_V${published.version}`);
      onPublished?.(published);
    } catch (caught) {
      setServerError(toTemplateError(caught));
    }
  };

  const htmlViolationNames =
    validation.htmlViolations.length > 0
      ? validation.htmlViolations
      : serverError?.code === 'TPL04'
        ? serverError.names
        : [];

  const variableViolationNames =
    validation.variableViolations.length > 0
      ? validation.variableViolations
      : serverError?.code === 'TPL01' || serverError?.code === 'TPL05'
        ? serverError.names
        : [];

  const showHtmlError = htmlViolationNames.length > 0 || serverError?.code === 'TPL04';
  const showVariableError =
    variableViolationNames.length > 0 ||
    serverError?.code === 'TPL01' ||
    serverError?.code === 'TPL05';

  const isBusy = upsertDraft.isPending || publishTemplate.isPending;

  return (
    <div className="@container w-full">
      <form
        onSubmit={(event) => {
          void handleSaveDraft(event);
        }}
        noValidate
        className="border-border bg-card text-card-foreground space-y-4 rounded-2xl border p-4 shadow-xs"
      >
        {/* Header with event key, locale, and version badge (§3.6.2 & §3.6.3) */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <div className="flex items-center gap-2.5">
            <span className="bg-primary/10 text-primary inline-flex size-9 shrink-0 items-center justify-center rounded-xl">
              <FileEdit className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-mono text-xs font-semibold" dir="ltr">
                {resolvedTemplate.key}
              </p>
              <p className="text-muted-foreground font-mono text-[11px]" dir="ltr">
                locale={resolvedTemplate.locale} • dir={resolvedTemplate.direction}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              data-testid="template-version-badge"
              className="border-border bg-muted/50 text-foreground inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs font-medium tabular-nums"
            >
              <span>{t('settings.notifications.templates.version')}:</span>
              <span dir="ltr">
                v{resolvedTemplate.version} ({resolvedTemplate.status})
              </span>
            </span>
          </div>
        </div>

        {/* §2.3 & §3.6.3: Variable Chips bar — clicking inserts {{variable}} at the cursor position */}
        <div className="border-border bg-muted/20 space-y-2 rounded-xl border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
              <Sparkles className="text-primary size-3.5" aria-hidden="true" />
              {t('settings.notifications.templates.variables')}
            </span>
            <span className="text-muted-foreground text-[11px]">
              {t('settings.notifications.templates.insert_variable')} ({activeField})
            </span>
          </div>

          <div
            role="group"
            aria-label={t('settings.notifications.templates.variables')}
            className="flex flex-wrap items-center gap-1.5"
          >
            {resolvedTemplate.variables.map((variable) => (
              <button
                key={variable.name}
                type="button"
                disabled={disabled || isBusy}
                data-testid={`variable-chip-${variable.name}`}
                aria-label={`${t('settings.notifications.templates.insert_variable')} {{${variable.name}}}`}
                onMouseDown={(event) => {
                  // Prevent focus loss on the input/textarea before reading selectionStart/selectionEnd.
                  event.preventDefault();
                }}
                onClick={() => handleInsertVariable(variable.name)}
                className="border-border bg-background hover:border-primary/50 hover:bg-primary/5 text-foreground inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                dir="ltr"
              >
                <span>{`{{${variable.name}}}`}</span>
                <span className="text-muted-foreground text-[10px]">
                  {variable.type}
                  {variable.required ? '*' : ''}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Subject field (`dir="auto"`) */}
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={subjectId} className="block text-xs font-medium">
            {t('settings.notifications.templates.subject')}
          </label>
          <input
            ref={subjectRef}
            id={subjectId}
            name="subject"
            type="text"
            dir="auto"
            maxLength={200}
            disabled={disabled || isBusy}
            value={draft.subject}
            onFocus={(event) => recordFieldSelection('subject', event)}
            onClick={(event) => recordFieldSelection('subject', event)}
            onKeyUp={(event) => recordFieldSelection('subject', event)}
            onSelect={(event) => recordFieldSelection('subject', event)}
            onChange={(event) => {
              recordFieldSelection('subject', event);
              updateFieldValue('subject', event.target.value);
            }}
            className={INPUT_CLASS}
          />
        </div>

        {/* §3.6.2: Responsive container-query grid for Plain Text and HTML Body (`minmax(0,1fr)`) */}
        <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* Plain Text Body (`dir="auto"`) */}
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={bodyTextId} className="block text-xs font-medium">
              {t('settings.notifications.templates.body_text')}
            </label>
            <textarea
              ref={bodyTextRef}
              id={bodyTextId}
              name="body_text"
              rows={8}
              dir="auto"
              disabled={disabled || isBusy}
              value={draft.body_text}
              onFocus={(event) => recordFieldSelection('body_text', event)}
              onClick={(event) => recordFieldSelection('body_text', event)}
              onKeyUp={(event) => recordFieldSelection('body_text', event)}
              onSelect={(event) => recordFieldSelection('body_text', event)}
              onChange={(event) => {
                recordFieldSelection('body_text', event);
                updateFieldValue('body_text', event.target.value);
              }}
              className={`${INPUT_CLASS} leading-relaxed break-words whitespace-pre-wrap`}
            />
          </div>

          {/* HTML Body (`dir="ltr"` for code per §3.6.2) */}
          <div className="min-w-0 space-y-1.5">
            <label
              htmlFor={bodyHtmlId}
              className="flex items-center justify-between gap-2 text-xs font-medium"
            >
              <span>{t('settings.notifications.templates.body_html')}</span>
              <span
                className="text-muted-foreground inline-flex items-center gap-1 font-mono text-[11px]"
                dir="ltr"
              >
                <Code2 className="size-3" aria-hidden="true" />
                dir=&quot;ltr&quot;
              </span>
            </label>
            <textarea
              ref={bodyHtmlRef}
              id={bodyHtmlId}
              name="body_html"
              rows={8}
              dir="ltr"
              disabled={disabled || isBusy}
              value={draft.body_html}
              onFocus={(event) => recordFieldSelection('body_html', event)}
              onClick={(event) => recordFieldSelection('body_html', event)}
              onKeyUp={(event) => recordFieldSelection('body_html', event)}
              onSelect={(event) => recordFieldSelection('body_html', event)}
              onChange={(event) => {
                recordFieldSelection('body_html', event);
                updateFieldValue('body_html', event.target.value);
              }}
              className={`${INPUT_CLASS} font-mono text-xs leading-relaxed break-words whitespace-pre-wrap`}
            />
          </div>
        </div>

        {/* §2.5, §3.4 & §3.6.2: Validation panel below fields for TPL04 (HTML) and TPL01 (Variables) */}
        {(showHtmlError || showVariableError) && (
          <div
            role="status"
            aria-live="polite"
            data-testid="template-validation-errors"
            className="space-y-2"
          >
            {showHtmlError && (
              <div
                data-testid="template-error-tpl04"
                className="border-destructive/40 bg-destructive/10 text-destructive flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
                  <span>{t('settings.notifications.templates.error_html')}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px]" dir="ltr">
                  <span className="font-semibold">TPL04</span>
                  {validation.firstHtmlViolationLine !== null && (
                    <span>line {validation.firstHtmlViolationLine}</span>
                  )}
                  {htmlViolationNames.length > 0 && <span>[{htmlViolationNames.join(', ')}]</span>}
                </div>
              </div>
            )}

            {showVariableError && (
              <div
                data-testid="template-error-tpl01"
                className="border-destructive/40 bg-destructive/10 text-destructive flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
                  <span>{t('settings.notifications.templates.error_variable')}</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px]" dir="ltr">
                  <span className="font-semibold">
                    {serverError?.code === 'TPL05' ? 'TPL05' : 'TPL01'}
                  </span>
                  {variableViolationNames.length > 0 && (
                    <span>[{variableViolationNames.join(', ')}]</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {serverError !== null &&
          serverError.code !== 'TPL04' &&
          serverError.code !== 'TPL01' &&
          serverError.code !== 'TPL05' && (
            <p
              role="alert"
              data-testid="template-server-error"
              className="text-destructive inline-flex items-center gap-1.5 font-mono text-xs"
            >
              <ShieldAlert className="size-3.5" aria-hidden="true" />
              {serverError.code}
            </p>
          )}

        {statusBanner !== null && (
          <p
            role="status"
            aria-live="polite"
            data-testid="template-status-banner"
            className="text-success inline-flex items-center gap-1.5 font-mono text-xs"
          >
            <Check className="size-3.5" aria-hidden="true" />
            {statusBanner}
          </p>
        )}

        {/* Action buttons: Save Draft & Publish (§2.7 & §3.6.2) */}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            type="submit"
            disabled={disabled || isBusy}
            className={`${BUTTON_CLASS} border-border bg-background hover:bg-muted border`}
          >
            {upsertDraft.isPending && (
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {t('settings.notifications.templates.save_draft')}
          </button>

          <button
            type="button"
            disabled={disabled || isBusy}
            onClick={() => {
              void handlePublish();
            }}
            className={`${BUTTON_CLASS} bg-primary text-primary-foreground hover:opacity-90`}
          >
            {publishTemplate.isPending ? (
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Send className="size-3.5" aria-hidden="true" />
            )}
            {t('settings.notifications.templates.publish')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default TemplateEditor;
