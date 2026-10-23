import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { randomUUID } from 'node:crypto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/context/AuthContext';
import { getSupabase } from '@/lib/supabase';
import { BrandingProvider } from '@/context/BrandingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';
import Login from '@/pages/Login';

vi.mock('@/lib/supabase', () => ({
  getSupabase: vi.fn(() => null),
}));

function mockSupabase(
  signUpResult: unknown = { data: { user: null, session: null }, error: null },
) {
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi.fn().mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    }),
    signUp: vi.fn().mockResolvedValue(signUpResult),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  const queryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: (resolve: (value: { data: never[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  queryBuilder.select.mockReturnValue(queryBuilder);
  queryBuilder.eq.mockReturnValue(queryBuilder);
  const client = {
    auth,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn().mockResolvedValue('ok'),
    from: vi.fn(() => queryBuilder),
  } as unknown as NonNullable<ReturnType<typeof getSupabase>>;
  vi.mocked(getSupabase).mockReturnValue(client);
  return { ...auth, profileQuery: queryBuilder };
}

function renderLogin(
  initialEntry: string | { pathname: string; search?: string; state?: unknown } = '/login',
) {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <BrandingProvider>
              <MemoryRouter initialEntries={[initialEntry]}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/" element={<p>Dashboard reached</p>} />
                  <Route path="/settings/system/users" element={<p>Forbidden users route</p>} />
                </Routes>
              </MemoryRouter>
            </BrandingProvider>
          </QueryClientProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('Login (standalone screen)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('renders the Arabic sign-in form outside any dashboard shell', () => {
    renderLogin();

    expect(screen.getByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeTruthy();
    expect(screen.getByLabelText('البريد الإلكتروني')).toBeTruthy();
    expect(screen.getByLabelText('كلمة المرور')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'دخول' })).toBeTruthy();
    // The dashboard shell must NOT leak into the public route.
    expect(document.querySelector('aside[aria-label="التنقل الرئيسي"]')).toBeNull();
  });

  it('shows the explicit Supabase setup banner when env vars are missing', () => {
    renderLogin();

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('إعدادات Supabase غير مكتملة');
    expect(banner.textContent).toContain('VITE_SUPABASE_URL');
  });

  it('validates required fields before touching the network', async () => {
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'الرجاء إدخال البريد الإلكتروني',
    );

    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'صيغة البريد الإلكتروني غير صحيحة',
    );

    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect((await screen.findByRole('alert')).textContent).toContain('الرجاء إدخال كلمة المرور');
  });

  it('shows the awaiting-approval message when signup returns no session', async () => {
    const auth = mockSupabase();
    const testPassword = `signup-${randomUUID()}`;
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'إنشاء حساب' }));
    expect(screen.getByRole('heading', { level: 1, name: 'إنشاء حساب' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'new.user@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), {
      target: { value: testPassword },
    });

    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'إنشاء الحساب' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    expect(
      await screen.findByText(
        'تم تسجيل طلبك بنجاح. حسابك حالياً قيد المراجعة، وسيتم تفعيله من قبل الإدارة قريباً.',
      ),
    ).toBeTruthy();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'new.user@example.com',
      password: testPassword,
    });
  });

  it('greets the founder with the first-owner message and discards the signup session', async () => {
    const auth = mockSupabase({
      data: {
        user: { id: 'first-signup-user', email_confirmed_at: '2026-10-18T00:00:00Z' },
        session: { user: { id: 'first-signup-user' } },
      },
      error: null,
    });
    /* The signup trigger auto-approves only the first owner. */
    auth.profileQuery.maybeSingle.mockResolvedValue({
      data: { approval_status: 'approved' },
      error: null,
    });
    const testPassword = `signup-${randomUUID()}`;
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'إنشاء حساب' }));
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'first.owner@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), {
      target: { value: testPassword },
    });

    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'إنشاء الحساب' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    expect(
      await screen.findByText(
        'تم إنشاء حسابك بنجاح. بصفتك المؤسس، تم تأكيد بريدك الإلكتروني ومنحك دور المالك الأصلي وصلاحيات كاملة فوراً.',
      ),
    ).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalled();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'first.owner@example.com',
      password: testPassword,
    });
  });

  it('keeps later auto-confirmed signups on the awaiting-approval message', async () => {
    const auth = mockSupabase({
      data: {
        user: { id: 'later-signup-user', email_confirmed_at: '2026-10-18T00:00:00Z' },
        session: { user: { id: 'later-signup-user' } },
      },
      error: null,
    });
    /* Project auto-confirm ON: everyone gets a session — approval_status
       (not the session) decides which outcome banner to show. */
    auth.profileQuery.maybeSingle.mockResolvedValue({
      data: { approval_status: 'pending' },
      error: null,
    });
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'إنشاء حساب' }));
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'later.user@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), {
      target: { value: `signup-${randomUUID()}` },
    });

    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'إنشاء الحساب' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    expect(
      await screen.findByText(
        'تم تسجيل طلبك بنجاح. حسابك حالياً قيد المراجعة، وسيتم تفعيله من قبل الإدارة قريباً.',
      ),
    ).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalled();
  });

  it.each([
    ['pending', 'حسابك قيد المراجعة، سيتم تفعيله قريباً'],
    ['rejected', 'تم رفض طلبك، تواصل مع الإدارة'],
  ] as const)('refuses a %s account and clears its session', async (status, message) => {
    const auth = mockSupabase();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'applicant' }, session: { user: { id: 'applicant' } } },
      error: null,
    });
    auth.profileQuery.maybeSingle.mockResolvedValue({
      data: { approval_status: status },
      error: null,
    });
    renderLogin();
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'pending@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'secret-pass' } });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'دخول' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalled();
    expect(screen.queryByText('Dashboard reached')).toBeNull();
  });

  it('admits a verified approved account', async () => {
    const auth = mockSupabase();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'approved' }, session: { user: { id: 'approved' } } },
      error: null,
    });
    auth.profileQuery.maybeSingle.mockResolvedValue({
      data: { approval_status: 'approved' },
      error: null,
    });
    renderLogin();
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'approved@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'secret-pass' } });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'دخول' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText('Dashboard reached')).toBeTruthy();
  });

  it('renders the account-creation form in English as well', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Create an account' })).toBeTruthy();
    expect(
      screen.getByText('Create an account to get started. Email confirmation may be required.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
  });

  it('maps an unconfigured environment to a clear actionable error on submit', async () => {
    renderLogin();

    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), {
      target: { value: `login-${randomUUID()}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('لم يتم ضبط متغيرات Supabase');
  });

  it('always redirects to "/" after successful sign-in even when stale redirect state exists', async () => {
    const auth = mockSupabase();
    auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'viewer-1' }, session: { user: { id: 'viewer-1' } } },
      error: null,
    });
    auth.profileQuery.maybeSingle.mockResolvedValue({
      data: { approval_status: 'approved' },
      error: null,
    });

    renderLogin({
      pathname: '/login',
      search: '?redirectTo=',
      state: { from: '/settings/system/users' },
    });

    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'viewer@example.com' },
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'secret-pass' } });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'دخول' });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText('Dashboard reached')).toBeTruthy();
    expect(screen.queryByText('Forbidden users route')).toBeNull();
  });

  it('follows the stored locale (English keys render after switching)', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');

    renderLogin();

    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
