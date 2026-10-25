import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PartiesModule from '@/hooks/useParties';
import { PartiesError, type Party } from '@/hooks/useParties';
import type * as PartiesMutationsModule from '@/hooks/usePartiesMutations';
import { PartyWriteError } from '@/hooks/usePartiesMutations';
import { I18nProvider } from '@/i18n/I18nContext';
import Parties from '@/pages/settings/Parties';

interface QueryStub {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: readonly Party[] | undefined;
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
      create: make(),
      update: make(),
      toggle: make(),
      remove: make(),
    },
  };
});

vi.mock('@/hooks/useParties', async (importOriginal) => {
  const actual = await importOriginal<typeof PartiesModule>();
  return { ...actual, useParties: () => queryState.value };
});

vi.mock('@/hooks/usePartiesMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof PartiesMutationsModule>();
  return {
    ...actual,
    useCreateParty: () => mutations.create,
    useUpdateParty: () => mutations.update,
    useSetPartyActive: () => mutations.toggle,
    useDeleteParty: () => mutations.remove,
  };
});

const party = (patch: Partial<Party> & Pick<Party, 'id' | 'type' | 'code' | 'name'>): Party => ({
  taxNumber: null,
  commercialRegister: null,
  address: null,
  contactPerson: null,
  phone: null,
  email: null,
  creditLimit: null,
  paymentTerms: null,
  isActive: true,
  ...patch,
});

const LOCAL_SUPPLIER = party({
  id: 'loc',
  type: 'local_supplier',
  code: 'LOC-001',
  name: 'شركة النيل للتوريدات الصناعية',
  creditLimit: 250000,
  paymentTerms: 30,
});

const FOREIGN_SUPPLIER = party({
  id: 'frn',
  type: 'foreign_supplier',
  code: 'FRN-001',
  name: 'Nile Trading GmbH',
});

const CUSTOMER = party({
  id: 'cus',
  type: 'customer',
  code: 'CUS-001',
  name: 'مؤسسة الأفق للتجارة والتوزيع',
  taxNumber: '987654321',
  email: 'purchases@horizon-trade.example.com',
  creditLimit: 150000,
  paymentTerms: 60,
});

const INACTIVE_CUSTOMER = party({
  id: 'cus2',
  type: 'customer',
  code: 'CUS-002',
  name: 'عميل معطّل للاختبار',
  isActive: false,
});

const DIRECTORY: readonly Party[] = [LOCAL_SUPPLIER, FOREIGN_SUPPLIER, CUSTOMER, INACTIVE_CUSTOMER];

function setQuery(patch: Partial<QueryStub> = {}) {
  const initial: QueryStub = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: DIRECTORY,
    error: null,
    refetch: vi.fn(),
  };
  queryState.value = { ...initial, ...patch };
  return queryState.value;
}

function renderScreen() {
  return render(
    <I18nProvider>
      <Parties />
    </I18nProvider>,
  );
}

const actionOf = (action: string, entity: string) =>
  screen.getByRole('button', { name: `${action} ${entity}` });

const subTab = (name: string) => screen.getByRole('tab', { name });

/** Invokes the callbacks the component passes to `mutate(vars, callbacks)`. */
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

function openCreateDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'إضافة جهة' }));
  return screen.getByRole('dialog');
}

function chooseType(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText('نوع الجهة'), { target: { value } });
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

