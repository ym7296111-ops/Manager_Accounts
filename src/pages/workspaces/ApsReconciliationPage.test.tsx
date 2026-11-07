import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import ApsReconciliationPage from './ApsReconciliationPage';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: getClient }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: 'user-one' } } }),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const month = id(1),
  station = id(2),
  otherStation = id(3),
  session = id(4),
  classification = id(5),
  lineId = id(6);
const defaultOptions = () => ({
  months: [{ id: month, label: 'يناير 2027', is_active: true, is_fiscal_closed: false }],
  stations: [
    { id: station, label: 'المحطة الأولى' },
    { id: otherStation, label: 'المحطة الثانية' },
  ],
  can_manage: true,
  can_close: true,
  can_reopen_as_owner: false,
});
const defaultState = () => ({
  fiscal_month: { id: month, is_active: true, is_fiscal_closed: false },
  selected_session: {
    id: session,
    status: 'open',
    flow_type: 'screen',
    has_legacy_items: false,
    sequence_number: 1,
  },
  selected_lines: [
    {
      id: lineId,
      classification_id: classification,
      classification_name: 'حديد',
      book_amount: '100.00',
      accountant_amount: '100.00',
      difference: '0.00',
    },
  ],
  month_summary: {
    open_sessions_count: 2,
    eligible_open_screen_sessions: 2,
    eligible_open_stations_count: 2,
    eligible_closed_screen_sessions: 0,
    total_stations_with_sessions: 2,
    stations_with_nonzero_difference: [] as {
      station_id: string;
      station_name: string;
      total_difference: string;
    }[],
    total_month_difference: '0.00',
  },
  pagination: { offset: 0, limit: 50, has_more: false },
  flags: { can_close_now: true, close_blocked_reason: null as string | null },
});
let options: ReturnType<typeof defaultOptions>;
let state: ReturnType<typeof defaultState>;
let rpc: ReturnType<
  typeof vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>
>;
let from: ReturnType<typeof vi.fn>;
let writeError: string | null;
let selectedPages: ReturnType<typeof defaultState>['selected_lines'];
let readError: string | null;
function setup() {
  rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    await Promise.resolve();
    if (name === 'aps_get_reconciliation_options')
      return { data: structuredClone(options), error: null };
    if (name === 'aps_get_reconciliation_state') {
      if (readError) return { data: null, error: { code: readError } };
      const offset = args.p_offset as number;
      const currentLines = selectedPages.length ? selectedPages : state.selected_lines;
      return {
        data: {
          ...structuredClone(state),
          selected_lines: structuredClone(currentLines.slice(offset, offset + 50)),
          pagination: { offset, limit: 50, has_more: offset + 50 < currentLines.length },
        },
        error: null,
      };
    }
    if (writeError) return { data: null, error: { code: writeError } };
    if (name === 'aps_record_reconciliation') {
      const amount = args.p_accountant_amount as string;
      state.selected_lines[0]!.accountant_amount = amount;
      state.selected_lines[0]!.difference = '25.50';
      return {
        data: [
          {
            id: lineId,
            accountant_amount: Number('9999999999999999'),
            book_amount: 100,
            difference: Number('9999999999999999'),
          },
        ],
        error: null,
      };
    }
    if (name === 'aps_close_reconciliation_month') {
      state.selected_session.status = 'closed';
      state.month_summary.open_sessions_count = 0;
      state.month_summary.eligible_open_screen_sessions = 0;
      state.month_summary.eligible_closed_screen_sessions = 2;
      state.flags.can_close_now = false;
      state.flags.close_blocked_reason = 'no_eligible_open_sessions';
    }
    if (name === 'aps_reopen_reconciliation_month') {
      state.selected_session.status = 'open';
      state.month_summary.open_sessions_count = 2;
      state.month_summary.eligible_open_screen_sessions = 2;
      state.month_summary.eligible_closed_screen_sessions = 0;
      state.flags.can_close_now = true;
      state.flags.close_blocked_reason = null;
    }
    return { data: name === 'aps_open_reconciliation' ? session : null, error: null };
  });
  from = vi.fn(() => {
    throw new Error('Direct table access is prohibited');
  });
  getClient.mockReturnValue({ rpc, from });
}
function mount(path = `/workspaces/aps/reconciliation?month=${month}&station=${station}`) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider defaultLocale="ar">
        <MemoryRouter initialEntries={[path]}>
          <ApsReconciliationPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  options = defaultOptions();
  state = defaultState();
  selectedPages = [];
  writeError = null;
  readError = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.documentElement.lang = 'ar';
  setup();
});

