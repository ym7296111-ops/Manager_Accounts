import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import type * as FiscalHooksModule from '@/hooks/useFiscalSettings';
import type * as StationsModule from '@/hooks/useStationsDirectory';
import type { ActiveLeafClassification } from '@/hooks/useClassifications';
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
  classifications: ActiveLeafClassification[];
  createYear: ReturnType<typeof vi.fn>;
  activateYear: ReturnType<typeof vi.fn>;
  updatePeriod: ReturnType<typeof vi.fn>;
  activateMonth: ReturnType<typeof vi.fn>;
  activationPending: boolean;
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
  activateMonth: vi.fn(),
  activationPending: false,
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
    useOpeningBalances: () => ({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useCreateFiscalYear: () => ({ mutateAsync: fiscalState.createYear, isPending: false }),
    useActivateFiscalYear: () => ({ mutateAsync: fiscalState.activateYear, isPending: false }),
    useUpdateFiscalPeriod: () => ({ mutateAsync: fiscalState.updatePeriod, isPending: false }),
    useActivateFiscalMonth: () => ({
      mutateAsync: fiscalState.activateMonth,
      isPending: fiscalState.activationPending,
      variables: fiscalState.activationPending ? { monthId: 'fm-2' } : undefined,
    }),
    useSaveOpeningBalances: () => ({ mutateAsync: fiscalState.saveBalances, isPending: false }),
    useDeleteOpeningBalance: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    useActiveLeafClassifications: () => ({
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
    opening_balances_locked: false,
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
      is_active: false,
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
    fiscalState.activationPending = false;
    fiscalState.activateMonth = vi.fn(
      (input: { fiscalYearId: string; monthId: string; reason?: string | null }) => {
        fiscalState.months = fiscalState.months.map((month) => ({
          ...month,
          is_active: month.id === input.monthId,
        }));
        return Promise.resolve({
          fiscal_month_id: input.monthId,
          fiscal_year_id: input.fiscalYearId,
          changed: true,
          was_closed: false,
          reason: input.reason ?? null,
        });
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
    expect(fiscalState.activateMonth).not.toHaveBeenCalled();
  });

  it('activates a month independently of selection and moves the single active badge', async () => {
    const year = createYear(true);
    fiscalState.years = [year];
    fiscalState.months = createMonths(year.id).map((month) => ({
      ...month,
      is_active: month.id === 'fm-1',
    }));
    renderFiscalSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));

    const rows = screen.getAllByTestId('fiscal-period-month');
    expect(rows[0]?.getAttribute('data-active')).toBe('true');
    expect(within(rows[0]!).getByText('فعال')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: 'تنشيط شهر يوليو 2035' })).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'تنشيط شهر أغسطس 2035' }));

    await waitFor(() =>
      expect(fiscalState.activateMonth).toHaveBeenCalledWith({
        fiscalYearId: year.id,
        monthId: 'fm-2',
        reason: null,
      }),
    );
    expect(await screen.findByText('تم تنشيط الشهر ليصبح فترة الترحيل للمشروع.')).toBeTruthy();
    expect(
      screen
        .getAllByTestId('fiscal-period-month')
        .filter((row) => row.getAttribute('data-active') === 'true'),
    ).toHaveLength(1);
    expect(screen.getAllByTestId('fiscal-period-month')[1]?.getAttribute('data-active')).toBe(
      'true',
    );
    // Activation neither selects the row nor edits its current_period.
    expect(screen.getByLabelText('الفترة الجارية')).toHaveProperty('value', '1');
    expect(
      within(screen.getAllByTestId('fiscal-period-month')[0]!).getByRole('button', {
        pressed: true,
      }),
    ).toBeTruthy();
    expect(fiscalState.updatePeriod).not.toHaveBeenCalled();
    expect(fiscalState.months.find((month) => month.id === 'fm-2')?.current_period).toBe(1);
  });

  it('requires a reason for a closed month and keeps the dialog open on refusal', async () => {
    const year = createYear(true);
    fiscalState.years = [year];
    fiscalState.months = createMonths(year.id).map((month) =>
      month.id === 'fm-2' ? { ...month, is_closed: true } : month,
    );
    fiscalState.activateMonth.mockRejectedValueOnce({
      code: '42501',
      message: 'permission denied',
    });
    renderFiscalSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));
    fireEvent.click(screen.getByRole('button', { name: 'تنشيط شهر أغسطس 2035' }));

    const dialog = screen.getByRole('dialog');
    expect(fiscalState.activateMonth).not.toHaveBeenCalled();
    const reason = within(dialog).getByLabelText('سبب التنشيط');
    const submit = within(dialog).getByRole('button', { name: 'تنشيط' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(reason, { target: { value: 'قصير' } });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(reason, { target: { value: '  اعتماد متأخر بموافقة المالك  ' } });
    expect(submit).toHaveProperty('disabled', false);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(fiscalState.activateMonth).toHaveBeenCalledWith({
        fiscalYearId: year.id,
        monthId: 'fm-2',
        reason: 'اعتماد متأخر بموافقة المالك',
      }),
    );
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByLabelText('سبب التنشيط')).toHaveProperty(
      'value',
      '  اعتماد متأخر بموافقة المالك  ',
    );
    expect(screen.queryByText('تم تنشيط الشهر ليصبح فترة الترحيل للمشروع.')).toBeNull();

    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByTestId('fiscal-period-month')[1]?.getAttribute('data-active')).toBe(
      'true',
    );
  });

  it('asks for a reason when the active year is closed even if the month is open', () => {
    fiscalState.years = [{ ...createYear(true), is_closed: true }];
    fiscalState.months = createMonths('fy-2035');
    renderFiscalSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));
    fireEvent.click(screen.getByRole('button', { name: 'تنشيط شهر يوليو 2035' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fiscalState.activateMonth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an activation failure without moving the active badge', async () => {
    fiscalState.years = [createYear(true)];
    fiscalState.months = createMonths('fy-2035').map((month) => ({
      ...month,
      is_active: month.id === 'fm-1',
    }));
    fiscalState.activateMonth.mockRejectedValueOnce(new Error('network down'));
    renderFiscalSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));
    fireEvent.click(screen.getByRole('button', { name: 'تنشيط شهر أغسطس 2035' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByTestId('fiscal-period-month')[0]?.getAttribute('data-active')).toBe(
      'true',
    );
    expect(screen.queryByText('تم تنشيط الشهر ليصبح فترة الترحيل للمشروع.')).toBeNull();
  });

  it('disables activation and period saving while a request is in flight', () => {
    fiscalState.years = [createYear(true)];
    fiscalState.months = createMonths('fy-2035');
    fiscalState.activationPending = true;
    renderFiscalSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'الضبط الدوري' }));
    const buttons = screen.getAllByRole('button', { name: /^تنشيط شهر/ });
    expect(buttons).toHaveLength(12);
    expect(buttons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(
      screen.getByRole('button', { name: 'تنشيط شهر أغسطس 2035' }).getAttribute('aria-busy'),
    ).toBe('true');
    fireEvent.change(screen.getByLabelText('الفترة الجارية'), { target: { value: '4' } });
    expect(screen.getByRole('button', { name: 'حفظ الفترة' })).toHaveProperty('disabled', true);
  });
});
