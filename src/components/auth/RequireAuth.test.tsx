import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CapabilitiesModule from '@/hooks/useAuthCapabilities';
import {
  RedirectDashboardOnly,
  RequireAuth,
  RequireCapability,
} from '@/components/auth/RequireAuth';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';

const signOutMock = vi.hoisted(() => vi.fn().mockResolvedValue({ error: null }));

const capabilityState = vi.hoisted(() => ({
  capabilities: [] as string[],
  isAuthoritative: true,
  isLoading: false,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    session: { user: { id: 'route-actor', email: 'route@example.invalid' } },
    loading: false,
    configured: true,
    signOut: signOutMock,
  }),
}));

vi.mock('@/hooks/useAuthCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilitiesModule>();
  return {
    ...actual,
    useAuthCapabilities: () => {
      const { capabilities, isAuthoritative, isLoading } = capabilityState;
      return {
        capabilities,
        isLoading,
        isAuthoritative,
        configured: true,
        hasCapability: (slug: string) => capabilities.includes('*') || capabilities.includes(slug),
      };
    },
  };
});

function renderGuarded(
  capability: string | readonly string[] | undefined,
  initialEntry = '/guarded',
) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/guarded"
            element={
              <RequireAuth capability={capability}>
                <p>secret screen</p>
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <p>dashboard screen</p>
              </RequireAuth>
            }
          />
          <Route path="/" element={<p>dashboard home</p>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('Executive dashboard-only route guard', () => {
  beforeEach(() => {
    capabilityState.capabilities = ['dashboard:read'];
    capabilityState.isAuthoritative = true;
    capabilityState.isLoading = false;
  });

  it('redirects executive users from settings to the dashboard root', async () => {
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/settings/system/users']}>
          <Routes>
            <Route
              path="/settings/*"
              element={
                <RedirectDashboardOnly>
                  <p>settings</p>
                </RedirectDashboardOnly>
              }
            />
            <Route path="/" element={<p>dashboard home</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(await screen.findByText('dashboard home')).toBeTruthy();
    expect(screen.queryByText('settings')).toBeNull();
  });
});

describe('RequireAuth capability & zero-role login guard', () => {
  beforeEach(() => {
    signOutMock.mockClear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    capabilityState.capabilities = [];
    capabilityState.isAuthoritative = true;
    capabilityState.isLoading = false;
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('blocks users with no roles in Arabic with "حسابك لا يملك صلاحيات حالياً. يرجى مراجعة المسؤول." and a sign-out button', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    capabilityState.capabilities = [];
    renderGuarded(undefined, '/dashboard');

    expect(screen.queryByText('dashboard screen')).toBeNull();
    expect(screen.getByTestId('auth-no-role-screen')).toBeTruthy();
    expect(screen.getByText('حسابك لا يملك صلاحيات حالياً. يرجى مراجعة المسؤول.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it('blocks entry to /dashboard when caller lacks dashboard capabilities', () => {
    capabilityState.capabilities = ['support.manage'];
    renderGuarded(undefined, '/dashboard');

    expect(screen.queryByText('dashboard screen')).toBeNull();
    expect(screen.getByTestId('auth-no-role-screen')).toBeTruthy();
    expect(
      screen.getByText(
        'Your account currently has no permissions assigned. Please contact the administrator.',
      ),
    ).toBeTruthy();
  });

  it('renders the children when caller holds dashboard capability and no route capability is required', () => {
    capabilityState.capabilities = ['dashboard:read'];
    renderGuarded(undefined, '/dashboard');
    expect(screen.queryByText('dashboard screen')).not.toBeNull();
  });

  it('renders the children when the caller holds the requirement', () => {
    capabilityState.capabilities = ['support.manage'];
    renderGuarded('support.manage');
    expect(screen.queryByText('secret screen')).not.toBeNull();
  });

  it('lets the wildcard through every requirement', () => {
    capabilityState.capabilities = ['*'];
    renderGuarded('users.manage');
    expect(screen.queryByText('secret screen')).not.toBeNull();
  });

  it('shows the 403 panel on an authoritative refusal', () => {
    capabilityState.capabilities = ['roles.manage'];
    renderGuarded('*');
    expect(screen.queryByText('secret screen')).toBeNull();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Access denied');
  });

  it('accepts any-of requirements (OR semantics)', () => {
    capabilityState.capabilities = ['settings.manage'];
    renderGuarded(['notifications.manage', 'settings.manage']);
    expect(screen.queryByText('secret screen')).not.toBeNull();
  });

  it('fails soft while the capability channel is unresolved', () => {
    capabilityState.isAuthoritative = false;
    renderGuarded('*');
    expect(screen.queryByText('secret screen')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('waits (no content, no denial) while the channel is loading', () => {
    capabilityState.isLoading = true;
    capabilityState.isAuthoritative = false;
    renderGuarded('*');
    expect(screen.queryByText('secret screen')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('RequireCapability (capability-only guard, no session redirect)', () => {
  beforeEach(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    capabilityState.capabilities = [];
    capabilityState.isAuthoritative = true;
    capabilityState.isLoading = false;
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('denies an authoritative caller who lacks the requirement', () => {
    capabilityState.capabilities = ['support.manage'];
    render(
      <I18nProvider>
        <MemoryRouter>
          <RequireCapability requirement="backup.manage">
            <p>backup screen</p>
          </RequireCapability>
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(screen.queryByText('backup screen')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('navigates cleanly to "/" when clicking the 403 back-to-dashboard button', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    capabilityState.capabilities = ['dashboard.view'];
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={['/settings/system/backup']}>
          <Routes>
            <Route
              path="/settings/system/backup"
              element={
                <RequireCapability requirement="backup.manage">
                  <p>backup screen</p>
                </RequireCapability>
              }
            />
            <Route path="/" element={<p>home dashboard screen</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    const backButton = screen.getByRole('button', { name: 'العودة إلى الشاشة الرئيسية' });
    fireEvent.click(backButton);

    expect(await screen.findByText('home dashboard screen')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