describe('Parties — the two sub-tabs', () => {
  it('renders only inbound and outbound tabs, with inbound open first', () => {
    renderScreen();

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(subTab('جهات وارد').getAttribute('aria-selected')).toBe('true');
    expect(subTab('جهات صرف').getAttribute('aria-selected')).toBe('false');
    /* Sister companies are a top-level tab of Project Settings now, not a
       a third sub-tab here. */
    expect(screen.queryByRole('tab', { name: 'شركات شقيقة' })).toBeNull();

    /* The inbound table holds both supplier kinds and no customer. */
    expect(screen.getByText('شركة النيل للتوريدات الصناعية')).toBeTruthy();
    expect(screen.getByText('Nile Trading GmbH')).toBeTruthy();
    expect(screen.queryByText('مؤسسة الأفق للتجارة والتوزيع')).toBeNull();
  });

  it('shows customers only in the outbound tab', () => {
    renderScreen();
    fireEvent.click(subTab('جهات صرف'));

    expect(subTab('جهات صرف').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('مؤسسة الأفق للتجارة والتوزيع')).toBeTruthy();
    expect(screen.getByText('عميل معطّل للاختبار')).toBeTruthy();
    expect(screen.queryByText('شركة النيل للتوريدات الصناعية')).toBeNull();
    expect(screen.queryByText('Nile Trading GmbH')).toBeNull();
  });

  it('keeps the sister-company tree out of this screen entirely', () => {
    renderScreen();

    expect(screen.queryByRole('heading', { name: 'شجرة الشركات الشقيقة' })).toBeNull();
    expect(screen.queryByText('الشركة المتحدة للخدمات اللوجستية')).toBeNull();
    /* Both remaining panes are tables. */
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.click(subTab('جهات صرف'));
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

describe('Parties — table rendering', () => {
  it('renders a table with name, code, type and status columns', () => {
    renderScreen();

    for (const header of ['الاسم', 'الكود', 'النوع', 'الحالة']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeTruthy();
    }

    const row = screen.getByRole('row', { name: /شركة النيل للتوريدات الصناعية/ });
    expect(within(row).getByText('LOC-001')).toBeTruthy();
    expect(within(row).getByText('مورّد محلي')).toBeTruthy();
    expect(within(row).getByText('نشط')).toBeTruthy();

    /* Each type badge is named in text, never colour alone. */
    fireEvent.click(subTab('جهات صرف'));
    const customerRow = screen.getByRole('row', { name: /مؤسسة الأفق للتجارة والتوزيع/ });
    expect(within(customerRow).getByText('عميل')).toBeTruthy();
    expect(within(customerRow).getByText('CUS-001')).toBeTruthy();
  });

  it('renders one disabled row and reports it as such', () => {
    renderScreen();
    fireEvent.click(subTab('جهات صرف'));

    const row = screen.getByRole('row', { name: /عميل معطّل للاختبار/ });
    expect(within(row).getByText('معطّل')).toBeTruthy();
  });
});

describe('Parties — empty, loading and permission states', () => {
  it('renders a scope-specific empty state when there are no parties', () => {
    setQuery({ data: [] });
    renderScreen();

    expect(screen.getByText('لا توجد جهات وارد بعد')).toBeTruthy();
    expect(
      screen.getByText(
        'أضف أول مورّد محلي أو أجنبي. الكود يُولَّد تلقائياً حسب نوع الجهة (LOC / FRN).',
      ),
    ).toBeTruthy();

    fireEvent.click(subTab('جهات صرف'));
    expect(screen.getByText('لا توجد جهات صرف بعد')).toBeTruthy();
    /* Creating the first party stays one click away. */
    expect(screen.getByRole('button', { name: 'إضافة جهة' })).toBeTruthy();
  });

  it('does not offer an inbound empty state for an outbound-only directory', () => {
    setQuery({ data: [CUSTOMER] });
    renderScreen();

    expect(screen.getByText('لا توجد جهات وارد بعد')).toBeTruthy();
    fireEvent.click(subTab('جهات صرف'));
    expect(screen.getByText('مؤسسة الأفق للتجارة والتوزيع')).toBeTruthy();
  });

  it('renders a loading indicator while the directory is in flight', () => {
    setQuery({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();

    expect(screen.getByText('جارٍ تحميل الجهات…')).toBeTruthy();
  });

  it('surfaces a denied grant explicitly instead of showing an empty table', () => {
    setQuery({
      isLoading: false,
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new PartiesError('forbidden'),
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'إضافة جهة' })).toBeNull();
    expect(screen.queryByText('لا توجد جهات وارد بعد')).toBeNull();
  });
});

describe('Parties — create', () => {
  it('offers both supplier kinds on the inbound tab and no customer', () => {
    renderScreen();
    const dialog = openCreateDialog();

    const select = within(dialog).getByLabelText<HTMLSelectElement>('نوع الجهة');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['اختر نوع الجهة…', 'مورّد محلي', 'مورّد أجنبي']);
  });

  it('requires the type and a valid name before any request', () => {
    renderScreen();
    const dialog = openCreateDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(within(dialog).getByText('اختر نوع الجهة.')).toBeTruthy();
    expect(within(dialog).getByText('الاسم مطلوب.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('creates a local supplier with its credit terms and closes on success', () => {
    renderScreen();
    const dialog = openCreateDialog();

    /* Credit terms appear once a type is chosen, for both supplier kinds. */
    expect(within(dialog).queryByLabelText('الحد الائتماني')).toBeNull();
    chooseType(dialog, 'local_supplier');
    expect(within(dialog).getByText('حد الشراء الآجل المتفق عليه مع المورّد.')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'مورّد الاختبار الآلي' },
    });
    fireEvent.change(within(dialog).getByLabelText('الحد الائتماني'), {
      target: { value: '5000' },
    });
    fireEvent.change(within(dialog).getByLabelText('شروط الدفع'), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      type: 'local_supplier',
      name: 'مورّد الاختبار الآلي',
      taxNumber: null,
      commercialRegister: null,
      address: null,
      contactPerson: null,
      phone: null,
      email: null,
      creditLimit: 5000,
      paymentTerms: 30,
    });

    settleWithSuccess(mutations.create);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });

  it('creates a customer from the outbound tab with the type fixed and no type control', () => {
    renderScreen();
    fireEvent.click(subTab('جهات صرف'));
    const dialog = openCreateDialog();

    /* The tab decides: a customer is shown as text, not as a select. */
    expect(within(dialog).queryByLabelText('نوع الجهة')).toBeNull();
    expect(within(dialog).getByText('عميل')).toBeTruthy();
    expect(
      within(dialog).getByText('هذا التبويب يُنشئ عملاء فقط، ويأخذ الكود من تسلسل CUS.'),
    ).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'عميل الاختبار الآلي' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toMatchObject({
      type: 'customer',
      name: 'عميل الاختبار الآلي',
      creditLimit: null,
      paymentTerms: null,
    });
  });

  it('refuses a malformed email inline, before any request', () => {
    renderScreen();
    const dialog = openCreateDialog();

    chooseType(dialog, 'foreign_supplier');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'مورّد الاختبار' },
    });
    fireEvent.change(within(dialog).getByLabelText('البريد الإلكتروني'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(within(dialog).getByText('أدخل بريداً إلكترونياً صحيحاً أو اتركه فارغاً.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and reports a denied write without pretending success', () => {
    renderScreen();
    const dialog = openCreateDialog();

    chooseType(dialog, 'local_supplier');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'مورّد الاختبار' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    settleWithError(mutations.create, new PartyWriteError('forbidden'));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.queryByText('تم الحفظ.')).toBeNull();
  });
});

describe('Parties — edit', () => {
  it('prefills the fields and renders type and code as read-only text', () => {
    renderScreen();
    fireEvent.click(subTab('جهات صرف'));
    fireEvent.click(actionOf('تعديل', 'مؤسسة الأفق للتجارة والتوزيع'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('اسم الجهة').value).toBe(
      'مؤسسة الأفق للتجارة والتوزيع',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('الحد الائتماني').value).toBe('150000');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('شروط الدفع').value).toBe('60');

    /* The identity is information, not input: the code is text, and the only
       select in the dialog is the payment terms — there is no type control. */
    expect(within(dialog).getByText('CUS-001')).toBeTruthy();
    expect(within(dialog).queryByLabelText('نوع الجهة')).toBeNull();
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1);
    expect(
      within(dialog).getByText('النوع والكود ثابتان ولا يقبلان التعديل بعد الإنشاء.'),
    ).toBeTruthy();
  });

  it('submits the edit with no type and no code anywhere', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'شركة النيل للتوريدات الصناعية'));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'النيل للتوريدات — الاسم الجديد' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    const submitted = mutations.update.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).toMatchObject({
      id: 'loc',
      name: 'النيل للتوريدات — الاسم الجديد',
      creditLimit: 250000,
      paymentTerms: 30,
    });
    expect(submitted).not.toHaveProperty('code');
    expect(submitted).not.toHaveProperty('type');

    settleWithSuccess(mutations.update);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });
});