describe('APS reconciliation screen', () => {
  it('loads exclusively through read RPCs and shows whole-month summary', async () => {
    state.month_summary.stations_with_nonzero_difference = [
      { station_id: otherStation, station_name: 'المحطة الثانية', total_difference: '150.00' },
    ];
    state.month_summary.total_month_difference = '150.00';
    state.flags.can_close_now = false;
    state.flags.close_blocked_reason = 'nonzero_differences';
    mount();
    expect(await screen.findByRole('heading', { name: /ملخص مطابقة الشهر/ })).not.toBeNull();
    expect(screen.getByText('الجلسات المفتوحة: 2')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'إغلاق جلسات الشهر' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/لا يمكن إغلاق جلسات الشهر لوجود فروق/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'عرض التفاصيل' })).not.toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('aps_get_reconciliation_state', {
      p_month_id: month,
      p_station_id: station,
      p_offset: 0,
      p_limit: 50,
    });
  });
  it('chooses the active month but requires an explicit station when there is more than one', async () => {
    mount('/workspaces/aps/reconciliation');
    await screen.findByLabelText('الشهر');
    expect(screen.getByLabelText('الشهر')).toHaveProperty('value', month);
    expect(screen.getByLabelText('المحطة')).toHaveProperty('value', '');
    expect(rpc.mock.calls.filter(([name]) => name === 'aps_get_reconciliation_state')).toHaveLength(
      0,
    );
  });
  it('shows loading and a read error without treating it as an empty session', async () => {
    readError = '42501';
    mount();
    expect(screen.getByText('جارٍ تحميل بيانات المطابقة…')).not.toBeNull();
    expect(await screen.findByText('ليست لديك صلاحية لهذه العملية.')).not.toBeNull();
    expect(screen.queryByText(/لا توجد جلسة مطابقة لهذه المحطة/)).toBeNull();
  });
  it('hides reopen for non-owner and shows a read-only closed session to owner', async () => {
    state.selected_session.status = 'closed';
    state.month_summary.open_sessions_count = 0;
    state.month_summary.eligible_open_screen_sessions = 0;
    state.month_summary.eligible_closed_screen_sessions = 2;
    state.flags.can_close_now = false;
    state.flags.close_blocked_reason = 'no_eligible_open_sessions';
    const view = mount();
    await screen.findByText('حديد');
    expect(screen.queryByRole('button', { name: 'إعادة فتح جلسات الشهر' })).toBeNull();
    expect(screen.getByRole('button', { name: 'فتح جلسة للمحطة' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('textbox', { name: /مبلغ المحاسب/ })).toBeNull();
    view.unmount();
    options.can_reopen_as_owner = true;
    setup();
    mount();
    expect(await screen.findByRole('button', { name: 'إعادة فتح جلسات الشهر' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  it('marks old and mixed legacy sessions read-only without displaying screen lines', async () => {
    state.selected_session.flow_type = 'legacy';
    state.selected_lines = [];
    const view = mount();
    expect(await screen.findByText(/جلسة مطابقة قديمة/)).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'سطور المطابقة' })).toBeNull();
    view.unmount();
    state.selected_session.flow_type = 'screen';
    state.selected_session.has_legacy_items = true;
    setup();
    mount();
    expect(await screen.findByText(/تحتوي الجلسة على عناصر مطابقة قديمة/)).not.toBeNull();
  });
  it('opens a session only for the selected station', async () => {
    const response = state as unknown as { selected_session: null; selected_lines: unknown[] };
    response.selected_session = null;
    response.selected_lines = [];
    mount();
    await screen.findByText(/لا توجد جلسة مطابقة لهذه المحطة/);
    fireEvent.click(screen.getByRole('button', { name: 'فتح جلسة للمحطة' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_open_reconciliation', {
        p_month_id: month,
        p_station_id: station,
      }),
    );
  });
  it('saves one line using an exact decimal string and reloads authoritative text amounts', async () => {
    mount();
    const input = await screen.findByLabelText('مبلغ المحاسب — حديد');
    fireEvent.change(input, { target: { value: '125.50' } });
    expect(screen.getByText('الفرق لآخر مبلغ محفوظ.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'إغلاق جلسات الشهر' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ — حديد' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_record_reconciliation', {
        p_session_id: session,
        p_classification_id: classification,
        p_accountant_amount: '125.50',
      }),
    );
    expect(await screen.findByText('تم حفظ السطر وتحديث البيانات.')).not.toBeNull();
    expect(screen.getByText('25.50')).not.toBeNull();
    expect(screen.queryByText('9999999999999999')).toBeNull();
  });
  it('rejects invalid amounts without a write', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('مبلغ المحاسب — حديد'), {
      target: { value: '-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ — حديد' }));
    expect(screen.getByRole('alert').textContent).toContain('أدخل مبلغاً غير سالب');
    expect(rpc.mock.calls.filter(([name]) => name === 'aps_record_reconciliation')).toHaveLength(0);
  });
  it('prevents a double click from sending two saves', async () => {
    let resolve!: (value: unknown) => void;
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation((name: string, args: Record<string, unknown>) =>
      name === 'aps_record_reconciliation'
        ? new Promise((r) => {
            resolve = r;
          })
        : original(name, args),
    );
    mount();
    fireEvent.change(await screen.findByLabelText('مبلغ المحاسب — حديد'), {
      target: { value: '101' },
    });
    const button = screen.getByRole('button', { name: 'حفظ — حديد' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(rpc.mock.calls.filter(([name]) => name === 'aps_record_reconciliation')).toHaveLength(1);
    resolve({ data: [], error: null });
    await screen.findByText(/تعذرت العملية؛ قد تكون البيانات/);
  });
  it('keeps the draft visible after another user closes the session while editing', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'aps_record_reconciliation') {
        state.selected_session.status = 'closed';
        state.month_summary.open_sessions_count = 0;
        state.month_summary.eligible_open_screen_sessions = 0;
        state.month_summary.eligible_closed_screen_sessions = 1;
        state.flags.can_close_now = false;
        state.flags.close_blocked_reason = 'no_eligible_open_sessions';
        return Promise.resolve({ data: null, error: { code: '22023' } });
      }
      return original(name, args);
    });
    mount();
    fireEvent.change(await screen.findByLabelText('مبلغ المحاسب — حديد'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ — حديد' }));
    expect(await screen.findByText('200')).not.toBeNull();
    expect(screen.getByText('المسودة غير المحفوظة:')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'مبلغ المحاسب — حديد' })).toBeNull();
  });
  it('closes the entire month only after a reason and refreshes', async () => {
    mount();
    await screen.findByText('حديد');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق جلسات الشهر' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/جميع محطات الشهر/)).not.toBeNull();
    expect(within(dialog).getByText('الجلسات: 2، المحطات: 2.')).not.toBeNull();
    fireEvent.change(within(dialog).getByLabelText('السبب'), { target: { value: 'تمت المطابقة' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_close_reconciliation_month', {
        p_month_id: month,
        p_reason: 'تمت المطابقة',
      }),
    );
    expect(await screen.findByText('أُغلقت جلسات المطابقة المؤهلة للشهر بنجاح.')).not.toBeNull();
  });
  it('owner reopens only when no month session is open', async () => {
    options.can_reopen_as_owner = true;
    state.selected_session.status = 'closed';
    state.month_summary.open_sessions_count = 0;
    state.month_summary.eligible_closed_screen_sessions = 2;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'إعادة فتح جلسات الشهر' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('السبب'), {
      target: { value: 'تصحيح البيانات' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_reopen_reconciliation_month', {
        p_month_id: month,
        p_reason: 'تصحيح البيانات',
      }),
    );
  });
  it('pages through 60 rows without duplicate IDs', async () => {
    selectedPages = Array.from({ length: 60 }, (_, i) => ({
      ...state.selected_lines[0]!,
      id: id(i + 100),
      classification_id: id(i + 200),
      classification_name: `تصنيف ${i}`,
    }));
    mount();
    expect(await screen.findByText('تصنيف 0')).not.toBeNull();
    expect(screen.queryByText('تصنيف 59')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد' }));
    expect(await screen.findByText('تصنيف 59')).not.toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(61);
    expect(rpc).toHaveBeenCalledWith('aps_get_reconciliation_state', {
      p_month_id: month,
      p_station_id: station,
      p_offset: 50,
      p_limit: 50,
    });
  });
  it('keeps long classification names visible without truncation', async () => {
    const name = 'تصنيف طويل للغاية '.repeat(25);
    state.selected_lines[0]!.classification_name = name;
    mount();
    expect((await screen.findByText(name.trim())).classList.contains('break-words')).toBe(true);
  });
  it('warns before changing station with an unsaved draft', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    fireEvent.change(await screen.findByLabelText('مبلغ المحاسب — حديد'), {
      target: { value: '110' },
    });
    fireEvent.change(screen.getByLabelText('المحطة'), { target: { value: otherStation } });
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('المحطة')).toHaveProperty('value', station);
    expect(screen.getByLabelText('مبلغ المحاسب — حديد')).toHaveProperty('value', '110');
    confirm.mockRestore();
  });
  it('restores a draft after unmount and reload in the same tab', async () => {
    const view = mount();
    fireEvent.change(await screen.findByLabelText('مبلغ المحاسب — حديد'), {
      target: { value: '123' },
    });
    await waitFor(() =>
      expect(window.sessionStorage.getItem('aps-reconciliation-drafts:user-one')).toContain('123'),
    );
    view.unmount();
    mount();
    expect(await screen.findByLabelText('مبلغ المحاسب — حديد')).toHaveProperty('value', '123');
  });
  it('blocks actions after a successful write if rereading fails and clears the draft only after confirmation', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === 'aps_record_reconciliation') readError = 'network';
      return result;
    });
    mount();
    fireEvent.change(await screen.findByLabelText('مبلغ المحاسب — حديد'), {
      target: { value: '125.50' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ — حديد' }));
    expect(
      await screen.findByText(/قد تكون العملية نجحت، لكن تعذّر تأكيد البيانات/),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'إغلاق جلسات الشهر' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('125.50')).not.toBeNull();
    readError = null;
    fireEvent.click(screen.getByRole('button', { name: 'تحديث البيانات' }));
    expect(await screen.findByText('تم تحديث البيانات.')).not.toBeNull();
    expect(screen.getByLabelText('مبلغ المحاسب — حديد')).toHaveProperty('value', '125.50');
    expect(screen.queryByText('الفرق لآخر مبلغ محفوظ.')).toBeNull();
  });
  it('detects a changed session between pages and disables all writes', async () => {
    selectedPages = Array.from({ length: 60 }, (_, i) => ({
      ...state.selected_lines[0]!,
      id: id(i + 100),
      classification_id: id(i + 200),
      classification_name: `تصنيف ${i}`,
    }));
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation((name, args) => {
      if (name === 'aps_get_reconciliation_state' && args.p_offset === 50)
        state.selected_session.id = id(999);
      return original(name, args);
    });
    mount();
    await screen.findByText('تصنيف 0');
    fireEvent.click(screen.getByRole('button', { name: 'تحميل المزيد' }));
    expect(await screen.findByText(/تغيّرت الجلسة بين الصفحات/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'إغلاق جلسات الشهر' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('textbox', { name: 'مبلغ المحاسب — تصنيف 0' })).toBeNull();
  });
  it('does not allow retrying a close after an uncertain response once the refreshed month is closed', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      if (name === 'aps_close_reconciliation_month') {
        await original(name, args);
        throw new Error('network lost after commit');
      }
      return original(name, args);
    });
    mount();
    await screen.findByText('حديد');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق جلسات الشهر' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('السبب'), { target: { value: 'تمت المطابقة' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    expect(await within(dialog).findByText(/تعذرت العملية أو الاتصال/)).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: 'تأكيد' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد' }));
    expect(
      rpc.mock.calls.filter(([name]) => name === 'aps_close_reconciliation_month'),
    ).toHaveLength(1);
  });
});
