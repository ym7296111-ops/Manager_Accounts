import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/context/AuthContext';
import { BrandingProvider } from '@/context/BrandingContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { I18nProvider } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';
import Login from '@/pages/Login';

/**
 * Forgot password as a MANUAL APPROVAL request: only the email is inserted
 * into `password_reset_requests`; an authorized administrator enters a new
 * password at approval time through `admin-reset-password`.
 * The OTP journey stays in `src/lib/passwordRecovery.ts` as the future
 * reference; Supabase is mocked here, so the assertions are about what the
 * form *sends* and what it *reveals*.
 */
vi.mock('@/lib/supabase', () => ({
  getSupabase: vi.fn(() => null),
}));

const REVIEW_MESSAGE =
  'تم إرسال طلبك بنجاح — طلبك قيد المراجعة من المسؤول. ستتمكن من تسجيل الدخول بكلمة المرور الجديدة بعد اعتماد الطلب.';

function mockSupabase(overrides: { insert?: unknown } = {}) {
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signInWithPassword: vi
      .fn()
      .mockResolvedValue({ data: { user: null, session: null }, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: { user: null, session: null }, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  };
  const queryBuilder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { approval_status: 'approved' }, error: null }),
    insert: vi.fn().mockResolvedValue(overrides.insert ?? { data: null, error: null }),
  };
  queryBuilder.select.mockReturnValue(queryBuilder);
  queryBuilder.eq.mockReturnValue(queryBuilder);
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  const from = vi.fn(() => queryBuilder);
  vi.mocked(getSupabase).mockReturnValue({
    auth,
    channel: vi.fn(() => channel),
    removeChannel: vi.fn().mockResolvedValue('ok'),
    from,
  } as unknown as NonNullable<ReturnType<typeof getSupabase>>);
  return { auth, queryBuilder, from };
}

function renderLogin() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <BrandingProvider>
              <MemoryRouter initialEntries={['/login']}>
                <Routes>
                  <Route path="/login" element={<Login />} />
                  <Route path="/" element={<p>Dashboard reached</p>} />
                </Routes>
              </MemoryRouter>
            </BrandingProvider>
          </QueryClientProvider>
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>,
  );
}

/** Open the recovery form (unless already open) and fill a complete request. */
async function fillRequest(address = 'member@example.com', options: { openForm?: boolean } = {}) {
  const { openForm = true } = options;
  if (openForm) {
    fireEvent.click(await screen.findByRole('button', { name: 'نسيت كلمة المرور؟' }));
  }
  fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
    target: { value: address },
  });
  return screen.getByRole<HTMLButtonElement>('button', { name: 'إرسال الطلب' });
}

