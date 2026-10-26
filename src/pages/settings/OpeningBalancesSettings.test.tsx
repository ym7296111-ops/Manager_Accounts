import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import type { ActiveLeafClassification } from '@/hooks/useClassifications';
import type * as FiscalHooksModule from '@/hooks/useFiscalSettings';
import { FiscalSettingsWriteError } from '@/hooks/useFiscalSettings';
import type {
  FiscalMonth,
  FiscalYear,
  OpeningBalanceRow,
  OpeningBalanceWrite,
} from '@/hooks/useFiscalSettings';
import type * as StationsModule from '@/hooks/useStationsDirectory';
import type { StationWithWarehouses } from '@/hooks/useStationsDirectory';
import { I18nProvider } from '@/i18n/I18nContext';
import { UnsavedChangesProvider } from './UnsavedChangesProvider';
import OpeningBalancesSettings from './OpeningBalancesSettings';
import { formatCents } from './fiscalSettingsUtils';
import FiscalSettings from './FiscalSettings';

/**
 * Unit coverage for the sparse opening-balance editor (design study §9.1).
 *
 * The three data hooks are mocked at module level, so these tests describe the
 * screen's contract — what it renders, what it sends, what it refuses — and not
 * PostgREST. The wire shape itself is covered by `useFiscalSettings.test.tsx`,
 * and the real database by `scripts/audit/database.mjs` plus the E2E suite.
 */

const YEAR_ID = 'fy-2025';

interface SavePayload {
  fiscalYearId: string;
  rows: readonly OpeningBalanceWrite[];
}

interface DeletePayload {
  fiscalYearId: string;
  balanceId: string;
}

interface TestState {
  years: FiscalYear[];
  months: FiscalMonth[];
  balances: OpeningBalanceRow[];
  stations: StationWithWarehouses[];
  classifications: ActiveLeafClassification[];
  save: Mock<(input: SavePayload) => Promise<readonly OpeningBalanceWrite[]>>;
  remove: Mock<(input: DeletePayload) => Promise<string>>;
  refetchBalances: ReturnType<typeof vi.fn>;
  savePending: boolean;
  deletePending: boolean;
}

const state = vi.hoisted<TestState>(() => ({
  years: [],
  months: [],
  balances: [],
  stations: [],
  classifications: [],
  save: vi.fn(),
  remove: vi.fn(),
  refetchBalances: vi.fn(),
  savePending: false,
  deletePending: false,
}));

