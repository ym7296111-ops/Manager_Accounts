import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';
import ResetPasswordPage from '@/pages/ResetPasswordPage';

/**
 * Reset password screen. The recovery session is supplied by the mocked client
 * (Supabase opens it from the emailed link before this screen renders), so the
 * tests cover both the "session ready" and the "link unusable" branches.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: vi.fn(() => null),
}));

function mockSupabase(overrides: { session?: unknown; updateUser?: unknown } = {}) {
  const recoverySession =
    overrides.session === undefined ? { user: { id: 'user-1' } } : overrides.session;
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: recoverySession }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    updateUser: vi.fn().mockResolvedValue(overrides.updateUser ?? { error: null }),
  };
  vi.mocked(getSupabase).mockReturnValue({
    auth,
  } as unknown as NonNullable<ReturnType<typeof getSupabase>>);
  return auth;
}

function renderReset(props: { graceMs?: number; redirectDelayMs?: number } = {}) {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <MemoryRouter initialEntries={['/reset-password']}>
          <Routes>
            <Route path="/reset-password" element={<ResetPasswordPage {...props} />} />
            <Route path="/login" element={<p>Sign in reached</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  );
}

async function renderWithSession(overrides: Parameters<typeof mockSupabase>[0] = {}) {
  const auth = mockSupabase(overrides);
  renderReset({ graceMs: 50, redirectDelayMs: 20 });
  await screen.findByLabelText('كلمة المرور الجديدة');
  return auth;
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('waits for the recovery session before offering the form', () => {
    mockSupabase();
    renderReset({ graceMs: 5000 });

    expect(screen.getByText('جارٍ التحقق من رابط الاستعادة...')).toBeTruthy();
    expect(screen.queryByLabelText('كلمة المرور الجديدة')).toBeNull();
  });

  it('keeps the new-password form available after the recovery grace period', async () => {
    await renderWithSession();
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(() => resolve(), 75));
    });

    expect(screen.getByRole('heading', { level: 1, name: 'إعادة تعيين كلمة المرور' })).toBeTruthy();
    expect(screen.getByLabelText('كلمة المرور الجديدة')).toBeTruthy();
    expect(screen.getByLabelText('تأكيد كلمة المرور')).toBeTruthy();
    expect(screen.queryByText('رابط غير صالح')).toBeNull();
  });

  it('falls back to an invalid-link state when no session appears', async () => {
    mockSupabase({ session: null });
    renderReset({ graceMs: 50 });

    expect(await screen.findByText('رابط غير صالح')).toBeTruthy();
    expect(screen.queryByLabelText('كلمة المرور الجديدة')).toBeNull();
    expect(screen.getByRole('link', { name: 'العودة إلى تسجيل الدخول' })).toBeTruthy();
  });

  it('enforces the 8 character policy before writing anything', async () => {
    const auth = await renderWithSession();

    fill('كلمة المرور الجديدة', 'short12');
    fill('تأكيد كلمة المرور', 'short12');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كلمة المرور الجديدة' }));

    expect(await screen.findByText('كلمة المرور قصيرة جداً — الحد الأدنى 8 أحرف.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('rejects a confirmation that does not match', async () => {
    const auth = await renderWithSession();

    fill('كلمة المرور الجديدة', 'a-brand-new-pass');
    fill('تأكيد كلمة المرور', 'a-brand-new-pasz');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كلمة المرور الجديدة' }));

    expect(await screen.findByText('كلمتا المرور غير متطابقتين.')).toBeTruthy();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it('writes the password, confirms, then hands the user to the login screen', async () => {
    const auth = await renderWithSession();

    fill('كلمة المرور الجديدة', 'a-brand-new-pass');
    fill('تأكيد كلمة المرور', 'a-brand-new-pass');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كلمة المرور الجديدة' }));

    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'a-brand-new-pass' });
    expect(
      await screen.findByText('تم تحديث كلمة المرور بنجاح، يمكنك الآن تسجيل الدخول.'),
    ).toBeTruthy();

    await waitFor(() => expect(screen.getByText('Sign in reached')).toBeTruthy());
  });

  it('keeps the user on the page when the write is refused', async () => {
    const auth = await renderWithSession({ updateUser: { error: { message: 'Weak password' } } });

    fill('كلمة المرور الجديدة', 'a-brand-new-pass');
    fill('تأكيد كلمة المرور', 'a-brand-new-pass');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كلمة المرور الجديدة' }));

    expect(
      await screen.findByText('رفض الخادم كلمة المرور الجديدة، جرّب كلمة مرور أخرى.'),
    ).toBeTruthy();
    expect(auth.updateUser).toHaveBeenCalled();
    expect(screen.queryByText('Sign in reached')).toBeNull();
  });

  it('does not offer the form when Supabase is not configured', async () => {
    renderReset({ graceMs: 50 });

    expect(await screen.findByText('رابط غير صالح')).toBeTruthy();
  });
});
