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
    useLetterBalances: () => ({ data: undefined }),
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
  parties: [
    { id: id(501), name: 'شركة النيل', code: 'IN-014', branch: 'inbound' },
    { id: id(504), name: 'المشتريات المحلية', code: 'IN-002', branch: 'inbound' },
    { id: id(503), name: 'قسم المشروعات', code: 'OUT-003', branch: 'outbound' },
    { id: id(505), name: 'صرف عام', code: 'OUT-001', branch: 'outbound' },
  ],
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
 * The pickers are searchable comboboxes: focus opens the list, typing filters
 * it, and the option is a button. Options show the name alone; the code is
 * search keywords, never part of the option's accessible name. The option is
 * looked up inside the field's own listbox (`aria-controls`): the tree's
 * reveal-on-add/error focuses fields too, so another row's list may still be
 * open in jsdom, where `fireEvent.focus` never fires the outside-mousedown
 * that would close it in a browser.
 */
function pickOption(input: HTMLElement, optionName: string) {
  fireEvent.focus(input);
  const listbox = document.getElementById(input.getAttribute('aria-controls')!);
  fireEvent.click(within(listbox!).getByRole('option', { name: optionName }));
}

function pick(label: string, optionName: string) {
  pickOption(screen.getByLabelText(label), optionName);
}

function pickAt(label: string, index: number, optionName: string) {
  pickOption(screen.getAllByLabelText(label)[index]!, optionName);
}

