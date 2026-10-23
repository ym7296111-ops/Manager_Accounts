import { AlertCircle, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { PasswordField } from '@/components/auth/PasswordField';
import { PASSWORD_CHANGE_ERROR_KEYS } from '@/components/auth/passwordErrorKeys';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { changePassword } from '@/lib/passwordRecovery';
import { PASSWORD_POLICY, validatePassword } from '@/lib/validatePassword';

export interface ChangePasswordDialogProps {
  readonly open: boolean;
  readonly email: string;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

function ChangePasswordDialogBody({
  email,
  onClose,
  onSuccess,
}: Omit<ChangePasswordDialogProps, 'open'>) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [policyKeys, setPolicyKeys] = useState<TranslationKey[]>([]);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  /* Focus management & restoration matching ConfirmRoleDialog / PasswordRevealDialog. */
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstInput = panelRef.current?.querySelector<HTMLInputElement>(
      '#profile-current-password',
    );
    if (firstInput !== null && firstInput !== undefined) {
      firstInput.focus();
    } else {
      cancelRef.current?.focus();
    }
    return () => previous?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!submitting) {
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusables = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([aria-disabled="true"]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (first !== undefined && last !== undefined) {
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const result = validatePassword(newPassword, { confirm: confirmPassword });
    if (!result.valid) {
      setPolicyKeys(result.errors);
      setErrorKey(null);
      return;
    }

    setPolicyKeys([]);
    setErrorKey(null);
    setSubmitting(true);
    const { error } = await changePassword({
      email,
      currentPassword,
      newPassword,
    });
    setSubmitting(false);

    if (error !== null) {
      setErrorKey(PASSWORD_CHANGE_ERROR_KEYS[error]);
      return;
    }

    /* Never keep a password in memory after a successful write. */
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    onSuccess();
    onClose();
  }

  const newPasswordError = policyKeys.includes('password.error.required')
    ? t('password.error.required')
    : policyKeys.includes('password.error.tooShort')
      ? t('password.error.tooShort')
      : null;
  const confirmError = policyKeys.includes('password.error.mismatch')
    ? t('password.error.mismatch')
    : null;

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={handleKeyDown}
        className="bg-card text-card-foreground animate-scale-in border-border w-full max-w-md rounded-2xl border p-5 shadow-xl motion-reduce:animate-none sm:p-6"
      >
        <div className="flex items-center gap-2.5">
          <span className="bg-primary/10 text-primary grid size-8 place-items-center rounded-lg">
            <KeyRound className="size-4" aria-hidden="true" />
          </span>
          <h2 id={titleId} className="text-card-foreground text-base font-semibold">
            {t('profile.password.dialog_title')}
          </h2>
        </div>
        <p id={bodyId} className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
          {t('profile.security.description')}
        </p>

        {errorKey !== null && (
          <div
            id={errorId}
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span>{t(errorKey)}</span>
            {errorKey === 'password.error.notAuthenticated' && (
              <Link
                to="/login"
                className="text-foreground inline-flex items-center gap-1 text-xs font-semibold underline-offset-4 hover:underline"
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t('password.error.signInAgain')}
              </Link>
            )}
          </div>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} noValidate className="mt-4 space-y-4">
          <PasswordField
            id="profile-current-password"
            label={t('profile.security.currentPassword')}
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            hint={t('profile.security.currentHint')}
            optional
            disabled={submitting}
          />
          <PasswordField
            id="profile-new-password"
            label={t('profile.security.newPassword')}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            hint={t('password.policy.hint', { min: PASSWORD_POLICY.minLength })}
            error={newPasswordError}
            disabled={submitting}
          />
          <PasswordField
            id="profile-confirm-password"
            label={t('profile.security.confirmPassword')}
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
            error={confirmError}
            disabled={submitting}
          />

          <div className="mt-5 flex flex-col-reverse gap-2.5 pt-1 sm:flex-row sm:justify-end">
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="border-border bg-background text-foreground hover:bg-accent inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('profile.password.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="bg-primary text-primary-foreground inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting && (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {submitting ? t('common.loading') : t('profile.password.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function ChangePasswordDialog({ open, ...props }: ChangePasswordDialogProps) {
  if (!open) {
    return null;
  }
  return <ChangePasswordDialogBody {...props} />;
}

export default ChangePasswordDialog;
