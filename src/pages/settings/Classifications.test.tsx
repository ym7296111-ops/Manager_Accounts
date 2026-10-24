import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import { ClassificationsError, type ClassificationNode } from '@/hooks/useClassifications';
import type * as ClassificationsMutationsModule from '@/hooks/useClassificationsMutations';
import { ClassificationWriteError } from '@/hooks/useClassificationsMutations';
import { I18nProvider } from '@/i18n/I18nContext';
import Classifications from '@/pages/settings/Classifications';

interface QueryStub {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  data: readonly ClassificationNode[] | undefined;
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

vi.mock('@/hooks/useClassifications', async (importOriginal) => {
  const actual = await importOriginal<typeof ClassificationsModule>();
  return { ...actual, useClassifications: () => queryState.value };
});

vi.mock('@/hooks/useClassificationsMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof ClassificationsMutationsModule>();
  return {
    ...actual,
    useCreateClassification: () => mutations.create,
    useRenameClassification: () => mutations.rename,
    useSetClassificationActive: () => mutations.toggle,
    useDeleteClassification: () => mutations.remove,
  };
});

const TREE: readonly ClassificationNode[] = [
  {
    id: 'c1',
    code: 'CLS-001',
    name: 'المواد والمستلزمات',
    level: 1,
    isLeaf: false,
    isActive: true,
    children: [
      {
        id: 'g1',
        code: 'CLS-002',
        name: 'المواد الخام',
        level: 2,
        isLeaf: false,
        isActive: true,
        children: [
          {
            id: 'i1',
            code: 'CLS-004',
            name: 'حديد وصلب',
            level: 3,
            isLeaf: true,
            isActive: true,
            children: [],
          },
          {
            id: 'i2',
            code: 'CLS-005',
            name: 'أخشاب',
            level: 3,
            isLeaf: true,
            isActive: false,
            children: [],
          },
        ],
      },
      {
        id: 'g2',
        code: 'CLS-003',
        name: 'مستلزمات التشغيل',
        level: 2,
        /* Childless, so the server derives is_leaf = true and it is deletable. */
        isLeaf: true,
        isActive: true,
        children: [],
      },
    ],
  },
  {
    id: 'c2',
    code: 'CLS-006',
    name: 'الخدمات',
    level: 1,
    isLeaf: true,
    isActive: false,
    children: [],
  },
];

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
      <Classifications />
    </I18nProvider>,
  );
}

/** The disclosure button whose accessible name starts with the given node name. */
const toggleOf = (name: string) =>
  screen.getByRole('button', {
    name: (accessibleName: string) => accessibleName.startsWith(name),
  });

const actionOf = (action: string, entity: string) =>
  screen.getByRole('button', { name: `${action} ${entity}` });

/**
 * The “add sub-classification” button inside a given parent.
 *
 * Both sub-levels share one visible label, and two of those buttons can be on
 * screen at once, so the screen qualifies the accessible name with the parent
 * the new row will land under.
 */
const subAddButton = (parent: string) => `إضافة تصنيف فرعي داخل «${parent}»`;

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

