import { AlertCircle, Check, Link2Off, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { PasswordField } from '@/components/auth/PasswordField';
import { LanguageToggle, ThemeToggle } from '@/components/layout/HeaderToggles';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { PASSWORD_CHANGE_ERROR_KEYS } from '@/components/auth/passwordErrorKeys';
import { updatePassword } from '@/lib/passwordRecovery';
import { getSupabase } from '@/lib/supabase';
import { PASSWORD_POLICY, validatePassword } from '@/lib/validatePassword';

/**
 * Reset password screen (`/reset-password`, public like `/login`).
 *
 * The recovery session is opened by the Supabase client itself
 * (`detectSessionInUrl`, PKCE code exchange) before this screen renders, so
 * the page never handles a token by hand: it waits until that session becomes
 * observable, offers the new-password form, and hands the value to
 * `updateUser`. A link that is expired, already used, or opened outside a
 * recovery flow falls back to an explicit "request a new link" state.
 *
 * Deliberately outside `DashboardLayout`: the visitor is not signed in yet.
 */

/** How long we wait for the client to publish the recovery session. */
export const RECOVERY_SESSION_GRACE_MS = 6000;

/** Delay between a successful write and the hand-off to the sign-in screen. */
export const REDIRECT_DELAY_MS = 1500;

type RecoveryState = 'checking' | 'ready' | 'invalid';

export interface ResetPasswordPageProps {
  /** Overridable grace period (tests); production uses the module constant. */
  graceMs?: number;
  /** Overridable hand-off delay (tests); production uses the module constant. */
  redirectDelayMs?: number;
}

export default function ResetPasswordPage({
  graceMs = RECOVERY_SESSION_GRACE_MS,
  redirectDelayMs = REDIRECT_DELAY_MS,
}: ResetPasswordPageProps = {}) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const [recovery, setRecovery] = useState<RecoveryState>(() =>
    /* Without a client there is no recovery flow to wait for. */
    getSupabase() === null ? 'invalid' : 'checking',
  );
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [policyKeys, setPolicyKeys] = useState<TranslationKey[]>([]);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [success, setSuccess] = useState(false);

  /* Wait for the recovery session the client opens from the emailed link: the
     PKCE exchange may still be in flight, so `getSession` and the auth
     listener both count, and the grace period decides the fallback. */
  useEffect(() => {
    const client = getSupabase();
    if (client === null) {
      /* Already resolved by the state initializer. */
      return;
    }

    let cancelled = false;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) {
        return;
      }
      if (event === 'PASSWORD_RECOVERY' || (nextSession !== null && event === 'SIGNED_IN')) {
        setRecovery('ready');
      }
    });

    void client.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled && data.session !== null) {
          setRecovery('ready');
        }
      })
      .catch(() => undefined);

    const timer = window.setTimeout(() => {
      if (!cancelled) {
        setRecovery('invalid');
      }
    }, graceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [graceMs]);

  /* Hand the freshly authenticated visitor back to the sign-in screen. */
  useEffect(() => {
    if (!success) {
      return;
    }
    const timer = window.setTimeout(() => {
      void navigate('/login', { replace: true });
    }, redirectDelayMs);
    return () => window.clearTimeout(timer);
  }, [success, redirectDelayMs, navigate]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const result = validatePassword(newPassword, { confirm: confirmPassword });
    if (!result.valid) {
      setPolicyKeys(result.errors);
      setErrorKey(null);
      setSuccess(false);
      return;
    }

    setPolicyKeys([]);
    setErrorKey(null);
    setSubmitting(true);
    const { error } = await updatePassword(newPassword);
    setSubmitting(false);

    if (error !== null) {
      setErrorKey(PASSWORD_CHANGE_ERROR_KEYS[error]);
      return;
    }

    /* The recovery session is spent: drop the value from memory. */
    setNewPassword('');
    setConfirmPassword('');
    setSuccess(true);
  }

  const newPasswordError = policyKeys.includes('password.error.required')
    ? t('password.error.required')
    : policyKeys.includes('password.error.tooShort')
      ? t('password.error.tooShort')
      : null;
  const confirmError = policyKeys.includes('password.error.mismatch')
    ? t('password.error.mismatch')
    : null;

  return (
    <div className="bg-background flex min-h-dvh flex-col">
      <div className="flex items-center justify-between px-5 py-6 sm:px-10">
        <div className="flex items-center gap-2.5">
          <span className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-lg">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <span className="text-foreground text-sm font-semibold">{t('app.name')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-md">
          <header className="mb-8 space-y-2">
            <h1 className="text-foreground text-2xl font-bold tracking-tight">
              {t('reset.title')}
            </h1>
            <p className="text-muted-foreground text-sm">{t('reset.subtitle')}</p>
          </header>

          {recovery === 'checking' && (
            <div role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="text-primary size-4 animate-spin" aria-hidden="true" />
              {t('reset.checking')}
            </div>
          )}

          {recovery === 'invalid' && (
            <section className="border-destructive/30 bg-card rounded-2xl border p-6 text-center">
              <Link2Off className="text-destructive mx-auto size-9" aria-hidden="true" />
              <h2 className="mt-3 text-lg font-bold">{t('reset.invalid.title')}</h2>
              <p className="text-muted-foreground mt-2 text-sm">{t('reset.invalid.body')}</p>
              <Link
                to="/login"
                className="bg-primary text-primary-foreground mt-5 inline-flex rounded-lg px-4 py-2 text-sm font-semibold"
              >
                {t('reset.invalid.back')}
              </Link>
            </section>
          )}

          {recovery === 'ready' && !success && (
            <form onSubmit={(event) => void handleSubmit(event)} noValidate className="space-y-5">
              {errorKey !== null && (
                <div
                  role="alert"
                  className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
                >
                  <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                  <span>{t(errorKey)}</span>
                </div>
              )}

              <PasswordField
                id="reset-new-password"
                label={t('profile.security.newPassword')}
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                hint={t('password.policy.hint', { min: PASSWORD_POLICY.minLength })}
                error={newPasswordError}
                disabled={submitting}
              />

              <PasswordField
                id="reset-confirm-password"
                label={t('profile.security.confirmPassword')}
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                error={confirmError}
                disabled={submitting}
              />

              <button
                type="submit"
                disabled={submitting}
                className="bg-primary text-primary-foreground inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                {submitting ? t('common.loading') : t('reset.submit')}
              </button>

              <p className="text-muted-foreground text-center text-sm">
                <Link
                  to="/login"
                  className="text-primary font-semibold underline-offset-4 hover:underline"
                >
                  {t('forgot.backToSignIn')}
                </Link>
              </p>
            </form>
          )}

          {success && (
            <div className="space-y-5">
              <div
                role="status"
                className="border-success/40 bg-success/10 text-success flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
              >
                <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t('reset.success')}</span>
              </div>
              <p className="text-muted-foreground text-center text-sm">
                <Link
                  to="/login"
                  className="text-primary font-semibold underline-offset-4 hover:underline"
                >
                  {t('forgot.backToSignIn')}
                </Link>
              </p>
            </div>
          )}

          <p className="text-muted-foreground mt-8 text-center text-xs">{t('reset.policyNote')}</p>
        </div>
      </div>
    </div>
  );
}
