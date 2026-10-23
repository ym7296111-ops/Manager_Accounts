import { Check, KeyRound, Loader2, Mail, Shield, ShieldCheck, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChangePasswordDialog } from '@/components/auth/ChangePasswordDialog';
import { useAuth } from '@/context/AuthContext';
import {
  isDelegationExpiringSoon,
  useMyCapabilities,
  useMyRoles,
  type MyRole,
} from '@/hooks/useMyCapabilities';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Profile settings (self-service, `/profile` and `/settings/my-profile`).
 *
 * * Read-only account card: the identity Supabase already owns.
 * * My Roles section: displays the caller's assigned roles (`viewer`/`editor`/`admin`/…).
 * * My Delegations section (`#delegations`): displays active delegated capabilities
 *   fetched via `useMyCapabilities()` -> `get_my_delegated_capabilities()`, including
 *   live status (`نشط` / `ينتهي قريباً`) with `🕐`, or a quiet empty state.
 * * Security section: triggers `ChangePasswordDialog` (portal + focus trap) and
 *   surfaces a polite toast upon completion.
 */

const PRIMARY_BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

const ROLE_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  owner: 'dashboard.role.owner',
  super_admin: 'dashboard.role.super_admin',
  admin: 'dashboard.role.admin',
  editor: 'dashboard.role.editor',
  viewer: 'dashboard.role.viewer',
  executive: 'dashboard.role.executive',
};

function accountName(sessionEmail: string | undefined, fullName: string | null): string {
  if (fullName !== null && fullName.trim() !== '') {
    return fullName;
  }
  return sessionEmail ?? '—';
}

