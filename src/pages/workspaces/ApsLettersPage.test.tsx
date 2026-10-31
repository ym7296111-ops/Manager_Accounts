import { createClient } from '@supabase/supabase-js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import ApsLetterDetailPage from './ApsLetterDetailPage';
import ApsLettersPage from './ApsLettersPage';
import ApsWorkspaceLayout from './ApsWorkspaceLayout';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: getClient }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: 'reader-one' } } }),
}));

const LETTER_ID = '00000000-0000-4000-8000-000000000001';
const LINE_ID = '00000000-0000-4000-8000-000000000002';
const WAREHOUSE_ID = '00000000-0000-4000-8000-000000000003';
const CLASS_ID = '00000000-0000-4000-8000-000000000004';
const header = {
  id: LETTER_ID,
  letter_type: 'inbound',
  letter_number: '27',
  letter_number_raw: '027',
  letter_date: '2026-10-20',
  status: 'approved',
  counterparty_code: 'IN-007',
  counterparty_name: 'شركة تجريبية',
  source_total: '0.00',
  destination_total: '1234.50',
  cancel_reason: null,
  settlement_reason: null,
};
const line = {
  id: LINE_ID,
  line_number: 1,
  direction: 'in',
  warehouse_id: WAREHOUSE_ID,
  classification_id: CLASS_ID,
  amount: '1234.50',
  warehouse_name: 'المخزن الرئيسي',
  classification_name: 'حديد',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let sequence = 0;
function setupTransport(
  scenario:
    'normal' | 'empty' | 'forbidden' | 'network' | 'hidden' | 'loading' | 'pagination' = 'normal',
) {
  const requests: URL[] = [];
  const pagedHeaders = Array.from({ length: 26 }, (_, index) => ({
    ...header,
    id: `00000000-0000-4000-8000-${String(100 - index).padStart(12, '0')}`,
    letter_number: String(index + 1),
    letter_number_raw: String(index + 1),
  }));
  getClient.mockReturnValue(
    createClient('https://aps-view-test.invalid', 'public-key', {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `aps-view-${sequence++}`,
      },
      global: {
        fetch: (input) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          requests.push(url);
          if (scenario === 'loading') return new Promise<Response>(() => undefined);
          if (scenario === 'network') return Promise.reject(new TypeError('Failed to fetch'));
          if (url.pathname.includes('/rpc/'))
            return Promise.resolve(json(scenario !== 'forbidden'));
          if (url.pathname.endsWith('/letters')) {
            if (scenario === 'pagination') {
              const id = url.searchParams.get('id')?.replace(/^eq\./, '');
              if (id) return Promise.resolve(json(pagedHeaders.filter((item) => item.id === id)));
              return Promise.resolve(
                json(url.searchParams.has('or') ? pagedHeaders.slice(25) : pagedHeaders),
              );
            }
            return Promise.resolve(json(scenario === 'empty' ? [] : [header]));
          }
          if (url.pathname.endsWith('/letter_lines')) return Promise.resolve(json([line]));
          if (scenario === 'hidden' && /\/(warehouses|classifications)$/.test(url.pathname))
            return Promise.resolve(json({ code: '42501', message: 'directory denied' }, 403));
          return Promise.resolve(json({ message: 'not found' }, 404));
        },
      },
    }),
  );
  return requests;
}

