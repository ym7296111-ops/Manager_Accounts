import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/context/AuthContext';
import { BrandingProvider } from '@/context/BrandingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';
import ProfilePage from '@/pages/ProfilePage';

/**
 * Profile settings & modal ChangePasswordDialog. The session runs through the
 * real `AuthProvider` over a mocked Supabase client so every validation rule,
 * portal/focus behavior, dialog dismissal, and toast notification is verified.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: vi.fn(() => null),
}));

function mockSupabase(
  overrides: {
    updateUser?: unknown;
    signInWithPassword?: unknown;
    session?: unknown;
    delegatedCapabilities?: unknown;
    roles?: unknown;
  } = {},
) {
  const auth = {
    getSession: vi.fn().mockResolvedValue({
      data: {
        session: overrides.session ?? {
          user: {
            id: 'user-1',
            email: 'member@example.com',
            user_metadata: { full_name: 'عضو الاختبار' },
          },
        },
      },
      error: null,
    }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi.fn().mockResolvedValue(overrides.signInWithPassword ?? { error: null }),
    updateUser: vi.fn().mockResolvedValue(overrides.updateUser ?? { error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const queryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { approval_status: 'approved' }, error: null }),
  };
  queryBuilder.select.mockReturnValue(queryBuilder);
  queryBuilder.eq.mockReturnValue(queryBuilder);
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  const rpc = vi.fn((fnName: string) => {
    if (fnName === 'get_my_delegated_capabilities') {
      return Promise.resolve({ data: overrides.delegatedCapabilities ?? [], error: null });
    }
    if (fnName === 'get_my_roles') {
      return Promise.resolve({ data: overrides.roles ?? [], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  vi.mocked(getSupabase).mockReturnValue({
    auth,
    rpc,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn().mockResolvedValue('ok'),
    from: vi.fn(() => queryBuilder),
  } as unknown as NonNullable<ReturnType<typeof getSupabase>>);
  return auth;
}

function renderProfile() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <BrandingProvider>
              <MemoryRouter initialEntries={['/profile']}>
                <Routes>
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/login" element={<p>Sign in reached</p>} />
                </Routes>
              </MemoryRouter>
            </BrandingProvider>
          </QueryClientProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

async function openPasswordDialog(): Promise<{
  dialog: HTMLElement;
  submit: HTMLButtonElement;
}> {
  const trigger = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'تغيير كلمة المرور',
  });
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  const submit = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'تحديث' });
  await waitFor(() => expect(submit.disabled).toBe(false));
  return { dialog, submit };
}

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('ProfilePage — ChangePasswordDialog & self-service profile', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('hides inline password inputs initially and opens ChangePasswordDialog when clicking "تغيير كلمة المرور"', async () => {
    mockSupabase();
    renderProfile();

    expect(await screen.findByRole('heading', { level: 1, name: 'الملف الشخصي' })).toBeTruthy();
    expect(await screen.findByText('عضو الاختبار')).toBeTruthy();
    expect(screen.getByText('member@example.com')).toBeTruthy();

    /* No inline password inputs cluttering `/profile` before clicking the trigger. */
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText(/كلمة المرور الحالية/)).toBeNull();
    expect(screen.queryByLabelText('كلمة المرور الجديدة')).toBeNull();
    expect(screen.queryByLabelText('تأكيد كلمة المرور')).toBeNull();

    const { dialog } = await openPasswordDialog();
    expect(
      within(dialog).getByRole('heading', { level: 2, name: 'تغيير كلمة المرور' }),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText(/كلمة المرور الحالية/)).toBeTruthy();
    expect(within(dialog).getByLabelText('كلمة المرور الجديدة')).toBeTruthy();
    expect(within(dialog).getByLabelText('تأكيد كلمة المرور')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'تحديث' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'إلغاء' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses a new password below the policy without calling Supabase', async () => {
    const auth = mockSupabase();
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', 'short7');
    fill('تأكيد كلمة المرور', 'short7');
    fireEvent.click(submit);

    expect(await screen.findByText('كلمة المرور قصيرة جداً — الحد الأدنى 8 أحرف.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('refuses a mismatched confirmation without calling Supabase', async () => {
    const auth = mockSupabase();
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', 'longenough1');
    fill('تأكيد كلمة المرور', 'longenough2');
    fireEvent.click(submit);

    expect(await screen.findByText('كلمتا المرور غير متطابقتين.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('accepts any character combination, closes the dialog, and displays toast "تم تغيير كلمة المرور بنجاح"', async () => {
    const auth = mockSupabase();
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', '!!!!!!!!');
    fill('تأكيد كلمة المرور', '!!!!!!!!');
    fireEvent.click(submit);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('password-change-toast').textContent).toContain(
      'تم تغيير كلمة المرور بنجاح',
    );
    expect(auth.updateUser).toHaveBeenCalledWith({ password: '!!!!!!!!' });
  });

  it('verifies the current password, updates the password, closes the dialog, and shows the toast', async () => {
    const auth = mockSupabase();
    renderProfile();
    await screen.findByText('member@example.com');
    const { submit } = await openPasswordDialog();

    fill(/كلمة المرور الحالية/, 'currentpass');
    fill('كلمة المرور الجديدة', 'brand-new-pass');
    fill('تأكيد كلمة المرور', 'brand-new-pass');
    fireEvent.click(submit);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('password-change-toast').textContent).toContain(
      'تم تغيير كلمة المرور بنجاح',
    );
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'member@example.com',
      password: 'currentpass',
    });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'brand-new-pass' });
  });

  it('skips the verification step when the current password is left empty', async () => {
    const auth = mockSupabase();
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', 'another-pass1');
    fill('تأكيد كلمة المرور', 'another-pass1');
    fireEvent.click(submit);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'another-pass1' });
  });

  it('refuses the change inside the dialog when the supplied current password is wrong', async () => {
    const auth = mockSupabase({
      signInWithPassword: { error: { message: 'Invalid login credentials' } },
    });
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill(/كلمة المرور الحالية/, 'not-it');
    fill('كلمة المرور الجديدة', 'brand-new-pass');
    fill('تأكيد كلمة المرور', 'brand-new-pass');
    fireEvent.click(submit);

    expect(await screen.findByText('كلمة المرور الحالية غير صحيحة.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('surfaces a refused write as an actionable error inside the dialog', async () => {
    const auth = mockSupabase({
      updateUser: { error: { message: 'New password should be different from the old password.' } },
    });
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', 'brand-new-pass');
    fill('تأكيد كلمة المرور', 'brand-new-pass');
    fireEvent.click(submit);

    expect(
      await screen.findByText('رفض الخادم كلمة المرور الجديدة، جرّب كلمة مرور أخرى.'),
    ).toBeTruthy();
    expect(auth.updateUser).toHaveBeenCalled();
  });

  it('points an expired session back to the sign-in screen', async () => {
    mockSupabase({ updateUser: { error: { message: 'Auth session missing!' } } });
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', 'brand-new-pass');
    fill('تأكيد كلمة المرور', 'brand-new-pass');
    fireEvent.click(submit);

    expect(await screen.findByText('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'تسجيل الدخول' })).toBeTruthy();
  });

  it('reports an unconfigured environment instead of pretending to succeed', async () => {
    renderProfile();
    const { submit } = await openPasswordDialog();

    fill('كلمة المرور الجديدة', 'brand-new-pass');
    fill('تأكيد كلمة المرور', 'brand-new-pass');
    fireEvent.click(submit);

    expect((await screen.findByRole('alert')).textContent).toContain('لم يتم ضبط متغيرات Supabase');
    expect(submit.disabled).toBe(false);
  });

  it('shows the Arabic empty state when the user has no extra delegations', async () => {
    mockSupabase({
      delegatedCapabilities: [],
      roles: [{ slug: 'viewer', name_ar: 'مشاهد', name_en: 'Viewer' }],
    });
    renderProfile();

    expect(await screen.findByText('لا تملك تفويضات إضافية حالياً')).toBeTruthy();
    expect(screen.getByTestId('profile-delegations-section').getAttribute('id')).toBe(
      'delegations',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'الأدوار' })).toBeTruthy();
    expect(screen.getByTestId('profile-role-viewer').textContent).toContain('viewer');
  });

  it('renders active and expiring-soon delegations with slug, granter, dates, and status badges', async () => {
    const fiveDaysOut = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const twentyDaysOut = new Date(Date.now() + 20 * 86_400_000).toISOString();

    mockSupabase({
      roles: [
        { slug: 'editor', name_ar: 'محرر', name_en: 'Editor' },
        { slug: 'admin', name_ar: 'مدير', name_en: 'Administrator' },
      ],
      delegatedCapabilities: [
        {
          id: 'cap-expiring',
          slug: 'users.approve',
          granted_by: 'owner-id',
          granted_by_email: 'owner@example.com',
          granted_at: '2026-10-20T09:00:00.000Z',
          expires_at: fiveDaysOut,
        },
        {
          id: 'cap-active',
          slug: 'users.reset_password',
          granted_by: 'owner-id',
          granted_by_email: 'admin@example.com',
          granted_at: '2026-10-21T09:00:00.000Z',
          expires_at: twentyDaysOut,
        },
      ],
    });
    renderProfile();

    const expiringItem = await screen.findByTestId('profile-delegation-users.approve');
    const activeItem = await screen.findByTestId('profile-delegation-users.reset_password');

    expect(expiringItem.textContent).toContain('users.approve');
    expect(expiringItem.textContent).toContain('owner@example.com');
    expect(expiringItem.textContent).toContain('🕐');
    expect(expiringItem.textContent).toContain('ينتهي قريباً');

    expect(activeItem.textContent).toContain('users.reset_password');
    expect(activeItem.textContent).toContain('admin@example.com');
    expect(activeItem.textContent).toContain('🕐');
    expect(activeItem.textContent).toContain('نشط');

    expect(screen.getByTestId('profile-role-editor').textContent).toContain('editor');
    expect(screen.getByTestId('profile-role-admin').textContent).toContain('admin');
  });
});
