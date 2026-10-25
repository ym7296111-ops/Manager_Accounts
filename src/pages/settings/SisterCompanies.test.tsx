import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SisterCompaniesModule from '@/hooks/useSisterCompanies';
import { SisterCompaniesError, type SisterCompany } from '@/hooks/useSisterCompanies';
import type * as SisterCompaniesMutationsModule from '@/hooks/useSisterCompaniesMutations';
import { SisterCompanyWriteError } from '@/hooks/useSisterCompaniesMutations';
import { I18nProvider } from '@/i18n/I18nContext';
import SisterCompanies from '@/pages/settings/SisterCompanies';

interface QueryStub {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: readonly SisterCompany[] | undefined;
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

vi.mock('@/hooks/useSisterCompanies', async (importOriginal) => {
  const actual = await importOriginal<typeof SisterCompaniesModule>();
  return { ...actual, useSisterCompanies: () => queryState.value };
});

vi.mock('@/hooks/useSisterCompaniesMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof SisterCompaniesMutationsModule>();
  return {
    ...actual,
    useCreateSisterCompany: () => mutations.create,
    useRenameSisterCompany: () => mutations.rename,
    useSetSisterCompanyActive: () => mutations.toggle,
    useDeleteSisterCompany: () => mutations.remove,
  };
});

const TREE: readonly SisterCompany[] = [
  {
    id: 'sc1',
    parentId: null,
    level: 1,
    code: 'SIS-001',
    name: 'الشركة المتحدة للخدمات اللوجستية',
    isActive: true,
    branches: [
      {
        id: 'sc1-1',
        parentId: 'sc1',
        level: 2,
        code: 'SIS-001-01',
        name: 'المتحدة للنقل الثقيل',
        isActive: true,
        branches: [],
      },
      {
        id: 'sc1-2',
        parentId: 'sc1',
        level: 2,
        code: 'SIS-001-02',
        name: 'المتحدة للتخليص الجمركي',
        isActive: false,
        branches: [],
      },
    ],
  },
  {
    id: 'sc2',
    parentId: null,
    level: 1,
    code: 'SIS-002',
    name: 'شركة الواحة للاستثمار',
    isActive: true,
    branches: [],
  },
];

function setQuery(patch: Partial<QueryStub> = {}) {
  queryState.value = {
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: TREE,
    error: null,
    refetch: vi.fn(),
    ...patch,
  };
}

function renderScreen() {
  return render(
    <I18nProvider>
      <SisterCompanies />
    </I18nProvider>,
  );
}

const actionOf = (action: string, entity: string) =>
  screen.getByRole('button', { name: `${action} ${entity}` });

/**
 * The disclosure button of a company row. Anchored to the start of the
 * accessible name: the row's action buttons ("Edit <name>", "Deactivate
 * <name>") also contain the name further along.
 */
const toggleOf = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

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

describe('Sister companies — tree rendering', () => {
  it('lists the parent companies collapsed, with codes, branch counts and status', () => {
    renderScreen();

    expect(screen.getByText('الشركة المتحدة للخدمات اللوجستية')).toBeTruthy();
    expect(screen.getByText('SIS-001')).toBeTruthy();
    expect(screen.getByText('شركة الواحة للاستثمار')).toBeTruthy();
    expect(screen.getByText('SIS-002')).toBeTruthy();
    expect(screen.getByText('الفروع: 2')).toBeTruthy();

    /* A branch is only rendered when its parent is open. */
    expect(screen.queryByText('المتحدة للنقل الثقيل')).toBeNull();
  });

  it('opens a parent onto its branches, each with its SIS-001-01 style code', () => {
    renderScreen();
    fireEvent.click(toggleOf('الشركة المتحدة للخدمات اللوجستية'));

    expect(screen.getByText('المتحدة للنقل الثقيل')).toBeTruthy();
    expect(screen.getByText('SIS-001-01')).toBeTruthy();
    expect(screen.getByText('المتحدة للتخليص الجمركي')).toBeTruthy();
    expect(screen.getByText('SIS-001-02')).toBeTruthy();
    /* The open panel is the disclosure button's controlled region. */
    expect(document.getElementById('sister-company-panel-sc1')).toBeTruthy();
  });

  it('offers delete on a branch but not on a parent that still has branches', () => {
    renderScreen();

    /* A parent with branches: no delete button (the FK is the real guard). */
    expect(
      screen.queryByRole('button', { name: /حذف الشركة المتحدة للخدمات اللوجستية/ }),
    ).toBeNull();
    /* A parent without branches can be deleted. */
    expect(actionOf('حذف', 'شركة الواحة للاستثمار')).toBeTruthy();

    fireEvent.click(toggleOf('الشركة المتحدة للخدمات اللوجستية'));
    expect(actionOf('حذف', 'المتحدة للنقل الثقيل')).toBeTruthy();
  });
});

