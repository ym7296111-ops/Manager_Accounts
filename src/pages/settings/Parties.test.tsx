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

const DIRECTORY: readonly Party[] = [
  party({
    id: 'sup',
    type: 'supplier',
    code: 'SUP-001',
    name: 'شركة النيل للتوريدات الصناعية',
    creditLimit: 250000,
    paymentTerms: 30,
  }),
  party({
    id: 'cus',
    type: 'customer',
    code: 'CUS-001',
    name: 'مؤسسة الأفق للتجارة والتوزيع',
    taxNumber: '987654321',
    email: 'purchases@horizon-trade.example.com',
    creditLimit: 150000,
    paymentTerms: 60,
  }),
  party({
    id: 'sis',
    type: 'sister_company',
    code: 'SIS-001',
    name: 'الشركة المتحدة للخدمات اللوجستية',
  }),
  party({
    id: 'int',
    type: 'internal',
    code: 'INT-001',
    name: 'إدارة الصيانة والتشغيل',
    isActive: false,
  }),
];

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

describe('Parties — directory rendering', () => {
  it('lists every party with its name, faint code, type badge and status', () => {
    renderScreen();

    for (const entry of DIRECTORY) {
      expect(screen.getByText(entry.name)).toBeTruthy();
      expect(screen.getByText(entry.code)).toBeTruthy();
    }
    /* One badge per type, named in text (never colour alone). */
    expect(screen.getByText('مورّد')).toBeTruthy();
    expect(screen.getByText('عميل')).toBeTruthy();
    expect(screen.getByText('شركة شقيقة')).toBeTruthy();
    expect(screen.getByText('جهة داخلية')).toBeTruthy();
    /* Status travels as an accessible label: three active, one disabled. */
    expect(screen.getAllByText('نشط')).toHaveLength(3);
    expect(screen.getAllByText('معطّل')).toHaveLength(1);
  });

  it('filters the already-loaded list by type, with counts, and back', () => {
    renderScreen();

    const suppliersFilter = screen.getByRole('button', { name: /موردون/ });
    expect(suppliersFilter.textContent).toContain('1');
    fireEvent.click(suppliersFilter);

    expect(suppliersFilter.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('شركة النيل للتوريدات الصناعية')).toBeTruthy();
    expect(screen.queryByText('مؤسسة الأفق للتجارة والتوزيع')).toBeNull();
    expect(screen.queryByText('إدارة الصيانة والتشغيل')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /الكل/ }));
    expect(screen.getByText('مؤسسة الأفق للتجارة والتوزيع')).toBeTruthy();
    expect(screen.getByText('إدارة الصيانة والتشغيل')).toBeTruthy();
  });

  it('says so when a filter matches nothing, without collapsing into the empty state', () => {
    setQuery({ data: [DIRECTORY[0]!] });
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: /عملاء/ }));

    expect(screen.getByText('لا توجد جهات مطابقة لهذه التصفية.')).toBeTruthy();
    expect(screen.queryByText('لا توجد جهات بعد')).toBeNull();
  });
});