function CurrentLocation() {
  const location = useLocation();
  return (
    <output data-testid="current-location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function mount(initial = '/workspaces/aps/letters') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider defaultLocale="ar">
        <MemoryRouter initialEntries={[initial]}>
          <CurrentLocation />
          <Routes>
            <Route path="/workspaces/aps" element={<ApsWorkspaceLayout />}>
              <Route path="letters" element={<ApsLettersPage />} />
              <Route path="letters/:letterId" element={<ApsLetterDetailPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('APS letters read-only screens', () => {
  beforeEach(() => {
    getClient.mockReset();
    window.localStorage.clear();
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  });

  it('shows the server-filtered card and returns from details with all filters intact', async () => {
    const requests = setupTransport();
    const search = '?type=inbound&status=approved&from=2026-10-01&to=2026-10-31';
    mount(`/workspaces/aps/letters${search}`);
    expect(await screen.findByRole('link', { name: 'عرض التفاصيل 027' })).toBeTruthy();
    expect(screen.getByText('شركة تجريبية')).toBeTruthy();
    expect(screen.getByText('IN-007')).toBeTruthy();
    // Latin digits everywhere, including the register card amounts.
    expect(screen.getByText('1,234.50')).toBeTruthy();
    const request = requests.find((url) => url.pathname.endsWith('/letters'))!;
    expect(request.searchParams.get('letter_type')).toBe('eq.inbound');
    expect(request.searchParams.get('status')).toBe('eq.approved');

    fireEvent.click(screen.getByRole('link', { name: 'عرض التفاصيل 027' }));
    expect(await screen.findByRole('heading', { name: 'سطور الخطاب' })).toBeTruthy();
    expect(screen.getByText('المخزن الرئيسي')).toBeTruthy();
    expect(screen.getByText('حديد')).toBeTruthy();
    expect(screen.getByTestId('current-location').textContent).toBe(
      `/workspaces/aps/letters/${LETTER_ID}${search}`,
    );
    fireEvent.click(screen.getByRole('link', { name: 'العودة إلى الخطابات' }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location').textContent).toBe(
        `/workspaces/aps/letters${search}`,
      ),
    );
    expect(await screen.findByRole('link', { name: 'عرض التفاصيل 027' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('نوع الخطاب').value).toBe('inbound');
    expect(screen.getByLabelText<HTMLSelectElement>('الحالة').value).toBe('approved');
    expect(
      screen.queryByRole('button', { name: /إنشاء خطاب|إضافة خطاب|اعتماد|إلغاء الخطاب/ }),
    ).toBeNull();
  });

  it('keeps rapid filter changes instead of overwriting the previous choice', async () => {
    setupTransport();
    mount();
    await screen.findByRole('link', { name: 'عرض التفاصيل 027' });
    const type = screen.getByLabelText('نوع الخطاب');
    const status = screen.getByLabelText('الحالة');
    const from = screen.getByLabelText('من تاريخ');
    act(() => {
      fireEvent.change(type, { target: { value: 'inbound' } });
      fireEvent.change(status, { target: { value: 'approved' } });
      fireEvent.change(from, { target: { value: '2026-10-01' } });
    });
    await waitFor(() => {
      const search = screen.getByTestId('current-location').textContent?.split('?')[1] ?? '';
      const params = new URLSearchParams(search);
      expect(params.get('type')).toBe('inbound');
      expect(params.get('status')).toBe('approved');
      expect(params.get('from')).toBe('2026-10-01');
    });
  });

  it('retains loaded pages and the cursor when returning from details, then refetches the latest page', async () => {
    const requests = setupTransport('pagination');
    mount('/workspaces/aps/letters?status=approved');
    await screen.findByRole('link', { name: 'عرض التفاصيل 25' });
    expect(screen.queryByRole('link', { name: 'عرض التفاصيل 26' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    await screen.findByRole('link', { name: 'عرض التفاصيل 26' });
    await waitFor(() =>
      expect(screen.getByTestId('current-location').textContent).toContain('cursor='),
    );
    const pagedLocation = screen.getByTestId('current-location').textContent;
    expect(pagedLocation).toContain('status=approved');
    fireEvent.click(screen.getByRole('link', { name: 'عرض التفاصيل 26' }));
    await screen.findByRole('heading', { name: 'سطور الخطاب' });
    fireEvent.click(screen.getByRole('link', { name: 'العودة إلى الخطابات' }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location').textContent).toBe(pagedLocation),
    );
    expect(await screen.findByRole('link', { name: 'عرض التفاصيل 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'عرض التفاصيل 26' })).toBeTruthy();
    const countBeforeLatest = requests.filter((url) => url.pathname.endsWith('/letters')).length;
    fireEvent.click(screen.getByRole('button', { name: 'عرض أحدث الخطابات' }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location').textContent).toBe(
        '/workspaces/aps/letters?status=approved',
      ),
    );
    await waitFor(() =>
      expect(requests.filter((url) => url.pathname.endsWith('/letters')).length).toBeGreaterThan(
        countBeforeLatest,
      ),
    );
    expect(await screen.findByRole('link', { name: 'عرض التفاصيل 25' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'عرض التفاصيل 26' })).toBeNull();
  });

  it('shows loading, empty, forbidden and network states distinctly', async () => {
    setupTransport('loading');
    const loading = mount();
    expect(await screen.findByText('جارٍ تحميل الخطابات...')).toBeTruthy();
    loading.unmount();

    setupTransport('empty');
    const empty = mount();
    expect(await screen.findByRole('heading', { name: 'لا توجد خطابات متاحة' })).toBeTruthy();
    empty.unmount();

    setupTransport('forbidden');
    const forbidden = mount();
    expect(
      await screen.findByRole('heading', { name: 'لا تملك صلاحية استعراض الخطابات' }),
    ).toBeTruthy();
    expect(screen.getByText('403')).toBeTruthy();
    forbidden.unmount();

    setupTransport('network');
    mount();
    expect(await screen.findByRole('heading', { name: 'تعذّر الاتصال' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });

  it('allows a bookmarked empty page to return to the latest letters', async () => {
    const requests = setupTransport('empty');
    mount(`/workspaces/aps/letters?cursor=2026-10-20_${LETTER_ID}`);
    await screen.findByRole('heading', { name: 'لا توجد خطابات متاحة' });
    fireEvent.click(screen.getByRole('button', { name: 'عرض أحدث الخطابات' }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location').textContent).toBe('/workspaces/aps/letters'),
    );
    await waitFor(() =>
      expect(requests.filter((url) => url.pathname.endsWith('/letters')).length).toBe(2),
    );
  });

  it('shows the saved names when directory access is denied, without querying the directories', async () => {
    const requests = setupTransport('hidden');
    mount(`/workspaces/aps/letters/${LETTER_ID}`);
    expect(await screen.findByRole('heading', { name: 'سطور الخطاب' })).toBeTruthy();
    expect(screen.getByText('المخزن الرئيسي')).toBeTruthy();
    expect(screen.getByText('حديد')).toBeTruthy();
    expect(screen.getAllByText('1,234.50').length).toBeGreaterThan(0);
    expect(requests.some((url) => /\/(warehouses|classifications)$/.test(url.pathname))).toBe(
      false,
    );
    expect(
      requests.find((url) => url.pathname.endsWith('/letter_lines'))?.searchParams.get('select'),
    ).toContain('warehouse_name');
  });

  it('applies mobile sheet filters only after confirmation and closes on Escape', async () => {
    const requests = setupTransport();
    mount();
    await screen.findByRole('link', { name: 'عرض التفاصيل 027' });
    fireEvent.click(screen.getByRole('button', { name: 'الفلاتر' }));
    const dialog = screen.getByRole('dialog', { name: 'تصفية الخطابات' });
    fireEvent.change(within(dialog).getByLabelText('الحالة'), { target: { value: 'approved' } });
    expect(screen.getByTestId('current-location').textContent).toBe('/workspaces/aps/letters');
    fireEvent.click(within(dialog).getByRole('button', { name: 'تطبيق الفلاتر' }));
    await waitFor(() =>
      expect(screen.getByTestId('current-location').textContent).toBe(
        '/workspaces/aps/letters?status=approved',
      ),
    );
    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('status') === 'eq.approved')).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: /الفلاتر/ }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'تصفية الخطابات' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'تصفية الخطابات' })).toBeNull();
  });

  it('switches labels and document direction in English', async () => {
    window.localStorage.setItem('admin-system:locale', 'en');
    setupTransport();
    mount();
    expect(await screen.findByRole('heading', { name: 'Letter register' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'View details 027' })).toBeTruthy();
    expect(screen.getByText('1,234.50')).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));
  });
});
