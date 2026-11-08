import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import ApsReconciliationPage from './ApsReconciliationPage';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: getClient }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: 'user-one' } } }),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const month = id(1),
  session = id(2),
  classification = id(3),
  lineId = id(4),
  scope = id(6);
const options = () => ({
  months: [{ id: month, label: 'يناير 2027', is_active: true, is_fiscal_closed: false }],
  stations: [{ id: id(999), label: 'ignored' }],
  can_manage: true,
  can_close: true,
  can_reopen_as_owner: false,
});
const movement = () => ({
  book_inbound: '100.00',
  book_outbound: '20.00',
  accountant_inbound: null as string | null,
  accountant_outbound: null as string | null,
  book_balance: '80.00',
  accountant_balance: null as string | null,
  inbound_difference: null as string | null,
  outbound_difference: null as string | null,
  balance_difference: null as string | null,
});
const state = () => ({
  current_config_revision_id: id(5),
  historical_overlap: false,
  fiscal_month: { id: month, is_active: true, is_fiscal_closed: false },
  selected_session: {
    id: session,
    scope_id: scope,
    scope_name_snapshot: 'النطاق',
    source_config_revision_id: id(5),
    config_generation: '1',
    status: 'open' as 'open' | 'closed',
    flow_type: 'screen_v2',
    settings_revision_id: id(5),
    needs_review: false,
    review_reason: null as string | null,
    sequence_number: 1,
    snapshot_version: '1',
  },
  selected_lines: [
    {
      id: lineId,
      classification_id: classification,
      classification_name: 'حديد',
      version: '1',
      monthly: movement(),
      ytd: {
        ...movement(),
        book_opening: '30.00' as string | null,
        accountant_opening: '30.00' as string | null,
        accountant_opening_source: 'trusted_system' as 'manual' | 'trusted_system' | 'missing',
      },
    },
  ],
  month_summary: {
    open_sessions_count: 1,
    closed_sessions_count: 0,
    missing_system_opening_count: 0,
  },
  pagination: { offset: 0, limit: 50, has_more: false },
  flags: {
    can_close_now: false,
    close_blocked_reason: 'incomplete' as string | null,
    settings_changed: false as boolean | null,
    can_sync_from_settings: true,
  },
});
let current: ReturnType<typeof state>,
  opts: ReturnType<typeof options>,
  readFail = false,
  writeFail = false,
  noCommit = false;
let rpc: ReturnType<
    typeof vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>
  >,
  from: ReturnType<typeof vi.fn>;