describe('Parties — empty, loading and permission states', () => {
  it('renders the empty state when there are no parties', () => {
    setQuery({ data: [] });
    renderScreen();

    expect(screen.getByText('لا توجد جهات بعد')).toBeTruthy();
    expect(screen.getByText(/الكود يُولَّد تلقائياً حسب نوع الجهة/)).toBeTruthy();
    /* Creating the first party stays one click away. */
    expect(screen.getByRole('button', { name: 'إضافة جهة' })).toBeTruthy();
  });

  it('renders a loading indicator while the directory is in flight', () => {
    setQuery({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();

    expect(screen.getByText('جارٍ تحميل الجهات…')).toBeTruthy();
  });

  it('surfaces a denied grant explicitly instead of showing an empty list', () => {
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
    expect(screen.queryByText('لا توجد جهات بعد')).toBeNull();
  });
});

describe('Parties — create', () => {
  it('requires the one-time type choice and a valid name before any request', () => {
    renderScreen();
    const dialog = openCreateDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(within(dialog).getByText('اختر نوع الجهة.')).toBeTruthy();
    expect(within(dialog).getByText('الاسم مطلوب.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the credit terms only for suppliers and customers', () => {
    renderScreen();
    const dialog = openCreateDialog();

    /* Unchosen: nothing credit-shaped on screen yet. */
    expect(within(dialog).queryByLabelText('الحد الائتماني')).toBeNull();
    expect(within(dialog).queryByLabelText('شروط الدفع')).toBeNull();

    chooseType(dialog, 'supplier');
    expect(within(dialog).getByLabelText('الحد الائتماني')).toBeTruthy();
    expect(within(dialog).getByLabelText('شروط الدفع')).toBeTruthy();
    expect(within(dialog).getByText('حد الشراء الآجل المتفق عليه مع المورّد.')).toBeTruthy();

    chooseType(dialog, 'sister_company');
    expect(within(dialog).queryByLabelText('الحد الائتماني')).toBeNull();

    chooseType(dialog, 'internal');
    expect(within(dialog).queryByLabelText('الحد الائتماني')).toBeNull();
    expect(within(dialog).queryByLabelText('شروط الدفع')).toBeNull();

    chooseType(dialog, 'customer');
    expect(within(dialog).getByLabelText('الحد الائتماني')).toBeTruthy();
    expect(within(dialog).getByText('حد البيع الآجل الممنوح للعميل.')).toBeTruthy();
  });

  it('creates a customer with its credit terms and closes on success', () => {
    renderScreen();
    const dialog = openCreateDialog();

    chooseType(dialog, 'customer');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'عميل الاختبار الآلي' },
    });
    fireEvent.change(within(dialog).getByLabelText('الحد الائتماني'), {
      target: { value: '5000' },
    });
    fireEvent.change(within(dialog).getByLabelText('شروط الدفع'), { target: { value: '30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      type: 'customer',
      name: 'عميل الاختبار الآلي',
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

  it('drops credit values typed before the type switched to an internal party', () => {
    renderScreen();
    const dialog = openCreateDialog();

    chooseType(dialog, 'customer');
    fireEvent.change(within(dialog).getByLabelText('الحد الائتماني'), {
      target: { value: '5000' },
    });
    fireEvent.change(within(dialog).getByLabelText('شروط الدفع'), { target: { value: '30' } });

    chooseType(dialog, 'internal');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'إدارة الاختبار الآلي' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    /* The mutation layer strips again at the wire; the dialog must already
       hand over nulls rather than the hidden leftovers. */
    expect(mutations.create.mutate.mock.calls[0]?.[0]).toMatchObject({
      type: 'internal',
      name: 'إدارة الاختبار الآلي',
      creditLimit: null,
      paymentTerms: null,
    });
  });

  it('refuses a malformed email inline, before any request', () => {
    renderScreen();
    const dialog = openCreateDialog();

    chooseType(dialog, 'supplier');
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

    chooseType(dialog, 'supplier');
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

  it('submits the edit with the stored type as context and no code anywhere', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'مؤسسة الأفق للتجارة والتوزيع'));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'الأفق للتجارة — الاسم الجديد' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    const submitted = mutations.update.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).toMatchObject({
      id: 'cus',
      type: 'customer',
      name: 'الأفق للتجارة — الاسم الجديد',
      creditLimit: 150000,
      paymentTerms: 60,
    });
    expect(submitted).not.toHaveProperty('code');

    settleWithSuccess(mutations.update);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });

  it('offers no credit fields when editing an internal party', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'إدارة الصيانة والتشغيل'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('INT-001')).toBeTruthy();
    expect(within(dialog).queryByLabelText('الحد الائتماني')).toBeNull();
    expect(within(dialog).queryByLabelText('شروط الدفع')).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
  });
});

describe('Parties — activate and deactivate', () => {
  it('flips is_active in both directions', () => {
    renderScreen();

    fireEvent.click(actionOf('تعطيل', 'شركة النيل للتوريدات الصناعية'));
    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'sup', isActive: false });

    fireEvent.click(actionOf('تفعيل', 'إدارة الصيانة والتشغيل'));
    expect(mutations.toggle.mutate.mock.calls[1]?.[0]).toEqual({ id: 'int', isActive: true });
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

    for (const entry of DIRECTORY) {
      expect(actionOf('حذف', entry.name)).toBeTruthy();
    }
  });

  it('confirms with the name and code before deleting', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'شركة النيل للتوريدات الصناعية'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('شركة النيل للتوريدات الصناعية');
    expect(dialog.textContent).toContain('SUP-001');
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toEqual({ id: 'sup' });

    settleWithSuccess(mutations.remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحذف.');

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق التنبيه' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('translates a refused delete (23503) into a references message and dismisses the dialog', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'مؤسسة الأفق للتجارة والتوزيع'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));

    settleWithError(mutations.remove, new PartyWriteError('hasReferences'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'لا يمكن حذف هذه الجهة لوجود مستندات مرتبطة بها',
    );
    expect(screen.queryByText('تم الحذف.')).toBeNull();
  });
});
