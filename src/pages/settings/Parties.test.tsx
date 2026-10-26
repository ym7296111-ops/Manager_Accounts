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
      rename: make(),
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
  const actual = await importOriginal<typeof PartiesModule>();
  void actual;
  return {
    ...(await importOriginal<typeof PartiesMutationsModule>()),
    useCreateParty: () => mutations.create,
    useRenameParty: () => mutations.rename,
    useSetPartyActive: () => mutations.toggle,
    useDeleteParty: () => mutations.remove,
  };
});

const party = (patch: Partial<Party> & Pick<Party, 'id' | 'branch' | 'code' | 'name'>): Party => ({
  isActive: true,
  ...patch,
});

const INBOUND_ONE = party({
  id: 'in-1',
  branch: 'inbound',
  code: 'IN-001',
  name: 'شركة النيل للتوريدات الصناعية',
});

const INBOUND_TWO = party({
  id: 'in-2',
  branch: 'inbound',
  code: 'IN-002',
  name: 'Nile Trading GmbH',
});

const INACTIVE_INBOUND = party({
  id: 'in-3',
  branch: 'inbound',
  code: 'IN-003',
  name: 'مورّد معطّل للاختبار',
  isActive: false,
});

const OUTBOUND_ONE = party({
  id: 'out-1',
  branch: 'outbound',
  code: 'OUT-001',
  name: 'مؤسسة الأفق للتجارة والتوزيع',
});

const TREE: readonly Party[] = [INBOUND_ONE, INBOUND_TWO, INACTIVE_INBOUND, OUTBOUND_ONE];

function setQuery(patch: Partial<QueryStub> = {}) {
  const initial: QueryStub = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: TREE,
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

const rootToggle = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

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

function openCreateDialog(rootName: string) {
  fireEvent.click(screen.getByRole('button', { name: `إضافة جهة داخل «${rootName}»` }));
  return screen.getByRole('dialog');
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

describe('Parties — the two-root tree', () => {
  it('renders exactly two roots, both open, with no sub-tab strip', () => {
    renderScreen();

    /* Two roots and nothing else: the tab strip of the previous design is
       gone, and sister companies are not part of this screen. */
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^جهات الوارد/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^أغراض الصرف/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^شركات شقيقة/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'شجرة الشركات الشقيقة' })).toBeNull();

    expect(rootToggle('جهات الوارد').getAttribute('aria-expanded')).toBe('true');
    expect(rootToggle('أغراض الصرف').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows each party under its own root and nothing under the other', () => {
    renderScreen();

    /* The section itself is a named region too, so the roots are pinned by
       their stable panel ids rather than by role alone. */
    const inboundPanel = document.getElementById('parties-root-panel-inbound')!;
    const outboundPanel = document.getElementById('parties-root-panel-outbound')!;
    expect(inboundPanel.getAttribute('role')).toBe('region');
    expect(outboundPanel.getAttribute('role')).toBe('region');

    expect(within(inboundPanel).getByText('شركة النيل للتوريدات الصناعية')).toBeTruthy();
    expect(within(inboundPanel).getByText('IN-001')).toBeTruthy();
    expect(within(inboundPanel).getByText('Nile Trading GmbH')).toBeTruthy();
    expect(within(inboundPanel).getByText('IN-002')).toBeTruthy();
    expect(within(inboundPanel).queryByText('مؤسسة الأفق للتجارة والتوزيع')).toBeNull();

    expect(within(outboundPanel).getByText('مؤسسة الأفق للتجارة والتوزيع')).toBeTruthy();
    expect(within(outboundPanel).getByText('OUT-001')).toBeTruthy();
    expect(within(outboundPanel).queryByText('شركة النيل للتوريدات الصناعية')).toBeNull();
  });

  it('counts the parties of each root', () => {
    renderScreen();

    expect(rootToggle('جهات الوارد').textContent).toContain('الجهات: 3');
    expect(rootToggle('أغراض الصرف').textContent).toContain('الجهات: 1');
  });

  it('reports the active flag in text, not by colour alone', () => {
    renderScreen();

    const activeRow = screen.getByText('شركة النيل للتوريدات الصناعية').closest('li');
    const inactiveRow = screen.getByText('مورّد معطّل للاختبار').closest('li');
    expect(activeRow?.textContent).toContain('نشط');
    expect(inactiveRow?.textContent).toContain('معطّل');
  });

  it('collapses and re-expands a root without losing the other', () => {
    renderScreen();

    fireEvent.click(rootToggle('جهات الوارد'));

    expect(rootToggle('جهات الوارد').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('شركة النيل للتوريدات الصناعية')).toBeNull();
    /* The other root is untouched. */
    expect(screen.getByText('مؤسسة الأفق للتجارة والتوزيع')).toBeTruthy();

    fireEvent.click(rootToggle('جهات الوارد'));
    expect(screen.getByText('شركة النيل للتوريدات الصناعية')).toBeTruthy();
  });

  it('keeps both roots on screen when a branch holds no parties', () => {
    setQuery({ data: [OUTBOUND_ONE] });
    renderScreen();

    const inboundPanel = document.getElementById('parties-root-panel-inbound')!;
    expect(within(inboundPanel).getByText('لا توجد جهات في هذا الفرع بعد.')).toBeTruthy();
    expect(rootToggle('جهات الوارد').textContent).toContain('الجهات: 0');
    /* The "add" affordance stays one click away even when empty. */
    expect(screen.getByRole('button', { name: 'إضافة جهة داخل «جهات الوارد»' })).toBeTruthy();
  });
});