describe('Classifications — tree rendering', () => {
  it('lists every category collapsed, with its code, group count and status', () => {
    renderScreen();

    expect(screen.getByRole('heading', { name: 'شجرة التصنيفات' })).toBeTruthy();
    expect(screen.getByText('المواد والمستلزمات')).toBeTruthy();
    expect(screen.getByText('CLS-001')).toBeTruthy();
    expect(screen.getByText('الخدمات')).toBeTruthy();
    expect(screen.getByText('CLS-006')).toBeTruthy();

    /* Counts and status are exposed to assistive technology, not just colour.
       Level 2 and level 3 share the "sub-classifications" label, so a count is
       only unambiguous inside the row it belongs to. */
    expect(within(toggleOf('المواد والمستلزمات')).getByText('التصنيفات الفرعية: 2')).toBeTruthy();
    expect(within(toggleOf('الخدمات')).getByText('التصنيفات الفرعية: 0')).toBeTruthy();
    const inactiveLabels = screen.getAllByText('معطّل');
    expect(inactiveLabels).toHaveLength(1); // the disabled category

    const toggles = screen
      .getAllByRole('button')
      .filter((node) => node.hasAttribute('aria-expanded'));
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByText('المواد الخام')).toBeNull();
    expect(screen.queryByText('حديد وصلب')).toBeNull();
  });

  it('reveals the groups of a category without revealing its items', () => {
    renderScreen();
    const header = toggleOf('المواد والمستلزمات');

    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('المواد الخام')).toBeTruthy();
    expect(screen.getByText('CLS-002')).toBeTruthy();
    expect(screen.getByText('مستلزمات التشغيل')).toBeTruthy();
    expect(within(toggleOf('المواد الخام')).getByText('التصنيفات الفرعية: 2')).toBeTruthy();
    expect(within(toggleOf('مستلزمات التشغيل')).getByText('التصنيفات الفرعية: 0')).toBeTruthy();
    expect(screen.queryByText('حديد وصلب')).toBeNull();

    const panel = document.getElementById('classification-category-panel-c1')!;
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-labelledby')).toBe('classification-category-c1');
  });

  it('reveals the items of a group when the group is expanded', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(toggleOf('المواد الخام'));

    expect(screen.getByText('حديد وصلب')).toBeTruthy();
    expect(screen.getByText('CLS-004')).toBeTruthy();
    expect(screen.getByText('أخشاب')).toBeTruthy();
    expect(screen.getByText('CLS-005')).toBeTruthy();

    // The disabled leaf keeps its own status marker.
    const leaf = screen.getByText('أخشاب').closest('li')!;
    expect(within(leaf).getByText('معطّل')).toBeTruthy();

    const panel = document.getElementById('classification-group-panel-g1')!;
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.getAttribute('aria-labelledby')).toBe('classification-group-g1');
  });

  it('expands categories and groups independently and collapses on a second click', () => {
    renderScreen();
    const materials = toggleOf('المواد والمستلزمات');
    const services = toggleOf('الخدمات');

    fireEvent.click(materials);
    expect(materials.getAttribute('aria-expanded')).toBe('true');
    expect(services.getAttribute('aria-expanded')).toBe('false');

    // A category with no children shows its empty note, not an empty box.
    fireEvent.click(services);
    expect(
      within(document.getElementById('classification-category-panel-c2')!).getByText(
        'لا توجد تصنيفات فرعية في هذا التصنيف بعد.',
      ),
    ).toBeTruthy();

    fireEvent.click(toggleOf('المواد الخام'));
    expect(toggleOf('المواد الخام').getAttribute('aria-expanded')).toBe('true');
    expect(toggleOf('مستلزمات التشغيل').getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(materials);
    expect(materials.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('المواد الخام')).toBeNull();

    fireEvent.click(materials);
    // Group state survives while its category stays mounted collapsed.
    expect(toggleOf('المواد الخام').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the empty note for a sub-classification without children', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(toggleOf('مستلزمات التشغيل'));

    expect(
      within(document.getElementById('classification-group-panel-g2')!).getByText(
        'لا توجد تصنيفات فرعية في هذا التصنيف بعد.',
      ),
    ).toBeTruthy();
  });
});

