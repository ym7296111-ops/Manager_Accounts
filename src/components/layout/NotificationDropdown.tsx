import { useEffect, type ReactNode } from 'react';
import { Bell, CheckCheck, Clock, Loader2, Shield, ShieldOff, WifiOff } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { useNotifications } from '@/components/layout/NotificationsProvider';
import type { UserNotificationRow } from '@/hooks/useUserNotifications';

/**
 * In-app notification panel — the dropdown body rendered by `NotificationBell`.
 *
 * The panel shows the CALLER'S own ACTIVE feed, read from
 * `NotificationsProvider` (the single feed owner in `Topbar`): the list is
 * active-only (`is_read = false AND resolved_at IS NULL`), so a row that was
 * read or resolved upstream never renders here. There is deliberately NO
 * "view history" affordance: no history view exists behind the panel, and a
 * disabled control pointing at nothing is worse than no control at all. If a
 * history view ships later, it comes with its own route and its own entry
 * point — not as a re-enabled stub here.
 *
 * RLS is the only gate, so the panel is correct for every account including
 * pending and dashboard-only ones (a pending account has an empty capability
 * set but still needs "your request was approved").
 *
 * Content arrives from the database as i18n KEYS plus params/metadata and is
 * translated here, so one row renders correctly in both Arabic and English.
 *
 * In-product only: no email, no push, no external transport.
 */

const MS_PER_DAY = 86_400_000;

