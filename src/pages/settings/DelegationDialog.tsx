import { AlertCircle, CalendarClock, KeyRound, Loader2, Plus, ShieldCheck, X } from 'lucide-react';
import { useCallback, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { PERMISSION_CATALOG_ERROR_KEYS, usePermissionCatalog } from '@/hooks/usePermissionCatalog';
import { useUserCapabilities } from '@/hooks/useUserCapabilities';
import type { ManagedUser } from '@/hooks/useUsersManagement';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/25';
const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Richer copy for the built-in delegations, kept as dictionary overrides.
 * Any other permission the owner flags delegatable (Roles & Permissions)
 * falls back to its catalogue `name_ar`/`name_en` — the LIST itself comes
 * from `public.permissions` (`is_delegatable = true`), never from here.
 */
const CAPABILITY_LABEL_KEYS: Readonly<Record<string, TranslationKey>> = {
  'users.approve': 'delegation.capability.usersApprove',
  'password_reset.manage': 'delegation.capability.passwordResetManage',
};

const ERROR_KEYS: Record<string, TranslationKey> = {
  unavailable: 'delegation.error.unavailable',
  forbidden: 'delegation.error.forbidden',
  duplicate: 'delegation.error.duplicate',
  'not-found': 'delegation.error.notFound',
  'not-delegatable': 'delegation.error.notDelegatable',
  'invalid-expiry': 'delegation.error.invalidExpiry',
  network: 'delegation.error.network',
  unknown: 'delegation.error.unknown',
};

function defaultExpiryDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 90);
  return date.toISOString().slice(0, 10);
}

function errorKey(error: unknown): TranslationKey {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
  return ERROR_KEYS[code] ?? ERROR_KEYS['unknown'] ?? 'delegation.error.unknown';
}