describe('Classifications — empty, loading and permission states', () => {
  it('renders the empty state when there are no classifications', () => {
    setQuery({ data: [] });
    renderScreen();

    expect(screen.getByRole('heading', { name: 'لا توجد تصنيفات بعد' })).toBeTruthy();
    expect(screen.queryByText('CLS-001')).toBeNull();
    // The add affordance stays present and live: an empty tree is the one place
    // where the next step must be obvious.
    expect(screen.getByRole('button', { name: 'إضافة تصنيف أساسي' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('renders a loading indicator while the tree is in flight', () => {
    setQuery({ isLoading: true, isSuccess: false, data: undefined });
    renderScreen();
    expect(screen.getByText('جارٍ تحميل التصنيفات…')).toBeTruthy();
  });

  it('surfaces a denied grant explicitly instead of collapsing into the empty state', () => {
    const refetch = vi.fn();
    setQuery({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: new ClassificationsError('forbidden'),
      refetch,
    });
    renderScreen();

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.queryByText('لا توجد تصنيفات بعد')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('never leaks the raw server message into the alert', () => {
    setQuery({
      isError: true,
      isSuccess: false,
      data: undefined,
      error: { code: '42501', message: 'permission denied for table classifications' },
    });
    renderScreen();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('permission denied');
    expect(alert.textContent).toContain('لا تملك صلاحية قراءة التصنيفات');
  });
});

describe('Classifications — create', () => {
  it('opens a name-only dialog for a new category and submits the trimmed name', () => {
    renderScreen();

    fireEvent.click(screen.getByRole('button', { name: 'إضافة تصنيف أساسي' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'إضافة تصنيف أساسي' })).toBeTruthy();

    // Exactly one field, and no code / level / parent input.
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(1);
    expect(within(dialog).queryByText(/CLS-/)).toBeNull();
    expect(dialog.textContent).toContain('سيُنشأ تصنيف أساسي جديد في المستوى الأول');

    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف أساسي'), {
      target: { value: '  تصنيف أساسي جديد  ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate).toHaveBeenCalledTimes(1);
    /* A category omits parent_id entirely — the level is the server's to derive. */
    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({ name: 'تصنيف أساسي جديد' });
  });

  it('sends parent_id for a group created inside a category', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));

    fireEvent.click(screen.getByRole('button', { name: subAddButton('المواد والمستلزمات') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'إضافة تصنيف فرعي' })).toBeTruthy();
    expect(dialog.textContent).toContain('المواد والمستلزمات');

    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف فرعي'), {
      target: { value: 'تصنيف فرعي' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      name: 'تصنيف فرعي',
      parentId: 'c1',
    });
  });

  it('sends parent_id for an item created inside a group', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(toggleOf('المواد الخام'));

    fireEvent.click(screen.getByRole('button', { name: subAddButton('المواد الخام') }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'إضافة تصنيف فرعي' })).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف فرعي'), {
      target: { value: 'تصنيف فرعي أدنى' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate.mock.calls[0]?.[0]).toEqual({
      name: 'تصنيف فرعي أدنى',
      parentId: 'g1',
    });
  });

  it('refuses an empty or single-character name before any request is made', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة تصنيف أساسي' }));

    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('اسم تصنيف أساسي');

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('الاسم مطلوب.');
    expect(mutations.create.mutate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'م' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('الاسم يجب ألا يقل عن حرفين.');
    expect(mutations.create.mutate).not.toHaveBeenCalled();
  });

  it('closes the dialog and reveals the new node once the insert resolves', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(screen.getByRole('button', { name: subAddButton('المواد والمستلزمات') }));

    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف فرعي'), {
      target: { value: 'جديدة' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    settleWithSuccess(mutations.create);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('تم الحفظ.');
    // The parent category stays open so the result is visible.
    expect(toggleOf('المواد والمستلزمات').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the dialog open and reports a denied write without pretending success', () => {
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة تصنيف أساسي' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف أساسي'), {
      target: { value: 'اسم مختصر' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    settleWithError(mutations.create, new ClassificationWriteError('forbidden'));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
    expect(screen.queryByText('تم الحفظ.')).toBeNull();
  });
});

describe('Classifications — rename', () => {
  it('prefills the name and shows the code as read-only text', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(actionOf('تعديل', 'المواد الخام'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'تعديل الاسم' })).toBeTruthy();
    /* The noun in the label follows the node's own level: this is a group. */
    expect(within(dialog).getByLabelText('اسم تصنيف فرعي')).toHaveProperty('value', 'المواد الخام');
    expect(within(dialog).getByText('CLS-002')).toBeTruthy();
    // The code is plain text: only the name is editable.
    expect(within(dialog).queryAllByRole('textbox')).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف فرعي'), {
      target: { value: 'اسم معدّل' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    /* Only id + name: no code, level, is_leaf or parent_id. */
    expect(mutations.rename.mutate.mock.calls[0]?.[0]).toEqual({
      id: 'g1',
      name: 'اسم معدّل',
    });
    expect(mutations.create.mutate).not.toHaveBeenCalled();
  });

  it('renames a leaf item too', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(toggleOf('المواد الخام'));
    fireEvent.click(actionOf('تعديل', 'حديد وصلب'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('اسم تصنيف فرعي')).toHaveProperty('value', 'حديد وصلب');
    fireEvent.change(within(dialog).getByLabelText('اسم تصنيف فرعي'), {
      target: { value: 'حديد' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.rename.mutate.mock.calls[0]?.[0]).toEqual({ id: 'i1', name: 'حديد' });
  });
});

describe('Classifications — activate and deactivate', () => {
  it('flips is_active on a category and keeps it listed', () => {
    renderScreen();
    fireEvent.click(actionOf('تعطيل', 'المواد والمستلزمات'));

    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'c1', isActive: false });
    expect(screen.getByText('المواد والمستلزمات')).toBeTruthy();
  });

  it('offers reactivation for an already disabled node', () => {
    renderScreen();
    fireEvent.click(actionOf('تفعيل', 'الخدمات'));

    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'c2', isActive: true });
  });

  it('flips is_active on a group and on an item', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(actionOf('تعطيل', 'المواد الخام'));
    expect(mutations.toggle.mutate.mock.calls[0]?.[0]).toEqual({ id: 'g1', isActive: false });

    fireEvent.click(toggleOf('المواد الخام'));
    // i2 is already disabled, so the affordance offered is activation.
    fireEvent.click(actionOf('تفعيل', 'أخشاب'));
    expect(mutations.toggle.mutate.mock.calls[1]?.[0]).toEqual({ id: 'i2', isActive: true });
  });

  it('reports a denied toggle instead of silently doing nothing', () => {
    renderScreen();
    fireEvent.click(actionOf('تعطيل', 'المواد والمستلزمات'));

    settleWithError(mutations.toggle, new ClassificationWriteError('forbidden'));

    expect(screen.getByRole('alert').textContent).toContain('project.settings:manage');
  });
});

