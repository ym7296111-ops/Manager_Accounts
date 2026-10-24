import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StationsDirectoryModule from '@/hooks/useStationsDirectory';
import { StationsDirectoryError, type StationWithWarehouses } from '@/hooks/useStationsDirectory';
import { I18nProvider } from '@/i18n/I18nContext';
import StationsWarehouses from '@/pages/settings/StationsWarehouses';

/** Shape the component reads off the query result. */
interface DirectoryQueryStub {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: readonly StationWithWarehouses[] | undefined;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
}

const { state } = vi.hoisted(() => {
  const initial: DirectoryQueryStub = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: [],
    error: null,
    refetch: vi.fn(),
  };
  return { state: { value: initial } };
});

vi.mock('@/hooks/useStationsDirectory', async (importOriginal) => {
  const actual = await importOriginal<typeof StationsDirectoryModule>();
  return { ...actual, useStationsDirectory: () => state.value };
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

function setState(patch: Partial<DirectoryQueryStub>): DirectoryQueryStub {
  state.value = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: STATIONS,
    error: null,
    refetch: vi.fn(),
    ...patch,
  };
  return state.value;
}

function renderScreen() {
  return render(
    <I18nProvider>
      <StationsWarehouses />
    </I18nProvider>,
  );
}

beforeEach(() => {
  setState({});
  window.localStorage.clear();
  document.documentElement.lang = 'ar';
  document.documentElement.dir = 'rtl';
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

    // Both headers are collapsed by default.
    const headers = screen
      .getAllByRole('button')
      .filter((node) => node.hasAttribute('aria-expanded'));
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.getAttribute('aria-expanded')).toBe('false');
    }

    // Nothing is revealed until a header is activated.
    expect(screen.queryByText('مخزن المواد الخام')).toBeNull();
  });

  it('exposes the status of each station and warehouse to assistive technology', () => {
    renderScreen();

    // ST-01 is active, ST-02 is disabled.
    expect(screen.getAllByText('نشط').length).toBeGreaterThan(0);
    expect(screen.getAllByText('معطّل').length).toBeGreaterThan(0);
  });

  it('reveals the warehouses of a station when its header is expanded', () => {
    renderScreen();

    const header = screen
      .getAllByRole('button')
      .find((node) => node.textContent?.includes('المحطة الرئيسية'))!;

    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('المخازن')).toBeTruthy();
    expect(screen.getByText('مخزن المواد الخام')).toBeTruthy();
    expect(screen.getByText('WH-001')).toBeTruthy();
    expect(screen.getByText('مخزن قطع الغيار')).toBeTruthy();
    expect(screen.getByText('WH-002')).toBeTruthy();

    // The panel is a labelled region wired to its header.
    const panel = document.getElementById(`station-panel-s1`)!;
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-labelledby')).toBe('station-header-s1');
  });

  it('collapses an expanded station when its header is clicked again', () => {
    renderScreen();

    const header = screen
      .getAllByRole('button')
      .find((node) => node.textContent?.includes('محطة الصيانة'))!;

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows an explicit note for a station that has no warehouses', () => {
    renderScreen();

    fireEvent.click(
      screen.getAllByRole('button').find((node) => node.textContent?.includes('محطة الصيانة'))!,
    );

    expect(screen.getByText('لا توجد مخازن مرتبطة بهذه المحطة بعد.')).toBeTruthy();
  });

  it('expands stations independently', () => {
    renderScreen();

    const [first, second] = screen
      .getAllByRole('button')
      .filter((node) => node.hasAttribute('aria-expanded'));

    fireEvent.click(first!);
    expect(first!.getAttribute('aria-expanded')).toBe('true');
    expect(second!.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders both add buttons, present but inert until the write phase', () => {
    renderScreen();

    const addStation = screen.getByRole('button', { name: 'إضافة محطة' });
    expect(addStation).toBeTruthy();
    expect((addStation as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      screen.getAllByRole('button').find((node) => node.textContent?.includes('المحطة الرئيسية'))!,
    );
    const addWarehouse = screen.getByRole('button', { name: 'إضافة مخزن' });
    expect((addWarehouse as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('StationsWarehouses — empty, loading and denied states', () => {
  it('renders the empty state when the directory has no stations', () => {
    setState({ data: [] });
    renderScreen();

    expect(screen.getByRole('heading', { name: 'لا توجد محطات بعد' })).toBeTruthy();
    expect(
      screen.getByText('أضف أول محطة لتبدأ بتنظيم المخازن المرتبطة بها. الأكواد تُولَّد تلقائياً.'),
    ).toBeTruthy();
    expect(screen.queryByText('ST-01')).toBeNull();
  });

  it('renders a loading indicator while the directory is in flight', () => {
    setState({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();

    expect(screen.getByText('جارٍ تحميل المحطات والمخازن…')).toBeTruthy();
    expect(screen.queryByText('ST-01')).toBeNull();
  });

  it('surfaces a denied grant explicitly instead of collapsing into the empty state', () => {
    /* The route is already capability-gated, but a revoked or delegated-away
       grant must not look like "no stations". */
    setState({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new StationsDirectoryError('forbidden'),
    });
    renderScreen();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('project.settings:manage');
    expect(screen.queryByText('لا توجد محطات بعد')).toBeNull();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });

  it('classifies an unrecognised failure under the generic message', () => {
    setState({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new StationsDirectoryError('unknown'),
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toBe('تعذّر تحميل المحطات والمخازن.');
  });

  it('retries through the query when the user asks for it', () => {
    const current = setState({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new StationsDirectoryError('network'),
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toBe('تعذّر الاتصال بالخادم، حاول مرة أخرى.');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(current.refetch).toHaveBeenCalledTimes(1);
  });

  it('treats a missing client as a configuration problem, not an empty directory', () => {
    setState({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new StationsDirectoryError('unavailable'),
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toBe(
      'الاتصال بقاعدة البيانات غير مُهيّأ في هذه البيئة.',
    );
  });
});
