import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StationsDirectoryModule from '@/hooks/useStationsDirectory';
import { StationsDirectoryError, type StationWithWarehouses } from '@/hooks/useStationsDirectory';
import type * as StationsMutationsModule from '@/hooks/useStationsMutations';
import { StationWriteError, validateName } from '@/hooks/useStationsMutations';
import { I18nProvider } from '@/i18n/I18nContext';
import StationsWarehouses from '@/pages/settings/StationsWarehouses';

interface QueryStub {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: readonly StationWithWarehouses[] | undefined;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
}

interface MutationStub {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

const { queryState, mutations } = vi.hoisted(() => {
  const make = (): { mutate: ReturnType<typeof vi.fn>; isPending: boolean } => ({
    mutate: vi.fn(),
    isPending: false,
  });
  return {
    queryState: { value: null as unknown as QueryStub },
    mutations: {
      createStation: make(),
      updateStation: make(),
      deleteStation: make(),
      createWarehouse: make(),
      updateWarehouse: make(),
      deleteWarehouse: make(),
    },
  };
});

vi.mock('@/hooks/useStationsDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof StationsDirectoryModule>();
  return { ...actual, useStationsDirectory: () => queryState.value };
});

vi.mock('@/hooks/useStationsMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof StationsMutationsModule>();
  return {
    ...actual,
    useCreateStation: () => mutations.createStation,
    useUpdateStation: () => mutations.updateStation,
    useDeleteStation: () => mutations.deleteStation,
    useCreateWarehouse: () => mutations.createWarehouse,
    useUpdateWarehouse: () => mutations.updateWarehouse,
    useDeleteWarehouse: () => mutations.deleteWarehouse,
  };
});

const STATIONS: readonly StationWithWarehouses[] = [
  {
    id: 's1',
    code: 'ST-01',
    name: 'المحطة الرئيسية',
    isActive: true,
    warehouses: [
      { id: 'w1', code: 'WH-001', name: 'مخزن المواد الخام', isActive: true },
      { id: 'w2', code: 'WH-002', name: 'مخزن قطع الغيار', isActive: false },
    ],
  },
  {
    id: 's2',
    code: 'ST-02',
    name: 'محطة الصيانة',
    isActive: false,
    warehouses: [],
  },
];

function setQuery(patch: Partial<QueryStub> = {}) {
  const initial: QueryStub = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: STATIONS,
    error: null,
    refetch: vi.fn(),
  };
  queryState.value = { ...initial, ...patch };
  return queryState.value;
}

function renderScreen() {
  return render(
    <I18nProvider>
      <StationsWarehouses />
    </I18nProvider>,
  );
}

const headerOf = (name: string) =>
  screen.getAllByRole('button').find((node) => node.textContent?.includes(name))!;

const actionOf = (action: string, entity: string) =>
  screen.getByRole('button', { name: `${action} ${entity}` });

/**
 * Invokes the callbacks the component passes to `mutate(vars, callbacks)`.
 * Wrapped in `act` because the callbacks drive `setState` outside React's own
 * event handling, exactly as TanStack Query would when a request settles.
 */
function callbacksOf(stub: MutationStub) {
  const call = stub.mutate.mock.calls.at(-1);
  return (call?.[1] ?? {}) as { onSuccess?: () => void; onError?: (error: unknown) => void };
}

function settleWithSuccess(stub: MutationStub) {
  act(() => {
    callbacksOf(stub).onSuccess?.();
  });
}

function settleWithError(stub: MutationStub, error: unknown) {
  act(() => {
    callbacksOf(stub).onError?.(error);
  });
}

beforeEach(() => {
  setQuery();
  for (const stub of Object.values(mutations)) {
    stub.mutate.mockReset();
    stub.isPending = false;
  }
  window.localStorage.clear();
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
});

describe('validateName', () => {
  it('trims, requires content and enforces the two-character minimum', () => {
    expect(validateName('  محطة  ')).toEqual({ ok: true, value: 'محطة' });
    expect(validateName('   ')).toEqual({ ok: false, code: 'required' });
    expect(validateName('')).toEqual({ ok: false, code: 'required' });
    expect(validateName('م')).toEqual({ ok: false, code: 'tooShort' });
    expect(validateName('ab')).toEqual({ ok: true, value: 'ab' });
  });
});

