import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClassificationsModule from '@/hooks/useClassifications';
import { ClassificationsError, type ClassificationNode } from '@/hooks/useClassifications';
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

const { queryState } = vi.hoisted(() => ({
  queryState: { value: null as unknown as QueryStub },
}));

vi.mock('@/hooks/useClassifications', async (importOriginal) => {
  const actual = await importOriginal<typeof ClassificationsModule>();
  return { ...actual, useClassifications: () => queryState.value };
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
        isLeaf: false,
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

const addButton = (label: string) => screen.getByRole('button', { name: label });

beforeEach(() => {
  setQuery();
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

    // Counts and status are exposed to assistive technology, not just colour.
    expect(screen.getByText('عدد المجموعات: 2')).toBeTruthy();
    expect(screen.getByText('عدد المجموعات: 0')).toBeTruthy();
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
    expect(screen.getByText('عدد الأصناف: 2')).toBeTruthy();
    expect(screen.getByText('عدد الأصناف: 0')).toBeTruthy();
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

    // A category with no children shows its empty-group note, not an empty box.
    fireEvent.click(services);
    expect(screen.getByText('لا توجد مجموعات في هذه الفئة بعد.')).toBeTruthy();

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

  it('shows the empty-group note for a group without items', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(toggleOf('مستلزمات التشغيل'));

    expect(screen.getByText('لا توجد أصناف في هذه المجموعة بعد.')).toBeTruthy();
  });
});

describe('Classifications — empty, loading and permission states', () => {
  it('renders the empty state when there are no classifications', () => {
    setQuery({ data: [] });
    renderScreen();

    expect(screen.getByRole('heading', { name: 'لا توجد تصنيفات بعد' })).toBeTruthy();
    expect(screen.queryByText('CLS-001')).toBeNull();
    // The add affordance stays present (disabled): an empty tree is the one
    // place where the next step must be obvious.
    expect(addButton('إضافة فئة رئيسية')).toHaveProperty('disabled', true);
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

describe('Classifications — not-yet-wired add buttons', () => {
  it('renders the category add button disabled and explained', () => {
    renderScreen();

    const button = addButton('إضافة فئة رئيسية');
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-describedby')).toBe('classifications-add-hint');
    expect(document.getElementById('classifications-add-hint')?.textContent).toContain(
      'الإضافة غير مفعّلة بعد',
    );
  });

  it('renders the group add button inside each category panel, disabled', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));

    const button = addButton('إضافة مجموعة');
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-describedby')).toBe('classifications-add-hint');

    // Scoped to the first category's panel, not a global floating button.
    const panel = document.getElementById('classification-category-panel-c1')!;
    expect(within(panel).getByRole('button', { name: 'إضافة مجموعة' })).toBe(button);
  });

  it('renders the item add button inside each group panel, disabled', () => {
    renderScreen();
    fireEvent.click(toggleOf('المواد والمستلزمات'));
    fireEvent.click(toggleOf('المواد الخام'));

    const button = addButton('إضافة صنف');
    expect(button).toHaveProperty('disabled', true);

    const panel = document.getElementById('classification-group-panel-g1')!;
    expect(within(panel).getByRole('button', { name: 'إضافة صنف' })).toBe(button);
  });

  it('issues no write and opens no dialog when a disabled button is clicked', () => {
    renderScreen();

    fireEvent.click(addButton('إضافة فئة رئيسية'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