describe('Login — forgot password (manual approval request)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
    vi.mocked(getSupabase).mockReturnValue(null);
  });

  it('opens the request form from the sign-in screen and returns back to it', () => {
    mockSupabase();
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'نسيت كلمة المرور؟' }));

    expect(screen.getByRole('heading', { level: 1, name: 'استعادة كلمة المرور' })).toBeTruthy();
    expect(screen.getByLabelText('البريد الإلكتروني')).toBeTruthy();
    expect(screen.queryByLabelText('كلمة المرور الجديدة')).toBeNull();
    expect(screen.queryByLabelText('تأكيد كلمة المرور')).toBeNull();
    /* The OTP step is gone from the UI (it stays in passwordRecovery.ts). */
    expect(screen.queryByLabelText('رمز التحقق')).toBeNull();
    /* The transparency note explains that an administrator must approve. */
    expect(screen.getByRole('note').textContent).toContain(
      'يرسل هذا النموذج طلباً بالبريد الإلكتروني فقط',
    );

    fireEvent.click(screen.getByRole('button', { name: 'العودة إلى تسجيل الدخول' }));
    expect(screen.getByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeTruthy();
    expect(screen.getByLabelText('كلمة المرور')).toBeTruthy();
  });

  it('validates the address locally before touching Supabase', async () => {
    const { queryBuilder } = mockSupabase();
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: 'نسيت كلمة المرور؟' }));

    fireEvent.click(screen.getByRole('button', { name: 'إرسال الطلب' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'الرجاء إدخال البريد الإلكتروني',
    );

    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'إرسال الطلب' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'صيغة البريد الإلكتروني غير صحيحة',
    );

    expect(queryBuilder.insert).not.toHaveBeenCalled();
  });

  it('submits a normalized request and shows the under-review confirmation', async () => {
    const { queryBuilder } = mockSupabase();
    renderLogin();

    /* Mixed case + padding must reach the table trimmed and lowercased: the
       check constraint and the unique pending index rely on it. */
    const submit = await fillRequest('  Member@Example.COM ');
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(queryBuilder.insert).toHaveBeenCalledWith({
        email: 'member@example.com',
      }),
    );
    expect(await screen.findByText(REVIEW_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    /* The success panel replaces the email-only request form. */
    expect(screen.queryByLabelText('البريد الإلكتروني')).toBeNull();
  });

  it('answers an unregistered address with the very same confirmation', async () => {
    /* The table accepts ANY well-formed address, so the screen cannot be used
       to discover which addresses have accounts. */
    const { queryBuilder } = mockSupabase();
    renderLogin();

    const submit = await fillRequest('stranger@example.com');
    fireEvent.click(submit);

    expect(await screen.findByText(REVIEW_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(queryBuilder.insert).toHaveBeenCalledTimes(1);
  });

  it('reports a request that is already under review', async () => {
    mockSupabase({
      insert: {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      },
    });
    renderLogin();

    const submit = await fillRequest('member@example.com');
    fireEvent.click(submit);

    expect(
      await screen.findByText('يوجد لديك طلب قيد المراجعة بالفعل، انتظر اعتماد المسؤول.'),
    ).toBeTruthy();
  });

  it('reports a missing migration as an operator problem', async () => {
    mockSupabase({
      insert: {
        data: null,
        error: {
          code: 'PGRST205',
          message: "Could not find the table 'public.password_reset_requests' in the schema cache",
        },
      },
    });
    renderLogin();

    const submit = await fillRequest('member@example.com');
    fireEvent.click(submit);

    expect(
      await screen.findByText(
        'خدمة استعادة كلمة المرور غير مفعّلة على هذا المشروع بعد، تواصل مع المسؤول.',
      ),
    ).toBeTruthy();
  });

  it('reports a network failure without losing the typed request', async () => {
    const { queryBuilder } = mockSupabase();
    queryBuilder.insert.mockRejectedValue(new TypeError('Failed to fetch'));
    renderLogin();

    const submit = await fillRequest('member@example.com');
    fireEvent.click(submit);

    expect(
      await screen.findByText('تعذّر الوصول إلى الخادم، تحقق من اتصالك بالإنترنت.'),
    ).toBeTruthy();
    /* The visitor stays on the form with the typed request intact. */
    expect(screen.getByLabelText('البريد الإلكتروني')).toHaveProperty(
      'value',
      'member@example.com',
    );
  });

  it('reports a missing Supabase configuration explicitly', async () => {
    /* getSupabase() returns null (no env): an operator problem, never the
       neutral review message. */
    renderLogin();

    const submit = await fillRequest('member@example.com');
    fireEvent.click(submit);

    expect(await screen.findByText('لم يتم ضبط متغيرات Supabase في هذه البيئة بعد.')).toBeTruthy();
  });

  it('returns to sign-in with the under-review banner after the request', async () => {
    mockSupabase();
    renderLogin();

    const submit = await fillRequest('member@example.com');
    fireEvent.click(submit);

    await screen.findByText(REVIEW_MESSAGE);
    fireEvent.click(screen.getByRole('button', { name: 'العودة إلى تسجيل الدخول' }));

    expect(screen.getByRole('heading', { level: 1, name: 'تسجيل الدخول' })).toBeTruthy();
    /* The banner repeats that an administrator must approve the request. */
    expect(screen.getByText(REVIEW_MESSAGE)).toBeTruthy();
  });
});
