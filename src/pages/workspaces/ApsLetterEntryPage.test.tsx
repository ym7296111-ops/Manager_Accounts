import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageHeaderProvider, usePageHeader } from '@/context/PageHeaderContext';
import { I18nProvider, useI18n } from '@/i18n/I18nContext';
import { ApsEntryError, type LoadedDraft } from '@/hooks/useApsLetterEntry';
import { localToday, type EntryForm, type EntryOptions } from '@/lib/apsLetterEntry';
import ApsLetterEntryPage from './ApsLetterEntryPage';

/* One stub shape for both hooks: the options query and the draft query answer
   with different payloads, and only the component under test reads them. */
type HookState = {
  isPending: boolean;
  isError: boolean;
  data: EntryOptions | LoadedDraft | null;
};

const { hooks, save, approve } = vi.hoisted<{
  hooks: { options: HookState; draft: HookState };
  save: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
}>(() => {
  const empty = (): HookState => ({ isPending: false, isError: false, data: null });
  return {
    hooks: { options: empty(), draft: empty() },
    save: vi.fn(),
    approve: vi.fn(),
  };
});

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: '00000000-0000-4000-8000-000000000001' } } }),
}));
vi.mock('@/hooks/useApsLetterEntry', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useApsLetterEntry');
  return {
    ...actual,
    useEntryOptions: () => hooks.options,
    useEntryDraft: () => hooks.draft,
    saveEntryDraft: save,
    approveEntryLetter: approve,
  };
});

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
/* The period is read from the settings through today's date, so the fixture
   month is built around the day the test actually runs. */
const today = localToday();
const calendarYear = today.slice(0, 4);
const options: EntryOptions = {
  years: [
    {
      id: id(400),
      name: `${calendarYear}-${Number(calendarYear) + 1}`,
      startDate: `${calendarYear}-01-01`,
      endDate: `${calendarYear}-12-31`,
      active: true,
      closed: false,
      supplementsOpen: false,
    },
  ],
  months: [
    {
      id: id(300),
      yearId: id(400),
      monthNumber: 1,
      name: 'مارس',
      startDate: `${calendarYear}-01-01`,
      endDate: `${calendarYear}-12-31`,
      period: 2,
      closed: false,
    },
  ],
  warehouses: [
    {
      id: id(100),
      name: 'المخزن الرئيسي',
      code: 'WH-001',
      stationName: 'غرب القاهرة',
      stationCode: 'ST-01',
    },
  ],
  classifications: [
    { id: id(201), name: 'حديد', code: 'CL-001' },
    { id: id(202), name: 'تشغيل', code: 'CL-002' },
  ],
  parties: [{ id: id(501), name: 'شركة النيل', code: 'IN-014', branch: 'inbound' }],
  sisters: [{ id: id(601), name: 'الشقيقة', code: 'SIS-001' }],
  issuers: [
    { id: id(701), code: 'YM', name: 'ياسر' },
    { id: id(702), code: 'AA', name: 'أحمد عبد الله' },
  ],
};

/**
 * Stands in for the shell's sticky top bar: it prints exactly what the page
 * publishes, so the test asserts the header the user actually sees without
 * mounting the whole shell.
 */
function ShellHeaderProbe() {
  const { t } = useI18n();
  const header = usePageHeader();
  return (
    <p data-testid="shell-header" data-tone={header?.tone ?? 'none'}>
      {header ? t(header.titleKey) : '—'}
    </p>
  );
}

function mount(entry = '/workspaces/aps/letters/new') {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider defaultLocale="ar">
        <PageHeaderProvider>
          <ShellHeaderProbe />
          <MemoryRouter initialEntries={[entry]}>
            <ApsLetterEntryPage />
          </MemoryRouter>
        </PageHeaderProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function choose(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * The warehouse is a searchable combobox: focus opens the list, typing filters
 * it, and the option is a button.
 */
function pick(label: string, optionName: string) {
  const input = screen.getByLabelText(label);
  fireEvent.focus(input);
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

function fillInbound() {
  fireEvent.click(screen.getByRole('button', { name: /^وارد/ }));
  fireEvent.change(screen.getByLabelText('رقم النظام (EPS)'), { target: { value: '2458' } });
  choose('المُصدر', 'YM');
  fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: '63' } });
  choose('جهة الوارد', id(501));
  pick('المخزن', 'المخزن الرئيسي - غرب القاهرة');
  choose('التصنيف', id(201));
  fireEvent.change(screen.getByLabelText('القيمة'), { target: { value: '١٢٠٫٥٠' } });
}

