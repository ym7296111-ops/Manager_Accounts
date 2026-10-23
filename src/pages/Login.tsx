import { AlertCircle, Check, Eye, EyeOff, Info, Loader2, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';
import { LanguageToggle, ThemeToggle } from '@/components/layout/HeaderToggles';
import { useAuth, type AuthErrorCode } from '@/context/AuthContext';
import { useBranding } from '@/context/BrandingContext';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { isValidEmail } from '@/lib/email';

/**
 * Standalone sign-in screen.
 *
 * Deliberately independent from the dashboard shell (no DashboardLayout, no
 * sidebar, no topbar): a public split layout with brand panel + auth card,
 * wired to real Supabase email/password authentication.
 */

const AUTH_ERROR_KEYS: Record<AuthErrorCode, TranslationKey> = {
  'not-configured': 'login.error.misconfigured',
  'invalid-credentials': 'login.error.invalidCredentials',
  'email-not-confirmed': 'login.error.emailNotConfirmed',
  'pending-approval': 'login.error.pendingApproval',
  'rejected-approval': 'login.error.rejectedApproval',
  'rate-limited': 'login.error.rateLimited',
  'signup-disabled': 'signup.error.disabled',
  'weak-password': 'signup.error.weakPassword',
  network: 'login.error.network',
  unknown: 'login.error.generic',
};

/** Three screens share one card: sign in, sign up, and the recovery step. */
type LoginMode = 'sign-in' | 'sign-up' | 'forgot';

const MODE_TITLE: Record<LoginMode, TranslationKey> = {
  'sign-in': 'login.title',
  'sign-up': 'signup.title',
  forgot: 'forgot.title',
};

const MODE_SUBTITLE: Record<LoginMode, TranslationKey> = {
  'sign-in': 'login.subtitle',
  'sign-up': 'signup.subtitle',
  forgot: 'forgot.subtitle',
};

export default function Login() {
  const { t } = useI18n();
  const { displayName, logoUrl } = useBranding();
  const { session, loading, configured, signIn, signUp } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<LoginMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [successKey, setSuccessKey] = useState<TranslationKey | null>(null);

  /* Always route authenticated sign-ins cleanly to the home dashboard (`/`),
     never replaying stale or unauthorized `redirectTo` / `from` paths. */
  if (!loading && session !== null) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    /* Client-side validation keeps failures fast and translatable. */
    if (email.trim() === '') {
      setErrorKey('login.error.requiredEmail');
      return;
    }
    if (!isValidEmail(email)) {
      setErrorKey('login.error.invalidEmail');
      return;
    }
    if (password === '') {
      setErrorKey('login.error.requiredPassword');
      return;
    }

    setErrorKey(null);
    setSuccessKey(null);
    setSubmitting(true);

    if (mode === 'sign-in') {
      const { error } = await signIn(email.trim(), password);
      setSubmitting(false);

      if (error !== null) {
        setErrorKey(AUTH_ERROR_KEYS[error]);
        return;
      }

      void navigate('/', { replace: true });
      return;
    }

    const { error, outcome } = await signUp(email.trim(), password);
    setSubmitting(false);

    if (error !== null) {
      setErrorKey(
        mode === 'sign-up' && error === 'unknown' ? 'signup.error.generic' : AUTH_ERROR_KEYS[error],
      );
      return;
    }

    setPassword('');
    /* Distinct signup outcomes: the first registrant is the founder (owner,
       activated immediately); everyone else awaits administration approval. */
    setSuccessKey(outcome === 'first-owner' ? 'signup.firstOwner' : 'signup.pendingApproval');
  }

  const fieldClassName =
    'w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-shadow focus:border-primary/60 focus:ring-2 focus:ring-primary/25';

  return (
    <div className="bg-background grid min-h-dvh lg:grid-cols-[1fr_1.05fr]">
      {/* ---------------------------------------------------------- form side */}
      <div className="flex flex-col px-5 py-8 sm:px-10 lg:px-16">
        <div className="flex items-center justify-between">
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

        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-md">
            <header className="mb-8 space-y-2">
              <h1 className="text-foreground text-2xl font-bold tracking-tight">
                {t(MODE_TITLE[mode])}
              </h1>
              <p className="text-muted-foreground text-sm">{t(MODE_SUBTITLE[mode])}</p>
            </header>

            {!configured && (
              <div
                role="status"
                className="border-warning/40 bg-warning/10 mb-5 flex items-start gap-3 rounded-xl border px-4 py-3"
              >
                <Info className="text-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="text-xs leading-relaxed">
                  <p className="text-foreground font-semibold">{t('login.notConfiguredTitle')}</p>
                  <p className="text-muted-foreground mt-1">{t('login.notConfiguredBody')}</p>
                </div>
              </div>
            )}

            {errorKey !== null && mode !== 'forgot' && (
              <div
                role="alert"
                className="border-destructive/40 bg-destructive/10 text-destructive mb-5 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm"
              >
                <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
                <span>{t(errorKey)}</span>
              </div>
            )}

            {successKey !== null && (
              <div
                role="status"
                className="border-success/40 bg-success/10 text-success mb-5 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
              >
                <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>{t(successKey)}</span>
              </div>
            )}

            {mode === 'forgot' ? (
              <ForgotPasswordForm
                onBack={() => {
                  setMode('sign-in');
                  setErrorKey(null);
                  setSuccessKey(null);
                }}
                onSuccess={() => {
                  setMode('sign-in');
                  setErrorKey(null);
                  /* The request was submitted (manual approval flow): the
                     banner repeats that an administrator must approve it
                     before the new password works. */
                  setSuccessKey('forgot.manual.success');
                }}
              />
            ) : (
              <>
                <form
                  onSubmit={(event) => void handleSubmit(event)}
                  noValidate
                  className="space-y-5"
                >
                  <div>
                    <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium">
                      {t('login.email')}
                    </label>
                    <input
                      id="login-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      dir="ltr"
                      placeholder={t('login.emailPlaceholder')}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      className={fieldClassName}
                    />
                  </div>

                  <div>
                    <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium">
                      {t('login.password')}
                    </label>
                    <div className="relative">
                      <input
                        id="login-password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                        dir="ltr"
                        placeholder={t('login.passwordPlaceholder')}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className={`${fieldClassName} pe-11`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((previous) => !previous)}
                        aria-label={
                          showPassword ? t('login.hidePassword') : t('login.showPassword')
                        }
                        className="text-muted-foreground hover:text-foreground absolute inset-y-0 end-0 grid w-11 place-items-center transition-colors"
                      >
                        {showPassword ? (
                          <EyeOff className="size-4" aria-hidden="true" />
                        ) : (
                          <Eye className="size-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting || loading}
                    className="bg-primary text-primary-foreground inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                    {submitting
                      ? t('common.loading')
                      : t(mode === 'sign-in' ? 'login.submit' : 'signup.submit')}
                  </button>
                </form>

                {mode === 'sign-in' && (
                  <p className="mt-4 text-center text-sm">
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => {
                        setMode('forgot');
                        setErrorKey(null);
                        setSuccessKey(null);
                      }}
                      className="text-muted-foreground hover:text-primary font-semibold underline-offset-4 hover:underline disabled:opacity-60"
                    >
                      {t('forgot.link')}
                    </button>
                  </p>
                )}

                <p className="text-muted-foreground mt-5 text-center text-sm">
                  <span>{t(mode === 'sign-in' ? 'login.noAccount' : 'signup.hasAccount')}</span>{' '}
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => {
                      setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                      setErrorKey(null);
                      setSuccessKey(null);
                    }}
                    className="text-primary font-semibold underline-offset-4 hover:underline disabled:opacity-60"
                  >
                    {t(mode === 'sign-in' ? 'login.createAccount' : 'signup.signIn')}
                  </button>
                </p>

                {mode === 'sign-in' && (
                  <p className="text-muted-foreground mt-6 flex items-center gap-2 text-xs">
                    <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
                    {t('login.secureNote')}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- brand side */}
      <aside className="from-primary via-primary/90 relative hidden overflow-hidden bg-gradient-to-br to-slate-900 lg:block">
        <div
          aria-hidden="true"
          className="absolute inset-0 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:28px_28px] opacity-25"
        />
        <div className="text-primary-foreground relative flex h-full flex-col justify-center gap-8 px-14 py-16">
          <div className="space-y-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur">
              Cloud-Only
            </span>
            <div className="flex items-center gap-3">
              {logoUrl !== null ? (
                <img
                  src={logoUrl}
                  alt=""
                  className="size-12 rounded-xl bg-white/10 object-contain p-1"
                />
              ) : (
                <span className="grid size-12 place-items-center rounded-xl bg-white/15">
                  <ShieldCheck className="size-6" aria-hidden="true" />
                </span>
              )}
              <p className="text-lg font-semibold">{displayName}</p>
            </div>
            <h2 className="max-w-md text-3xl leading-snug font-bold">{t('login.brandTitle')}</h2>
          </div>

          <ul className="space-y-4">
            {(['login.brandPoint1', 'login.brandPoint2', 'login.brandPoint3'] as const).map(
              (key) => (
                <li key={key} className="text-primary-foreground/85 flex items-start gap-3 text-sm">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/20">
                    <Check className="size-3" aria-hidden="true" />
                  </span>
                  <span className="leading-relaxed">{t(key)}</span>
                </li>
              ),
            )}
          </ul>

          <div className="text-primary-foreground/70 mt-auto flex items-center gap-6 border-t border-white/20 pt-6 text-xs">
            <span>Vite · React · TypeScript</span>
            <span>Supabase · PostgreSQL</span>
            <span>Vercel</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
