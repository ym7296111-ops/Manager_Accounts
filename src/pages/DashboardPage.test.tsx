import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthCapabilitiesModule from '@/hooks/useAuthCapabilities';
import type {
  ExecutiveDashboard,
  ExecutiveDashboardErrorCode,
} from '@/hooks/useExecutiveDashboard';
import type * as ExecutiveDashboardModule from '@/hooks/useExecutiveDashboard';
import { BrandingProvider } from '@/context/BrandingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider } from '@/i18n/I18nContext';
import DashboardPage from '@/pages/DashboardPage';

/**
 * Screen-level tests for the executive dashboard section of DashboardPage.
 *
 * The capability channel and the data hook are stubbed at their module seams
 * so each state can be pinned independently:
 *
 *   - a caller without `dashboard:read` gets the denial panel and the RPC is
 *     never called;
 *   - a holder gets the four KPI cards, both charts and the activity list;
 *   - loading and failure render explicit states instead of zeros;
 *   - the dashboard-only shell keeps hiding quick access (unchanged).
 */

interface CapabilityState {
  capabilities: string[];
  isAuthoritative: boolean;
  isLoading: boolean;
  configured: boolean;
}

interface HookState {
  data: ExecutiveDashboard | null;
  isLoading: boolean;
  isRefreshing: boolean;
  errorCode: ExecutiveDashboardErrorCode | null;
  lastSyncedAt: number | null;
  refresh: ReturnType<typeof vi.fn>;
  enabled: boolean | null;
  windowDays: number | null;
}

const { capabilities, hook } = vi.hoisted(
  (): { capabilities: CapabilityState; hook: HookState } => ({
    capabilities: {
      capabilities: [],
      isAuthoritative: false,
      isLoading: false,
      configured: true,
    },
    hook: {
      data: null,
      isLoading: false,
      isRefreshing: false,
      errorCode: null,
      lastSyncedAt: null,
      refresh: vi.fn(),
      enabled: null,
      windowDays: null,
    },
  }),
);

vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthCapabilitiesModule>();
  return {
    ...actual,
    useAuthCapabilities: () => ({
      ...capabilities,
      hasCapability: (slug: string) =>
        capabilities.capabilities.includes('*') || capabilities.capabilities.includes(slug),
    }),
  };
});

vi.mock('@/hooks/useExecutiveDashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecutiveDashboardModule>();
  return {
    ...actual,
    useExecutiveDashboard: (options?: { enabled?: boolean; windowDays?: number }) => {
      hook.enabled = options?.enabled ?? null;
      hook.windowDays = options?.windowDays ?? null;
      return {
        data: hook.data,
        isLoading: hook.isLoading,
        isRefreshing: hook.isRefreshing,
        errorCode: hook.errorCode,
        lastSyncedAt: hook.lastSyncedAt,
        refresh: hook.refresh,
      };
    },
  };
});

const DASHBOARD: ExecutiveDashboard = {
  generatedAt: '2026-10-20T09:00:00.000Z',
  timezone: 'Asia/Riyadh',
  windowDays: 30,
  kpis: {
    totalUsers: 42,
    pendingApprovals: 3,
    suspendedUsers: 1,
    pendingPasswordResets: 2,
    signedInToday: 7,
  },
  dailySignups: [
    { day: '2026-10-19', count: 2 },
    { day: '2026-10-20', count: 1 },
  ],
  roleDistribution: [
    { slug: 'viewer', nameAr: 'مشاهد', nameEn: 'Viewer', userCount: 30 },
    { slug: 'executive', nameAr: 'الإدارة العليا', nameEn: 'Executive', userCount: 2 },
  ],
  usersWithoutRole: 3,
  recentActivity: [
    {
      id: '1',
      occurredAt: '2026-10-20T08:30:00.000Z',
      action: 'user.updated',
      event: 'user.approval_approve',
      entity: 'user',
      actorKind: 'user',
      actorLabel: 'Sara',
      targetLabel: 'm***@example.invalid',
      roleSlugs: ['viewer'],
    },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <ThemeProvider>
      <I18nProvider defaultLocale="en">
        <QueryClientProvider client={queryClient}>
          <BrandingProvider>
            <MemoryRouter>
              <DashboardPage />
            </MemoryRouter>
          </BrandingProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  capabilities.capabilities = [];
  capabilities.isAuthoritative = false;
  hook.data = null;
  hook.isLoading = false;
  hook.isRefreshing = false;
  hook.errorCode = null;
  hook.lastSyncedAt = null;
  hook.enabled = null;
  hook.windowDays = null;
  hook.refresh = vi.fn();
  window.localStorage.clear();
});