describe('APS letter entry screen', () => {
  beforeEach(() => {
    hooks.options = { isPending: false, isError: false, data: options };
    hooks.draft = { isPending: false, isError: false, data: null };
    save.mockReset().mockResolvedValue({ id: id(900), updatedAt: '2026-03-04T10:00:00Z' });
    approve.mockReset().mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  it('offers exactly the four ordinary types as one button group and saves an exact inbound draft', async () => {
    mount();
    const group = screen.getByRole('group', { name: 'اختر نوع الخطاب' });
    for (const name of ['وارد', 'منصرف', 'تحويل داخلي', 'تحويل خارجي']) {
      expect(within(group).getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
    expect(within(group).getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /تسوية/ })).toBeNull();
    fillInbound();
    expect(screen.getByText('١٢٠٫٥٠')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [, version, form] = save.mock.calls[0] as [string, string | null, EntryForm];
    expect(version).toBeNull();
    expect(form).toMatchObject({
      type: 'inbound',
      number: '2458',
      letterCode: 'YM:63',
      partyId: id(501),
    });
    expect(form).not.toHaveProperty('date');
    expect(screen.getByTestId('shell-header').textContent).toBe('خطاب وارد جديد');
    expect(await screen.findByText(/حُفظت المسودة بنجاح/)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ التعديلات' })).toBeTruthy();
  });

  it('validates before any request and keeps the reason rule for reclassification', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    expect(await screen.findByText(/أدخل رقم النظام \(EPS\) بالأرقام فقط/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /تحويل داخلي/ }));
    fireEvent.change(screen.getByLabelText('رقم النظام (EPS)'), { target: { value: '90' } });
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(4);
    pick('المصدر — المخزن', 'المخزن الرئيسي - غرب القاهرة');
    choose('المصدر — التصنيف', id(201));
    pick('الوجهة — المخزن', 'المخزن الرئيسي - غرب القاهرة');
    choose('الوجهة — التصنيف', id(202));
    fireEvent.change(screen.getByLabelText('قيمة الزوج'), { target: { value: '10' } });
    expect(await screen.findByLabelText(/سبب إعادة التصنيف/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    expect(await screen.findByText(/أدخل سبب إعادة التصنيف/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/سبب إعادة التصنيف/), {
      target: { value: 'إعادة تصنيف أثناء النقل' },
    });
    save.mockResolvedValue({ id: id(901), updatedAt: '2026-03-04T10:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(save.mock.calls[0]![0]));
    expect(await screen.findByText('تم اعتماد الخطاب بنجاح.')).toBeTruthy();
  });

  it('reports a duplicate number without losing the entered data', async () => {
    save.mockRejectedValue(new ApsEntryError('duplicate'));
    mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    expect(await screen.findByText(/رقم الخطاب مستخدم بالفعل/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('رقم النظام (EPS)').value).toBe('2458');
    expect(screen.getByLabelText<HTMLInputElement>('القيمة').value).toBe('١٢٠٫٥٠');
  });

  it('keeps the saved draft and warns when approval fails afterwards', async () => {
    approve.mockRejectedValue(new ApsEntryError('invalid'));
    mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(await screen.findByText(/حُفظت المسودة، لكن تعذّر اعتمادها/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'عرض المسودة' })).toBeTruthy();
    expect(screen.queryByText('تم اعتماد الخطاب بنجاح.')).toBeNull();
  });

  it('states the running period above two fields and asks for no date', () => {
    mount();
    expect(screen.getByText(new RegExp(`فترة 2 — مارس ${calendarYear} — عام مالي`))).toBeTruthy();
    // The three retired controls are gone: the date, the year and the issuer
    // picker. Only the EPS number and the letter-code number are typed; the
    // issuer is chosen from the register.
    expect(screen.queryByLabelText('تاريخ الخطاب')).toBeNull();
    expect(screen.queryByLabelText('السنة المالية')).toBeNull();
    const header = screen.getByText('بيانات الخطاب').closest('section')!;
    expect(within(header).getAllByRole('textbox')).toHaveLength(2);
    const issuerSelect = within(header).getAllByRole('combobox');
    expect(issuerSelect).toHaveLength(1);
    expect(issuerSelect[0]?.getAttribute('aria-label')).toBe('المُصدر');
  });

  it('builds the letter code from the issuer dropdown and a digits-only number', () => {
    mount();
    const issuer = screen.getByLabelText<HTMLSelectElement>('المُصدر');
    const number = screen.getByLabelText<HTMLInputElement>('الرقم');

    // The list is the register, printed as `code — name`, with the colon never
    // typed and the number field closed until an issuer is chosen.
    expect(within(issuer).getByRole('option', { name: 'YM — ياسر' })).toBeTruthy();
    expect(within(issuer).getByRole('option', { name: 'AA — أحمد عبد الله' })).toBeTruthy();
    expect(number.disabled).toBe(true);
    expect(screen.getByText(/النقطتان توضعان تلقائياً/)).toBeTruthy();

    choose('المُصدر', 'YM');
    expect(issuer.value).toBe('YM');
    expect(screen.getByLabelText('الرقم').hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/اكتب رقم كود الخطاب بالأرقام فقط/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: '٦٣' } });
    // Arabic-Indic digits never reach the field: the number stays Latin.
    expect(screen.getByLabelText<HTMLInputElement>('الرقم').value).toBe('');

    fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: 'a6b3' } });
    expect(screen.getByLabelText<HTMLInputElement>('الرقم').value).toBe('63');
    expect(screen.getByText(/النقطتان توضعان تلقائياً/)).toBeTruthy();

    // Clearing the issuer clears the pair: a number cannot stand alone.
    choose('المُصدر', '');
    expect(screen.getByLabelText<HTMLInputElement>('الرقم').value).toBe('');
  });

  it('says where a code is added when no issuer is active', () => {
    // No active issuer at all: the dropdown explains itself instead of
    // offering an empty list, and both controls are closed.
    hooks.options = { isPending: false, isError: false, data: { ...options, issuers: [] } };
    mount();
    expect(screen.getByText(/لا يوجد مُصدر نشط/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('المُصدر').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('الرقم').disabled).toBe(true);
  });

  it('keeps a draft whose issuer is no longer active, and explains it', () => {
    hooks.draft = {
      isPending: false,
      isError: false,
      data: {
        id: id(900),
        updatedAt: '2026-03-04T10:00:00Z',
        form: {
          type: 'inbound',
          number: '2458',
          // The row is no longer active: the stored value stays visible so the
          // clerk can switch to a live code instead of losing it.
          letterCode: 'ZZ:7',
          yearId: id(400),
          partyId: id(501),
          sisterId: '',
          direction: 'in',
          reason: '',
          lines: [
            {
              key: 'line-1',
              warehouseId: id(100),
              classificationId: id(201),
              destinationWarehouseId: '',
              destinationClassificationId: '',
              amount: '10',
            },
          ],
        },
      },
    };
    mount(`/workspaces/aps/letters/new?draft=${id(900)}`);
    const issuer = screen.getByLabelText<HTMLSelectElement>('المُصدر');
    expect(issuer.value).toBe('ZZ');
    expect(within(issuer).getByRole('option', { name: 'ZZ (غير نشط)' })).toBeTruthy();
    expect(screen.getByText(/بادئة الكود ليست مُصدراً نشطاً/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('الرقم').value).toBe('7');
  });

  it('drives the shell header from the chosen type without a second title', () => {
    mount();
    expect(screen.getByTestId('shell-header').textContent).toBe('خطاب وارد جديد');
    expect(screen.getByTestId('shell-header').dataset.tone).toBe('emerald');
    fireEvent.click(screen.getByRole('button', { name: /تحويل داخلي/ }));
    expect(screen.getByTestId('shell-header').textContent).toBe('تحويل داخلي جديد');
    expect(screen.getByTestId('shell-header').dataset.tone).toBe('violet');
    fireEvent.click(screen.getByRole('button', { name: /تحويل خارجي/ }));
    expect(screen.getByTestId('shell-header').textContent).toBe('تحويل خارجي جديد');
    expect(screen.getByTestId('shell-header').dataset.tone).toBe('sky');
    fireEvent.click(screen.getByRole('button', { name: /منصرف/ }));
    expect(screen.getByTestId('shell-header').textContent).toBe('خطاب منصرف جديد');
    expect(screen.getByTestId('shell-header').dataset.tone).toBe('orange');
    // No heading of its own: the sticky header is the only title on the page.
    expect(screen.queryAllByRole('heading', { name: /جديد/ })).toHaveLength(0);
  });

  it('refuses to save a chosen issuer without a number', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^وارد/ }));
    fireEvent.change(screen.getByLabelText('رقم النظام (EPS)'), { target: { value: '2458' } });
    choose('المُصدر', 'YM');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    expect(await screen.findByText(/اختر المُصدر ثم اكتب رقم كود الخطاب/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('shows the server refusal on a load error and offers a retry', () => {
    hooks.options = { isPending: false, isError: true, data: null };
    mount();
    expect(screen.getByRole('alert').textContent).toContain('تعذّر تحميل بيانات الإدخال');
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });
});