/** Rows carry plain strings; `t` falls back to the key for unknown entries. */
function asKey(value: string): TranslationKey {
  return value as TranslationKey;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const raw = record[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return '';
}

interface NotificationDropdownProps {
  /** Called when the user navigates from an item so the panel can close. */
  onNavigate: () => void;
}

export function NotificationDropdown({ onNavigate }: NotificationDropdownProps) {
  const { t, locale } = useI18n();
  const {
    notifications,
    unreadCount,
    isLoading,
    isError,
    realtimeState,
    markRead,
    markAllRead,
    isMarking,
    refetch,
  } = useNotifications();

  /* Refresh on open so stale cached rows do not linger in the panel. */
  useEffect(() => {
    refetch();
  }, [refetch]);

  /* House convention: Intl only, zero bundled date libraries. */
  const formatWhen = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  const renderDelegationRow = (
    row: UserNotificationRow,
  ): {
    readonly icon: ReactNode;
    readonly title: string;
    readonly body: string;
    readonly targetLink: string;
  } => {
    const meta: Record<string, unknown> = {
      ...row.params,
      ...(row.metadata ?? {}),
    };
    const event = stringField(meta, 'event');
    const slug = stringField(meta, 'slug');
    const granterEmail = stringField(meta, 'granter_email');
    const delegateEmail = stringField(meta, 'email');
    const rawExpires = stringField(meta, 'expires_at');
    const isGranter = meta['recipient_role'] === 'granter';

    let days = stringField(meta, 'days');
    if (days === '' && rawExpires !== '') {
      const expiryMs = Date.parse(rawExpires);
      const baseMs = Date.parse(row.created_at);
      if (!Number.isNaN(expiryMs) && !Number.isNaN(baseMs)) {
        days = String(Math.max(1, Math.ceil((expiryMs - baseMs) / MS_PER_DAY)));
      }
    }
    if (days === '') {
      days = '1';
    }

    const formattedExpiry =
      rawExpires === ''
        ? t('profile.delegations.permanent')
        : (() => {
            const parsed = new Date(rawExpires);
            return Number.isNaN(parsed.getTime())
              ? rawExpires
              : new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
                  dateStyle: 'medium',
                }).format(parsed);
          })();

    const defaultLink = isGranter ? '/settings/system/users' : '/profile#delegations';
    const targetLink = row.link ?? defaultLink;

    if (event === 'revoked') {
      return {
        icon: (
          <ShieldOff
            className="text-destructive mt-0.5 size-4 shrink-0"
            aria-hidden="true"
            data-icon="shield-off"
          />
        ),
        title: t('notifications.type.delegation_revoked.title', { slug }),
        body: t('notifications.type.delegation_revoked.body', { slug }),
        targetLink,
      };
    }

    if (event === 'expiring') {
      if (isGranter && delegateEmail !== '') {
        return {
          icon: (
            <Clock
              className="text-warning mt-0.5 size-4 shrink-0"
              aria-hidden="true"
              data-icon="clock"
            />
          ),
          title: t('notifications.type.delegation_expiring_granter.title', { slug, days }),
          body: t('notifications.type.delegation_expiring_granter.body', {
            email: delegateEmail,
            days,
            slug,
          }),
          targetLink,
        };
      }
      return {
        icon: (
          <Clock
            className="text-warning mt-0.5 size-4 shrink-0"
            aria-hidden="true"
            data-icon="clock"
          />
        ),
        title: t('notifications.type.delegation_expiring.title', { slug, days }),
        body: t('notifications.type.delegation_expiring.body', { slug, days }),
        targetLink,
      };
    }

    return {
      icon: (
        <Shield
          className="text-primary mt-0.5 size-4 shrink-0"
          aria-hidden="true"
          data-icon="shield"
        />
      ),
      title: t('notifications.type.delegation_granted.title', { slug }),
      body:
        granterEmail !== ''
          ? t('notifications.type.delegation_granted.body', {
              slug,
              granter_email: granterEmail,
              expires_at: formattedExpiry,
            })
          : t('notifications.type.delegation_granted.body_short', {
              slug,
              expires_at: formattedExpiry,
            }),
      targetLink,
    };
  };

  const handleItemClick = (row: UserNotificationRow) => {
    /* Fire and forget: the mutation already updated the cache optimistically. */
    if (!row.is_read) {
      void markRead(row.id);
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t('notifications.panel.title')}
      className="animate-scale-in origin-top-end bg-popover text-popover-foreground absolute end-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border shadow-lg"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <p className="text-sm font-semibold">{t('notifications.panel.title')}</p>
        {unreadCount !== null && unreadCount > 0 && (
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={isMarking}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors disabled:opacity-50"
          >
            <CheckCheck className="size-3.5" aria-hidden="true" />
            {t('notifications.panel.markAllRead')}
          </button>
        )}
      </div>

      {/* Degraded live feed: say so instead of showing a silently stale badge. */}
      {realtimeState === 'offline' && (
        <p className="text-muted-foreground bg-muted/40 flex items-center gap-1.5 px-3 py-1.5 text-[11px]">
          <WifiOff className="size-3 shrink-0" aria-hidden="true" />
          {t('notifications.panel.offline')}
        </p>
      )}

      {isLoading ? (
        <p className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('notifications.panel.loading')}
        </p>
      ) : isError ? (
        <p className="text-destructive px-3 py-6 text-center text-sm">
          {t('notifications.panel.error')}
        </p>
      ) : notifications.length === 0 ? (
        /* Empty but ready: same tokens as `ui/EmptyState` (muted icon tile,
           quiet copy) scaled down for a 20rem popover — a page-sized block
           would dominate the panel. `role="status"` announces the resolved
           state, since the list area changes after the first fetch. */
        <div
          role="status"
          data-testid="notification-empty"
          className="text-muted-foreground flex flex-col items-center gap-3 px-5 py-8 text-center"
        >
          <span className="bg-muted text-muted-foreground/70 grid size-10 place-items-center rounded-xl">
            <Bell className="size-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="text-card-foreground text-sm font-medium">
              {t('notifications.empty.title')}
            </p>
            <p className="text-xs leading-relaxed">{t('notifications.empty.description')}</p>
          </div>
        </div>
      ) : (
        <ul className="max-h-96 scrollbar-thin divide-y overflow-y-auto">
          {notifications.map((row) => {
            const when = formatWhen(row.created_at);
            const params = row.params as Record<string, string>;
            const delegation = row.type === 'delegation_event' ? renderDelegationRow(row) : null;
            const title = delegation !== null ? delegation.title : t(asKey(row.title_key), params);
            const body = delegation !== null ? delegation.body : t(asKey(row.body_key), params);
            const targetLink = delegation !== null ? delegation.targetLink : row.link;

            const content = (
              <span className="flex items-start gap-2.5">
                {delegation !== null && delegation.icon}
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span
                      className={`text-sm ${row.is_read ? 'text-muted-foreground' : 'font-semibold'}`}
                    >
                      {title}
                    </span>
                    {!row.is_read && (
                      <span
                        aria-label={t('notifications.panel.unread')}
                        className="bg-primary mt-1.5 size-2 shrink-0 rounded-full"
                      />
                    )}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">{body}</span>
                  {when !== '' && (
                    <span className="text-muted-foreground/70 mt-1 block text-[11px]" dir="ltr">
                      {when}
                    </span>
                  )}
                </span>
              </span>
            );

            return (
              <li key={row.id} data-notification-id={row.id}>
                {targetLink !== null ? (
                  <Link
                    to={targetLink}
                    onClick={() => {
                      handleItemClick(row);
                      onNavigate();
                    }}
                    className="hover:bg-accent block px-3 py-2.5 transition-colors"
                  >
                    {content}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleItemClick(row)}
                    className="hover:bg-accent block w-full px-3 py-2.5 text-start transition-colors"
                  >
                    {content}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