describe('Parties — create', () => {
  it('opens the inbound dialog from the inbound root, with no type control', () => {
    renderScreen();
    const dialog = openCreateDialog('جهات الوارد');

    expect(within(dialog).getByRole('heading', { name: 'إضافة جهة وارد' })).toBeTruthy();
    /* The branch is decided by the root, never by a field. */
    expect(within(dialog).queryByLabelText('نوع الجهة')).toBeNull();
    expect(within(dialog).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(dialog).getByText(/تسلسل IN/)).toBeTruthy();
    expect(within(dialog).getByText('IN-###')).toBeTruthy();

    /* Name is the only field: no email, phone, credit limit, tax number… */
    const fields = within(dialog).getAllByRole('textbox');
    expect(fields).toHaveLength(1);
    expect(within(dialog).getByLabelText('اسم الجهة')).toBe(fields[0]);
  });

  it('opens the outbound dialog from the outbound root and previews OUT-###', () => {
    renderScreen();
    const dialog = openCreateDialog('أغراض الصرف');

    expect(within(dialog).getByRole('heading', { name: 'إضافة جهة صرف' })).toBeTruthy();
    expect(within(dialog).getByText(/تسلسل OUT/)).toBeTruthy();
    expect(within(dialog).getByText('OUT-###')).toBeTruthy();
  });

  it('creates under the root it was opened from', () => {
    renderScreen();
    const dialog = openCreateDialog('أغراض الصرف');

    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: '  عميل الاختبار الآلي  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      branch: 'outbound',
      name: 'عميل الاختبار الآلي',
    });

    settleWithSuccess(mutations.create);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });

  it('creates under inbound when the inbound root opened the dialog', () => {
    renderScreen();
    const dialog = openCreateDialog('جهات الوارد');

    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'مورّد الاختبار' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      branch: 'inbound',
      name: 'مورّد الاختبار',
    });
  });

  it('requires a name before any request', () => {
    renderScreen();
    const dialog = openCreateDialog('جهات الوارد');

    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(within(dialog).getByText('الاسم مطلوب.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), { target: { value: 'ش' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByText('الاسم يجب ألا يقل عن حرفين.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and reports a denied write', () => {
    renderScreen();
    const dialog = openCreateDialog('جهات الوارد');

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
  it('prefills the name and renders the code as read-only text', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'شركة النيل للتوريدات الصناعية'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('اسم الجهة').value).toBe(
      'شركة النيل للتوريدات الصناعية',
    );
    expect(within(dialog).getByText('IN-001')).toBeTruthy();
    expect(
      within(dialog).getByText('الفرع والكود ثابتان ولا يقبلان التعديل بعد الإنشاء.'),
    ).toBeTruthy();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('submits the rename with no branch and no code anywhere', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'شركة النيل للتوريدات الصناعية'));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم الجهة'), {
      target: { value: 'النيل للتوريدات — الاسم الجديد' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    const submitted = mutations.rename.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submitted).toEqual({ id: 'in-1', name: 'النيل للتوريدات — الاسم الجديد' });
    expect(submitted).not.toHaveProperty('branch');
    expect(submitted).not.toHaveProperty('code');

    settleWithSuccess(mutations.rename);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });
});

describe('Parties — activate and deactivate', () => {
  it('flips is_active in both directions', () => {
    renderScreen();

    fireEvent.click(actionOf('تعطيل', 'شركة النيل للتوريدات الصناعية'));
    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'in-1', isActive: false });

    fireEvent.click(actionOf('تفعيل', 'مورّد معطّل للاختبار'));
    expect(mutations.toggle.mutate.mock.calls[1]?.[0]).toEqual({ id: 'in-3', isActive: true });
  });

  it('reports a denied toggle instead of silently doing nothing', () => {
    renderScreen();
    fireEvent.click(actionOf('تعطيل', 'شركة النيل للتوريدات الصناعية'));

    settleWithError(mutations.toggle, new PartyWriteError('forbidden'));

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
  });
});

describe('Parties — delete', () => {
  it('offers delete on every row (nothing references a party yet)', () => {
    renderScreen();

    for (const entry of TREE) {
      expect(actionOf('حذف', entry.name)).toBeTruthy();
    }
  });

  it('confirms with the name and code before deleting', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'شركة النيل للتوريدات الصناعية'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('شركة النيل للتوريدات الصناعية');
    expect(dialog.textContent).toContain('IN-001');
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toEqual({ id: 'in-1' });

    settleWithSuccess(mutations.remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحذف.');

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق التنبيه' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('translates a refused delete (23503) into a references message', () => {
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

describe('Parties — loading and permission states', () => {
  it('renders a loading indicator while the tree is in flight', () => {
    setQuery({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();

    expect(screen.getByText('جارٍ تحميل الجهات…')).toBeTruthy();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('surfaces a denied grant explicitly instead of showing two empty roots', () => {
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
    expect(screen.queryByRole('button', { name: /^إضافة جهة داخل/ })).toBeNull();
    expect(screen.queryByText('لا توجد جهات في هذا الفرع بعد.')).toBeNull();
  });
});
