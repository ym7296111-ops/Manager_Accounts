import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import type * as FiscalHooksModule from '@/hooks/useFiscalSettings';
import type * as StationsModule from '@/hooks/useStationsDirectory';
import type { ClassificationNode } from '@/hooks/useClassifications';
import type {
  FiscalMonth,
  FiscalYear,
  OpeningBalance,
  OpeningBalanceWrite,
} from '@/hooks/useFiscalSettings';
import type { StationWithWarehouses } from '@/hooks/useStationsDirectory';
import { I18nProvider } from '@/i18n/I18nContext';
import FiscalSettings from './FiscalSettings';

interface TestState {
  years: FiscalYear[];
  months: FiscalMonth[];
  balances: OpeningBalance[];
  stations: StationWithWarehouses[];
  classifications: ClassificationNode[];
  createYear: ReturnType<typeof vi.fn>;
  activateYear: ReturnType<typeof vi.fn>;
  updatePeriod: ReturnType<typeof vi.fn>;
  saveBalances: ReturnType<typeof vi.fn>;
}

const fiscalState = vi.hoisted<TestState>(() => ({
  years: [],
  months: [],
  balances: [],
  stations: [],
  classifications: [],
  createYear: vi.fn(),
  activateYear: vi.fn(),
  updatePeriod: vi.fn(),
  saveBalances: vi.fn(),
}));