export default function ProfilePage() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const { capabilities, isLoading: delegationsLoading } = useMyCapabilities();
  const { roles, isLoading: rolesLoading } = useMyRoles();

  const email = session?.user.email ?? '';
  const fullName =
    typeof session?.user.user_metadata?.full_name === 'string'
      ? session.user.user_metadata.full_name
      : null;

  const [referenceNowMs] = useState(() => Date.now());
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordToastVisible, setPasswordToastVisible] = useState(false);

  useEffect(() => {
    if (!passwordToastVisible) {
      return;
    }
    const timer = setTimeout(() => setPasswordToastVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [passwordToastVisible]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const formatTimestamp = (value: string | null): string => {
    if (value === null || value.trim() === '') {
      return '—';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return dateFormatter.format(parsed);
  };

  const renderRoleLabel = (role: MyRole): string => {
    const key = ROLE_LABEL_KEYS[role.slug];
    if (key !== undefined) {
      return t(key);
    }
    return locale === 'ar' ? role.name_ar : role.name_en;
  };

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-xl">
          <UserRound className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-foreground text-xl font-bold tracking-tight">{t('profile.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('profile.subtitle')}</p>
        </div>
      </header>

      <section className="border-border bg-card rounded-2xl border p-5 shadow-sm sm:p-6">
        <div className="flex items-center gap-2">
          <Mail className="text-muted-foreground size-4" aria-hidden="true" />
          <h2 className="text-base font-semibold">{t('profile.account.title')}</h2>
        </div>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground text-xs font-medium">
              {t('profile.account.name')}
            </dt>
            <dd className="text-foreground mt-1 text-sm font-semibold">
              {accountName(session?.user.email, fullName)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs font-medium">
              {t('profile.account.email')}
            </dt>
            <dd className="text-foreground mt-1 text-sm font-semibold" dir="ltr">
              {email === '' ? '—' : email}
            </dd>
          </div>
        </dl>

        <p className="text-muted-foreground mt-4 text-xs">{t('profile.account.readOnlyNote')}</p>
      </section>

      <section
        id="roles"
        data-testid="profile-roles-section"
        className="border-border bg-card rounded-2xl border p-5 shadow-sm sm:p-6"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-muted-foreground size-4" aria-hidden="true" />
          <h2 className="text-base font-semibold">{t('profile.roles.title')}</h2>
        </div>

        {rolesLoading ? (
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('common.loading')}
          </p>
        ) : roles.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">{t('profile.roles.empty')}</p>
        ) : (
          <ul className="mt-4 flex flex-wrap gap-2">
            {roles.map((role) => (
              <li
                key={role.slug}
                data-testid={`profile-role-${role.slug}`}
                className="border-primary/25 bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold"
              >
                <span>{renderRoleLabel(role)}</span>
                <code className="font-mono text-[11px] opacity-80" dir="ltr">
                  {role.slug}
                </code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        id="delegations"
        data-testid="profile-delegations-section"
        className="border-border bg-card rounded-2xl border p-5 shadow-sm sm:p-6"
      >
        <div className="flex items-center gap-2">
          <Shield className="text-muted-foreground size-4" aria-hidden="true" />
          <h2 className="text-base font-semibold">{t('profile.delegations.title')}</h2>
        </div>

        {delegationsLoading ? (
          <p className="text-muted-foreground mt-3 flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t('common.loading')}
          </p>
        ) : capabilities.length === 0 ? (
          <p
            data-testid="profile-delegations-empty"
            className="text-muted-foreground mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-sm"
          >
            {t('profile.delegations.empty')}
          </p>
        ) : (
          <ul className="divide-border mt-4 divide-y">
            {capabilities.map((item) => {
              const expiringSoon = isDelegationExpiringSoon(item.expires_at, referenceNowMs);
              const statusTone = expiringSoon
                ? 'border-warning/30 bg-warning/10 text-warning'
                : 'border-success/30 bg-success/10 text-success';
              const granterDisplay = item.granted_by_email ?? item.granted_by ?? '—';

              return (
                <li
                  key={item.id}
                  data-testid={`profile-delegation-${item.slug}`}
                  className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-foreground font-mono text-sm font-semibold" dir="ltr">
                        {item.slug}
                      </code>
                      <span
                        data-testid="delegation-status-badge"
                        data-status={expiringSoon ? 'expiring_soon' : 'active'}
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusTone}`}
                      >
                        <span aria-hidden="true">🕐</span>
                        <span>
                          {expiringSoon
                            ? t('profile.delegations.expiry_soon')
                            : t('profile.delegations.active')}
                        </span>
                      </span>
                    </div>

                    <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <div className="inline-flex items-center gap-1">
                        <dt className="font-medium">{t('profile.delegations.grantedBy')}:</dt>
                        <dd dir="ltr">{granterDisplay}</dd>
                      </div>
                      <div className="inline-flex items-center gap-1">
                        <dt className="font-medium">{t('profile.delegations.grantedAt')}:</dt>
                        <dd>{formatTimestamp(item.granted_at)}</dd>
                      </div>
                      <div className="inline-flex items-center gap-1">
                        <dt className="font-medium">{t('profile.delegations.expiresAt')}:</dt>
                        <dd>
                          {item.expires_at === null
                            ? t('profile.delegations.permanent')
                            : formatTimestamp(item.expires_at)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border-border bg-card flex flex-col gap-4 rounded-2xl border p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <KeyRound className="text-muted-foreground size-4" aria-hidden="true" />
            <h2 className="text-base font-semibold">{t('profile.security.title')}</h2>
          </div>
          <p className="text-muted-foreground text-sm">{t('profile.security.description')}</p>
        </div>

        <button
          type="button"
          data-testid="open-change-password-dialog"
          onClick={() => setPasswordDialogOpen(true)}
          className={`${PRIMARY_BUTTON_CLASS} bg-primary text-primary-foreground shrink-0 self-start sm:self-center`}
        >
          <KeyRound className="size-4" aria-hidden="true" />
          {t('profile.password.change_button')}
        </button>
      </section>

      <ChangePasswordDialog
        open={passwordDialogOpen}
        email={email}
        onClose={() => setPasswordDialogOpen(false)}
        onSuccess={() => setPasswordToastVisible(true)}
      />

      {passwordToastVisible &&
        createPortal(
          <div
            role="status"
            aria-live="polite"
            data-testid="password-change-toast"
            className="border-success/40 bg-card text-foreground animate-scale-in fixed end-4 bottom-4 z-50 flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg"
          >
            <span className="bg-success/15 text-success grid size-6 shrink-0 place-items-center rounded-full">
              <Check className="size-3.5" aria-hidden="true" />
            </span>
            <span>{t('profile.password.toast_success')}</span>
            <button
              type="button"
              aria-label={t('profile.password.cancel')}
              onClick={() => setPasswordToastVisible(false)}
              className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-md transition-colors"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