describe('Sister companies — create', () => {
  it('creates a parent company with a name only', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة شركة أم' }));

    /* The root hint shows the shape of the code, never a specific number: the
       next parent is SIS-002 when SIS-001 is already taken. */
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/SIS-###/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم الشركة'), {
      target: { value: 'شركة جديدة للاختبار' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({ name: 'شركة جديدة للاختبار' });

    settleWithSuccess(mutations.create);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
  });

  it('creates a branch under the open parent, sending its parent id', () => {
    renderScreen();
    fireEvent.click(toggleOf('الشركة المتحدة للخدمات اللوجستية'));
    fireEvent.click(
      screen.getByRole('button', { name: 'إضافة فرع تحت «الشركة المتحدة للخدمات اللوجستية»' }),
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/SIS-001-##/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم الشركة'), {
      target: { value: 'فرع الاختبار' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      name: 'فرع الاختبار',
      parentId: 'sc1',
    });
  });

  it('refuses a one-character name before any request', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة شركة أم' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم الشركة'), { target: { value: 'ش' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(within(dialog).getByText('الاسم يجب ألا يقل عن حرفين.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and explains a refused write', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة شركة أم' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم الشركة'), {
      target: { value: 'شركة مرفوضة' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    settleWithError(mutations.create, new SisterCompanyWriteError('forbidden'));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
  });
});

describe('Sister companies — rename and toggle', () => {
  it('renames a company without sending its code, level or parent', () => {
    renderScreen();
    fireEvent.click(actionOf('تعديل', 'شركة الواحة للاستثمار'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('SIS-002')).toBeTruthy();
    expect(
      within(dialog).getByText(/الشركة الأم والمستوى والكود ثابتة ولا تقبل التعديل/),
    ).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم الشركة'), {
      target: { value: 'الواحة للاستثمار والتطوير' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.rename.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'sc2',
      name: 'الواحة للاستثمار والتطوير',
    });
  });

  it('flips is_active for a company and for one of its branches', () => {
    renderScreen();

    fireEvent.click(actionOf('تعطيل', 'شركة الواحة للاستثمار'));
    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'sc2', isActive: false });

    fireEvent.click(toggleOf('الشركة المتحدة للخدمات اللوجستية'));
    fireEvent.click(actionOf('تفعيل', 'المتحدة للتخليص الجمركي'));
    expect(mutations.toggle.mutate.mock.calls[1]?.[0]).toEqual({ id: 'sc1-2', isActive: true });
  });
});

describe('Sister companies — delete', () => {
  it('confirms with the name and code, then deletes', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'شركة الواحة للاستثمار'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('شركة الواحة للاستثمار');
    expect(dialog.textContent).toContain('SIS-002');

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toEqual({ id: 'sc2' });

    settleWithSuccess(mutations.remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحذف.');
  });

  it('translates a refused delete (23503) into a branches message', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'شركة الواحة للاستثمار'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));

    settleWithError(mutations.remove, new SisterCompanyWriteError('hasBranches'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain(
      'لا يمكن حذف هذه الشركة لأن لها فروعاً',
    );
  });
});

describe('Sister companies — loading, empty and denied states', () => {
  it('renders the empty state when there are no companies', () => {
    setQuery({ data: [] });
    renderScreen();

    expect(screen.getByText('لا توجد شركات شقيقة بعد')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إضافة شركة أم' })).toBeTruthy();
  });

  it('renders a loading indicator', () => {
    setQuery({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();

    expect(screen.getByText('جارٍ تحميل الشركات الشقيقة…')).toBeTruthy();
  });

  it('surfaces a denied read explicitly instead of an empty tree', () => {
    setQuery({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new SisterCompaniesError('forbidden'),
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.queryByText('لا توجد شركات شقيقة بعد')).toBeNull();
    expect(screen.queryByRole('button', { name: 'إضافة شركة أم' })).toBeNull();
  });
});