describe('DashboardPage — executive section', () => {
  it('never claims a denial while the capability channel is unresolved', () => {
    renderPage();
    expect(screen.queryByTestId('dashboard-no-access')).toBeNull();
    expect(screen.queryByTestId('dashboard-loading')).toBeNull();
    expect(hook.enabled).toBe(false);
  });

  it('renders the denial panel and keeps the RPC parked for a viewer', () => {
    capabilities.capabilities = ['dashboard.view'];
    capabilities.isAuthoritative = true;
    renderPage();

    expect(screen.getByTestId('dashboard-no-access')).toBeTruthy();
    expect(hook.enabled).toBe(false);
    // The rest of the landing page is untouched.
    expect(screen.getByText('Quick access')).toBeTruthy();
  });

  it('renders skeletons while the first snapshot is loading', () => {
    capabilities.capabilities = ['dashboard:read'];
    capabilities.isAuthoritative = true;
    hook.isLoading = true;
    renderPage();

    expect(hook.enabled).toBe(true);
    expect(hook.windowDays).toBe(30);
    expect(screen.getByTestId('dashboard-loading')).toBeTruthy();
  });

  it('renders the four KPI cards, both charts and the activity list', () => {
    capabilities.capabilities = ['dashboard:read'];
    capabilities.isAuthoritative = true;
    hook.data = DASHBOARD;
    hook.lastSyncedAt = Date.parse('2026-10-20T09:00:00.000Z');
    renderPage();

    const total = screen.getByTestId('kpi-total-users');
    expect(within(total).getByText('Total users')).toBeTruthy();
    expect(within(total).getByText('42')).toBeTruthy();

    const pending = screen.getByTestId('kpi-pending-approvals');
    expect(within(pending).getByText('Pending approvals')).toBeTruthy();
    expect(within(pending).getByText('3')).toBeTruthy();

    const resets = screen.getByTestId('kpi-pending-resets');
    expect(within(resets).getByText('Pending password resets')).toBeTruthy();
    expect(within(resets).getByText('2')).toBeTruthy();

    const today = screen.getByTestId('kpi-signed-in-today');
    expect(within(today).getByText('Signed in today')).toBeTruthy();
    expect(within(today).getByText('7')).toBeTruthy();

    // Suspended stays a secondary indicator (D1) — never a primary card.
    expect(screen.getByTestId('dashboard-suspended').textContent).toContain('1 suspended accounts');

    expect(screen.getByTestId('signups-chart')).toBeTruthy();
    expect(screen.getByTestId('role-distribution')).toBeTruthy();
    expect(within(screen.getByTestId('role-distribution')).getByText('No Role')).toBeTruthy();

    const activity = screen.getByTestId('recent-activity');
    expect(
      within(activity).getByText('Sara approved the signup m***@example.invalid'),
    ).toBeTruthy();

    /* The header names the project time zone next to "last updated" and
       renders the sync time in it: 09:00Z is 12:00 in Asia/Riyadh (the
       mocked RPC snapshot above), not the viewer's 09:00 UTC frame. */
    const lastUpdated = screen.getByTestId('dashboard-last-updated');
    expect(lastUpdated.textContent).toContain('Asia/Riyadh');
    expect(lastUpdated.textContent).toContain('12:00');

    /* Activity timestamps title-attribute renders in the same zone:
       08:30Z → 11:30 in Asia/Riyadh. */
    const activityTime = activity.querySelector('time');
    expect(activityTime?.getAttribute('title')).toContain('11:30');
  });

  it('shows the explicit error panel and retries on demand', () => {
    capabilities.capabilities = ['*'];
    capabilities.isAuthoritative = true;
    hook.errorCode = 'forbidden';
    renderPage();

    const panel = screen.getByTestId('dashboard-error');
    expect(
      within(panel).getByText('These indicators are limited to executive management.'),
    ).toBeTruthy();

    fireEvent.click(within(panel).getByText('Try again'));
    expect(hook.refresh).toHaveBeenCalledTimes(1);
  });

  it('hides quick access for the dashboard-only shell but keeps the KPIs', () => {
    capabilities.capabilities = ['dashboard:read'];
    capabilities.isAuthoritative = true;
    hook.data = DASHBOARD;
    renderPage();

    // The heading stays; its links are what the dashboard-only shell drops.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByTestId('kpi-total-users')).toBeTruthy();
  });

  it('treats an extra dashboard alias as dashboard-only (length === 1 regression)', () => {
    capabilities.capabilities = ['dashboard:read', 'dashboard.read'];
    capabilities.isAuthoritative = true;
    hook.data = DASHBOARD;
    renderPage();

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByTestId('kpi-total-users')).toBeTruthy();
  });

  it('restores the full shell for an administrator holding the wildcard', async () => {
    capabilities.capabilities = ['*'];
    capabilities.isAuthoritative = true;
    hook.data = DASHBOARD;
    renderPage();

    await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));
    expect(screen.getByTestId('kpi-total-users')).toBeTruthy();
  });
});