function setup() {
  rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(
    async (name: string, args: Record<string, unknown> = {}) => {
      await Promise.resolve();
      if (name === 'aps_get_reconciliation_options')
        return { data: structuredClone(opts), error: null };
      if (name === 'aps_get_reconciliation_scopes_v3')
        return {
          data: [{ id: scope, name: 'النطاق', is_default: true, is_active: true }],
          error: null,
        };
      if (name === 'aps_get_reconciliation_state_v3')
        return readFail
          ? { data: null, error: { code: 'network' } }
          : { data: structuredClone(current), error: null };
      if (name === 'aps_record_reconciliation_v3') {
        if (writeFail) return { data: null, error: { code: '40001' } };
        if (!noCommit) {
          const l = current.selected_lines[0]!;
          l.monthly.accountant_inbound = args.p_accountant_inbound as string;
          l.monthly.accountant_outbound = args.p_accountant_outbound as string;
          l.ytd.accountant_inbound = args.p_accountant_ytd_inbound as string;
          l.ytd.accountant_outbound = args.p_accountant_ytd_outbound as string;
          l.ytd.accountant_opening_source =
            args.p_accountant_year_opening === null ? 'trusted_system' : 'manual';
          l.ytd.accountant_opening =
            (args.p_accountant_year_opening as string | null) ?? l.ytd.book_opening;
          l.version = String(BigInt(l.version) + 1n);
          current.selected_session.snapshot_version = String(
            BigInt(current.selected_session.snapshot_version) + 1n,
          );
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  );
  from = vi.fn(() => {
    throw new Error('direct table access forbidden');
  });
  getClient.mockReturnValue({ rpc, from });
}
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider defaultLocale="ar">
        <MemoryRouter initialEntries={[`/workspaces/aps/reconciliation?month=${month}`]}>
          <ApsReconciliationPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
async function edit() {
  fireEvent.click(await screen.findByRole('button', { name: 'إدخال المحاسب — حديد' }));
  return screen.getByRole('dialog');
}
function fill(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), {
    target: { value: '9999999999999999.99' },
  });
  fireEvent.change(within(dialog).getByLabelText('منصرف المحاسب'), { target: { value: '20' } });
  fireEvent.change(within(dialog).getByLabelText('وارد المحاسب التراكمي'), {
    target: { value: '130' },
  });
  fireEvent.change(within(dialog).getByLabelText('منصرف المحاسب التراكمي'), {
    target: { value: '30' },
  });
}
beforeEach(() => {
  current = state();
  opts = options();
  readFail = false;
  writeFail = false;
  noCommit = false;
  window.sessionStorage.clear();
  window.localStorage.clear();
  setup();
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe('v3 reconciliation', () => {
  it('reads v3 without a station, renders both tables and distinguishes null', async () => {
    mount();
    expect((await screen.findAllByText('حديد')).length).toBe(2);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('aps_get_reconciliation_state_v3', {
      p_month_id: month,
      p_scope_id: scope,
      p_offset: 0,
      p_limit: 50,
    });
    expect(screen.queryByLabelText('المحطة')).toBeNull();
    expect(screen.getAllByText('غير مدخل').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('التراكمي منذ بداية السنة'));
    expect(screen.getByText('مرجع النظام، ليس تأكيداً مستقلاً')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إغلاق النطاق للشهر' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('sends exact strings for all movements and null opening, and clears the draft only after confirmed reread', async () => {
    mount();
    const dialog = await edit();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_record_reconciliation_v3', {
        p_session_id: session,
        p_scope_id: scope,
        p_line_id: lineId,
        p_expected_generation: '1',
        p_classification_id: classification,
        p_accountant_inbound: '9999999999999999.99',
        p_accountant_outbound: '20.00',
        p_accountant_ytd_inbound: '130.00',
        p_accountant_ytd_outbound: '30.00',
        p_accountant_year_opening: null,
        p_expected_version: '1',
      }),
    );
    expect(await screen.findByText('تم حفظ السطر وتأكيد القيم من الخادم.')).toBeTruthy();
    await waitFor(() =>
      expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toBeNull(),
    );
  });
  it('saves a manual opening with all four independent movements', async () => {
    mount();
    const dialog = await edit();
    fill(dialog);
    fireEvent.click(within(dialog).getByLabelText('إدخال افتتاح مستقل'));
    fireEvent.change(within(dialog).getByLabelText('افتتاح المحاسب'), {
      target: { value: '45.25' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'aps_record_reconciliation_v3',
        expect.objectContaining({
          p_accountant_year_opening: '45.25',
          p_accountant_ytd_inbound: '130.00',
        }),
      ),
    );
    expect(await screen.findByText('تم حفظ السطر وتأكيد القيم من الخادم.')).toBeTruthy();
  });
  it('does not create a blocking draft just by opening and closing the editor', async () => {
    current.flags.can_close_now = true;
    current.flags.close_blocked_reason = null;
    mount();
    const dialog = await edit();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('button', { name: 'إغلاق النطاق للشهر' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toBeNull();
  });
  it('preserves a manual opening on later edits', async () => {
    const l = current.selected_lines[0]!;
    l.monthly.accountant_inbound = '100.00';
    l.monthly.accountant_outbound = '20.00';
    l.ytd.accountant_inbound = '130.00';
    l.ytd.accountant_outbound = '30.00';
    l.ytd.accountant_opening_source = 'manual';
    l.ytd.accountant_opening = '45.00';
    mount();
    const dialog = await edit();
    expect(within(dialog).getByLabelText('افتتاح المحاسب')).toHaveProperty('value', '45.00');
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), { target: { value: '101' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'aps_record_reconciliation_v3',
        expect.objectContaining({
          p_accountant_year_opening: '45.00',
          p_accountant_ytd_inbound: '130.00',
        }),
      ),
    );
  });
  it('retains drafts if a successful write cannot be verified', async () => {
    noCommit = true;
    mount();
    const dialog = await edit();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText(/تعذّر تأكيد الحفظ/)).toBeTruthy();
    await waitFor(() =>
      expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain(
        '9999999999999999.99',
      ),
    );
    expect(screen.getByRole('button', { name: 'إغلاق النطاق للشهر' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('retains drafts on version conflict and never sends invalid values', async () => {
    mount();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), { target: { value: '-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    expect(rpc.mock.calls.filter(([name]) => name === 'aps_record_reconciliation_v3')).toHaveLength(
      0,
    );
    fill(dialog);
    writeFail = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain(
        '9999999999999999.99',
      ),
    );
  });
  it('automatically rereads a 40001 conflict, keeps even an identical rejected draft, and requires review before retry', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      if (name === 'aps_record_reconciliation_v3' && args.p_expected_version === '1') {
        const line = current.selected_lines[0]!;
        line.monthly.accountant_inbound = '9999999999999999.99';
        line.monthly.accountant_outbound = '20.00';
        line.ytd.accountant_inbound = '130.00';
        line.ytd.accountant_outbound = '30.00';
        line.version = '2';
        current.selected_session.snapshot_version = '2';
        return { data: null, error: { code: '40001' } };
      }
      return original(name, args);
    });
    mount();
    const dialog = await edit();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(
        rpc.mock.calls.filter(([name]) => name === 'aps_get_reconciliation_state_v3').length,
      ).toBeGreaterThan(1),
    );
    expect((await within(dialog).findAllByText(/تغيّر السطر أو الجلسة/)).length).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText('وارد المحاسب')).toHaveProperty(
      'value',
      '9999999999999999.99',
    );
    expect(within(dialog).getByRole('button', { name: 'حفظ' })).toHaveProperty('disabled', true);
    await waitFor(() =>
      expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain(
        '"conflicted":true',
      ),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'الاحتفاظ بالمسودة ومتابعة التعديل' }),
    );
    expect(confirm).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'aps_record_reconciliation_v3',
        expect.objectContaining({ p_expected_version: '2' }),
      ),
    );
    expect(await screen.findByText('تم حفظ السطر وتأكيد القيم من الخادم.')).toBeTruthy();
  });
  it('falls back to session storage if local storage cannot write, and restores the draft', async () => {
    const set = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value as (
      this: Storage,
      key: string,
      value: string,
    ) => void;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === window.localStorage) throw new DOMException('unavailable', 'QuotaExceededError');
      return set.call(this, key, value);
    });
    const view = mount();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), {
      target: { value: '123.45' },
    });
    expect(await screen.findByText(/تُحفظ المسودات لهذا التبويب فقط/)).toBeTruthy();
    await waitFor(() =>
      expect(
        sessionStorage.getItem('aps-reconciliation-v3-drafts:user-one:session-fallback'),
      ).toContain('123.45'),
    );
    view.unmount();
    mount();
    const restored = await edit();
    expect(within(restored).getByLabelText('وارد المحاسب')).toHaveProperty('value', '123.45');
  });
  it('falls back to memory if local and session reads are unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('unavailable', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('unavailable', 'SecurityError');
    });
    mount();
    expect(await screen.findByText(/المسودات في الذاكرة فقط/)).toBeTruthy();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), { target: { value: '99.00' } });
    expect(within(dialog).getByLabelText('وارد المحاسب')).toHaveProperty('value', '99.00');
  });
  it('retains the in-memory draft and warns when both browser stores fail', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('unavailable', 'QuotaExceededError');
    });
    mount();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), {
      target: { value: '321.45' },
    });
    expect(await screen.findByText(/المسودات في الذاكرة فقط/)).toBeTruthy();
    expect(within(dialog).getByLabelText('وارد المحاسب')).toHaveProperty('value', '321.45');
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    const reopened = await edit();
    expect(within(reopened).getByLabelText('وارد المحاسب')).toHaveProperty('value', '321.45');
  });
  it('shows missing system opening as null and blocks closure', async () => {
    const l = current.selected_lines[0]!;
    l.ytd.book_opening = null;
    l.ytd.accountant_opening = null;
    l.ytd.accountant_opening_source = 'missing';
    current.flags.close_blocked_reason = 'missing_system_opening';
    mount();
    await screen.findAllByText('حديد');
    fireEvent.click(screen.getByText('التراكمي منذ بداية السنة'));
    expect(screen.getByText('الافتتاح مفقود')).toBeTruthy();
    expect(screen.getByText(/غياب افتتاح النظام/)).toBeTruthy();
  });
  it('blocks closure when system opening is missing even with a manual accountant opening', async () => {
    const line = current.selected_lines[0]!;
    line.ytd.book_opening = null;
    line.ytd.accountant_opening = '45.00';
    line.ytd.accountant_opening_source = 'manual';
    current.flags.close_blocked_reason = 'missing_system_opening';
    mount();
    await screen.findAllByText('حديد');
    fireEvent.click(screen.getByText('التراكمي منذ بداية السنة'));
    expect(screen.getByText('افتتاح مستقل أدخله المحاسب')).toBeTruthy();
    expect(screen.getByText(/غياب افتتاح النظام/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إغلاق النطاق للشهر' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('blocks closing when movements differ even if the displayed balance difference is zero', async () => {
    const line = current.selected_lines[0]!;
    line.monthly.accountant_inbound = '101.00';
    line.monthly.accountant_outbound = '21.00';
    line.monthly.balance_difference = '0.00';
    current.flags.close_blocked_reason = 'nonzero_differences';
    mount();
    await screen.findAllByText('حديد');
    expect(screen.getByText(/حتى إذا كان صافي الفرق صفراً/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إغلاق النطاق للشهر' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('retains a draft across unmount and restores it from local storage', async () => {
    const view = mount();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), {
      target: { value: '123.45' },
    });
    await waitFor(() =>
      expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain('123.45'),
    );
    view.unmount();
    mount();
    const restored = await edit();
    expect(within(restored).getByLabelText('وارد المحاسب')).toHaveProperty('value', '123.45');
  });
  it('retains a successful write until a later successful read confirms it', async () => {
    const original = rpc.getMockImplementation() as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      const result: unknown = await original(name, args);
      if (name === 'aps_record_reconciliation_v3') readFail = true;
      return result;
    });
    mount();
    const dialog = await edit();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText(/تعذّر تأكيد الحفظ/)).toBeTruthy();
    expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain(
      '9999999999999999.99',
    );
    readFail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'إعادة قراءة البيانات' }));
    expect(await screen.findByText('تم حفظ السطر وتأكيد القيم من الخادم.')).toBeTruthy();
    await waitFor(() =>
      expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toBeNull(),
    );
  });
  it('detects snapshot changes between paginated reads and blocks writes', async () => {
    const original = rpc.getMockImplementation() as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    current.pagination.has_more = true;
    rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'aps_get_reconciliation_state_v3' && args.p_offset === 50) {
        const next = structuredClone(current);
        next.pagination = { offset: 50, limit: 50, has_more: false };
        next.selected_session.snapshot_version = '2';
        next.selected_lines[0]!.id = id(10);
        next.selected_lines[0]!.classification_id = id(11);
        next.selected_lines[0]!.classification_name = 'نحاس';
        return Promise.resolve({ data: next, error: null });
      }
      return original(name, args);
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'تحميل المزيد' }));
    expect(await screen.findByText(/تغيّرت لقطة البيانات بين الصفحات/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إدخال المحاسب — حديد' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'إغلاق النطاق للشهر' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('v3 scope and sync safeguards', () => {
  it('renders both grouped headers with opening outside the columns', async () => {
    mount();
    await screen.findAllByText('حديد');
    const tables = screen.getAllByRole('table', { hidden: true });
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      const rows = table.querySelectorAll('thead tr');
      expect(rows).toHaveLength(2);
      expect(
        [...rows[0]!.querySelectorAll('th')].map((h) => [h.textContent, h.rowSpan, h.colSpan]),
      ).toEqual([
        ['التصنيف', 2, 1],
        ['وارد', 1, 2],
        ['منصرف', 1, 2],
        ['الرصيد', 1, 2],
        ['الفرق', 2, 1],
        ['حالة السطر', 2, 1],
      ]);
      expect([...rows[1]!.querySelectorAll('th')].map((h) => h.textContent)).toEqual([
        'تكاليف',
        'حسابات',
        'تكاليف',
        'حسابات',
        'تكاليف',
        'حسابات',
      ]);
    }
  });
  it('shows sync only for an open eligible changed session and sends concurrency tokens', async () => {
    current.flags.settings_changed = true;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    const button = await screen.findByRole('button', { name: 'تحديث الجلسة من الضبط' });
    expect(screen.getByText(/التحديث سيعيد بناء السطور/)).toBeTruthy();
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_sync_empty_reconciliation_v3', {
        p_session_id: session,
        p_scope_id: scope,
        p_expected_snapshot_version: '1',
        p_expected_generation: '1',
        p_expected_config_revision: id(5),
      }),
    );
  });
  it('never enables sync with a local draft and preserves that draft', async () => {
    current.flags.settings_changed = true;
    mount();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), {
      target: { value: '123.45' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('button', { name: 'تحديث الجلسة من الضبط' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/التحديث غير متاح لوجود مسودة/)).toBeTruthy();
    expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain('123.45');
  });
  it.each([
    [null, true, 'open'],
    [false, true, 'open'],
    [true, false, 'open'],
    [true, true, 'closed'],
  ] as const)(
    'does not offer sync for flags %s, %s and status %s',
    async (changed, canSync, status) => {
      current.flags.settings_changed = changed;
      current.flags.can_sync_from_settings = canSync;
      current.selected_session.status = status;
      mount();
      await screen.findAllByText('حديد');
      expect(screen.queryByRole('button', { name: 'تحديث الجلسة من الضبط' })).toBeNull();
      if (changed === null) expect(screen.getByText(/تعذر تحديد ما إذا تغيّر الضبط/)).toBeTruthy();
    },
  );
  it('keeps old v2 drafts accessible and blocks sync until explicitly removed', async () => {
    current.flags.settings_changed = true;
    const key = `${month}:${session}:${lineId}`;
    localStorage.setItem(
      'aps-reconciliation-v2-drafts:user-one',
      JSON.stringify({
        [key]: {
          version: '1',
          monthlyInbound: '123.45',
          monthlyOutbound: '',
          ytdInbound: '',
          ytdOutbound: '',
          opening: '',
          manual: false,
        },
      }),
    );
    mount();
    expect(await screen.findByText(/توجد مسودات قديمة محفوظة/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تحديث الجلسة من الضبط' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(localStorage.getItem('aps-reconciliation-v2-drafts:user-one')).toContain('123.45');
  });
  it('warns on historical overlap', async () => {
    current.historical_overlap = true;
    mount();
    expect(await screen.findByText(/تداخل تاريخي/)).toBeTruthy();
  });
});

describe('scope isolation', () => {
  it('queries the selected scope and retains drafts separately across scopes', async () => {
    const second = id(20);
    const original = rpc.getMockImplementation() as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    rpc.mockImplementation(async (name, args) => {
      if (name === 'aps_get_reconciliation_scopes_v3')
        return {
          data: [
            { id: scope, name: 'النطاق', is_default: true, is_active: true },
            { id: second, name: 'آخر', is_default: false, is_active: true },
          ],
          error: null,
        };
      if (name === 'aps_get_reconciliation_state_v3' && args.p_scope_id === second) {
        const result = structuredClone(current);
        result.selected_session.scope_id = second;
        result.selected_session.id = id(21);
        result.selected_lines[0]!.id = id(22);
        return { data: result, error: null };
      }
      return original(name, args);
    });
    mount();
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), {
      target: { value: '777.12' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: second } });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        'aps_get_reconciliation_state_v3',
        expect.objectContaining({ p_scope_id: second, p_month_id: month }),
      ),
    );
    const nextDialog = await edit();
    expect(within(nextDialog).getByLabelText('وارد المحاسب')).toHaveProperty('value', '');
    fireEvent.click(within(nextDialog).getByRole('button', { name: 'إلغاء' }));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: scope } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'إدخال المحاسب — حديد' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    const restored = await edit();
    expect(within(restored).getByLabelText('وارد المحاسب')).toHaveProperty('value', '777.12');
  });
});

