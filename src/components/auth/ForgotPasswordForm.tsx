import { AlertCircle, Info, Loader2, Send, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { isValidEmail } from '@/lib/email';
import { submitPasswordResetRequest, type ManualResetErrorCode } from '@/lib/manualPasswordReset';

/**
 * Email-only manual recovery request. The new password is entered by an
 * authorized administrator at approval time and is sent directly to the
 * `admin-reset-password` Edge Function; this form never handles a password.
 * The independent OTP helpers in `src/lib/passwordRecovery.ts` are untouched.
 */

const FIELD_CLASS =
  'w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-shadow focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

const PRIMARY_BUTTON_CLASS =
  'inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

const SUBMIT_ERROR_KEYS: Record<ManualResetErrorCode, TranslationKey> = {
  'not-configured': 'login.error.misconfigured',
  'not-deployed': 'forgot.manual.error.notDeployed',
  'duplicate-pending': 'forgot.manual.error.duplicatePending',
  'rate-limited': 'login.error.rateLimited',
  network: 'login.error.network',
  unknown: 'forgot.manual.error.unknown',
};

export interface ForgotPasswordFormProps {
  /** The visitor abandoned the recovery: return to the sign-in form. */
  onBack: () => void;
  /** Request acknowledged; return to the sign-in form. */
  onSuccess: () => void;
}

export function ForgotPasswordForm({ onBack, onSuccess }: ForgotPasswordFormProps) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const address = email.trim();
    if (address === '') {
      setErrorKey('forgot.error.requiredEmail');
      return;
    }
    if (!isValidEmail(address)) {
      setErrorKey('forgot.error.invalidEmail');
      return;
    }

    setErrorKey(null);
    setSubmitting(true);
    const { error } = await submitPasswordResetRequest({ email: address });
    setSubmitting(false);
    if (error !== null) {
      setErrorKey(SUBMIT_ERROR_KEYS[error]);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="space-y-5">
        <div
          role="status"
          className="border-success/40 bg-success/10 text-success flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('forgot.manual.success')}</span>
        </div>
        <p className="text-muted-foreground text-center text-sm">
          <button
            type="button"
            onClick={onSuccess}
            className="text-primary font-semibold underline-offset-4 hover:underline"
          >
            {t('forgot.backToSignIn')}
          </button>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="space-y-5">
      <div
        role="note"
        className="border-warning/40 bg-warning/10 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
      >
        <Info className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="text-muted-foreground text-xs leading-relaxed">
          {t('forgot.manual.notice')}
        </span>
      </div>

      {errorKey !== null && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
          <span>{t(errorKey)}</span>
        </div>
      )}

      <div>
        <label htmlFor="forgot-email" className="mb-1.5 block text-sm font-medium">
          {t('login.email')}
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          dir="ltr"
          placeholder={t('login.emailPlaceholder')}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={FIELD_CLASS}
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground`}
      >
        {submitting ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <Send className="size-4" aria-hidden="true" />
        )}
        {submitting ? t('common.loading') : t('forgot.manual.submit')}
      </button>

      <p className="text-muted-foreground text-center text-sm">
        <button
          type="button"
          onClick={onBack}
          className="text-primary font-semibold underline-offset-4 hover:underline"
        >
          {t('forgot.backToSignIn')}
        </button>
      </p>
    </form>
  );
}