export interface DelegationDialogProps {
  user: ManagedUser;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export default function DelegationDialog({ user, onClose, onChanged }: DelegationDialogProps) {
  const { t, locale } = useI18n();
  const capabilities = useUserCapabilities(user.id);
  const catalog = usePermissionCatalog();
  const titleId = useId();
  const [permissionSlug, setPermissionSlug] = useState('');
  const [expiryDate, setExpiryDate] = useState(defaultExpiryDate);
  const [neverExpires, setNeverExpires] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);

  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );
  const alreadyGranted = new Set(capabilities.grants.map((grant) => grant.permissionSlug));
  /* The grantable set is whatever the owner flags delegatable right now. */
  const available = catalog.delegatable.filter((entry) => !alreadyGranted.has(entry.slug));
  /* The select always shows a grantable option: fall back to the first one
     when the remembered pick was just granted or stopped being delegatable. */
  const selectedSlug = available.some((entry) => entry.slug === permissionSlug)
    ? permissionSlug
    : (available[0]?.slug ?? '');

  const labelFor = useCallback(
    (slug: string): string => {
      const key = CAPABILITY_LABEL_KEYS[slug];
      if (key !== undefined) return t(key);
      const entry = catalog.bySlug.get(slug);
      if (entry === undefined) return slug;
      const name = locale === 'ar' ? entry.nameAr : entry.nameEn;
      return name !== '' ? name : slug;
    },
    [t, locale, catalog.bySlug],
  );

  async function handleGrant() {
    setError(null);
    setNotice(null);
    if (
      !neverExpires &&
      (expiryDate === '' || Number.isNaN(Date.parse(`${expiryDate}T00:00:00Z`)))
    ) {
      setError('delegation.error.invalidExpiry');
      return;
    }
    if (selectedSlug === '') {
      setError('delegation.error.unknown');
      return;
    }
    const expiresAt = neverExpires ? null : new Date(`${expiryDate}T23:59:59.999Z`).toISOString();
    setBusy(true);
    try {
      await capabilities.grant(selectedSlug, expiresAt);
      await onChanged();
      setNotice('delegation.success.granted');
      setExpiryDate(defaultExpiryDate());
      setNeverExpires(false);
    } catch (caught) {
      const key = errorKey(caught);
      setError(key);
      if (key === 'delegation.error.notDelegatable') {
        /* The owner pulled this permission while the dialog was open —
           refetch so the stale option disappears. */
        void catalog.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(capabilityId: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await capabilities.revoke(capabilityId);
      await onChanged();
      setNotice('delegation.success.revoked');
    } catch (caught) {
      setError(errorKey(caught));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="bg-foreground/50 fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card text-card-foreground border-border w-full max-w-xl rounded-2xl border p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {t('delegation.title')}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              <bdi dir="auto">{user.fullName ?? user.email}</bdi> ·{' '}
              <bdi dir="ltr">{user.email}</bdi>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
            className="text-muted-foreground hover:text-foreground grid size-8 place-items-center rounded-lg"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          {t('delegation.description')}
        </p>

        {error !== null && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 text-destructive mt-4 rounded-xl border px-3 py-2 text-sm"
          >
            <AlertCircle className="me-2 inline size-4" aria-hidden="true" />
            {t(error)}
          </div>
        )}
        {notice !== null && (
          <p
            role="status"
            className="border-success/40 bg-success/10 text-success mt-4 rounded-xl border px-3 py-2 text-sm"
          >
            {t(notice)}
          </p>
        )}
        {capabilities.error !== null && error === null && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {t(ERROR_KEYS[capabilities.error] ?? 'delegation.error.unknown')}
          </p>
        )}

        <div className="border-border mt-5 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t('delegation.grantTitle')}</h3>
          {catalog.isLoading ? (
            <p className="text-muted-foreground mt-3 text-sm">{t('common.loading')}</p>
          ) : catalog.error !== null ? (
            <p role="alert" className="text-destructive mt-3 text-sm">
              {t(PERMISSION_CATALOG_ERROR_KEYS[catalog.error])}
            </p>
          ) : catalog.delegatable.length === 0 ? (
            <p
              className="text-muted-foreground mt-3 text-sm"
              data-testid="delegation-none-delegatable"
            >
              {t('delegation.noneDelegatable')}
            </p>
          ) : available.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm">{t('delegation.allGranted')}</p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <label className="text-sm font-medium" htmlFor="delegation-capability">
                {t('delegation.capabilityLabel')}
                <select
                  id="delegation-capability"
                  value={selectedSlug}
                  onChange={(event) => setPermissionSlug(event.target.value)}
                  className={FIELD_CLASS}
                  disabled={busy}
                >
                  {available.map((entry) => (
                    <option key={entry.slug} value={entry.slug}>
                      {labelFor(entry.slug)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium" htmlFor="delegation-expiry">
                {t('delegation.expiryLabel')}
                <input
                  id="delegation-expiry"
                  type="date"
                  value={expiryDate}
                  onChange={(event) => setExpiryDate(event.target.value)}
                  className={FIELD_CLASS}
                  disabled={busy || neverExpires}
                />
              </label>
              <label className="text-muted-foreground flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  checked={neverExpires}
                  onChange={(event) => setNeverExpires(event.target.checked)}
                  disabled={busy}
                />
                {t('delegation.neverExpires')}
              </label>
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs sm:col-span-2">
                <CalendarClock className="size-3.5" aria-hidden="true" />
                {t('delegation.defaultExpiry')}
              </p>
              <button
                type="button"
                onClick={() => void handleGrant()}
                disabled={busy || capabilities.isLoading}
                className={`${BUTTON_CLASS} bg-primary text-primary-foreground sm:col-span-2 sm:justify-self-end`}
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="size-4" aria-hidden="true" />
                )}
                {t('delegation.grant')}
              </button>
            </div>
          )}
        </div>

        <div className="mt-5">
          <h3 className="text-sm font-semibold">{t('delegation.currentTitle')}</h3>
          {capabilities.isLoading ? (
            <p className="text-muted-foreground mt-3 text-sm">{t('common.loading')}</p>
          ) : capabilities.grants.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm">{t('delegation.none')}</p>
          ) : (
            <ul className="divide-border mt-2 divide-y">
              {capabilities.grants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <ShieldCheck className="text-primary size-4 shrink-0" aria-hidden="true" />
                      {labelFor(grant.permissionSlug)}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {grant.expiresAt === null
                        ? t('delegation.noExpiry')
                        : t('delegation.expiresAt', {
                            date: formatter.format(new Date(grant.expiresAt)),
                          })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(grant.id)}
                    disabled={busy}
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                  >
                    <KeyRound className="size-3.5" aria-hidden="true" />
                    {t('delegation.revoke')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`${BUTTON_CLASS} border-border bg-background border`}
          >
            {t('common.close')}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