describe('safe session deletion', () => {
  it('offers delete only when server confirms eligibility; cancellation does not call delete', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) =>
      name === 'aps_can_delete_reconciliation_session_v3'
        ? { data: true, error: null }
        : original(name, args),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount();
    const del = await screen.findByRole('button', { name: 'حذف الجلسة' });
    fireEvent.click(del);
    expect(confirm).toHaveBeenCalledWith('هل أنت متأكد من إلغاء هذه الجلسة؟');
    expect(rpc).not.toHaveBeenCalledWith('aps_delete_reconciliation_session_v3', expect.anything());
  });
  it.each(['ineligible', 'closed', 'no-permission', 'eligibility-error'] as const)(
    'does not offer delete for %s',
    async (scenario) => {
      if (scenario === 'ineligible') current.selected_lines[0]!.ytd.accountant_inbound = '0.00';
      if (scenario === 'closed') current.selected_session.status = 'closed';
      if (scenario === 'no-permission') opts.can_manage = false;
      const original = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (name, args) =>
        name === 'aps_can_delete_reconciliation_session_v3'
          ? { data: false, error: scenario === 'eligibility-error' ? { code: 'network' } : null }
          : original(name, args),
      );
      mount();
      await screen.findAllByText('حديد');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'حذف الجلسة' })).toBeNull());
    },
  );
  it('disables delete while any draft is present', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) =>
      name === 'aps_can_delete_reconciliation_session_v3'
        ? { data: true, error: null }
        : original(name, args),
    );
    mount();
    await screen.findByRole('button', { name: 'حذف الجلسة' });
    const dialog = await edit();
    fireEvent.change(within(dialog).getByLabelText('وارد المحاسب'), { target: { value: '8.00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('button', { name: 'حذف الجلسة' })).toHaveProperty('disabled', true);
    expect(localStorage.getItem('aps-reconciliation-v3-drafts:user-one')).toContain('8.00');
  });
  it('deletes only after confirmation and verifies the new state', async () => {
    let deleted = false;
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      if (name === 'aps_can_delete_reconciliation_session_v3') return { data: true, error: null };
      if (name === 'aps_delete_reconciliation_session_v3') {
        deleted = true;
        return { data: null, error: null };
      }
      if (name === 'aps_get_reconciliation_state_v3' && deleted)
        return {
          data: { ...structuredClone(current), selected_session: null, selected_lines: [] },
          error: null,
        };
      return original(name, args);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'حذف الجلسة' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_delete_reconciliation_session_v3', {
        p_session_id: session,
      }),
    );
    expect(await screen.findByText('تم حذف الجلسة وتأكيد ذلك.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'حذف الجلسة' })).toBeNull();
  });
  it('does not claim success when the server rejects a concurrent recording', async () => {
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (name, args) => {
      if (name === 'aps_can_delete_reconciliation_session_v3') return { data: true, error: null };
      if (name === 'aps_delete_reconciliation_session_v3')
        return { data: null, error: { code: '22023' } };
      return original(name, args);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'حذف الجلسة' }));
    expect(
      await screen.findByText('تعذرت العملية أو الاتصال. راجع الحالة قبل إعادة المحاولة.'),
    ).toBeTruthy();
    expect(screen.queryByText('تم حذف الجلسة وتأكيد ذلك.')).toBeNull();
  });
});
