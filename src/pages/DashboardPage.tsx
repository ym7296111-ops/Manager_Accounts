import {
  Activity,
  AlertCircle,
  ArrowUpLeft,
  ArrowUpRight,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  UserCheck,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { KPICard } from '@/components/dashboard/KPICard';
import { RecentActivityList } from '@/components/dashboard/RecentActivityList';
import { RoleDistributionChart } from '@/components/dashboard/RoleDistributionChart';
import { SignupsChart } from '@/components/dashboard/SignupsChart';
import { useBranding } from '@/context/BrandingContext';
import { useTheme } from '@/context/ThemeContext';
import {
  DASHBOARD_READ_CAPABILITY,
  isDashboardOnlyActor,
  useAuthCapabilities,
} from '@/hooks/useAuthCapabilities';
import {
  EXECUTIVE_DASHBOARD_ERROR_KEYS,
  EXECUTIVE_DASHBOARD_WINDOW_DAYS,
  useExecutiveDashboard,
  type ExecutiveDashboard,
  type ExecutiveDashboardErrorCode,
} from '@/hooks/useExecutiveDashboard';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { formatDashboardDateTime, formatDashboardNumber } from '@/lib/dashboardFormat';
import { env } from '@/lib/env';

/**
 * Landing screen of the dashboard.
 *
 * Two layers, in this order:
 *
 *   1. the executive read model (KPIs, 30-day signups, role distribution and
 *      the last ten audit events) for holders of `dashboard:read`, served by
 *      the single SECURITY DEFINER RPC `get_executive_dashboard`;
 *   2. the original welcome / quick-access / system-status panels, kept for
 *      every other account and still shown to executives below the KPIs
 *      (quick access is hidden for a dashboard-only account, as before).
 *
 * The capability gate mirrors the server's: the RPC re-checks the capability
 * and refuses with 42501, so the client never treats the gate as security — it
 * only avoids a guaranteed-failing request and chooses the right empty state.
 *
 * No figures are ever fabricated: a failed or unparseable snapshot renders an
 * explicit error panel, never a zero.
 */
export default function DashboardPage() {
  const { t, locale } = useI18n();
  const { displayName } = useBranding();
  const { resolvedTheme } = useTheme();
  const capabilities = useAuthCapabilities();
  const dashboardOnly = isDashboardOnlyActor(capabilities);

  /* The gate waits for an authoritative capability answer. Claiming "no
     access" while the channel is still loading would flash a denial panel on
     every cold load. */
  const canReadDashboard = capabilities.hasCapability(DASHBOARD_READ_CAPABILITY);
  const dashboard = useExecutiveDashboard({
    enabled: canReadDashboard,
    windowDays: EXECUTIVE_DASHBOARD_WINDOW_DAYS,
  });

  const isRtl = locale === 'ar';
  const Arrow = isRtl ? ArrowUpLeft : ArrowUpRight;

  const quickLinks = [
    { to: '/workspaces/1', labelKey: 'nav.workspace1', icon: FolderKanban },
    { to: '/workspaces/2', labelKey: 'nav.workspace2', icon: FolderKanban },
    { to: '/workspaces/3', labelKey: 'nav.workspace3', icon: FolderKanban },
    { to: '/settings/app/general', labelKey: 'nav.settings', icon: SlidersHorizontal },
  ] as const;

  const statusRows = [
    {
      labelKey: 'dashboard.status.theme',
      value: t(`theme.${resolvedTheme}`),
      tone: 'bg-muted text-muted-foreground',
    },
    {
      labelKey: 'dashboard.status.language',
      value: t(`language.${locale}`),
      tone: 'bg-muted text-muted-foreground',
    },
    {
      labelKey: 'dashboard.status.database',
      value: env.isSupabaseConfigured
        ? t('dashboard.status.databaseReady')
        : t('dashboard.status.databasePending'),
      tone: env.isSupabaseConfigured
        ? 'bg-success/15 text-success'
        : 'bg-warning/20 text-warning-foreground dark:text-warning',
    },
  ] as const;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ welcome */}
      <section className="bg-card flex flex-col gap-4 rounded-2xl border p-6 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-xl">
              <LayoutDashboard className="size-5" aria-hidden="true" />
            </span>
            <h1 className="text-card-foreground text-xl font-bold tracking-tight">
              {t('dashboard.welcome', { app: displayName })}
            </h1>
          </div>
          <p className="text-muted-foreground max-w-2xl text-sm">{t('dashboard.welcomeSub')}</p>
        </div>

        <span className="bg-background text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium">
          <span className="bg-success size-2 rounded-full" aria-hidden="true" />
          v0.1.0
        </span>
      </section>

      {/* -------------------------------------------------- executive metrics */}
      {capabilities.isAuthoritative && canReadDashboard ? (
        <ExecutiveDashboardSection
          dashboard={dashboard.data}
          isLoading={dashboard.isLoading}
          isRefreshing={dashboard.isRefreshing}
          errorCode={dashboard.errorCode}
          lastSyncedAt={dashboard.lastSyncedAt}
          onRefresh={dashboard.refresh}
        />
      ) : capabilities.isAuthoritative ? (
        <section
          role="status"
          className="bg-card flex flex-col items-center gap-3 rounded-2xl border p-8 text-center shadow-sm"
          data-testid="dashboard-no-access"
        >
          <span className="bg-muted text-muted-foreground grid size-12 place-items-center rounded-xl">
            <ShieldAlert className="size-6" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <h2 className="text-card-foreground text-base font-semibold">
              {t('dashboard.access.denied.title')}
            </h2>
            <p className="text-muted-foreground mx-auto max-w-md text-sm">
              {t('dashboard.access.denied.body')}
            </p>
          </div>
        </section>
      ) : null}

      {/* -------------------------------------------------------- quick access */}
      <section aria-labelledby="quick-access-heading">
        <h2 id="quick-access-heading" className="text-foreground mb-3 text-sm font-semibold">
          {t('dashboard.quickAccess')}
        </h2>

        {!dashboardOnly && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {quickLinks.map(({ to, labelKey, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="group bg-card text-card-foreground hover:border-primary/40 flex items-center justify-between gap-3 rounded-xl border p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary grid size-9 shrink-0 place-items-center rounded-lg transition-colors">
                    <Icon className="size-[18px]" aria-hidden="true" />
                  </span>
                  <span className="truncate text-sm font-medium">{t(labelKey)}</span>
                </span>
                <Arrow
                  className="text-muted-foreground group-hover:text-primary size-4 shrink-0 transition-transform ltr:group-hover:-translate-x-0.5 rtl:group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- system status */}
      <section aria-labelledby="system-status-heading">
        <h2 id="system-status-heading" className="text-foreground mb-3 text-sm font-semibold">
          {t('dashboard.systemStatus')}
        </h2>

        <div className="bg-card text-card-foreground rounded-2xl border p-2 shadow-sm">
          <dl className="divide-y">
            {statusRows.map(({ labelKey, value, tone }) => (
              <div key={labelKey} className="flex items-center justify-between gap-4 px-4 py-3.5">
                <dt className="text-muted-foreground text-sm">{t(labelKey)}</dt>
                <dd>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}
                  >
                    {value}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

interface ExecutiveDashboardSectionProps {
  readonly dashboard: ExecutiveDashboard | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly errorCode: ExecutiveDashboardErrorCode | null;
  readonly lastSyncedAt: number | null;
  readonly onRefresh: () => void;
}

/** Loading / error / ready states of the executive read model. */
function ExecutiveDashboardSection({
  dashboard,
  isLoading,
  isRefreshing,
  errorCode,
  lastSyncedAt,
  onRefresh,
}: ExecutiveDashboardSectionProps) {
  const { t, locale } = useI18n();

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h2 className="text-foreground text-base font-semibold">
          {t('dashboard.executive.title')}
        </h2>
        <p className="text-muted-foreground text-xs">{t('dashboard.executive.subtitle')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {lastSyncedAt !== null && (
          <span className="text-muted-foreground text-[11px]" data-testid="dashboard-last-updated">
            {t('dashboard.lastUpdated', {
              time: formatDashboardDateTime(
                new Date(lastSyncedAt).toISOString(),
                locale,
                dashboard?.timezone,
              ),
            })}
            {/* The figures are bucketed in the project time zone the RPC
                echoes; naming it here keeps every timestamp on the screen
                unambiguous (the IANA name is data, not prose). */}
            {dashboard !== null && (
              <>
                {' '}
                · <span dir="ltr">{dashboard.timezone}</span>
              </>
            )}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="bg-background text-foreground hover:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRefreshing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden="true" />
          )}
          {isRefreshing ? t('dashboard.refreshing') : t('dashboard.refresh')}
        </button>
      </div>
    </div>
  );

  if (isLoading && dashboard === null) {
    return (
      <section aria-busy="true" className="space-y-4" data-testid="dashboard-loading">
        {header}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="bg-card h-32 animate-pulse rounded-2xl border" />
          ))}
        </div>
        <p className="sr-only">{t('dashboard.loading')}</p>
      </section>
    );
  }

  if (errorCode !== null && dashboard === null) {
    return (
      <section className="space-y-4" data-testid="dashboard-error">
        {header}
        <div
          role="alert"
          className="border-destructive/30 bg-card flex flex-col items-center gap-3 rounded-2xl border p-8 text-center"
        >
          <AlertCircle className="text-destructive size-8" aria-hidden="true" />
          <div className="space-y-1">
            <h3 className="text-card-foreground text-sm font-semibold">
              {t('dashboard.error.title')}
            </h3>
            <p className="text-muted-foreground text-sm">
              {t(EXECUTIVE_DASHBOARD_ERROR_KEYS[errorCode])}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
          >
            {t('dashboard.error.retry')}
          </button>
        </div>
      </section>
    );
  }

  if (dashboard === null) {
    return null;
  }

  const {
    kpis,
    dailySignups,
    roleDistribution,
    usersWithoutRole,
    recentActivity,
    windowDays,
    timezone,
  } = dashboard;

  const cards: ReadonlyArray<{
    key: string;
    labelKey: TranslationKey;
    value: number | null;
    hint: string;
    definitionKey: TranslationKey;
    icon: LucideIcon;
    tone: 'primary' | 'warning' | 'success' | 'neutral';
    testId: string;
  }> = [
    {
      key: 'total-users',
      labelKey: 'dashboard.kpi.totalUsers',
      value: kpis.totalUsers,
      hint: t('dashboard.kpi.totalUsersHint', {
        count: formatDashboardNumber(
          dailySignups.reduce((sum, point) => sum + point.count, 0),
          locale,
        ),
        days: windowDays,
      }),
      definitionKey: 'dashboard.definition.totalUsers',
      icon: Users,
      tone: 'primary',
      testId: 'kpi-total-users',
    },
    {
      key: 'pending-approvals',
      labelKey: 'dashboard.kpi.pendingApprovals',
      value: kpis.pendingApprovals,
      hint:
        kpis.pendingApprovals === 0
          ? t('dashboard.kpi.pendingApprovalsEmpty')
          : t('dashboard.kpi.pendingApprovalsHint'),
      definitionKey: 'dashboard.definition.pendingApprovals',
      icon: UserCheck,
      tone: kpis.pendingApprovals > 0 ? 'warning' : 'neutral',
      testId: 'kpi-pending-approvals',
    },
    {
      key: 'pending-resets',
      labelKey: 'dashboard.kpi.pendingResets',
      value: kpis.pendingPasswordResets,
      hint:
        kpis.pendingPasswordResets === 0
          ? t('dashboard.kpi.pendingResetsEmpty')
          : t('dashboard.kpi.pendingResetsHint'),
      definitionKey: 'dashboard.definition.pendingResets',
      icon: KeyRound,
      tone: kpis.pendingPasswordResets > 0 ? 'warning' : 'neutral',
      testId: 'kpi-pending-resets',
    },
    {
      key: 'signed-in-today',
      labelKey: 'dashboard.kpi.signedInToday',
      value: kpis.signedInToday,
      hint: t('dashboard.kpi.signedInTodayHint'),
      definitionKey: 'dashboard.definition.signedInToday',
      icon: Activity,
      tone: 'success',
      testId: 'kpi-signed-in-today',
    },
  ];

  return (
    <section aria-labelledby="executive-dashboard-heading" className="space-y-4">
      {header}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ key, ...card }) => (
          <KPICard
            key={key}
            label={t(card.labelKey)}
            value={card.value}
            hint={card.hint}
            definition={t(card.definitionKey)}
            icon={card.icon}
            tone={card.tone}
            testId={card.testId}
          />
        ))}
      </div>

      {/* Secondary indicator: suspended accounts (D1). Kept out of the four
          primary cards so "pending" and "suspended" are never conflated. */}
      <p className="text-muted-foreground text-xs" data-testid="dashboard-suspended">
        {t('dashboard.kpi.suspended', {
          count: formatDashboardNumber(kpis.suspendedUsers, locale),
        })}{' '}
        · {t('dashboard.kpi.suspendedHint')}
      </p>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SignupsChart points={dailySignups} days={windowDays} testId="signups-chart" />
        <RoleDistributionChart
          items={roleDistribution}
          usersWithoutRole={usersWithoutRole}
          totalUsers={kpis.totalUsers}
          testId="role-distribution"
        />
      </div>

      <RecentActivityList
        items={recentActivity}
        timezone={timezone}
        nowMs={lastSyncedAt ?? undefined}
        testId="recent-activity"
      />
    </section>
  );
}