describe('StationsWarehouses — read-only accordion', () => {
  it('lists every station collapsed, with its code, warehouse count and status', () => {
    renderScreen();

    expect(screen.getByText('المحطة الرئيسية')).toBeTruthy();
    expect(screen.getByText('ST-01')).toBeTruthy();
    expect(screen.getByText('محطة الصيانة')).toBeTruthy();
    expect(screen.getByText('ST-02')).toBeTruthy();
    expect(screen.getByText('2 مخزن')).toBeTruthy();
    expect(screen.getByText('0 مخزن')).toBeTruthy();

    const headers = screen
      .getAllByRole('button')
      .filter((node) => node.hasAttribute('aria-expanded'));
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByText('مخزن المواد الخام')).toBeNull();
  });

  it('reveals the warehouses of a station when its header is expanded', () => {
    renderScreen();
    const header = headerOf('المحطة الرئيسية');

    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('مخزن المواد الخام')).toBeTruthy();
    expect(screen.getByText('WH-001')).toBeTruthy();
    expect(screen.getByText('مخزن قطع الغيار')).toBeTruthy();

    const panel = document.getElementById('station-panel-s1')!;
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-labelledby')).toBe('station-header-s1');
  });

  it('expands stations independently and collapses on a second click', () => {
    renderScreen();
    const headers = screen
      .getAllByRole('button')
      .filter((node) => node.hasAttribute('aria-expanded'));

    fireEvent.click(headers[0]!);
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(headers[1]!.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(headers[0]!);
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows an explicit note for a station that has no warehouses', () => {
    renderScreen();
    fireEvent.click(headerOf('محطة الصيانة'));
    expect(screen.getByText('لا توجد مخازن مرتبطة بهذه المحطة بعد.')).toBeTruthy();
  });

  it('renders the empty state when the directory has no stations', () => {
    setQuery({ data: [] });
    renderScreen();
    expect(screen.getByRole('heading', { name: 'لا توجد محطات بعد' })).toBeTruthy();
    expect(screen.queryByText('ST-01')).toBeNull();
  });

  it('renders a loading indicator while the directory is in flight', () => {
    setQuery({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();
    expect(screen.getByText('جارٍ تحميل المحطات والمخازن…')).toBeTruthy();
  });

  it('surfaces a denied grant explicitly instead of collapsing into the empty state', () => {
    setQuery({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new StationsDirectoryError('forbidden'),
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.queryByText('لا توجد محطات بعد')).toBeNull();
  });
});

describe('StationsWarehouses — create', () => {
  it('opens the station dialog from the add button and submits the trimmed name', () => {
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'إضافة محطة' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'إضافة محطة' })).toBeTruthy();
    // The code is minted server-side, so the create form has no code field.
    expect(within(dialog).queryByText(/ST-/)).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('اسم المحطة'), {
      target: { value: '  محطة جديدة  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.createStation.mutate).toHaveBeenCalledTimes(1);
    expect(mutations.createStation.mutate.mock.calls[0]?.[0]).toEqual({ name: 'محطة جديدة' });
  });

  it('refuses an empty or single-character name before any request is made', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة محطة' }));

    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('اسم المحطة');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('الاسم مطلوب.');
    expect(mutations.createStation.mutate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'م' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('الاسم يجب ألا يقل عن حرفين.');
    expect(mutations.createStation.mutate).not.toHaveBeenCalled();
  });

  it('closes the dialog and reports success once the insert resolves', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة محطة' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم المحطة'), { target: { value: 'محطة' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    settleWithSuccess(mutations.createStation);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });

  it('adds a warehouse to the station the button belongs to', () => {
    renderScreen();
    fireEvent.click(headerOf('المحطة الرئيسية'));

    fireEvent.click(screen.getByRole('button', { name: 'إضافة مخزن' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'إضافة مخزن' })).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم المخزن'), {
      target: { value: 'مخزن جديد' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.createWarehouse.mutate.mock.calls[0]?.[0]).toEqual({
      stationId: 's1',
      name: 'مخزن جديد',
    });
  });
});

describe('StationsWarehouses — edit', () => {
  it('prefills the station name and shows the code as read-only text', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'المحطة الرئيسية'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'تعديل المحطة' })).toBeTruthy();
    expect(within(dialog).getByLabelText('اسم المحطة')).toHaveProperty('value', 'المحطة الرئيسية');
    // The code is rendered as text, never as an editable field.
    expect(within(dialog).getByText('ST-01')).toBeTruthy();
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText('اسم المحطة'), {
      target: { value: 'الاسم المعدّل' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.updateStation.mutate.mock.calls[0]?.[0]).toEqual({
      id: 's1',
      name: 'الاسم المعدّل',
    });
  });

  it('edits a warehouse name without exposing its code', () => {
    renderScreen();
    fireEvent.click(headerOf('المحطة الرئيسية'));
    fireEvent.click(actionOf('تعديل', 'مخزن المواد الخام'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'تعديل المخزن' })).toBeTruthy();
    expect(within(dialog).getByText('WH-001')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم المخزن'), {
      target: { value: 'مخزن معدّل' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.updateWarehouse.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'w1',
      name: 'مخزن معدّل',
    });
  });
});

