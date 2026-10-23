import { Activity, Inbox } from 'lucide-react';
import type { RecentActivityItem } from '@/hooks/useExecutiveDashboard';
import { useI18n } from '@/i18n/I18nContext';
import type { TranslationKey } from '@/i18n/I18nContext';
import { formatDashboardDateTime, formatDashboardRelative } from '@/lib/dashboardFormat';
import { roleSlugLabel } from '@/components/dashboard/roleLabels';

/**
 * The last ten administrative audit events.
 *
 * Every sentence is composed from a translation key plus server-resolved
 * labels — the database never returns rendered prose. `actor_label` and
 * `target_label` are already masked server-side (full name when known, masked
 * e-mail otherwise), so this component renders text it did not have to trust.
 *
 * The list is honest about its scope: `audit_logs` does not record sign-ins or
 * account creation, so the section is titled "recent administrative activity"
 * rather than "activity".
 */

/** Exact `metadata.event` / `action` → sentence key. */
const EVENT_KEYS: Readonly<Record<string, TranslationKey>> = {
  'user.approval_approve': 'dashboard.activity.event.userApprovalApprove',
  'user.approval_reject': 'dashboard.activity.event.userApprovalReject',
  'password_reset.approved': 'dashboard.activity.event.passwordResetApproved',
  'password_reset.rejected': 'dashboard.activity.event.passwordResetRejected',
  'user.suspended': 'dashboard.activity.event.userSuspended',
  'user.updated': 'dashboard.activity.event.userUpdated',
  'role.granted': 'dashboard.activity.event.roleGranted',
  'role.revoked': 'dashboard.activity.event.roleRevoked',
  'role.permissions_updated': 'dashboard.activity.event.rolePermissionsUpdated',
  'settings.updated': 'dashboard.activity.event.settingsUpdated',
  'support.ticket_created': 'dashboard.activity.event.ticketCreated',
  'support.ticket_status_updated': 'dashboard.activity.event.ticketStatusUpdated',
  'support.ticket_replied': 'dashboard.activity.event.ticketReplied',
  'email.transport_updated': 'dashboard.activity.event.emailTransportUpdated',
  'email.credentials_rotated': 'dashboard.activity.event.emailCredentialsRotated',
  'notification.template_updated': 'dashboard.activity.event.templateUpdated',
  'notification.template_previewed': 'dashboard.activity.event.templatePreviewed',
  'backup.created': 'dashboard.activity.event.backupCreated',
  'backup.restored': 'dashboard.activity.event.backupRestored',
};

export interface RecentActivityListProps {
  readonly items: readonly RecentActivityItem[];
  readonly testId?: string;
  /** Project time zone echoed by the RPC; absolute times render in it. */
  readonly timezone?: string;
  /**
   * Reference "now" for the relative labels — callers pass the snapshot's
   * last-sync time so ages are measured against the data's frame and the
   * render stays pure (no wall-clock read during render).
   */
  readonly nowMs?: number;
}

export function RecentActivityList({ items, testId, timezone, nowMs }: RecentActivityListProps) {
  const { t, locale } = useI18n();

  return (
    <section
      aria-labelledby={`${testId ?? 'recent-activity'}-heading`}
      className="bg-card text-card-foreground rounded-2xl border p-5 shadow-sm"
      data-testid={testId}
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="bg-primary/10 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
          <Activity className="size-[18px]" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h3 id={`${testId ?? 'recent-activity'}-heading`} className="text-sm font-semibold">
            {t('dashboard.activity.title')}
          </h3>
          <p className="text-muted-foreground text-xs">{t('dashboard.activity.subtitle')}</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center">
          <Inbox className="size-6" aria-hidden="true" />
          <p className="text-sm">{t('dashboard.activity.empty')}</p>
        </div>
      ) : (
        <ol className="divide-y">
          {items.map((item) => {
            const actor =
              item.actorKind === 'system'
                ? t('dashboard.activity.system')
                : (item.actorLabel ?? t('dashboard.activity.system'));
            const target = item.targetLabel ?? t('dashboard.activity.unknownTarget');
            const key = EVENT_KEYS[item.event] ?? 'dashboard.activity.event.other';
            const roles = item.roleSlugs.map((slug) => roleSlugLabel(slug, locale, t)).join('، ');

            return (
              <li key={item.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <p className="text-card-foreground text-sm">{t(key, { actor, target })}</p>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <time
                    dateTime={item.occurredAt}
                    title={formatDashboardDateTime(item.occurredAt, locale, timezone)}
                  >
                    {formatDashboardRelative(item.occurredAt, locale, nowMs, timezone)}
                  </time>
                  {roles !== '' && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{t('dashboard.activity.roles', { roles })}</span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