vi.mock('@/hooks/useFiscalSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof FiscalHooksModule>();
  return {
    ...actual,
    useFiscalYears: () => ({
      data: state.years,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useFiscalMonths: () => ({
      data: state.months,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useOpeningBalances: () => ({
      data: state.balances,
      isLoading: false,
      isError: false,
      error: null,
      refetch: state.refetchBalances,
    }),
    useCreateFiscalYear: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useActivateFiscalYear: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpdateFiscalPeriod: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSaveOpeningBalances: () => ({
      mutateAsync: state.save,
      isPending: state.savePending,
    }),
    useDeleteOpeningBalance: () => ({
      mutateAsync: state.remove,
      isPending: state.deletePending,
    }),
  };
});

vi.mock('@/hooks/useStationsDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof StationsModule>();
  return {
    ...actual,
    useStationsDirectory: () => ({
      data: state.stations,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useClassifications', async (importOriginal) => {
  const actual = await importOriginal<typeof ClassificationsModule>();
  return {
    ...actual,
    useActiveLeafClassifications: () => ({
      data: state.classifications,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function fiscalYear(): FiscalYear {
  return {
    id: YEAR_ID,
    name: '2025-2026',
    start_date: '2025-07-01',
    end_date: '2026-06-30',
    is_active: true,
    is_closed: false,
    supplements_open: false,
    created_at: '2025-07-01T00:00:00.000Z',
    updated_at: '2025-07-01T00:00:00.000Z',
  };
}

function leaf(index: number, overrides: Partial<ActiveLeafClassification> = {}) {
  return {
    id: `cls-${index}`,
    code: `CLS-${String(index).padStart(3, '0')}`,
    name: `تصنيف ${index}`,
    ...overrides,
  } satisfies ActiveLeafClassification;
}

function savedBalance(
  index: number,
  amount: number,
  overrides: {
    warehouseId?: string;
    classification?: Partial<ActiveLeafClassification>;
    isLeaf?: boolean;
    isActive?: boolean;
    classificationNull?: boolean;
  } = {},
): OpeningBalanceRow {
  const base = leaf(index, overrides.classification);
  return {
    id: `ob-${index}`,
    fiscal_year_id: YEAR_ID,
    warehouse_id: overrides.warehouseId ?? 'wh-1',
    classification_id: base.id,
    amount,
    created_at: '2025-07-01T00:00:00.000Z',
    updated_at: '2025-07-01T00:00:00.000Z',
    classification: overrides.classificationNull
      ? null
      : {
          id: base.id,
          code: base.code,
          name: base.name,
          isLeaf: overrides.isLeaf ?? true,
          isActive: overrides.isActive ?? true,
        },
  };
}

function singleStation(): StationWithWarehouses[] {
  return [
    {
      id: 'st-1',
      code: 'ST-01',
      name: 'المحطة الرئيسية',
      isActive: true,
      warehouses: [
        { id: 'wh-1', code: 'WH-001', name: 'مخزن المواد الخام', isActive: true },
        { id: 'wh-2', code: 'WH-002', name: 'مخزن قطع الغيار', isActive: true },
      ],
    },
  ];
}

const SAVE_SUCCESS: readonly OpeningBalanceWrite[] = [];

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <UnsavedChangesProvider>
          <OpeningBalancesSettings />
        </UnsavedChangesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function renderFiscalTabs() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <UnsavedChangesProvider>
          <FiscalSettings />
        </UnsavedChangesProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function openWarehouse(name = 'مخزن المواد الخام') {
  fireEvent.click(screen.getByRole('button', { name: 'عرض تصنيفات مخزن ' + name }));
}

function openStation() {
  fireEvent.click(screen.getByRole('button', { name: 'عرض مخازن محطة المحطة الرئيسية' }));
}

function panelFor(warehouseId: string): HTMLElement {
  const element = document.getElementById(`opening-warehouse-panel-${warehouseId}`);
  if (element === null) {
    throw new Error(`warehouse panel ${warehouseId} is not rendered`);
  }
  return element;
}

function openPicker(warehouseId = 'wh-1') {
  const panel = panelFor(warehouseId);
  fireEvent.click(within(panel).getByRole('button', { name: 'إضافة تصنيف' }));
  return within(panel).getByTestId('classification-picker');
}

function amountInputs(): HTMLElement[] {
  return screen.queryAllByRole('spinbutton');
}

/* The Arabic locale renders Arabic-Indic digits, so expected totals go through
   the same formatter instead of hard-coding a locale's numerals. */
function money(cents: bigint): string {
  return formatCents(cents, 'ar');
}

/** The payload of the most recent save, typed so the assertions stay narrow. */
function lastSave(): SavePayload {
  const call = state.save.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('the screen never called save');
  }
  return call[0];
}

let saveCalls = 0;

beforeEach(() => {
  window.localStorage.clear();
  saveCalls = 0;
  state.years = [fiscalYear()];
  state.months = [];
  state.balances = [];
  state.stations = singleStation();
  state.classifications = [leaf(1), leaf(2), leaf(3)];
  state.savePending = false;
  state.deletePending = false;
  state.refetchBalances = vi.fn();
  state.save = vi.fn((input: { fiscalYearId: string; rows: readonly OpeningBalanceWrite[] }) => {
    saveCalls += 1;
    /* Mirror the real mutation: the saved rows come back and the cache is
       updated, so `clearSaved` has something to reconcile against. */
    state.balances = [
      ...state.balances,
      ...input.rows.map((row, index) => ({
        id: `saved-${saveCalls}-${index}`,
        fiscal_year_id: row.fiscal_year_id,
        warehouse_id: row.warehouse_id,
        classification_id: row.classification_id,
        amount: Number(row.amount),
        created_at: '2025-07-01T00:00:00.000Z',
        updated_at: '2025-07-01T00:00:00.000Z',
        classification: {
          id: row.classification_id,
          code:
            state.classifications.find((entry) => entry.id === row.classification_id)?.code ??
            'CLS-000',
          name:
            state.classifications.find((entry) => entry.id === row.classification_id)?.name ??
            'تصنيف',
          isLeaf: true,
          isActive: true,
        },
      })),
    ];
    return Promise.resolve(SAVE_SUCCESS);
  });
  state.remove = vi.fn(() => Promise.resolve('ob-1'));
});

describe('U1/U2 — sparse rendering', () => {
  it('renders only the saved balances, not one field per classification', () => {
    state.classifications = Array.from({ length: 50 }, (_, index) => leaf(index + 1));
    state.balances = [
      savedBalance(1, 125.5, { classification: { name: 'حديد وصلب' } }),
      savedBalance(4, 3000, { classification: { name: 'أخشاب' } }),
    ];
    renderScreen();
    openStation();
    openWarehouse();

    expect(amountInputs()).toHaveLength(2);
    expect(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: حديد وصلب' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: أخشاب' })).toBeTruthy();
  });

  it('shows an empty state and an add button for a warehouse with nothing entered', () => {
    renderScreen();
    openStation();
    openWarehouse();

    expect(amountInputs()).toHaveLength(0);
    expect(
      screen.getByText('لا توجد أرصدة مسجّلة لهذا المخزن بعد. أضف تصنيفاً للبدء.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إضافة تصنيف' })).toBeTruthy();
  });

  it('mounts no inputs while the warehouse panel is collapsed', () => {
    state.balances = [savedBalance(1, 10)];
    renderScreen();
    openStation();

    expect(amountInputs()).toHaveLength(0);
    expect(panelFor('wh-1').hasAttribute('hidden')).toBe(true);
    expect(within(panelFor('wh-1')).queryByText(/إضافة تصنيف/)).toBeNull();
  });
});

describe('U3/U4 — picker contents and Arabic search', () => {
  it('never offers a classification that is already saved or already added', () => {
    state.classifications = [
      leaf(1, { name: 'حديد وصلب', code: 'CLS-001' }),
      leaf(2, { name: 'أخشاب', code: 'CLS-002' }),
      leaf(3, { name: 'زيوت', code: 'CLS-003' }),
    ];
    state.balances = [savedBalance(1, 5)];
    renderScreen();
    openStation();
    openWarehouse();

    let picker = openPicker();
    expect(within(picker).queryByRole('option', { name: /حديد وصلب/ })).toBeNull();
    fireEvent.click(within(picker).getByRole('option', { name: /أخشاب/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));

    picker = openPicker();
    expect(within(picker).queryByRole('option', { name: /أخشاب/ })).toBeNull();
    expect(within(picker).getByRole('option', { name: /زيوت/ })).toBeTruthy();
  });

  it('matches hamza, ta-marbuta and code variants', () => {
    state.classifications = [
      leaf(1, { name: 'أخشاب', code: 'CLS-001' }),
      leaf(2, { name: 'مواد تعبئة', code: 'CLS-002' }),
      leaf(3, { name: 'حديد وصلب', code: 'CLS-003' }),
    ];
    renderScreen();
    openStation();
    openWarehouse();
    const picker = openPicker();
    const search = within(picker).getByRole('combobox', { name: 'ابحث بالاسم أو الكود…' });

    fireEvent.change(search, { target: { value: 'اخشاب' } });
    expect(within(picker).getAllByRole('option')).toHaveLength(1);
    expect(within(picker).getByRole('option', { name: /أخشاب/ })).toBeTruthy();

    fireEvent.change(search, { target: { value: 'تعبيه' } });
    expect(within(picker).getByRole('option', { name: /مواد تعبئة/ })).toBeTruthy();

    fireEvent.change(search, { target: { value: 'cls-003' } });
    expect(within(picker).getAllByRole('option')).toHaveLength(1);

    fireEvent.change(search, { target: { value: 'لا يوجد' } });
    expect(within(picker).getByText('لا توجد تصنيفات مطابقة.')).toBeTruthy();
  });
});

describe('U5/U6 — multi-select and keyboard', () => {
  it('adds three rows in one commit, announces it and focuses the first amount', () => {
    state.classifications = [leaf(1), leaf(2), leaf(3)];
    renderScreen();
    openStation();
    openWarehouse();
    const picker = openPicker();

    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 2/ }));
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 3/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (3)' }));

    expect(amountInputs()).toHaveLength(3);
    expect(screen.getByRole('status').textContent).toContain('أُضيف 3 سطراً.');
    expect(document.activeElement).toBe(
      screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' }),
    );
  });

  it('supports arrow keys, Enter, Backspace and Escape', () => {
    state.classifications = [leaf(1), leaf(2), leaf(3)];
    renderScreen();
    openStation();
    openWarehouse();
    let picker = openPicker();
    const search = within(picker).getByRole('combobox');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(picker).getByRole('button', { name: 'إزالة تصنيف 2' })).toBeTruthy();

    fireEvent.keyDown(search, { key: 'Backspace' });
    expect(within(picker).queryByRole('button', { name: 'إزالة تصنيف 2' })).toBeNull();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByTestId('classification-picker')).toBeNull();

    /* Escape discards staged chips: nothing was written, so nothing is lost. */
    picker = openPicker();
    expect(within(picker).getAllByRole('option')).toHaveLength(3);
  });

  it('disables the add button when every active leaf is already present', () => {
    state.classifications = [leaf(1)];
    state.balances = [savedBalance(1, 10)];
    renderScreen();
    openStation();
    openWarehouse();
    const picker = openPicker();

    expect(within(picker).getByText('كل التصنيفات الورقية النشطة مضافة لهذا المخزن.')).toBeTruthy();
    expect(
      within(picker).getByRole<HTMLButtonElement>('button', { name: 'إضافة (0)' }).disabled,
    ).toBe(true);
  });
});

describe('U7/U8/U9/U16 — saving', () => {
  it('sends the added and modified rows only, with two-decimal amounts', async () => {
    state.classifications = [leaf(1), leaf(2), leaf(3)];
    state.balances = [savedBalance(1, 100), savedBalance(2, 200)];
    renderScreen();
    openStation();
    openWarehouse();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' }), {
      target: { value: '125.5' },
    });
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 3/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 3' }), {
      target: { value: '7' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'حفظ أرصدة مخزن مخزن المواد الخام' }));

    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(state.save.mock.calls[0]?.[0]).toEqual({
      fiscalYearId: YEAR_ID,
      rows: [
        {
          fiscal_year_id: YEAR_ID,
          warehouse_id: 'wh-1',
          classification_id: 'cls-1',
          amount: '125.50',
        },
        {
          fiscal_year_id: YEAR_ID,
          warehouse_id: 'wh-1',
          classification_id: 'cls-3',
          amount: '7.00',
        },
      ],
    });
  });

  it('does not send an empty added row, and drops it after a successful save', async () => {
    state.classifications = [leaf(1), leaf(2)];
    renderScreen();
    openStation();
    openWarehouse();

    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    const input = screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' });
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.change(input, { target: { value: '' } });

    const saveButton = screen.getByRole<HTMLButtonElement>('button', {
      name: 'حفظ أرصدة مخزن مخزن المواد الخام',
    });
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '42' } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(lastSave().rows).toHaveLength(1);
  });

  it('rejects a negative amount without sending it', () => {
    state.classifications = [leaf(1)];
    renderScreen();
    openStation();
    openWarehouse();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));

    const input = screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' });
    fireEvent.change(input, { target: { value: '-5' } });

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'حفظ أرصدة مخزن مخزن المواد الخام',
      }).disabled,
    ).toBe(true);

    /* The minus key never reaches the field either — `type="number"` accepts it. */
    const keyDown = new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true });
    input.dispatchEvent(keyDown);
    expect(keyDown.defaultPrevented).toBe(true);
  });

  it('keeps the second warehouse drafts after the first one is saved', async () => {
    state.classifications = [leaf(1), leaf(2)];
    renderScreen();
    openStation();
    openWarehouse('مخزن قطع الغيار');
    let picker = openPicker('wh-2');
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 2/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    fireEvent.change(
      within(panelFor('wh-2')).getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 2' }),
      { target: { value: '9' } },
    );

    openWarehouse('مخزن المواد الخام');
    picker = openPicker('wh-1');
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    fireEvent.change(
      within(panelFor('wh-1')).getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' }),
      { target: { value: '3' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'حفظ أرصدة مخزن مخزن المواد الخام' }));

    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(lastSave().rows).toHaveLength(1);
    expect(lastSave().rows[0]?.warehouse_id).toBe('wh-1');
    expect(
      within(panelFor('wh-2')).getByRole<HTMLInputElement>('spinbutton', {
        name: 'رصيد أول المدة: تصنيف 2',
      }).value,
    ).toBe('9');
  });
});