describe('Classifications — delete (double guard)', () => {
  it('offers delete only for a node with no children', () => {
    renderScreen();

    // The category holds two groups and the group holds two items.
    expect(() => actionOf('حذف', 'المواد والمستلزمات')).toThrow();
    expect(() => actionOf('حذف', 'الخدمات')).not.toThrow();

    fireEvent.click(toggleOf('المواد والمستلزمات'));
    expect(() => actionOf('حذف', 'المواد الخام')).toThrow();
    // A group with no items is a leaf and can be deleted.
    expect(() => actionOf('حذف', 'مستلزمات التشغيل')).not.toThrow();

    fireEvent.click(toggleOf('المواد الخام'));
    expect(() => actionOf('حذف', 'حديد وصلب')).not.toThrow();
  });

  it('hides delete for a node the server still marks non-leaf, even with no rendered children', () => {
    /* A stale read can show a childless node whose derived `is_leaf` is still
       false (a child was added by somebody else). Both conditions must hold, and
       when they disagree the UI fails safe — the FK would refuse the delete and
       an offered button would be a lie. */
    setQuery({
      data: [
        {
          id: 'c1',
          code: 'CLS-001',
          name: 'المواد والمستلزمات',
          level: 1,
          isLeaf: false,
          isActive: true,
          children: [],
        },
      ],
    });
    renderScreen();

    expect(() => actionOf('حذف', 'المواد والمستلزمات')).toThrow();
    expect(actionOf('تعديل', 'المواد والمستلزمات')).toBeTruthy();
  });

  it('confirms before deleting a leaf', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'الخدمات'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'حذف التصنيف' })).toBeTruthy();
    expect(within(dialog).getByText(/الخدمات/)).toBeTruthy();
    expect(within(dialog).getByText(/CLS-006/)).toBeTruthy();
    // The dialog says out loud that the constraint, not the UI, is the guard.
    expect(dialog.textContent).toContain('الحذف مرفوض من قاعدة البيانات');
    expect(mutations.remove.mutate).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'تأكيد الحذف' }));
    expect(mutations.remove.mutate.mock.calls[0]?.[0]).toEqual({ id: 'c2' });
  });

  it('translates ON DELETE RESTRICT (23503) into a child message', () => {
    /* The button is hidden for a non-empty node, but the constraint is the real
       guard: a child inserted concurrently must still produce clear copy. */
    renderScreen();
    fireEvent.click(actionOf('حذف', 'الخدمات'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));

    settleWithError(mutations.remove, new ClassificationWriteError('hasChildren'));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('لا يمكن حذف هذا التصنيف لاحتوائه على تصنيفات فرعية');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports a delete that matched no row instead of claiming success', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'الخدمات'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));

    settleWithError(mutations.remove, new ClassificationWriteError('notFound'));

    expect(screen.getByRole('alert').textContent).toContain('لم يعد هذا التصنيف موجوداً');
    expect(screen.queryByText('تم الحذف.')).toBeNull();
  });

  it('reports success and dismisses the banner on request', () => {
    renderScreen();
    fireEvent.click(actionOf('حذف', 'الخدمات'));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحذف' }));
    settleWithSuccess(mutations.remove);

    expect(screen.getByRole('alert').textContent).toBe('تم الحذف.');
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق التنبيه' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Classifications — no reparenting from the UI', () => {
  it("renders no control that could change a node's parent", () => {
    renderScreen();

    /* Moving a node re-derives a whole subtree, which is deliberately out of
       scope. There is no such affordance, and the rename dialog has no parent
       field: `parent_id` is write-once, on insert only. */
    expect(document.querySelector('[name="parent_id"]')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(actionOf('تعديل', 'المواد الخام'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
  });
});