describe('Parties — activate and deactivate', () => {
  it('flips is_active in both directions', () => {
    renderScreen();

    fireEvent.click(actionOf('تعطيل', 'شركة النيل للتوريدات الصناعية'));
    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'loc', isActive: false });

    fireEvent.click(subTab('جهات صرف'));
    fireEvent.click(actionOf('تفعيل', 'عميل معطّل للاختبار'));
    expect(mutations.toggle.mutate.mock.calls[1]?.[0]).toEqual({ id: 'cus2', isActive: true });
  });

  it('reports a denied toggle instead of silently doing nothing', () => {
    renderScreen();
    fireEvent.click(actionOf('تعطيل', 'شركة النيل للتوريدات الصناعية'));

    settleWithError(mutations.toggle, new PartyWriteError('forbidden'));

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
  });
});

describe('Parties — delete', () => {
  it('is offered on every row in this phase (nothing references a party yet)', () => {
    renderScreen();

    for (const entry of [LOCAL_SUPPLIER, FOREIGN_SUPPLIER]) {
      expect(actionOf('حذف', entry.name)).toBeTruthy();
    }

    fireEvent.click(subTab('جهات صرف'));
    for (const entry of [CUSTOMER, INACTIVE_CUSTOMER]) {
      expect(actionOf('حذف', entry.name)).toBeTruthy();
    }
  });

  it('confirms with the name and code before deleting', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'شركة النيل للتوريدات الصناعية'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('شركة النيل للتوريدات الصناعية');
    expect(dialog.textContent).toContain('LOC-001');
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toEqual({ id: 'loc' });

    settleWithSuccess(mutations.remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحذف.');

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق التنبيه' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('translates a refused delete (23503) into a references message and dismisses the dialog', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'Nile Trading GmbH'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));

    settleWithError(mutations.remove, new PartyWriteError('hasReferences'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'لا يمكن حذف هذه الجهة لوجود مستندات مرتبطة بها',
    );
    expect(screen.queryByText('تم الحذف.')).toBeNull();
  });
});
