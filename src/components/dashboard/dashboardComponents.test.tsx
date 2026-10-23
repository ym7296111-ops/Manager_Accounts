import { render, screen, within } from '@testing-library/react';
import { Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { KPICard } from '@/components/dashboard/KPICard';
import { RecentActivityList } from '@/components/dashboard/RecentActivityList';
import { RoleDistributionChart } from '@/components/dashboard/RoleDistributionChart';
import { SignupsChart } from '@/components/dashboard/SignupsChart';
import type { RecentActivityItem, SignupPoint } from '@/hooks/useExecutiveDashboard';
import { I18nProvider } from '@/i18n/I18nContext';
import {
  formatDashboardDateTime,
  formatDashboardDay,
  formatDashboardPercent,
  formatDashboardRelative,
} from '@/lib/dashboardFormat';

/**
 * Presentation tests for the executive dashboard widgets.
 *
 * They pin the properties that make the figures trustworthy: no fabricated
 * zeros, explicit empty states, honest footnotes about multi-role counts, and
 * activity sentences assembled from translation keys (never raw server prose).
 */

function withI18n(node: ReactNode, locale: 'ar' | 'en' = 'en') {
  return <I18nProvider defaultLocale={locale}>{node}</I18nProvider>;
}

const SERIES: readonly SignupPoint[] = [
  { day: '2026-10-18', count: 0 },
  { day: '2026-10-19', count: 3 },
  { day: '2026-10-20', count: 1 },
];

const ACTIVITY: readonly RecentActivityItem[] = [
  {
    id: '1',
    occurredAt: '2026-10-20T08:00:00.000Z',
    action: 'user.updated',
    event: 'user.approval_approve',
    entity: 'user',
    actorKind: 'user',
    actorLabel: 'سارة',
    targetLabel: 'm***@example.invalid',
    roleSlugs: ['viewer'],
  },
  {
    id: '2',
    occurredAt: '2026-10-19T08:00:00.000Z',
    action: 'settings.updated',
    event: 'settings.updated',
    entity: 'app_settings',
    actorKind: 'system',
    actorLabel: null,
    targetLabel: null,
    roleSlugs: [],
  },
  {
    id: '3',
    occurredAt: '2026-10-19T07:00:00.000Z',
    action: 'user.updated',
    event: 'some.future_event',
    entity: 'user',
    actorKind: 'user',
    actorLabel: null,
    targetLabel: null,
    roleSlugs: [],
  },
];

describe('KPICard', () => {
  it('renders the label, the formatted value and the definition hint', () => {
    render(
      withI18n(
        <KPICard
          label="Total users"
          value={1204}
          hint="12 new signups in the last 30 days"
          definition="Every profile."
          icon={Users}
          testId="kpi"
        />,
      ),
    );

    const card = screen.getByTestId('kpi');
    expect(within(card).getByText('Total users')).toBeTruthy();
    expect(within(card).getByText('1,204')).toBeTruthy();
    expect(within(card).getByText('12 new signups in the last 30 days')).toBeTruthy();
    expect(card.getAttribute('title')).toBe('Every profile.');
  });

  it('renders an em dash instead of a misleading zero when the value is null', () => {
    render(
      withI18n(
        <KPICard label="Pending" value={null} hint="unavailable" icon={Users} testId="kpi" />,
      ),
    );
    expect(within(screen.getByTestId('kpi')).getByText('—')).toBeTruthy();
  });
});

describe('SignupsChart', () => {
  it('renders one bar per day and keeps zero days in the series', () => {
    const { container } = render(
      withI18n(<SignupsChart points={SERIES} days={30} testId="chart" />),
    );
    const scope = screen.getByTestId('chart');

    expect(within(scope).getByRole('heading', { name: 'New users — last 30 days' })).toBeTruthy();
    expect(within(scope).getByText('4 signups in this period.')).toBeTruthy();
    // Three data points → three <rect> bars (grid lines are <line>, not rect).
    expect(container.querySelectorAll('rect')).toHaveLength(3);
    // The hidden table repeats the series for assistive technology.
    expect(within(scope).getAllByRole('row')).toHaveLength(SERIES.length + 1);
  });

  it('shows an explicit empty state when every day is zero', () => {
    render(
      withI18n(
        <SignupsChart points={[{ day: '2026-10-20', count: 0 }]} days={30} testId="chart" />,
      ),
    );
    expect(
      within(screen.getByTestId('chart')).getByText('No new signups in this period.'),
    ).toBeTruthy();
  });
});

describe('RoleDistributionChart', () => {
  const items = [
    { slug: 'viewer', nameAr: 'مشاهد', nameEn: 'Viewer', userCount: 30 },
    { slug: 'custom_auditor', nameAr: 'مدقق مخصص', nameEn: 'Custom auditor', userCount: 4 },
  ];

  it('translates known roles, falls back to the bilingual column and adds the gray no_role slice', () => {
    render(
      withI18n(
        <RoleDistributionChart items={items} usersWithoutRole={3} totalUsers={40} testId="roles" />,
      ),
    );
    const scope = screen.getByTestId('roles');
    expect(within(scope).getByText('Viewer')).toBeTruthy();
    expect(within(scope).getByText('Custom auditor')).toBeTruthy();
    expect(within(scope).getByText('No Role')).toBeTruthy();
    const noRoleRow = scope.querySelector('[data-role-slug="no_role"]');
    expect(noRoleRow).not.toBeNull();
    expect(noRoleRow?.querySelector('.bg-muted-foreground\\/40')).not.toBeNull();
    expect(within(scope).getByText(/A user can hold more than one role/)).toBeTruthy();
  });

  it('uses the Arabic dictionary for system roles and renders "بدون دور" for no_role slice', () => {
    render(
      withI18n(
        <RoleDistributionChart
          items={[
            ...items,
            { slug: 'no_role', nameAr: 'بدون دور', nameEn: 'No Role', userCount: 2 },
          ]}
          usersWithoutRole={2}
          totalUsers={40}
          testId="roles"
        />,
        'ar',
      ),
    );
    const scope = screen.getByTestId('roles');
    expect(within(scope).getByText('مشاهد')).toBeTruthy();
    expect(within(scope).getByText('مدقق مخصص')).toBeTruthy();
    expect(within(scope).getByText('بدون دور')).toBeTruthy();
  });
});

describe('RecentActivityList', () => {
  it('composes sentences from translation keys and labels the system actor', () => {
    render(withI18n(<RecentActivityList items={ACTIVITY} testId="activity" />));
    const scope = screen.getByTestId('activity');

    expect(within(scope).getByText('سارة approved the signup m***@example.invalid')).toBeTruthy();
    expect(within(scope).getByText('System updated the settings')).toBeTruthy();
    // An unknown event degrades to the generic sentence, never to a raw slug.
    expect(within(scope).getByText('System: administrative activity')).toBeTruthy();
    expect(within(scope).getByText('Roles: Viewer')).toBeTruthy();
  });

  it('shows the honest empty state', () => {
    render(withI18n(<RecentActivityList items={[]} testId="activity" />));
    expect(
      within(screen.getByTestId('activity')).getByText(
        'No administrative activity has been recorded yet.',
      ),
    ).toBeTruthy();
  });
});

describe('dashboardFormat', () => {
  it('formats relative times deterministically', () => {
    const now = new Date('2026-10-20T09:00:00.000Z').getTime();
    expect(formatDashboardRelative('2026-10-20T08:55:00.000Z', 'en', now)).toBe('5 minutes ago');
    expect(formatDashboardRelative('2026-10-20T06:00:00.000Z', 'en', now)).toBe('3 hours ago');
  });

  it('does not shift a calendar-day bucket across a day boundary', () => {
    expect(formatDashboardDay('2026-10-01', 'en')).toBe('1 Oct');
  });

  it('renders an instant in the project time zone it is given', () => {
    // 08:30Z is 11:30 in Asia/Riyadh (fixed UTC+3, no DST).
    expect(formatDashboardDateTime('2026-10-20T08:30:00.000Z', 'en', 'Asia/Riyadh')).toContain(
      '11:30',
    );
    /* An unknown zone (corrupt setting) never throws — it degrades to the
       no-zone formatting so the dashboard stays up. */
    expect(formatDashboardDateTime('2026-10-20T08:30:00.000Z', 'en', 'Mars/Olympus_Mons')).toBe(
      formatDashboardDateTime('2026-10-20T08:30:00.000Z', 'en'),
    );
  });

  it('guards percentages with a zero total', () => {
    expect(formatDashboardPercent(5, 0, 'en')).toBe('0');
    expect(formatDashboardPercent(1, 4, 'en')).toBe('25');
  });
});