describe('U10/U11/U17 — deletion', () => {
  it('confirms, deletes by id and drops the row from the total', async () => {
    state.balances = [
      savedBalance(1, 100, { classification: { name: 'حديد وصلب' } }),
      savedBalance(2, 250, { classification: { name: 'أخشاب' } }),
    ];
    renderScreen();
    openStation();
    openWarehouse();
    expect(screen.getAllByText(money(35000n)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'حذف رصيد حديد وصلب' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/سيُحذف رصيد «حديد وصلب»/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف الرصيد' }));

    await waitFor(() => expect(state.remove).toHaveBeenCalledTimes(1));
    expect(state.remove.mock.calls[0]?.[0]).toEqual({ fiscalYearId: YEAR_ID, balanceId: 'ob-1' });

    state.balances = state.balances.filter((row) => row.id !== 'ob-1');
    await waitFor(() => expect(screen.getByText('حُذف الرصيد بنجاح.')).toBeTruthy());
  });

  it('treats notFound as "already updated" instead of an error', async () => {
    state.balances = [savedBalance(1, 100)];
    /* The hook itself throws this, so the screen sees the same value as in
       production: zero affected rows is a typed `notFound`, not a raw error. */
    state.remove = vi.fn(() => Promise.reject(new FiscalSettingsWriteError('notFound')));
    renderScreen();
    openStation();
    openWarehouse();

    fireEvent.click(screen.getByRole('button', { name: 'حذف رصيد تصنيف 1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'حذف الرصيد' }));

    expect(await screen.findByText('حُدِّثت الأرصدة مسبقاً — أُعيد التحميل.')).toBeTruthy();
    expect(state.refetchBalances).toHaveBeenCalled();
  });

  it.each([
    [{ code: '42501', message: 'permission denied' }, 'forbidden' as const],
    [{ code: 'PGRST503', message: 'failed to fetch' }, 'network' as const],
  ])('reports %o as a classified error', async (error, _label) => {
    state.balances = [savedBalance(1, 100)];
    state.remove = vi.fn(() => Promise.reject(Object.assign(new Error('x'), error)));
    renderScreen();
    openStation();
    openWarehouse();

    fireEvent.click(screen.getByRole('button', { name: 'حذف رصيد تصنيف 1' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'حذف الرصيد' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('discards a session-added row without asking and without a request', () => {
    state.classifications = [leaf(1)];
    renderScreen();
    openStation();
    openWarehouse();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));

    fireEvent.click(screen.getByRole('button', { name: 'تجاهل سطر تصنيف 1' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(amountInputs()).toHaveLength(0);
    expect(state.remove).not.toHaveBeenCalled();
  });
});

describe('U12/U13 — review rows and the counter', () => {
  it('keeps a balance whose classification gained children in the total, read-only', () => {
    state.balances = [
      savedBalance(1, 100),
      savedBalance(2, 450, {
        classification: { name: 'المواد الخام' },
        isLeaf: false,
      }),
    ];
    renderScreen();
    openStation();
    openWarehouse();

    expect(amountInputs()).toHaveLength(1);
    const review = screen.getByRole('region', { name: /أرصدة تحتاج مراجعة/ });
    expect(within(review).getByText('المواد الخام')).toBeTruthy();
    expect(within(review).getByText(/تصنيف له تصنيفات فرعية/)).toBeTruthy();
    expect(within(review).queryByRole('spinbutton')).toBeNull();
    expect(screen.getAllByText(money(55000n)).length).toBeGreaterThan(0);
  });

  it('flags an inactive classification and an unreadable one', () => {
    state.balances = [
      savedBalance(1, 10, { classification: { name: 'بلاستيك' }, isActive: false }),
      savedBalance(2, 20, { classificationNull: true }),
    ];
    renderScreen();
    openStation();
    openWarehouse();

    expect(screen.getByText(/تصنيف معطّل/)).toBeTruthy();
    expect(screen.getAllByText(/تعذّرت قراءة التصنيف/).length).toBeGreaterThan(0);
  });

  it('moves the warehouse and station totals while an added row is typed', () => {
    state.classifications = [leaf(1), leaf(2)];
    state.balances = [savedBalance(1, 100)];
    renderScreen();
    openStation();
    openWarehouse();
    expect(screen.getAllByText(money(10000n))).toHaveLength(2);

    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 2/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 2' }), {
      target: { value: '25' },
    });

    /* The warehouse header and the station total both count the draft; the
       amount only becomes a saved balance after the save succeeds. */
    expect(screen.getAllByText(money(12500n))).toHaveLength(2);
    expect(screen.queryAllByText(money(10000n))).toHaveLength(0);
  });

  it('counts entered rows against the eligible leaves and shows the review badge', () => {
    state.classifications = Array.from({ length: 12 }, (_, index) => leaf(index + 1));
    state.balances = [
      savedBalance(1, 1),
      savedBalance(2, 2),
      savedBalance(3, 3),
      savedBalance(4, 4, { isLeaf: false }),
    ];
    renderScreen();
    openStation();
    openWarehouse();

    expect(screen.getByText('3 من 12 تصنيفاً مُدخلاً')).toBeTruthy();
    expect(screen.getByText('1 رصيد يحتاج مراجعة')).toBeTruthy();
  });
});

describe('U14/U15 — unsaved changes guard', () => {
  it('asks before switching fiscal tabs when a draft exists', async () => {
    state.classifications = [leaf(1)];
    renderFiscalTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'أرصدة أول المدة' }));
    openStation();
    openWarehouse();
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' }), {
      target: { value: '5' },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'الضبط السنوي' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('لديك تغييرات غير محفوظة')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'العودة للحفظ' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('tab', { name: 'أرصدة أول المدة' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('tab', { name: 'الضبط السنوي' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'مغادرة بدون حفظ' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'الضبط السنوي' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });

  it('switches tabs without asking when nothing was typed', () => {
    renderFiscalTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'أرصدة أول المدة' }));
    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('registers beforeunload only while dirty', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    state.classifications = [leaf(1)];
    const { unmount } = renderScreen();
    openStation();
    openWarehouse();

    expect(addSpy.mock.calls.some(([event]) => event === 'beforeunload')).toBe(false);

    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('option', { name: /تصنيف 1/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'إضافة (1)' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'رصيد أول المدة: تصنيف 1' }), {
      target: { value: '5' },
    });

    expect(addSpy.mock.calls.some(([event]) => event === 'beforeunload')).toBe(true);

    /* Unmounting is what a tab switch does; the listener must not outlive it. */
    unmount();
    expect(removeSpy.mock.calls.some(([event]) => event === 'beforeunload')).toBe(true);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
