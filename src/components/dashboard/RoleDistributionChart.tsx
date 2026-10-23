import type { RoleDistributionItem } from '@/hooks/useExecutiveDashboard';
import { useI18n } from '@/i18n/I18nContext';
import { formatDashboardNumber, formatDashboardPercent } from '@/lib/dashboardFormat';
import { roleLabel } from '@/components/dashboard/roleLabels';

/**
 * Users per role, as horizontal bars.
 *
 * Horizontal bars (not a pie/donut): up to six seeded roles plus a gray
 * "no role" pending row, long Arabic labels, and values that need to be
 * compared precisely. A donut would force colour-only distinction and truncate
 * labels.
 *
 * A user can hold several roles, so the counts may sum to more than the user
 * total; the footnote says so instead of pretending the bars form a whole.
 */

export interface RoleDistributionChartProps {
  readonly items: readonly RoleDistributionItem[];
  readonly usersWithoutRole: number;
  readonly totalUsers: number;
  readonly testId?: string;
}

export function RoleDistributionChart({
  items,
  usersWithoutRole,
  totalUsers,
  testId,
}: RoleDistributionChartProps) {
  const { t, locale } = useI18n();

  const hasExplicitNoRoleItem = items.some((item) => item.slug === 'no_role');
  const rows = [
    ...items
      .filter((item) => item.slug !== 'no_role' || item.userCount > 0)
      .map((item) => ({
        slug: item.slug,
        label: roleLabel(item.slug, item, locale, t),
        count: item.userCount,
      })),
    !hasExplicitNoRoleItem && usersWithoutRole > 0
      ? {
          slug: 'no_role',
          label: t('dashboard.roles.no_role'),
          count: usersWithoutRole,
        }
      : null,
  ].filter((row): row is { slug: string; label: string; count: number } => row !== null);

  const max = Math.max(1, ...rows.map((row) => row.count));
  const isEmpty = rows.length === 0 || rows.every((row) => row.count === 0);

  return (
    <section
      aria-labelledby={`${testId ?? 'role-distribution'}-heading`}
      className="bg-card text-card-foreground flex flex-col gap-4 rounded-2xl border p-5 shadow-sm"
      data-testid={testId}
    >
      <div className="space-y-1">
        <h3 id={`${testId ?? 'role-distribution'}-heading`} className="text-sm font-semibold">
          {t('dashboard.roles.title')}
        </h3>
        <p className="text-muted-foreground text-xs">{t('dashboard.roles.subtitle')}</p>
      </div>

      {isEmpty ? (
        <p className="text-muted-foreground grid min-h-32 place-items-center rounded-xl border border-dashed px-4 text-center text-sm">
          {t('dashboard.roles.empty')}
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {rows.map((row) => {
              const width = (row.count / max) * 100;
              const isNoRoleSlice = row.slug === 'no_role' || row.slug === '__none__';
              return (
                <li key={row.slug} data-role-slug={row.slug} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-card-foreground truncate font-medium">{row.label}</span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {t('dashboard.roles.count', {
                        count: formatDashboardNumber(row.count, locale),
                      })}
                      {' · '}
                      {t('dashboard.roles.share', {
                        percent: formatDashboardPercent(row.count, totalUsers, locale),
                      })}
                    </span>
                  </div>
                  <div
                    className="bg-muted h-2 overflow-hidden rounded-full"
                    role="img"
                    aria-label={`${row.label}: ${formatDashboardNumber(row.count, locale)}`}
                  >
                    <div
                      className={
                        isNoRoleSlice ? 'bg-muted-foreground/40 h-full' : 'bg-chart-2 h-full'
                      }
                      style={{ width: `${Math.max(row.count === 0 ? 0 : 2, width)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground text-[11px] leading-relaxed">
            {t('dashboard.roles.footnote')}
          </p>
        </>
      )}
    </section>
  );
}