vi.mock('@/hooks/useFiscalSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof FiscalHooksModule>();
  return {
    ...actual,
    useFiscalYears: () => ({
      data: fiscalState.years,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useFiscalMonths: (yearId: string | null) => ({
      data:
        yearId === null
          ? []
          : fiscalState.months.filter((month) => month.fiscal_year_id === yearId),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useOpeningBalances: (yearId: string | null) => ({
      data:
        yearId === null
          ? []
          : fiscalState.balances.filter((balance) => balance.fiscal_year_id === yearId),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useCreateFiscalYear: () => ({ mutateAsync: fiscalState.createYear, isPending: false }),
    useActivateFiscalYear: () => ({ mutateAsync: fiscalState.activateYear, isPending: false }),
    useUpdateFiscalPeriod: () => ({ mutateAsync: fiscalState.updatePeriod, isPending: false }),
    useSaveOpeningBalances: () => ({ mutateAsync: fiscalState.saveBalances, isPending: false }),
  };
});

vi.mock('@/hooks/useStationsDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof StationsModule>();
  return {
    ...actual,
    useStationsDirectory: () => ({
      data: fiscalState.stations,
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
    useClassifications: () => ({
      data: fiscalState.classifications,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function createYear(isActive = false): FiscalYear {
  return {
    id: 'fy-2035',
    name: '2035-2036',
    start_date: '2035-07-01',
    end_date: '2036-06-30',
    is_active: isActive,
    is_closed: false,
    supplements_open: false,
    created_at: '2035-07-01T00:00:00.000Z',
    updated_at: '2035-07-01T00:00:00.000Z',
  };
}

function createMonths(yearId: string): FiscalMonth[] {
  const names = [
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
  ];
  return names.map((name, index) => {
    const year = index < 6 ? 2035 : 2036;
    const monthNumber = index < 6 ? index + 7 : index - 5;
    const start = `${year}-${String(monthNumber).padStart(2, '0')}-01`;
    const id = `fm-${index + 1}`;
    return {
      id,
      fiscal_year_id: yearId,
      month_number: index + 1,
      name: `${name} ${year}`,
      start_date: start,
      end_date: start,
      current_period: 1,
      is_closed: false,
      created_at: '2035-07-01T00:00:00.000Z',
      updated_at: '2035-07-01T00:00:00.000Z',
    };
  });
}

function renderFiscalSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <FiscalSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('FiscalSettings', () => {
  beforeEach(() => {
    window.localStorage.clear();
    fiscalState.years = [];
    fiscalState.months = [];
    fiscalState.balances = [];
    fiscalState.stations = [];
    fiscalState.classifications = [];
    fiscalState.createYear = vi.fn((input: { start_date: string; end_date: string }) => {
      const year = createYear(false);
      fiscalState.years = [year];
      fiscalState.months = createMonths(year.id);
      expect(input).toEqual({ start_date: year.start_date, end_date: year.end_date });
      return Promise.resolve(year);
    });
    fiscalState.activateYear = vi.fn((id: string) => {
      fiscalState.years = fiscalState.years.map((year) => ({
        ...year,
        is_active: year.id === id,
      }));
      return Promise.resolve(fiscalState.years.find((year) => year.id === id)!);
    });
    fiscalState.updatePeriod = vi.fn(
      (input: { fiscalYearId: string; monthId: string; currentPeriod: number }) => {
        fiscalState.months = fiscalState.months.map((month) =>
          month.id === input.monthId ? { ...month, current_period: input.currentPeriod } : month,
        );
        return Promise.resolve(fiscalState.months.find((month) => month.id === input.monthId)!);
      },
    );
    fiscalState.saveBalances = vi.fn(
      (input: { fiscalYearId: string; rows: readonly OpeningBalanceWrite[] }) => {
        const saved = input.rows.map((row, index) => ({
          id: `ob-${index + 1}`,
          fiscal_year_id: row.fiscal_year_id,
          warehouse_id: row.warehouse_id,
          classification_id: row.classification_id,
          amount: Number(row.amount),
          created_at: '2035-07-01T00:00:00.000Z',
          updated_at: '2035-07-01T00:00:00.000Z',
        }));
        fiscalState.balances = [...fiscalState.balances, ...saved];
        return Promise.resolve(saved);
      },
    );
  });

  it('offers the three financial subtabs inside the project General panel', () => {
    renderFiscalSettings();

    expect(screen.getByRole('heading', { name: 'الضبط المالي' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'الضبط المالي' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'الضبط السنوي' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'الضبط الدوري' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'أرصدة أول المدة' })).toBeTruthy();
  });

  it('previews and creates a year, then activates it and shows the trigger-generated months', async () => {
    renderFiscalSettings();

    fireEvent.click(screen.getByRole('button', { name: 'إضافة سنة مالية' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('تاريخ البداية'), {
      target: { value: '2035-07-01' },
    });
    fireEvent.change(within(dialog).getByLabelText('تاريخ النهاية'), {
      target: { value: '2036-06-30' },
    });
    expect(screen.getByText('الاسم الذي ستولده قاعدة البيانات: 2035-2036')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ السنة المالية' }));
    await waitFor(() => expect(fiscalState.createYear).toHaveBeenCalledTimes(1));
    expect(fiscalState.createYear).toHaveBeenCalledWith({
      start_date: '2035-07-01',
      end_date: '2036-06-30',
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(
      within(screen.getByRole('table')).getByRole('button', {
        name: 'تفعيل السنة المالية 2035-2036',
      }),
    );
    await waitFor(() => expect(fiscalState.activateYear).toHaveBeenCalledWith('fy-2035'));

    await waitFor(() => expect(screen.getAllByTestId('fiscal-month-row')).toHaveLength(12));
  });

  it('updates the current period for a month in the active year', async () => {
    const year = createYear(true);
    fiscalState.years = [year];
    fiscalState.months = createMonths(year.id);
    renderFiscalSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));
    expect(await screen.findByText('نحن الآن في الفترة 1 من شهر يوليو 2035.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('الفترة الجارية'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الفترة' }));

    await waitFor(() =>
      expect(fiscalState.updatePeriod).toHaveBeenCalledWith({
        fiscalYearId: year.id,
        monthId: 'fm-1',
        currentPeriod: 3,
      }),
    );
    expect(await screen.findByText('نحن الآن في الفترة 3 من شهر يوليو 2035.')).toBeTruthy();
  });

  it('saves a decimal opening balance for a classification in its warehouse', async () => {
    const year = createYear(true);
    fiscalState.years = [year];
    fiscalState.stations = [
      {
        id: 'station-1',
        code: 'ST-01',
        name: 'المحطة الرئيسية',
        isActive: true,
        warehouses: [
          {
            id: 'warehouse-1',
            code: 'WH-001',
            name: 'مخزن المواد الخام',
            isActive: true,
          },
        ],
      },
    ];
    fiscalState.classifications = [
      {
        id: 'classification-steel',
        code: 'CLS-001',
        name: 'حديد وصلب',
        level: 1,
        isLeaf: true,
        isActive: true,
        children: [],
      },
    ];
    renderFiscalSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'أرصدة أول المدة' }));
    fireEvent.click(screen.getByRole('button', { name: 'عرض مخازن محطة المحطة الرئيسية' }));
    fireEvent.click(screen.getByRole('button', { name: 'عرض تصنيفات مخزن مخزن المواد الخام' }));

    const balanceInput = screen.getByRole('spinbutton', {
      name: 'رصيد أول المدة: حديد وصلب',
    });
    fireEvent.change(balanceInput, { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ أرصدة مخزن مخزن المواد الخام' }));

    await waitFor(() => expect(fiscalState.saveBalances).toHaveBeenCalledTimes(1));
    expect(fiscalState.saveBalances).toHaveBeenCalledWith({
      fiscalYearId: year.id,
      rows: [
        {
          fiscal_year_id: year.id,
          warehouse_id: 'warehouse-1',
          classification_id: 'classification-steel',
          amount: '125.50',
        },
      ],
    });
    await waitFor(() => expect((balanceInput as HTMLInputElement).value).toBe('125.50'));
    expect(screen.getByText('تم حفظ أرصدة المخزن بنجاح.')).toBeTruthy();
  });
});
