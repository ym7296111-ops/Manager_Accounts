import { Check, KeyRound, Loader2, ShieldAlert, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  toTransportError,
  useNotificationTransport,
  type TransportErrorCode,
} from '@/hooks/useNotificationTransport';
import { useClearTransportPassword, useSetTransportPassword } from '@/hooks/useUpdateTransport';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Write-only SMTP Secret Manager (Phase 3.1).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §1.3 & §1.5: Plaintext secrets never leave the write path; the UI only ever receives
 *   `has_password`, an 8-character `fingerprint` prefix, and `updated_at`.
 * - §3.4: Errors are value-free normalized codes (`FORBIDDEN`, `VALIDATION`, `MAIL01`, `MAIL03`, `SEC01`).
 * - §3.6.1: Uses `@container` queries exclusively (zero `@media` viewport breakpoints).
 * - §3.6.3 (Golden Rule):
 *   1. "Change Password" opens an isolated dialog (`role="dialog"`).
 *   2. Password input uses `type="password"`, `autoComplete="new-password"`, and an
 *      unconventional `name="np_7x9k"` to prevent browser password manager auto-fill injection.
 *   3. Immediately upon submission, the password value is wiped from React state (`setPassword('')`)
 *      and the DOM node; it is NEVER stored in TanStack Query cache or `localStorage`.
 *   4. "Clear Secret" requires explicit confirmation in a dedicated dialog before execution.
 */

export interface SecretManagerProps {
  /** §3.6.3: Masked boolean status indicating whether a secret is stored. */
  readonly hasPassword?: boolean;
  /** §1.3 & §3.6.3: First 8 hex characters of the secret's SHA-256 fingerprint. */
  readonly fingerprint?: string | null;
  /** Timestamp of the last transport/credential update. */
  readonly updatedAt?: string | null;
  /** Optimistic concurrency counter (`secrets_version`, §1.2.1). */
  readonly secretsVersion?: number;
  /** Target carrier slug (defaults to `default-smtp`). */
  readonly transportSlug?: string;
  /** Disables secret mutations when the caller lacks `settings.manage`. */
  readonly disabled?: boolean;
  /** Optional custom handler for password rotation (also used in isolated unit tests). */
  readonly onSubmitPassword?: (newPassword: string) => Promise<void> | void;
  /** Optional custom handler for clearing the stored secret. */
  readonly onClearPassword?: () => Promise<void> | void;
}

const BUTTON_BASE_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