describe('StationsWarehouses — activate and deactivate', () => {
  it('flips is_active on a station and keeps it listed', () => {
    renderScreen();
    fireEvent.click(actionOf('تعطيل', 'المحطة الرئيسية'));

    expect(mutations.updateStation.mutate.mock.calls[0]?.[0]).toEqual({
      id: 's1',
      isActive: false,
    });
  });

  it('offers reactivation for an already disabled station', () => {
    renderScreen();
    fireEvent.click(actionOf('تفعيل', 'محطة الصيانة'));

    expect(mutations.updateStation.mutate.mock.calls[0]?.[0]).toEqual({
      id: 's2',
      isActive: true,
    });
  });

  it('flips is_active on a warehouse', () => {
    renderScreen();
    fireEvent.click(headerOf('المحطة الرئيسية'));
    fireEvent.click(actionOf('تعطيل', 'مخزن المواد الخام'));

    expect(mutations.updateWarehouse.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'w1',
      isActive: false,
    });
  });
});

describe('StationsWarehouses — delete', () => {
  it('offers delete only for a station that has no warehouses', () => {
    renderScreen();

    expect(() => actionOf('حذف', 'المحطة الرئيسية')).toThrow();
    expect(actionOf('حذف', 'محطة الصيانة')).toBeTruthy();
  });

  it('confirms before deleting a station', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'محطة الصيانة'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'حذف المحطة' })).toBeTruthy();
    expect(within(dialog).getByText(/محطة الصيانة/)).toBeTruthy();
    expect(mutations.deleteStation.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.deleteStation.mutate.mock.calls[0]?.[0]).toEqual({ id: 's2' });
  });

  it('confirms before deleting a warehouse', () => {
    renderScreen();
    fireEvent.click(headerOf('المحطة الرئيسية'));
    fireEvent.click(actionOf('حذف', 'مخزن قطع الغيار'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'حذف المخزن' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.deleteWarehouse.mutate.mock.calls[0]?.[0]).toEqual({ id: 'w2' });
  });

  it('reports the RESTRICT violation in plain language when a station gained warehouses', () => {
    /* The button is hidden for a non-empty station, but the constraint is the
       real guard: a concurrent insert must still produce a clear message. */
    renderScreen();
    fireEvent.click(actionOf('حذف', 'محطة الصيانة'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));

    settleWithError(mutations.deleteStation, new StationWriteError('conflict'));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('لا يمكن حذف المحطة لأنها تحتوي على مخازن');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a denied write without pretending it succeeded', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة محطة' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم المحطة'), { target: { value: 'محطة' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    settleWithError(mutations.createStation, new StationWriteError('forbidden'));

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.queryByText('تم الحفظ.')).toBeNull();
  });

  it('dismisses the banner on request', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'محطة الصيانة'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));
    settleWithSuccess(mutations.deleteStation);

    expect(screen.getByRole('alert').textContent).toBe('تم الحذف.');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق التنبيه' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
