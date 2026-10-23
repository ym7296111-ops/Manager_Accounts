import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import { ar } from '@/i18n/locales/ar';
import { en } from '@/i18n/locales/en';
import SettingsPage from '@/pages/SettingsPage';

/**
 * Capability gate on `/settings/app/notifications`.
 *
 * The screen used to mount for every authenticated caller and fail on every
 * server call (42501) instead of refusing up front. These cases pin the new
 * behaviour: a caller holding neither `notifications.manage` nor
 * `settings.manage` is shown the shared 403 panel, and one holding either
 * capability still reaches the screen.
 */

const { rpc, client } = vi.hoisted(() => {
  const rpc = vi.fn();
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn(() => channel),
  };
  const client = {
    rpc,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return { rpc, client };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => client,
}));

vi.mock('@/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    session: { user: { id: 'gate-actor', email: 'gate@example.invalid' } },
    loading: false,
    configured: true,
    signIn: vi.fn(),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
  }),
}));

/** Capabilities the fake server grants: no argument = neither one. */
function grantCapabilities(capabilities: {
  templates?: boolean | PostgrestErrorLike;
  transport?: boolean | PostgrestErrorLike;
}) {
  rpc.mockReset().mockImplementation((fnName: string) => {
    if (fnName === 'can_manage_notification_templates') {
      return Promise.resolve(asResponse(capabilities.templates));
    }
    if (fnName === 'can_manage_email_transport') {
      return Promise.resolve(asResponse(capabilities.transport));
    }
    return Promise.resolve({ data: null, error: null });
  });
}

interface PostgrestErrorLike {
  code: string;
  message: string;
  details: string;
  hint: string;
}

/** A boolean is a granted/refused capability; an object is a refused RPC. */
function asResponse(value: boolean | PostgrestErrorLike | undefined) {
  if (typeof value === 'object' && value !== null) {
    return { data: null, error: value };
  }
  return { data: value === true, error: null };
}

const REFUSED: PostgrestErrorLike = {
  code: '42501',
  message: 'administrator privileges required',
  details: '',
  hint: '',
};

function renderNotifications(locale: 'ar' | 'en' = 'ar') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings/app/notifications']}>
          <Routes>
            <Route path="settings/:family/:section" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('SettingsPage — notifications capability gate', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    grantCapabilities({});
  });

  it('shows the 403 panel immediately when the caller holds neither capability', async () => {
    grantCapabilities({ templates: false, transport: false });
    renderNotifications();

    expect(await screen.findByText('403')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /الوصول مرفوض/ })).toBeTruthy();
    // The screen itself is never mounted — no failed RPC calls behind it.
    expect(screen.queryByTestId('notification-settings')).toBeNull();
    expect(screen.getByRole('link', { name: ar['notifications.denied.back'] })).toBeTruthy();
  });

  it('shows the 403 panel translated into English when the UI locale is English', async () => {
    grantCapabilities({ templates: false, transport: false });
    renderNotifications('en');

    expect(await screen.findByText('403')).toBeTruthy();
    expect(screen.getByRole('heading', { name: en['notifications.denied.title'] })).toBeTruthy();
    expect(screen.getByText(en['notifications.denied.body'])).toBeTruthy();
  });

  it('mounts the screen when the caller holds notifications.manage only', async () => {
    grantCapabilities({ templates: true, transport: false });
    renderNotifications();

    expect(await screen.findByTestId('notification-settings')).toBeTruthy();
    expect(screen.queryByText('403')).toBeNull();
  });

  it('mounts the screen when the caller holds settings.manage only', async () => {
    grantCapabilities({ templates: false, transport: true });
    renderNotifications();

    expect(await screen.findByTestId('notification-settings')).toBeTruthy();
    expect(screen.queryByText('403')).toBeNull();
  });

  it('denies access when a capability RPC is refused with 42501', async () => {
    grantCapabilities({ templates: REFUSED, transport: REFUSED });
    renderNotifications();

    expect(await screen.findByText('403')).toBeTruthy();
    expect(screen.queryByTestId('notification-settings')).toBeNull();
  });

  it('resolves the capability once per actor — never one request per render', async () => {
    grantCapabilities({ templates: true, transport: true });
    renderNotifications();

    await screen.findByTestId('notification-settings');
    const capabilityCalls = rpc.mock.calls.filter(([fnName]) =>
      String(fnName).startsWith('can_manage_'),
    );
    expect(capabilityCalls).toHaveLength(2);
  });
});