export function SecretManager({
  hasPassword: hasPasswordProp,
  fingerprint: fingerprintProp,
  updatedAt: updatedAtProp,
  secretsVersion: secretsVersionProp,
  transportSlug = 'default-smtp',
  disabled = false,
  onSubmitPassword,
  onClearPassword,
}: SecretManagerProps) {
  const { t, locale } = useI18n();
  // Query the masked snapshot only when status props are not supplied by the parent.
  const shouldFetchSnapshot =
    hasPasswordProp === undefined && fingerprintProp === undefined && updatedAtProp === undefined;
  const { transport } = useNotificationTransport({ enabled: shouldFetchSnapshot });
  const setPasswordMutation = useSetTransportPassword();
  const clearPasswordMutation = useClearTransportPassword();

  // §3.6.3: Write-only local state — exists solely while typing inside the dialog and is
  // wiped immediately upon submission or dialog dismissal. Never persisted or cached.
  const [password, setPassword] = useState<string>('');
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState<boolean>(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorCode, setErrorCode] = useState<TransportErrorCode | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const passwordInputRef = useRef<HTMLInputElement>(null);
  const passwordInputId = useId();
  const passwordDialogTitleId = useId();
  const clearDialogTitleId = useId();

  // §3.6.3: Display masked status fields only (`has_password`, 8-char `fingerprint`, `updated_at`).
  const effectiveHasPassword = hasPasswordProp ?? transport?.has_password ?? false;
  const rawFingerprint = fingerprintProp !== undefined ? fingerprintProp : transport?.fingerprint;
  const effectiveFingerprint =
    typeof rawFingerprint === 'string' && rawFingerprint.trim().length > 0
      ? rawFingerprint.trim().slice(0, 8)
      : null;
  const effectiveUpdatedAt =
    updatedAtProp !== undefined ? updatedAtProp : (transport?.updated_at ?? null);
  const effectiveSecretsVersion = secretsVersionProp ?? transport?.secrets_version;

  // §3.6.3: Helper that zeroes both React state and the underlying input element value.
  const wipePasswordState = useCallback(() => {
    setPassword('');
    if (passwordInputRef.current !== null) {
      passwordInputRef.current.value = '';
    }
  }, []);

  useEffect(() => {
    return () => {
      // §3.6.3: Guarantee secret state is wiped on unmount.
      wipePasswordState();
    };
  }, [wipePasswordState]);

  const openPasswordDialog = () => {
    wipePasswordState();
    setErrorCode(null);
    setStatusMessage(null);
    setIsPasswordDialogOpen(true);
  };

  const closePasswordDialog = () => {
    // §3.6.3: Always purge any typed characters when closing the dialog.
    wipePasswordState();
    setErrorCode(null);
    setIsPasswordDialogOpen(false);
  };

  const handlePasswordDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !isSubmitting) {
      event.preventDefault();
      closePasswordDialog();
    }
  };

  const handleClearDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !isSubmitting) {
      event.preventDefault();
      setIsClearConfirmOpen(false);
    }
  };

  const handlePasswordSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = password;
    if (candidate.trim().length === 0 || disabled || isSubmitting) {
      return;
    }

    setErrorCode(null);
    setStatusMessage(null);
    setIsSubmitting(true);

    try {
      if (onSubmitPassword !== undefined) {
        await onSubmitPassword(candidate);
      } else {
        await setPasswordMutation.mutateAsync({
          new_password: candidate,
          transport_slug: transportSlug,
          expected_secrets_version: effectiveSecretsVersion,
          expected_updated_at: effectiveUpdatedAt,
        });
      }
      // §3.6.3 (Golden Rule): Immediately wipe the password from state after successful submission.
      wipePasswordState();
      setStatusMessage('ROTATED_OK');
    } catch (caught) {
      // §3.4 & §3.6.3: Wipe the password even on error and expose only a value-free error code.
      wipePasswordState();
      setErrorCode(toTransportError(caught).code);
    } finally {
      wipePasswordState();
      setIsSubmitting(false);
    }
  };

  const handleConfirmClearPassword = async () => {
    if (disabled || isSubmitting) {
      return;
    }

    setErrorCode(null);
    setStatusMessage(null);
    setIsSubmitting(true);

    try {
      if (onClearPassword !== undefined) {
        await onClearPassword();
      } else {
        await clearPasswordMutation.mutateAsync({
          transport_slug: transportSlug,
          expected_secrets_version: effectiveSecretsVersion,
          expected_updated_at: effectiveUpdatedAt,
        });
      }
      wipePasswordState();
      setIsClearConfirmOpen(false);
      setStatusMessage('CLEARED_OK');
    } catch (caught) {
      setErrorCode(toTransportError(caught).code);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="@container space-y-3">
      {/* §3.6.3: Read-only masked credential status card (has_password, 8-char fingerprint, updated_at) */}
      <div className="border-border bg-muted/30 rounded-xl border p-3.5">
        <div className="flex flex-col gap-3 @md:flex-row @md:items-center @md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <KeyRound className="text-primary size-4 shrink-0" aria-hidden="true" />
              <span className="text-foreground text-sm font-semibold">
                {t('settings.notifications.transport.password')}
              </span>
              <span
                data-testid="secret-has-password"
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium',
                  effectiveHasPassword
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-border bg-muted text-muted-foreground',
                ].join(' ')}
              >
                has_password: {String(effectiveHasPassword)}
              </span>
            </div>

            <dl className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
              <div className="inline-flex items-center gap-1">
                <dt className="font-sans">fingerprint:</dt>
                <dd data-testid="secret-fingerprint" dir="ltr" className="text-foreground">
                  {effectiveFingerprint ?? '—'}
                </dd>
              </div>
              <div className="inline-flex items-center gap-1">
                <dt className="font-sans">updated_at:</dt>
                <dd data-testid="secret-updated-at" dir="ltr" className="tabular-nums">
                  {effectiveUpdatedAt ?? '—'}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* §3.6.3: Opens standalone password rotation dialog */}
            <button
              type="button"
              disabled={disabled || isSubmitting}
              onClick={openPasswordDialog}
              className={`${BUTTON_BASE_CLASS} bg-primary text-primary-foreground hover:opacity-90`}
            >
              <KeyRound className="size-3.5" aria-hidden="true" />
              {t('settings.notifications.transport.change_password')}
            </button>

            {/* §3.6.3: Explicit "Clear Secret" button with confirmation step */}
            <button
              type="button"
              disabled={disabled || isSubmitting}
              onClick={() => {
                setErrorCode(null);
                setStatusMessage(null);
                setIsClearConfirmOpen(true);
              }}
              className={`${BUTTON_BASE_CLASS} border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 border`}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t('settings.notifications.transport.clear_password')}
            </button>
          </div>
        </div>

        {statusMessage !== null && (
          <p
            role="status"
            aria-live="polite"
            className="text-success mt-2 inline-flex items-center gap-1.5 font-mono text-xs"
          >
            <Check className="size-3.5" aria-hidden="true" />
            {statusMessage}
          </p>
        )}

        {errorCode !== null && (
          <p
            role="alert"
            className="text-destructive mt-2 inline-flex items-center gap-1.5 font-mono text-xs"
          >
            <ShieldAlert className="size-3.5" aria-hidden="true" />
            {errorCode}
          </p>
        )}
      </div>

      {/* §3.6.3: Standalone dialog for write-only password rotation */}
      {isPasswordDialogOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={passwordDialogTitleId}
          onKeyDown={handlePasswordDialogKeyDown}
          className="border-border bg-card text-card-foreground rounded-2xl border p-4 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 id={passwordDialogTitleId} className="text-sm font-semibold">
              {t('settings.notifications.transport.change_password')}
            </h3>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={closePasswordDialog}
              aria-label={t('identity.confirm.cancel')}
              className="text-muted-foreground hover:text-foreground rounded-lg p-1"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <form
            onSubmit={(event) => void handlePasswordSubmit(event)}
            autoComplete="off"
            className="mt-3 space-y-3"
          >
            <div className="space-y-1.5">
              <label htmlFor={passwordInputId} className="block text-xs font-medium">
                {t('settings.notifications.transport.password')}
              </label>
              {/* §3.6.3: type="password", autoComplete="new-password", and unconventional name="np_7x9k"
                  to block password manager auto-fill injection */}
              <input
                ref={passwordInputRef}
                id={passwordInputId}
                type="password"
                name="np_7x9k"
                autoComplete="new-password"
                dir="ltr"
                disabled={disabled || isSubmitting}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </div>

            <div className="flex flex-col-reverse gap-2 @sm:flex-row @sm:justify-end">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={closePasswordDialog}
                className={`${BUTTON_BASE_CLASS} border-border bg-background border`}
              >
                {t('identity.confirm.cancel')}
              </button>
              <button
                type="submit"
                disabled={disabled || isSubmitting || password.trim().length === 0}
                className={`${BUTTON_BASE_CLASS} bg-primary text-primary-foreground`}
              >
                {isSubmitting && (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                {t('identity.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* §3.6.3: Explicit confirmation dialog before clearing the stored secret */}
      {isClearConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={clearDialogTitleId}
          onKeyDown={handleClearDialogKeyDown}
          className="border-destructive/40 bg-card text-card-foreground rounded-2xl border p-4 shadow-lg"
        >
          <h3 id={clearDialogTitleId} className="text-destructive text-sm font-semibold">
            {t('settings.notifications.transport.clear_password')}
          </h3>
          <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
            {locale === 'ar'
              ? 'سيتم مسح السرّ المُعمّى وتعطيل الناقل فوراً مع تسجيل العملية في سجل التدقيق.'
              : 'The encrypted secret will be wiped and the transport will be disabled immediately.'}
          </p>
          <div className="mt-3 flex flex-col-reverse gap-2 @sm:flex-row @sm:justify-end">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setIsClearConfirmOpen(false)}
              className={`${BUTTON_BASE_CLASS} border-border bg-background border`}
            >
              {t('identity.confirm.cancel')}
            </button>
            <button
              type="button"
              disabled={disabled || isSubmitting}
              onClick={() => void handleConfirmClearPassword()}
              className={`${BUTTON_BASE_CLASS} bg-destructive text-destructive-foreground`}
            >
              {isSubmitting && (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {t('settings.notifications.transport.clear_password')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default SecretManager;