function fillInbound() {
  fireEvent.click(screen.getByRole('button', { name: /^وارد/ }));
  fireEvent.change(screen.getByLabelText('رقم النظام (EPS)'), { target: { value: '2458' } });
  choose('المُصدر', 'YM');
  fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: '63' } });
  pick('اختر الجهة', 'شركة النيل');
  pick('المخزن', 'المخزن الرئيسي - غرب القاهرة');
  pick('التصنيف', 'حديد');
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
    // The amount echoes in the party and warehouse subtotals and the summary —
    // always in Latin digits, even though it was typed in Arabic ones.
    expect(screen.getAllByText('120.50').length).toBeGreaterThanOrEqual(3);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [, version, form] = save.mock.calls[0] as [string, string | null, EntryForm];
    expect(version).toBeNull();
    expect(form).toMatchObject({
      type: 'inbound',
      number: '2458',
      letterCode: 'YM:63',
      lines: [{ partyId: id(501), warehouseId: id(100), classificationId: id(201) }],
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
    pick('المصدر — التصنيف', 'حديد');
    pick('الوجهة — المخزن', 'المخزن الرئيسي - غرب القاهرة');
    pick('الوجهة — التصنيف', 'تشغيل');
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

  it('opens a new outbound tree with the smallest-code purpose already present', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^منصرف/ }));
    // OUT-001 («صرف عام») wins over OUT-003: the comparison is numeric, never
    // textual — and the closed field prints the name, never the code.
    expect(screen.getByLabelText<HTMLInputElement>('اختر غرض الصرف').value).toBe('صرف عام');
  });

  it('saves one inbound letter carrying two parties in the tree', async () => {
    mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة جهة الوارد' }));
    const partyFields = screen.getAllByLabelText<HTMLInputElement>('اختر الجهة');
    expect(partyFields).toHaveLength(2);
    // The new group arrives holding the first still-unused party (IN-002),
    // shown by name alone.
    expect(partyFields[1]?.value).toBe('المشتريات المحلية');
    const warehouses = screen.getAllByLabelText('المخزن');
    fireEvent.focus(warehouses[1]!);
    fireEvent.click(screen.getByRole('option', { name: 'المخزن الرئيسي - غرب القاهرة' }));
    pickAt('التصنيف', 1, 'تشغيل');
    const amounts = screen.getAllByLabelText('القيمة');
    fireEvent.change(amounts[1]!, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const form = (save.mock.calls[0] as [string, string | null, EntryForm])[2];
    expect(form.lines.map((line) => line.partyId)).toEqual([id(501), id(504)]);
  });

  it('asks with descendant counts before removing a party group, but removes a row at once', async () => {
    mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة جهة الوارد' }));
    const warehouses = screen.getAllByLabelText('المخزن');
    fireEvent.focus(warehouses[1]!);
    fireEvent.click(screen.getByRole('option', { name: 'المخزن الرئيسي - غرب القاهرة' }));
    pickAt('التصنيف', 1, 'تشغيل');
    fireEvent.change(screen.getAllByLabelText('القيمة')[1]!, { target: { value: '30' } });

    // Removing the whole party is a group act: it asks, with the counts.
    fireEvent.click(screen.getByRole('button', { name: 'حذف المشتريات المحلية' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/1 مخزن و1 تصنيف/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByLabelText('اختر الجهة')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'حذف المشتريات المحلية' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'حذف' }));
    expect(screen.getAllByLabelText('اختر الجهة')).toHaveLength(1);

    // A single classification row needs no ceremony.
    fireEvent.click(screen.getByRole('button', { name: 'حذف التصنيف' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('القيمة').value).toBe('');

    // Refill and save so the suite's unsaved-entry cache is left clean.
    pick('اختر الجهة', 'شركة النيل');
    pick('المخزن', 'المخزن الرئيسي - غرب القاهرة');
    pick('التصنيف', 'حديد');
    fireEvent.change(screen.getByLabelText('القيمة'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('paints both rows of a duplicate triple and unfolds their ancestors', async () => {
    const view = mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة تصنيف' }));
    pickAt('التصنيف', 1, 'حديد');
    fireEvent.change(screen.getAllByLabelText('القيمة')[1]!, { target: { value: '5' } });

    // Fold the party away, then let validation fail: the tree must unfold
    // itself back to the offending rows instead of reporting from afar.
    fireEvent.click(screen.getAllByRole('button', { name: 'طي' })[0]!);
    expect(screen.queryAllByLabelText('القيمة')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    expect(await screen.findByText(/مُضاف بالفعل لنفس الجهة والمخزن/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getAllByLabelText('القيمة')).toHaveLength(2);
    const painted = [...view.container.querySelectorAll('[data-line-key]')].filter((row) =>
      row.className.includes('ring-destructive'),
    );
    expect(painted).toHaveLength(2);

    // Fix the repeat and save, so no dirty entry leaks into the next test.
    pickAt('التصنيف', 1, 'تشغيل');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('recomputes the warehouse, party and letter totals on every amount edit', async () => {
    const view = mount();
    fillInbound(); // one party, one warehouse, one row of 120.50
    const card = view.container.querySelector('.aps-tree');
    /* No digit folding on purpose: the totals must print Latin digits as-is
       (`120.50`), matching the raw amounts in the inputs — never `١٢٠٫٥٠`. */
    const occurrences = (needle: string) => (card?.textContent ?? '').split(needle).length - 1;
    // Root, party and warehouse each carry the same running total; the row's
    // own input value is a property, not text, so it cannot inflate the count.
    expect(occurrences('120.50')).toBe(3);
    expect(card?.textContent).not.toMatch(/[٠-٩]/);

    fireEvent.change(screen.getByLabelText('القيمة'), { target: { value: '200' } });
    expect(occurrences('120.50')).toBe(0);
    expect(occurrences('200.00')).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it('allows the same classification under two warehouses without calling it a duplicate', async () => {
    hooks.options.data = {
      ...options,
      warehouses: [
        ...options.warehouses,
        {
          id: id(101),
          name: 'مخزن فرعي',
          code: 'WH-002',
          stationName: 'شرق القاهرة',
          stationCode: 'ST-02',
        },
      ],
    };
    const view = mount();
    fillInbound(); // party 501, main warehouse, CL-001
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مخزن' }));
    const warehouses = screen.getAllByLabelText('المخزن');
    fireEvent.focus(warehouses[1]!);
    fireEvent.click(screen.getByRole('option', { name: 'مخزن فرعي - شرق القاهرة' }));
    // Same classification as the first row, but a different warehouse: the
    // duplicate rule is the (party, warehouse, classification) triple.
    pickAt('التصنيف', 1, 'حديد');
    fireEvent.change(screen.getAllByLabelText('القيمة')[1]!, { target: { value: '50' } });

    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/مُضاف بالفعل لنفس الجهة والمخزن/)).toBeNull();
    const painted = [...view.container.querySelectorAll('[data-line-key]')].filter((row) =>
      row.className.includes('ring-destructive'),
    );
    expect(painted).toHaveLength(0);
    const form = (save.mock.calls[0] as [string, string | null, EntryForm])[2];
    expect(form.lines.map((line) => line.warehouseId)).toEqual([id(100), id(101)]);
    expect(form.lines.every((line) => line.classificationId === id(201))).toBe(true);
  });

  it('prints picker names without codes, yet a typed code still finds its row', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^وارد/ }));
    fireEvent.change(screen.getByLabelText('رقم النظام (EPS)'), { target: { value: '2458' } });
    choose('المُصدر', 'YM');
    fireEvent.change(screen.getByLabelText('الرقم'), { target: { value: '63' } });

    // The code is searchable but is no part of the option's printed name, in
    // each of the three pickers: party, warehouse and classification. The
    // fields are re-queried after each choice: picking a party or warehouse
    // re-keys (and remounts) its tree block, orphaning the old input node.
    const partyField = screen.getByLabelText<HTMLInputElement>('اختر الجهة');
    fireEvent.focus(partyField);
    fireEvent.change(partyField, { target: { value: 'IN-014' } });
    expect(screen.queryByRole('option', { name: /IN-014/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'شركة النيل' }));
    expect(screen.getByLabelText<HTMLInputElement>('اختر الجهة').value).toBe('شركة النيل');

    const warehouseField = screen.getByLabelText<HTMLInputElement>('المخزن');
    fireEvent.focus(warehouseField);
    fireEvent.change(warehouseField, { target: { value: 'WH-001' } });
    expect(screen.queryByRole('option', { name: /WH-001/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'المخزن الرئيسي - غرب القاهرة' }));
    expect(screen.getByLabelText<HTMLInputElement>('المخزن').value).toBe(
      'المخزن الرئيسي - غرب القاهرة',
    );

    const classificationField = screen.getByLabelText<HTMLInputElement>('التصنيف');
    fireEvent.focus(classificationField);
    fireEvent.change(classificationField, { target: { value: 'CL-002' } });
    expect(screen.queryByRole('option', { name: /CL-002/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'تشغيل' }));
    expect(classificationField.value).toBe('تشغيل');

    fireEvent.change(screen.getByLabelText('القيمة'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const form = (save.mock.calls[0] as [string, string | null, EntryForm])[2];
    expect(form.lines[0]).toMatchObject({
      partyId: id(501),
      warehouseId: id(100),
      classificationId: id(202),
    });
  });

  it('states the running period above two fields and asks for no date', () => {
    mount();
    // The period is a badge, the month is the emphasis, and the fiscal year is
    // quiet. The month's own year is not printed twice: `أكتوبر` inside
    // `2026/2027` already says which October it is.
    const periodBar = screen
      .getByText('بيانات الخطاب')
      .closest('section')!
      .querySelector('[role="status"]')!;
    expect(within(periodBar as HTMLElement).getByText('فترة 2')).toBeTruthy();
    expect(within(periodBar as HTMLElement).getByText('مارس')).toBeTruthy();
    expect(
      within(periodBar as HTMLElement).getByText(
        `عام مالي ${calendarYear}/${Number(calendarYear) + 1}`,
      ),
    ).toBeTruthy();
    // The month's own year is not repeated: the fiscal year already says it.
    expect(periodBar.textContent).not.toContain('مارس ');
    expect(periodBar.textContent).toContain('مارسعام مالي');
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

  it('merges the type, the period and the numbers into one «بيانات الخطاب» paragraph', () => {
    mount();
    // The type is not a paragraph of its own any more: its heading only
    // restated the sticky header, which already names the type.
    expect(screen.queryByRole('heading', { name: 'اختر نوع الخطاب' })).toBeNull();

    const header = screen.getByRole('heading', { name: 'بيانات الخطاب' }).closest('section')!;
    // One paragraph, read top to bottom: the switch, the read-only period, the
    // two typed numbers.
    const typeGroup = within(header).getByRole('group', { name: 'اختر نوع الخطاب' });
    const periodBar = header.querySelector('[role="status"]')!;
    const eps = within(header).getByLabelText('رقم النظام (EPS)');
    const code = within(header).getByLabelText('المُصدر');
    const follows = (first: Node, second: Node) =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(typeGroup, periodBar)).toBe(true);
    expect(follows(periodBar, eps)).toBe(true);
    // EPS and the letter code share one row: neither is a paragraph of its own.
    const row = eps.closest('label')!.parentElement!;
    expect(row.children).toHaveLength(2);
    expect(row.lastElementChild!.contains(code)).toBe(true);

    // A segmented control, not four cards: one bordered row of four pressed
    // buttons, exactly one of them the current type.
    const buttons = within(typeGroup).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(typeGroup.className).toContain('grid-cols-4');

    // The paragraph numbers are sequential and never repeated: the header,
    // then the tree — the party no longer has a paragraph of its own.
    expect(screen.getAllByText(/^0\d$/).map((node) => node.textContent)).toEqual(['01', '02']);
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
        letterDate: '2026-08-01',
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
              partyId: '',
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
